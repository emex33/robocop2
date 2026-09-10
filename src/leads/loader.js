import { createReadStream } from "fs";
import { parse } from "csv-parse";
import logger from "../utils/logger.js";

/**
 * Load leads from a CSV file.
 * Expected columns: phone, name, company (additional columns are preserved).
 */
export async function loadLeads(filePath = "leads.csv") {
  return new Promise((resolve, reject) => {
    const leads = [];
    createReadStream(filePath)
      .pipe(
        parse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
        })
      )
      .on("data", (row) => {
        if (row.phone) {
          leads.push({
            phone: row.phone.replace(/\s+/g, ""),
            name: row.name || "Unknown",
            company: row.company || "",
            ...row,
          });
        }
      })
      .on("end", () => {
        logger.info(`Loaded ${leads.length} leads from ${filePath}`);
        resolve(leads);
      })
      .on("error", (err) => {
        logger.error(`Failed to load leads: ${err.message}`);
        reject(err);
      });
  });
}

/**
 * Simple sequential call queue with stop support.
 */
export class CallQueue {
  constructor(leads, maxConcurrent = 1, delayMs = 5000) {
    this.leads = [...leads];
    this.maxConcurrent = maxConcurrent;
    this.delayMs = delayMs;
    this.activeCalls = 0;
    this.results = [];
    this.onCall = null; // callback: async (lead) => result
    this.stopped = false; // Flag to stop processing
    this.refill = null; // optional () => lead[]
    this.seenIds = new Set(leads.map(l => l.id).filter(Boolean));

    // Optional gate: (lead) => boolean. Leads that fail it are parked in
    // `deferred` (still in seenIds so refills don't duplicate them) and
    // re-checked every minute — used for consumer-local calling hours.
    this.eligible = null;
    this.deferred = [];
    this._lastDeferCheck = 0;
    this.idleWaitMs = 30_000; // how long to idle when only deferred leads remain
    this.onDeferred = null; // optional (count) => void, for campaign logs

    // Pacing is driven by slot occupancy, never by carrier responses. The
    // configured concurrency is the target: while two or more slots are empty
    // we dial every fastGapMs (~4 dials/s); only when the floor is full does a
    // gentler stagger apply, to avoid lock-step bursts as calls end together.
    // The previous adaptive pacer stretched the gap to 3s after SIP 503s,
    // which capped a 23-slot campaign at ~5 live calls — exactly the "does
    // not make the concurrent calls it should" complaint. With the carrier
    // rejecting 75% of INVITEs instantly, 4 dials/s x 25% x ~35s calls still
    // sustains ~30 live calls, so the configured limit is what binds.
    this.fastGapMs = 250;
    this.baseGapMs = Math.min(delayMs, 600);
    this.rejected503 = 0;
    this._slotWaiters = [];
    this.completedCount = 0;
    this._lastRefillAt = 0;
  }

  /** Stats only: how many dials the carrier rejected with 503 this session. */
  _learnPace(result) {
    if (!result) return;
    if (result.outcome === "error" && /\b503\b/.test(String(result.notes || result.error || ""))) this.rejected503++;
  }

  /** Gap before the next dial given how many slots are currently empty. */
  _nextGapMs() {
    const free = this.maxConcurrent - this.activeCalls;
    const gap = free >= 2 ? this.fastGapMs : this.baseGapMs;
    return gap + Math.floor(Math.random() * gap * 0.4);
  }

  /** Resolves as soon as a call finishes (or after `ms`, whichever is first). */
  _waitForSlot(ms = 1000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._slotWaiters = this._slotWaiters.filter(w => w !== resolve); resolve(); }, ms);
      this._slotWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  _notifySlotFreed() {
    const waiters = this._slotWaiters;
    this._slotWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Stop the queue immediately - no more calls will be started.
   */
  stop() {
    this.stopped = true;
    this.leads = []; // Clear remaining leads
    this.deferred = [];
    logger.info(`Call queue stopped. ${this.activeCalls} calls still active.`);
  }

  /** Move deferred leads whose gate now passes back to the front of the queue. */
  _recheckDeferred(force = false) {
    if (!this.eligible || !this.deferred.length) return;
    if (!force && Date.now() - this._lastDeferCheck < 60_000) return;
    this._lastDeferCheck = Date.now();
    const ready = [], still = [];
    for (const lead of this.deferred) (this.eligible(lead) ? ready : still).push(lead);
    if (ready.length) {
      this.deferred = still;
      this.leads.unshift(...ready);
      logger.info(`[local-hours] ${ready.length} deferred leads now inside their local calling hours (${still.length} still waiting)`);
    }
  }

  async start(onCall) {
    this.onCall = onCall;
    this.stopped = false;
    logger.info(`Starting call queue: ${this.leads.length} leads, max ${this.maxConcurrent} concurrent, delay ${this.delayMs}ms between dials`);

    let deferredAnnounced = 0;
    while (!this.stopped) {
      this._recheckDeferred();
      if (this.leads.length === 0) {
        this._refillQueue();
        if (this.leads.length === 0) {
          if (this.deferred.length > 0) {
            // Everything left is waiting for its local morning. Idle, don't finish.
            if (this.deferred.length !== deferredAnnounced) {
              deferredAnnounced = this.deferred.length;
              logger.info(`[local-hours] all ${this.deferred.length} remaining leads are outside their local calling hours — waiting`);
              this.onDeferred?.(this.deferred.length);
            }
            await this._sleep(this.idleWaitMs);
            this._recheckDeferred(true);
            continue;
          }
          break;
        }
      }

      // Wait for a free slot — woken the instant a call ends, not on a timer.
      while (this.activeCalls >= this.maxConcurrent && !this.stopped) {
        await this._waitForSlot(1000);
      }
      if (this.stopped) break;

      // Keep the buffer topped up before it runs dry so a refill never sits
      // between "slot free" and "dial".
      if (this.leads.length < 50 && Date.now() - this._lastRefillAt > 15_000) this._refillQueue();

      const lead = this.leads.shift();
      if (!lead) continue;
      if (this.eligible && !this.eligible(lead)) {
        this.deferred.push(lead);
        continue;
      }
      this.activeCalls++;

      this._processCall(lead).finally(() => {
        this.activeCalls--;
        // seenIds tracks leads that are queued or in-flight. Once the call is
        // done (and the lead wasn't re-queued for an immediate retry), release
        // the id so a later refill can pick it up again if it's still callable
        // in the DB (e.g. voicemail / no_answer awaiting another attempt).
        if (lead?.id && !this.leads.some(l => l.id === lead.id)) {
          this.seenIds.delete(lead.id);
        }
        this._notifySlotFreed();
      });

      // Short stagger between dials (see _nextGapMs). Jitter avoids lock-step
      // with the carrier's one-second CPS window.
      if ((this.leads.length > 0 || this.refill) && !this.stopped) {
        await this._sleep(this._nextGapMs());
      }
    }

    while (this.activeCalls > 0 && !this.stopped) {
      await this._waitForSlot(1000);
    }

    if (this.stopped) {
      logger.info(`Call queue stopped by user. ${this.completedCount} calls completed${this.rejected503 ? ` (${this.rejected503} carrier 503s)` : ""}.`);
    } else {
      logger.info(`Call queue complete. ${this.completedCount} calls processed${this.rejected503 ? ` (${this.rejected503} carrier 503s)` : ""}.`);
    }
    return this.results;
  }

  async _processCall(lead) {
    if (this.stopped) {
      this.results.push({ outcome: "skipped" });
      return;
    }
    try {
      logger.info(`Dialing ${lead.first_name || lead.name || "Unknown"} at ${lead.phone}`);
      const result = await this.onCall(lead);
      this._learnPace(result);
      // Keep only the outcome: a full day of dialing used to retain every lead
      // row + result object here (tens of MB) for a single count at the end.
      this.results.push({ outcome: result?.outcome || "unknown" });
      if (result?.outcome !== "skipped") this.completedCount++;
    } catch (err) {
      logger.error(`Call to ${lead.phone} failed: ${err.message}`);
      this.results.push({ outcome: "error", error: err.message });
      this.completedCount++;
    }
  }

  _refillQueue() {
    if (!this.refill || this.stopped) return;
    this._lastRefillAt = Date.now();
    let more = [];
    try {
      more = this.refill() || [];
    } catch (e) {
      logger.error(`Queue refill failed: ${e.message}`);
      return;
    }
    let added = 0;
    for (const lead of more) {
      if (lead?.id && this.seenIds.has(lead.id)) continue;
      if (lead?.id) this.seenIds.add(lead.id);
      this.leads.push(lead);
      added++;
    }
    if (added > 0) logger.info(`Queue refilled: +${added} leads (${this.leads.length} waiting)`);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
