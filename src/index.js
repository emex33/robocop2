import "dotenv/config";
import logger from "./utils/logger.js";
import { SipDialer } from "./sip/dialer.js";
import { CallManager } from "./call/manager.js";
import { CallQueue } from "./leads/loader.js";
import { isLocalCallingHour } from "./call/local-hours.js";
import { attachHourCapDatabase, hourCap, hourCapMessage } from "./call/hour-cap.js";
import { DashboardServer } from "./dashboard/server-new.js";
import { getDb } from "./db/schema.js";
import {
  buildAgentSettingsFromDb,
  getCampaignExtensions,
  getCampaignCallableLeads,
  getCampaignCallableLeadCount,
  recordCall,
  updateLeadStatus,
  markLeadInvalidPhone,
  createAppointment,
  getUserBalance,
  deductCredits,
  getCostRates,
} from "./db/helpers.js";
import { getUserSipSettings, getUserDeepgramKey, getUserDeepgramKeyInfo } from "./api/settings.js";
import { deepgramKeyManager } from "./deepgram/key-manager.js";
import { getSipConfig } from "../config/sip.js";
import { sipAgentManager } from "./sip-agent/manager.js";
import { evaluateBalances, describeBalances, getTrunkState, shouldRetrySipFailure } from "./billing/balance-guard.js";
import { startHeartbeat } from "./utils/heartbeat.js";
import { scheduleNightlyBackup } from "./db/backup.js";
import { scheduleRecordingRetention } from "./services/recording-retention.js";
import { startLoopMonitor, noteActivity } from "./utils/loop-monitor.js";
import { startReadPool } from "./db/read-pool.js";

/**
 * ROBOCOP - AI Robot Caller (Enterprise Edition)
 * 
 * Entry point. Starts dashboard, connects to drachtio, registers SIP,
 * and runs DB-backed campaigns with per-user agents and lists.
 */

let dashboard;
let sipDialer;
let callManager;
const campaignRunners = new Map(); // campaignId -> { queue, running, userId }

const dialTimeoutTracker = {
  timestamps: [],
  isReconnecting: false,
  THRESHOLD: 5,
  WINDOW_MS: 120_000,

  record() {
    const now = Date.now();
    this.timestamps.push(now);
    this.timestamps = this.timestamps.filter(t => now - t < this.WINDOW_MS);
    if (this.timestamps.length >= this.THRESHOLD && !this.isReconnecting) {
      this.triggerReconnect();
    }
  },

  async triggerReconnect() {
    this.isReconnecting = true;
    this.timestamps = [];
    logger.warn(`⚠️ ${this.THRESHOLD}+ dial timeouts in ${this.WINDOW_MS / 1000}s — drachtio may be stuck, reconnecting...`);
    try {
      sipDialer.srf.disconnect();
      await new Promise(r => setTimeout(r, 3000));
      await sipDialer.connect();
      await sipAgentManager.init(sipDialer.srf);
      logger.info("Drachtio reconnected successfully after timeout cascade");
    } catch (err) {
      logger.error(`Drachtio reconnect failed: ${err.message}`);
    }
    this.isReconnecting = false;
  },

  reset() {
    this.timestamps = [];
  }
};

/**
 * Consecutive calls that died because Deepgram could not be reached.
 *
 * The balance guard now refuses to dial while Deepgram is unreachable, but it
 * only re-evaluates once a minute. At full concurrency that is still hundreds of
 * leads answering to silence, so the runner also watches live calls and pauses
 * as soon as a short run of them fails to connect to Deepgram.
 */
const deepgramOutageTracker = {
  consecutive: 0,
  THRESHOLD: 5,

  /** @returns {boolean} true when the run is long enough to stop dialing. */
  record() {
    this.consecutive++;
    return this.consecutive >= this.THRESHOLD;
  },

  reset() {
    this.consecutive = 0;
  },
};

/** A call error that means Deepgram was never reached (vs. answering an error). */
function isDeepgramUnreachableError(notes = "") {
  return /econnrefused|etimedout|ehostunreach|enetunreach|enotfound|eai_again|socket hang up|fetch failed/i
    .test(String(notes));
}

async function main() {
  logger.info("=== ROBOCOP AI Robot Caller v2 ===");
  logger.info("Starting up...");

  // Initialize database
  getDb();
  attachHourCapDatabase(getDb);
  logger.info("Database initialized");
  // Worker threads for heavy dashboard reads, so they never block live-call audio.
  startReadPool();

  // Detect and record how long the process was gone (host reboot / Docker down).
  const offlineGap = startHeartbeat();

  // Log every main-thread stall >250 ms with the request/job that caused it —
  // stalls freeze the RTP send loop of every live call.
  startLoopMonitor();

  // Nightly copy of the (volume-resident) database back to ./data/backups.
  scheduleNightlyBackup();
  // Keep appointment/callback recordings 30 days, conversations 3 days, the rest 2 hours.
  scheduleRecordingRetention();

  // Deepgram key is now per-user (stored in DB). Env var is optional fallback.
  if (!process.env.DEEPGRAM_API_KEY) {
    logger.warn("DEEPGRAM_API_KEY not set in .env — users must configure their key in Settings.");
  }

  // Step 1: Start Dashboard
  dashboard = new DashboardServer(parseInt(process.env.DASHBOARD_PORT || "3000"));
  await dashboard.start();
  logger.info("Dashboard server started");

  // Step 2: Connect to drachtio-server
  sipDialer = new SipDialer();
  try {
    await sipDialer.connect();
    logger.info("Connected to drachtio-server");
    
    // Initialize SIP Agent Manager with the same srf instance
    await sipAgentManager.init(sipDialer.srf);
    logger.info("SIP Agent Manager initialized");
  } catch (err) {
    logger.error(`Failed to connect to drachtio: ${err.message}`);
    logger.error("Make sure drachtio-server is running (docker compose up)");
  }

  // Step 3: Set up call manager (SIP registration happens per-campaign based on user's DB config)
  callManager = new CallManager(sipDialer);

  // Wire up dashboard campaign control callbacks
  dashboard.onStartCampaign = startCampaign;
  dashboard.onStopCampaign = (campaignId, { force = false } = {}) => {
    if (force) {
      forceStopCampaign(campaignId);
    } else {
      softStopCampaign(campaignId);
    }
  };

  // Enforce each campaign's calling window: automatically start campaigns when
  // their window opens and pause them when it closes. Runs every minute, plus
  // once now so any campaign left "running" across a restart is re-evaluated.
  // The same tick enforces provider balances (Deepgram / VoIP).
  setInterval(() => { noteActivity("job: scheduler tick"); tickScheduler().catch(e => logger.error(`Scheduler tick error: ${e.message}`)); }, 60_000);
  tickScheduler().catch(e => logger.error(`Scheduler tick error: ${e.message}`));
  logger.info("Campaign scheduler started (checks calling windows + provider balances every 60s)");

  // Tell the user, in the campaign feed, when the machine itself was down.
  // Delayed so the first scheduler tick has registered the runners (the feed
  // lives on the runner) — otherwise the notice would be dropped.
  if (offlineGap) {
    setTimeout(() => {
      try {
        const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Amsterdam", hour12: false });
        for (const c of getDb().prepare("SELECT id, user_id, name FROM campaigns WHERE status = 'running'").all()) {
          dashboard.pushCampaignLog(c.id, c.user_id, "warn",
            `Robocop was offline ${fmt(offlineGap.from)} → ${fmt(offlineGap.to)} Amsterdam (${offlineGap.minutes} min) — the computer or Docker was down, no calls could be placed. Resumed automatically.`);
        }
      } catch (e) {
        logger.warn(`[heartbeat] could not post offline notice: ${e.message}`);
      }
    }, 30_000).unref();
  }

  logger.info("ROBOCOP ready. Use the dashboard to start calling.");
}

/* ----------------------------------------------------------------------------
 * Campaign scheduling
 *
 * Each campaign carries a calling window (days_of_week + daily_start_time /
 * daily_end_time in a timezone, optionally bounded by start_date / end_date).
 * The engine previously ignored all of this. The helpers below enforce it: a
 * campaign the user marked "running" only dials while inside its window and is
 * automatically paused/resumed as the window closes/opens. Overnight windows
 * (start > end, e.g. 18:00–12:00) are supported for calling other continents.
 * -------------------------------------------------------------------------- */

function parseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || "").trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** True if `now` falls inside the campaign's calling window. */
function isWithinSchedule(campaign, now = new Date()) {
  const tz = campaign.timezone || "Europe/London";
  let parts;
  try {
    parts = getZonedParts(now, tz);
  } catch {
    parts = getZonedParts(now, "UTC");
  }

  let hour = parseInt(parts.hour, 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0;
  const minute = parseInt(parts.minute, 10) || 0;
  const nowMinutes = hour * 60 + minute;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;

  // Optional overall date range (inclusive, YYYY-MM-DD string comparison)
  if (campaign.start_date && dateStr < campaign.start_date) return false;
  if (campaign.end_date && dateStr > campaign.end_date) return false;

  // Days of week (empty list = every day allowed)
  let days = [];
  try { days = JSON.parse(campaign.days_of_week || "[]"); } catch { days = []; }
  if (Array.isArray(days) && days.length > 0 && !days.includes(parts.weekday)) {
    return false;
  }

  // Daily time window. Equal/blank start & end => run 24h.
  const start = parseHM(campaign.daily_start_time);
  const end = parseHM(campaign.daily_end_time);
  if (start === null || end === null || start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // Overnight window (e.g. 18:00–12:00 next day)
  return nowMinutes >= start || nowMinutes < end;
}

/** Human-readable window description for logs. */
function describeWindow(campaign) {
  let days = [];
  try { days = JSON.parse(campaign.days_of_week || "[]"); } catch { days = []; }
  const dayStr = Array.isArray(days) && days.length
    ? days.map(d => d.slice(0, 3)).join("/")
    : "every day";
  return `${campaign.daily_start_time || "00:00"}–${campaign.daily_end_time || "24:00"} ${campaign.timezone || "Europe/London"} (${dayStr})`;
}

/**
 * Pause a running campaign because it fell outside its schedule window.
 * Unlike a user stop this KEEPS status = 'running' (the user's intent), so the
 * scheduler resumes it when the window re-opens. Active calls finish naturally.
 */
function pauseForSchedule(campaignId, runnerArg) {
  // Prefer the caller's runner reference: the registry lookup can miss (e.g.
  // the entry was clobbered), and silently skipping the pause here is what
  // caused campaigns to end up mis-marked as finished at window close.
  const runner = runnerArg || campaignRunners.get(campaignId);
  if (!runner || runner.pausedForSchedule) return;
  runner.pausedForSchedule = true;
  runner.running = false;
  if (runner.queue) {
    runner.queue.leads = [];
    runner.queue.stop();
  }
  dashboard.pushCampaignLog(campaignId, runner.userId, "info",
    "Outside calling hours — pausing. Active calls will finish; will auto-resume at next window.");
  logger.info(`[scheduler] Campaign ${campaignId} paused for schedule`);
}

/**
 * Pause a running campaign because a provider (Deepgram / VoIP) ran out of
 * balance. Like pauseForSchedule this KEEPS status = 'running', so the scheduler
 * resumes dialing automatically once the balance is topped up.
 */
function pauseForBalance(campaignId, reasons) {
  const runner = campaignRunners.get(campaignId);
  if (!runner || runner.pausedForBalance) return;
  runner.pausedForBalance = true;
  runner.running = false;
  if (runner.queue) {
    runner.queue.leads = [];
    runner.queue.stop();
  }
  const trunkHold = reasons.some(r => /SIP 40[18]/.test(r));
  dashboard.pushCampaignLog(campaignId, runner.userId, "error",
    `${trunkHold ? "Trunk is not completing calls" : "Out of balance"} — pausing. ${reasons.join("; ")} Active calls will finish; retrying in a few minutes.`);
  logger.warn(`[balance-guard] Campaign ${campaignId} paused: ${reasons.join("; ")}`);
}

// Throttle the "out of balance" log so it isn't emitted every single minute.
let lastBalanceWarnAt = 0;

// Last completed balance verdict per user, used when a later evaluation cannot
// finish in time. Keeps a known "do not dial" decision in force.
const lastBalanceVerdict = new Map();

/**
 * Runs every minute: starts campaigns whose window just opened and pauses those
 * whose window just closed. Only touches campaigns the user marked 'running'
 * (i.e. actively wants dialing) — manually paused campaigns are left alone.
 *
 * Also enforces provider balances: when Deepgram keys or the VoIP account run
 * dry, running campaigns are paused and no new ones are started until funded.
 */
/** Reject if `promise` outlives `ms`, so one slow dependency can't stall the tick. */
function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function tickScheduler() {
  let campaigns;
  try {
    const db = getDb();
    campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'running'").all();
  } catch (e) {
    logger.error(`Scheduler tick failed: ${e.message}`);
    return;
  }

  // STEP 1 — Enforce calling hours FIRST, with no awaits before it.
  //
  // This used to run after the provider-balance lookup. A single stalled HTTP
  // request to a provider then hung the whole tick, so the window was never
  // enforced and campaigns dialed 24/7. Closing the window must never depend
  // on a third party being reachable.
  const inWindowCampaigns = [];
  for (const c of campaigns) {
    let inWindow;
    try {
      inWindow = isWithinSchedule(c);
    } catch (e) {
      logger.error(`[scheduler] schedule check failed for ${c.id}: ${e.message} — treating as OUT of window`);
      inWindow = false;
    }

    const runner = campaignRunners.get(c.id);
    if (!inWindow) {
      if (runner && !runner.pausedForSchedule) {
        logger.info(`[scheduler] Window closed for "${c.name}" — pausing`);
        pauseForSchedule(c.id);
      }
      continue;
    }
    inWindowCampaigns.push(c);
  }

  if (inWindowCampaigns.length === 0) return;

  // STEP 2 — Provider balances (per user, once per tick). Bounded so a slow
  // provider degrades to "unknown" instead of freezing the scheduler.
  const balanceByUser = new Map();
  for (const userId of new Set(inWindowCampaigns.map(c => c.user_id))) {
    try {
      const verdict = await withDeadline(evaluateBalances(userId), 20_000);
      balanceByUser.set(userId, verdict);
      lastBalanceVerdict.set(userId, verdict);
    } catch (e) {
      logger.warn(`[balance-guard] evaluation failed for user ${userId}: ${e.message}`);
      // Fall back to the last verdict rather than no verdict. An unresolved
      // evaluation used to leave `balance` undefined, which skipped the guard
      // entirely and started dialing — so the one moment a provider was in
      // trouble was the moment protection switched off.
      const previous = lastBalanceVerdict.get(userId);
      if (previous && !previous.ok) {
        logger.warn(`[balance-guard] reusing last verdict for user ${userId}: ${previous.reasons.join("; ")}`);
        balanceByUser.set(userId, previous);
      }
    }
  }

  for (const c of inWindowCampaigns) {
    const balance = balanceByUser.get(c.user_id);

    if (balance && !balance.ok) {
      const runner = campaignRunners.get(c.id);
      if (runner && !runner.pausedForBalance) {
        pauseForBalance(c.id, balance.reasons);
      } else if (!runner && Date.now() - lastBalanceWarnAt > 5 * 60 * 1000) {
        lastBalanceWarnAt = Date.now();
        logger.warn(`[balance-guard] Holding "${c.name}" — ${balance.reasons.join("; ")}`);
        // Surface it in the dashboard too. Otherwise the campaign just sits there
        // looking "running" with no calls and no visible explanation.
        dashboard.pushCampaignLog(c.id, c.user_id, "warn",
          `Dialing on hold — ${balance.reasons.join("; ")}`);
      }
      continue; // never start or resume dialing while out of balance
    }

    if (!campaignRunners.get(c.id)) {
      logger.info(`[scheduler] Window open for "${c.name}" — starting`);
      Promise.resolve(startCampaign(c.id, c.user_id)).catch(err =>
        logger.error(`[scheduler] Failed to start ${c.id}: ${err.message}`));
    }
  }
}

/**
 * Start a campaign - loads leads from DB, calls them sequentially.
 */
async function startCampaign(campaignId, userId) {
  if (campaignRunners.has(campaignId)) return;

  // Register the runner BEFORE any awaits. Registering it only after the SIP /
  // balance checks left a multi-second window where a second start could slip
  // past the guard above; the duplicate runners then clobbered each other's
  // registry entry, schedule pauses were lost, and a window close mis-marked
  // the campaign as finished (status 'paused').
  const runner = { running: true, userId, logs: [], activeCalls: [], activeAbortHandles: new Map(), completedCalls: 0, totalLeads: 0 };
  campaignRunners.set(campaignId, runner);
  dashboard.campaignRunners.set(campaignId, runner);
  try {
    await runCampaign(campaignId, userId, runner);
  } finally {
    // Only remove our own registration — never another runner's.
    if (campaignRunners.get(campaignId) === runner) campaignRunners.delete(campaignId);
    if (dashboard.campaignRunners.get(campaignId) === runner) dashboard.campaignRunners.delete(campaignId);
  }
}

async function runCampaign(campaignId, userId, runner) {
  const db = getDb();
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) {
    logger.error(`Campaign ${campaignId} not found`);
    return;
  }

  // Respect the calling window. If we're outside it, stay "running" (the user's
  // intent) but don't dial — the scheduler starts us the moment it opens.
  if (!isWithinSchedule(campaign)) {
    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Outside calling hours ${describeWindow(campaign)}. Waiting — will auto-start when the window opens.`);
    logger.info(`Campaign ${campaignId} start deferred (outside window ${describeWindow(campaign)})`);
    return;
  }

  const agent = campaign.agent_id
    ? db.prepare("SELECT * FROM agents WHERE id = ?").get(campaign.agent_id)
    : null;

  if (!agent) {
    logger.warn(`Campaign ${campaignId} has no agent assigned`);
    dashboard.pushCampaignLog(campaignId, userId, "warn", "No agent assigned to this campaign");
    return;
  }

  if (!sipDialer?.isConnected) {
    try {
      await sipDialer.connect();
      await sipAgentManager.init(sipDialer.srf);
      logger.info("Connected to drachtio-server (on campaign start)");
    } catch (err) {
      dashboard.pushCampaignLog(campaignId, userId, "error",
        `Cannot start — SIP server not connected: ${err.message}`);
      logger.error(`Campaign ${campaignId} blocked: SIP not connected (${err.message})`);
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
      return;
    }
  }

  // Check credit balance before starting
  const balance = getUserBalance(userId);
  if (balance <= 0) {
    dashboard.pushCampaignLog(campaignId, userId, "error", `Insufficient credits ($${balance.toFixed(2)}). Add credits to start calling.`);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }

  // Check upstream provider balances (Deepgram keys / VoIP). Stay 'running' so the
  // scheduler resumes automatically once the accounts are topped up.
  try {
    const providers = await evaluateBalances(userId);
    if (!providers.ok) {
      dashboard.pushCampaignLog(campaignId, userId, "error",
        `Cannot start — out of balance. ${providers.reasons.join("; ")}. Will auto-start once topped up.`);
      logger.warn(`Campaign ${campaignId} start blocked: ${providers.reasons.join("; ")}`);
      return;
    }
    logger.info(`[balance-guard] ${describeBalances(providers)}`);
  } catch (e) {
    logger.warn(`[balance-guard] check skipped (${e.message}) — proceeding`);
  }

  const QUEUE_BATCH = 4000;
  const callableTotal = getCampaignCallableLeadCount(campaignId);
  const leads = getCampaignCallableLeads(campaignId, QUEUE_BATCH);
  if (leads.length === 0) {
    dashboard.pushCampaignLog(campaignId, userId, "warn", "No callable leads in this campaign");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }
  logger.info(`Loaded ${leads.length} leads to start (callable pool: ${callableTotal})`);

  const extensions = getCampaignExtensions(campaignId);
  const maxConcurrent = campaign.max_concurrent_calls || 1;
  const delayMs = parseInt(process.env.CALL_DELAY_MS || "5000");

  // Load SIP settings: campaign-specific trunk, or user's default
  const trunkId = campaign.sip_settings_id || null;
  const dbSipSettings = getUserSipSettings(userId, trunkId);
  if (!dbSipSettings) {
    logger.error(`No SIP settings found for user ${userId}. Configure SIP in dashboard Settings.`);
    dashboard.pushCampaignLog(campaignId, userId, "error", "No SIP settings configured. Go to Settings to configure SIP.");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }
  const sipConfig = getSipConfig(dbSipSettings);
  logger.info(`Campaign SIP trunk: "${dbSipSettings.name}" (${dbSipSettings.id}) mode=${sipConfig.mode}, trunkHost=${sipConfig.trunkHost}, server=${sipConfig.server}`);

  // Load per-user Deepgram API key (pool → legacy single → env var)
  let deepgramKeyInfo = getUserDeepgramKeyInfo(userId);
  if (!deepgramKeyInfo) {
    logger.error(`No Deepgram API key for user ${userId}. Configure in Settings.`);
    dashboard.pushCampaignLog(campaignId, userId, "error", "No Deepgram API key configured. Go to Settings to set your API key.");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }
  logger.info(`Using Deepgram key: "${deepgramKeyInfo.label}" (source: ${deepgramKeyInfo.source})`);

  // Register with SIP provider if account mode (trunk mode skips registration)
  if (sipConfig.mode === "account") {
    try {
      await sipDialer.register(sipConfig);
      logger.info(`SIP registered for campaign (account mode, ${sipConfig.server})`);
    } catch (err) {
      logger.error(`SIP registration failed: ${err.message}`);
      dashboard.pushCampaignLog(campaignId, userId, "error", `SIP registration failed: ${err.message}`);
    }
  }

  runner.totalLeads = callableTotal;

  // Live "remaining" figure for the dashboard: the real callable count from the
  // DB (refreshed at most every 30s), not the size of the in-memory dial buffer.
  let remainingCache = { value: callableTotal, ts: Date.now() };
  const getRemainingLeads = () => {
    if (Date.now() - remainingCache.ts > 30_000) {
      try { remainingCache = { value: getCampaignCallableLeadCount(campaignId), ts: Date.now() }; } catch {}
    }
    return remainingCache.value;
  };
  runner.getRemainingLeads = getRemainingLeads;

  dashboard.pushCampaignLog(campaignId, userId, "info",
    `Campaign "${campaign.name}" started: ${callableTotal} callable leads, ${extensions.length} extensions — window ${describeWindow(campaign)}`);

  // Build lead queue
  const queue = new CallQueue(leads, maxConcurrent, delayMs);
  queue.refill = () => getCampaignCallableLeads(campaignId, QUEUE_BATCH);
  // Consumer-local calling hours (CRTC: weekdays 09:00–21:30 in the lead's own
  // zone). Western leads wait for their morning instead of being rung at 06:00.
  queue.eligible = (lead) => isLocalCallingHour(lead.phone) && hourCap.peek(lead.phone, userId).ok;
  queue.onDeferred = (n) => dashboard.pushCampaignLog(campaignId, userId, "info",
    `${n} leads are waiting — local calling hours or the 5-calls-per-hour cap. Dialing resumes automatically`);
  runner.queue = queue;

  const results = await queue.start(async (lead) => {
    if (!runner.running || !lead) return { outcome: "skipped" };

    // Hard stop at the calling window, checked per call. The scheduler also
    // enforces this, but relying on it alone means any stall in that loop lets
    // the dialer run through the night. Never dial outside the user's hours.
    if (!isWithinSchedule(campaign)) {
      if (!runner.pausedForSchedule) {
        logger.info(`[scheduler] Window closed mid-run for "${campaign.name}" — stopping dialer`);
        pauseForSchedule(campaignId, runner);
      }
      return { outcome: "skipped" };
    }

    // Per-call credit check
    const currentBalance = getUserBalance(userId);
    if (currentBalance <= 0) {
      dashboard.pushCampaignLog(campaignId, userId, "error", "Credits depleted — stopping campaign.");
      runner.running = false;
      if (runner.queue) { runner.queue.leads = []; runner.queue.stop(); }
      return { outcome: "skipped" };
    }

    const rawName = lead.first_name || lead.name || "Unknown";
    const displayName = rawName.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());

    // Never send garbage to the trunk. Some imported lists carry an e-mail
    // address (or nothing) in the phone column; the carrier answers those with
    // "503 (DNS Error)", which looked exactly like its capacity 503s and — as
    // an "infrastructure" error — would have been retried forever.
    const digits = String(lead.phone || "").replace(/\D/g, "");
    if (/[@a-z]/i.test(String(lead.phone || "")) || digits.length < 10 || digits.length > 15) {
      try { markLeadInvalidPhone(lead.id, lead.phone); } catch {}
      dashboard.pushCampaignLog(campaignId, userId, "warn", `Skipped ${displayName}: "${lead.phone}" is not a phone number — lead retired`);
      return { outcome: "skipped" };
    }

    const hourSlot = hourCap.claim(lead.phone, userId);
    if (!hourSlot.ok) {
      const message = hourCapMessage(lead.phone, hourSlot.count);
      if (hourCap.shouldLogBlock(lead.phone)) {
        dashboard.pushCampaignLog(campaignId, userId, "warn", `${displayName}: ${message}`);
        dashboard.broadcastToUser(userId, "live_event", {
          campaignId,
          type: "blocked",
          phone: lead.phone,
          name: displayName,
          count: hourSlot.count,
          max: hourSlot.max,
          message,
          time: new Date().toISOString(),
        });
      }
      logger.warn(`[hour-cap] ${displayName} (${lead.phone}) — ${message}`);
      return { outcome: "skipped" };
    }

    dashboard.pushCampaignLog(campaignId, userId, "info", `Dialing ${displayName} (${lead.phone})`);
    try {

    // Pick the current healthy key at call start (local DB read — no Deepgram HTTP, no delay).
    // If the pool retired a low-balance key since the last call, this is already the replacement.
    const liveKey = getUserDeepgramKeyInfo(userId);
    if (!liveKey) {
      dashboard.pushCampaignLog(campaignId, userId, "error", "All Deepgram API keys depleted! Add more keys in Settings.");
      runner.running = false;
      if (runner.queue) { runner.queue.leads = []; runner.queue.stop(); }
      return { outcome: "skipped" };
    }
    if (!deepgramKeyInfo || liveKey.id !== deepgramKeyInfo.id) {
      if (deepgramKeyInfo) {
        dashboard.pushCampaignLog(campaignId, userId, "info", `Switched Deepgram key to "${liveKey.label}" — campaign continues.`);
      }
      deepgramKeyInfo = liveKey;
    }
    const deepgramApiKey = liveKey.key;

    // Track active call
    const activeCall = { leadId: lead.id, phone: lead.phone, name: displayName, startedAt: new Date().toISOString(), status: "dialing" };
    runner.activeCalls.push(activeCall);
    dashboard.broadcastToUser(userId, "call_started", { campaignId, call: activeCall, activeCalls: runner.activeCalls.length, remainingLeads: getRemainingLeads() });

    // Build agent settings interpolated with this lead's data
    const leadData = { ...lead, ...JSON.parse(lead.extra_json || "{}") };
    const agentSettings = buildAgentSettingsFromDb(agent, leadData);

    const startedAt = new Date().toISOString();
    let result;
    let appointmentAlreadySaved = false;
    
    try {
      result = await callManager.callLead(leadData, { 
        agentSettings, 
        responseDelayMs: agent.response_delay_ms ?? 600,
        transferExtensions: extensions, 
        sipConfig,
        deepgramApiKey,
        onCallAbortHandle: (handle) => {
          runner.activeAbortHandles.set(handle.callId, handle);
        },
        onLiveEvent: (type, data) => {
          // Keep the Command Center's live-call row honest: what stage is this call in?
          try {
            if (type === "sip_connected") activeCall.status = "connected";
            else if (type === "deepgram" && data.status === "connected") activeCall.status = "talking";
            else if (type === "transcript") {
              activeCall.status = "talking";
              activeCall.turns = (activeCall.turns || 0) + 1;
              activeCall.lastRole = data.role;
              activeCall.lastText = String(data.text || "").slice(0, 140);
            }
            else if (type === "voicemail_detected") activeCall.status = "voicemail";
            else if (type === "function_call" && data.function === "book_appointment") activeCall.status = "booking";
            else if (type === "appointment_saved") activeCall.status = "booked";
            else if (type === "function_call" && data.function === "transfer_call") activeCall.status = "transfer";
            else if (type === "function_call" && data.function === "end_call") activeCall.status = `ending:${data.outcome || ""}`;
          } catch {}
          dashboard.broadcastToUser(userId, "live_event", { 
            campaignId, 
            type, 
            ...data,
            time: new Date().toISOString() 
          });
        },
        // Update lead name/info when AI captures it mid-call (cold list)
        onLeadInfoUpdated: ({ leadId, firstName, lastName, email }) => {
          try {
            const db = getDb();
            const updates = [];
            const vals = [];
            if (firstName) { updates.push("first_name = ?"); vals.push(firstName); }
            if (lastName) { updates.push("last_name = ?"); vals.push(lastName); }
            if (email) { updates.push("email = ?"); vals.push(email); }
            if (updates.length > 0) {
              vals.push(leadId);
              db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
              const fullName = [firstName, lastName].filter(Boolean).join(" ");
              logger.info(`Lead ${leadId} updated mid-call: ${fullName}${email ? ` (${email})` : ""}`);
            }
          } catch (e) {
            logger.error(`Failed to update lead info: ${e.message}`);
          }
        },
        // CRITICAL: Save appointment IMMEDIATELY when AI books it (don't wait for call end)
        onAppointmentBooked: async (apptData) => {
          try {
            const apptId = createAppointment({
              user_id: userId,
              campaign_id: campaignId,
              lead_id: lead.id,
              call_id: apptData.callId || "",
              lead_name: apptData.leadName,
              phone: apptData.phone,
              email: apptData.email || "",
              appointment_date: apptData.date,
              appointment_time: apptData.time,
              notes: apptData.notes || "",
            });
            appointmentAlreadySaved = true;
            logger.info(`Appointment created IMMEDIATELY: ${apptId} for ${apptData.leadName} on ${apptData.date} ${apptData.time}`);
            dashboard.broadcastToUser(userId, "appointment_created", { 
              appointmentId: apptId, 
              leadName: apptData.leadName, 
              date: apptData.date, 
              time: apptData.time 
            });
          } catch (e) {
            logger.error(`Failed to create appointment immediately: ${e.message}`);
          }
        }
      });
    } catch (err) {
      result = { outcome: "error", notes: err.message, transcript: [] };
    }
    const endedAt = new Date().toISOString();

    // 402/401 detection — auto-rotate Deepgram key if needed
    if (result.outcome === "error" && deepgramKeyInfo.id) {
      const errMsg = (result.notes || "").toLowerCase();
      if (errMsg.includes("bandwidth limit") || errMsg.includes("using the proxy")) {
        pauseForBalance(campaignId, ["Webshare proxy is out of bandwidth. The Deepgram key was not rejected."]);
      } else if (errMsg.includes("402") || errMsg.includes("payment required") || errMsg.includes("insufficient")) {
        const rotated = deepgramKeyManager.report402(userId, deepgramKeyInfo.id);
        if (rotated?.rotated) {
          deepgramKeyInfo = rotated;
          deepgramApiKey = rotated.key;
          dashboard.pushCampaignLog(campaignId, userId, "warn", `Deepgram key hit low balance. Auto-switched to "${rotated.label}" — campaign continues.`);
        } else if (!rotated) {
          // No funded key left. Pausing keeps the remaining leads intact; the
          // guard reactivates a key and resumes as soon as one is topped up.
          pauseForBalance(campaignId, ["All Deepgram API keys are out of balance — add credit or add a key"]);
        }
      } else if ((errMsg.includes("deepgram 401") || errMsg.includes("invalid_auth") || errMsg.includes("deactivated")) && !errMsg.includes("sip")) {
        const rotated = deepgramKeyManager.report401(userId, deepgramKeyInfo.id);
        if (rotated?.rotated) {
          deepgramKeyInfo = rotated;
          deepgramApiKey = rotated.key;
          dashboard.pushCampaignLog(campaignId, userId, "warn", `Deepgram key invalid (401). Auto-switched to "${rotated.label}".`);
        } else if (!rotated) {
          pauseForBalance(campaignId, ["All Deepgram API keys are invalid — add a working key"]);
        }
      }
    }

    // Deepgram unreachable: rotating keys cannot help, and every further dial
    // connects a real lead to silence. Stop after a short run.
    if (result.outcome === "error" && isDeepgramUnreachableError(result.notes)) {
      if (deepgramOutageTracker.record()) {
        pauseForBalance(campaignId, [
          `Deepgram unreachable (${result.notes}) — calls would connect to silence; retrying every minute`,
        ]);
      }
    } else if (result.outcome !== "error") {
      deepgramOutageTracker.reset();
    }
    // Report success to reset error counter
    if (result.outcome !== "error" && deepgramKeyInfo.id) {
      deepgramKeyManager.reportSuccess(userId, deepgramKeyInfo.id);
      dialTimeoutTracker.reset();
    }

    // Remove from active calls and abort handles
    runner.activeCalls = runner.activeCalls.filter(c => c.leadId !== lead.id);
    if (result?.callId) runner.activeAbortHandles.delete(result.callId);
    runner.completedCalls++;
    dashboard.broadcastToUser(userId, "call_ended", { campaignId, leadId: lead.id, phone: lead.phone, name: displayName, outcome: result.outcome, duration: Math.round((new Date(endedAt) - new Date(startedAt)) / 1000), activeCalls: runner.activeCalls.length, completedCalls: runner.completedCalls, remainingLeads: getRemainingLeads() });

    // Calculate duration
    const durationMs = new Date(endedAt) - new Date(startedAt);
    const durationSeconds = Math.round(durationMs / 1000);

    // Calculate costs from connected time only. Calls the carrier rejected (486/503/404)
    // never answered, so no VoIP minutes and no AI ran — those must cost nothing.
    const aiDurationSec = result.aiDurationSeconds || 0;
    const rates = getCostRates();
    let billableSeconds = 0;
    if (result.answeredAt) {
      billableSeconds = Math.max(0, Math.round((new Date(endedAt) - new Date(result.answeredAt)) / 1000));
    }
    const voipCost = (billableSeconds / 60) * rates.voipCostPerMin;
    const aiCost = (billableSeconds / 60) * rates.aiCostPerMin;
    const callCost = voipCost + aiCost;

    // Record in DB
    let callRecordId;
    try {
      callRecordId = recordCall({
        campaign_id: campaignId,
        agent_id: agent.id,
        lead_id: lead.id,
        user_id: userId,
        call_id: result.callId || "unknown",
        phone: lead.phone,
        lead_name: displayName,
        outcome: result.outcome,
        duration_seconds: durationSeconds,
        notes: result.notes || "",
        client_wants: result.clientWants || "",
        requested_callback: result.requestedCallback || "",
        transcript: result.transcript || [],
        transferred_to: result.outcome === "transferred" ? (result.transferredTo || extensions[0] || "") : "",
        error_message: result.outcome === "error" ? (result.notes || "") : "",
        started_at: startedAt,
        ended_at: endedAt,
        recording_path: result.recordingPath || "",
        ai_duration_seconds: aiDurationSec,
        call_cost: callCost,
        voip_cost: voipCost,
        ai_cost: aiCost,
      });
    } catch (e) {
      logger.error(`Failed to record call: ${e.message}`);
    }
    hourCap.release(lead.phone, hourSlot.token);
    hourSlot.token = 0;

    // Fire-and-forget: push transfer to Google Sheets
    if (result.outcome === "transferred" && callRecordId) {
      setTimeout(() => {
        import("./services/google-sheets.js").then(({ pushTransferToSheet }) => {
          pushTransferToSheet({
            id: callRecordId,
            campaign_id: campaignId,
            user_id: userId,
            lead_id: lead.id,
            lead_name: displayName,
            phone: lead.phone,
            email: lead.email || "",
            call_id: result.callId || "",
            transferred_to: result.transferredTo || "",
            notes: result.notes || "",
            status: "transferred",
            duration_seconds: durationSeconds,
            transferred_at: endedAt,
          }).catch(err => {
            logger.error(`Google Sheets transfer push failed: ${err.message}`);
          });
        }).catch(() => {});
      }, 2000);
    }

    // Fire-and-forget: upload recording to Google Drive (waits for ffmpeg to finish)
    if (callRecordId && result.recordingPath) {
      setTimeout(() => {
        import("./services/google-drive.js").then(({ uploadAndLinkRecording }) => {
          uploadAndLinkRecording(callRecordId).catch(err => {
            logger.error(`Drive upload failed: ${err.message}`);
          });
        }).catch(() => {});
      }, 5000);
    }

    // Deduct credits
    if (callCost > 0) {
      try {
        const newBalance = deductCredits(userId, callCost, `Call to ${displayName} (${lead.phone}) - ${billableSeconds}s connected`, result.callId || "");
        logger.info(`Credits deducted: $${callCost.toFixed(4)} (VoIP: $${voipCost.toFixed(4)}, AI: $${aiCost.toFixed(4)}). Balance: $${newBalance.toFixed(2)}`);
      } catch (e) {
        logger.error(`Failed to deduct credits: ${e.message}`);
      }
    }

    // Update lead status based on call outcome
    try {
      updateLeadStatus(lead.id, result.outcome, result.outcome === "error" ? (result.notes || "") : "");
    } catch (e) {
      logger.error(`Failed to update lead status: ${e.message}`);
    }

    // Auto-retry: if SIP error is retryable (busy/unavailable/service down),
    // put the lead back at the end of the queue for one more attempt
    const RETRYABLE_SIP = ["486", "480", "503", "408"];
    const retryMax = 2;
    if (result.outcome === "error" && runner.running) {
      const errNotes = result.notes || "";
      const sipMatch = errNotes.match(/(\d{3})/);
      const sipCode = sipMatch ? sipMatch[1] : null;
      const isDialTimeout = errNotes.includes("Dial timeout");
      if (isDialTimeout) dialTimeoutTracker.record();
      if ((sipCode && RETRYABLE_SIP.includes(sipCode)) || isDialTimeout) {
        const reason = isDialTimeout ? "Dial timeout" : `SIP ${sipCode}`;
        if (sipCode && !shouldRetrySipFailure(sipCode)) {
          logger.info(`[${result.callId}] ${reason} — not retrying ${displayName} (${lead.phone}); trunk is failing every call`);
        } else if (!hourCap.peek(lead.phone, userId).ok) {
          logger.info(`[${result.callId}] ${reason} — not retrying ${displayName} (${lead.phone}); hourly cap of 5 calls reached`);
        } else {
          lead._retryCount = (lead._retryCount || 0) + 1;
          if (lead._retryCount <= retryMax) {
            logger.info(`[${result.callId}] ${reason} — queueing retry ${lead._retryCount}/${retryMax} for ${displayName} (${lead.phone})`);
            queue.leads.push(lead);
          } else {
            logger.info(`[${result.callId}] ${reason} — max retries reached for ${displayName} (${lead.phone})`);
          }
        }
      }
    }

    const trunkNow = getTrunkState();
    if (!trunkNow.ok && runner.running) {
      pauseForBalance(campaignId, [trunkNow.reason || "Trunk is not completing calls"]);
    }

    // Save appointment if one was booked (fallback - only if not already saved immediately)
    if (!appointmentAlreadySaved && result.outcome === "appointment_set" && result.appointmentDate && result.appointmentTime) {
      try {
        const apptId = createAppointment({
          user_id: userId,
          campaign_id: campaignId,
          lead_id: lead.id,
          call_id: result.callId || "",
          lead_name: displayName,
          phone: lead.phone,
          email: lead.email || "",
          appointment_date: result.appointmentDate,
          appointment_time: result.appointmentTime,
          notes: result.notes || "",
        });
        logger.info(`Appointment created (fallback): ${apptId} for ${displayName} on ${result.appointmentDate} ${result.appointmentTime}`);
        dashboard.broadcastToUser(userId, "appointment_created", { 
          appointmentId: apptId, 
          leadName: displayName, 
          date: result.appointmentDate, 
          time: result.appointmentTime 
        });
      } catch (e) {
        logger.error(`Failed to create appointment: ${e.message}`);
      }
    }

    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Call to ${displayName}: ${result.outcome} (${durationSeconds}s)`);

    // Push real-time update to user
    dashboard.broadcastToUser(userId, "call_result", {
      campaignId,
      phone: lead.phone,
      leadName: displayName,
      outcome: result.outcome,
      duration: durationSeconds,
    });

    return result;
    } finally {
      hourCap.release(lead.phone, hourSlot.token);
    }
  });

  // Campaign loop ended. If the schedule window closed we auto-paused, so keep
  // status = 'running' (the scheduler will resume it next window). Otherwise the
  // campaign genuinely finished (leads exhausted) or was stopped by the user —
  // mark it 'paused'.
  const wasSchedulePause = runner.pausedForSchedule === true;
  const wasBalancePause = runner.pausedForBalance === true;
  const wasShutdownPause = runner.pausedForShutdown === true;
  // Registry cleanup happens in startCampaign's finally (guarded so it can
  // never remove another runner's entry).

  const completed = results.filter(r => r && r.outcome !== "skipped").length;

  if (wasShutdownPause) {
    // App restart — not a user stop and not "finished". Keep status = 'running'
    // so the scheduler resumes dialing right after the next boot.
    db.prepare("UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(campaignId);
  } else if (wasBalancePause) {
    db.prepare("UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(campaignId);
    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Out of balance — paused after ${completed} calls this session. Will retry automatically every few minutes.`);
  } else if (wasSchedulePause) {
    db.prepare("UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(campaignId);
    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Outside calling hours — paused after ${completed} calls this session. Will auto-resume at next window (${describeWindow(campaign)}).`);
  } else {
    db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
      .run(campaignId);
    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Campaign "${campaign.name}" finished: ${completed} calls completed`);
    dashboard.broadcastToUser(userId, "campaign_finished", { campaignId });
  }
}

/**
 * Soft stop — stops dialing new leads but lets active calls finish naturally.
 */
function softStopCampaign(campaignId) {
  const runner = campaignRunners.get(campaignId);
  if (runner) {
    const activeCount = runner.activeCalls?.length || 0;
    logger.info(`Soft-stopping campaign ${campaignId}: ${activeCount} active calls will finish naturally`);
    
    runner.running = false;
    
    if (runner.queue) {
      runner.queue.leads = [];
      runner.queue.stop();
    }
    
    const msg = activeCount > 0
      ? `Campaign stopped — ${activeCount} active call(s) will finish naturally`
      : "Campaign stopped";
    dashboard.pushCampaignLog(campaignId, runner.userId, "info", msg);
  }

  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
  
  logger.info(`Campaign ${campaignId} soft-stopped`);
}

/**
 * Force stop — kills all active SIP + Deepgram connections immediately.
 */
function forceStopCampaign(campaignId) {
  const runner = campaignRunners.get(campaignId);
  if (runner) {
    logger.info(`FORCE stopping campaign ${campaignId}: ${runner.activeCalls?.length || 0} active calls, ${runner.activeAbortHandles?.size || 0} abort handles`);
    
    runner.running = false;
    
    if (runner.queue) {
      runner.queue.leads = [];
      runner.queue.stop();
    }
    
    if (runner.activeAbortHandles && runner.activeAbortHandles.size > 0) {
      logger.info(`Force-killing ${runner.activeAbortHandles.size} active calls`);
      for (const [callId, handle] of runner.activeAbortHandles) {
        try {
          handle.abort();
          logger.info(`Aborted call ${callId}`);
        } catch (e) {
          logger.error(`Failed to abort call ${callId}: ${e.message}`);
        }
      }
      runner.activeAbortHandles.clear();
    }
    
    runner.activeCalls = [];
    
    dashboard.pushCampaignLog(campaignId, runner.userId, "info", "Campaign FORCE stopped — all active calls killed");
    campaignRunners.delete(campaignId);
    dashboard.campaignRunners.delete(campaignId);
    
    dashboard.broadcastToUser(runner.userId, "campaign_finished", { campaignId });
  }

  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
  
  logger.info(`Campaign ${campaignId} force-stopped and set to paused`);
}

/**
 * Graceful shutdown.
 *
 * Every live call MUST be hung up (BYE) before we exit. Exiting without it leaves
 * the carrier holding those channels open until its own session timers expire, and
 * while they're held the trunk rejects new calls with 486/503 — so an abrupt
 * restart mid-campaign takes dialing down for as long as half an hour afterwards.
 */
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);

  let hungUp = 0;
  for (const [campaignId, runner] of campaignRunners) {
    // A restart is not a user stop: flag it so the campaign-finished handler
    // keeps status = 'running' and the scheduler auto-resumes on next boot.
    runner.pausedForShutdown = true;
    runner.running = false;
    if (runner.queue) {
      runner.queue.leads = [];
      runner.queue.stop();
    }
    if (runner.activeAbortHandles && runner.activeAbortHandles.size > 0) {
      logger.info(`Hanging up ${runner.activeAbortHandles.size} active call(s) for campaign ${campaignId}`);
      for (const [callId, handle] of runner.activeAbortHandles) {
        try {
          handle.abort();
          hungUp++;
        } catch (e) {
          logger.error(`Failed to hang up ${callId} during shutdown: ${e.message}`);
        }
      }
      runner.activeAbortHandles.clear();
    }
  }

  // Let the BYEs reach the carrier before the socket dies. Docker allows 10s
  // before SIGKILL, so stay well inside that budget.
  if (hungUp > 0) {
    logger.info(`Released ${hungUp} channel(s) — waiting 4s for BYEs to flush`);
    await new Promise(r => setTimeout(r, 4000));
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(err => {
    logger.error(`Shutdown error: ${err.message}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(err => {
    logger.error(`Shutdown error: ${err.message}`);
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception (kept alive): ${err.message}\n${err.stack}`);
});

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
