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
  }

  /**
   * Stop the queue immediately - no more calls will be started.
   */
  stop() {
    this.stopped = true;
    this.leads = []; // Clear remaining leads
    logger.info(`Call queue stopped. ${this.activeCalls} calls still active.`);
  }

  async start(onCall) {
    this.onCall = onCall;
    this.stopped = false;
    logger.info(`Starting call queue: ${this.leads.length} leads, max ${this.maxConcurrent} concurrent, delay ${this.delayMs}ms between dials`);

    while (!this.stopped) {
      if (this.leads.length === 0) {
        this._refillQueue();
        if (this.leads.length === 0) break;
      }

      // Wait for a free slot
      while (this.activeCalls >= this.maxConcurrent && !this.stopped) {
        await this._sleep(500);
      }
      if (this.stopped) break;

      const lead = this.leads.shift();
      if (!lead) break;
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
      });

      // Small stagger between dials to avoid SIP bursts, but keep pipeline full
      const stagger = Math.min(this.delayMs, 800);
      if ((this.leads.length > 0 || this.refill) && !this.stopped) {
        await this._sleep(stagger);
      }
    }

    while (this.activeCalls > 0 && !this.stopped) {
      await this._sleep(1000);
    }

    if (this.stopped) {
      logger.info(`Call queue stopped by user. ${this.results.length} calls completed.`);
    } else {
      logger.info(`Call queue complete. ${this.results.length} calls processed.`);
    }
    return this.results;
  }

  async _processCall(lead) {
    if (this.stopped) {
      this.results.push({ lead, result: { outcome: "skipped" }, status: "skipped" });
      return;
    }
    try {
      logger.info(`Dialing ${lead.first_name || lead.name || "Unknown"} at ${lead.phone}`);
      const result = await this.onCall(lead);
      this.results.push({ lead, result, status: "completed" });
    } catch (err) {
      logger.error(`Call to ${lead.phone} failed: ${err.message}`);
      this.results.push({ lead, error: err.message, status: "failed" });
    }
  }

  _refillQueue() {
    if (!this.refill || this.stopped) return;
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
