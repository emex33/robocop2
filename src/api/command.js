/**
 * Command Center API
 *
 * Operations-grade metrics for the dialing floor: funnel, unit economics,
 * time-of-day performance, carrier health, and provider state, plus a light
 * live feed for the ticker.
 *
 * Performance model
 * -----------------
 * call_records has >1.3 M rows on a slow bind-mounted disk, so a 30-day view
 * cannot re-scan raw rows on every request (measured: 97 s). Past UTC days are
 * immutable, so they are rolled up ONCE into `cr_rollup_hourly` — one row per
 * (user, day, hour, campaign, agent, region), a few hundred rows a day — and
 * only the current day is aggregated live. Every view is then assembled in JS
 * from those "cells". Warm-up runs in the background one day at a time so the
 * event loop stays responsive; until it finishes the response says so.
 *
 * Time handling: started_at is ISO-8601 UTC. Buckets are grouped in UTC and
 * shifted to the house zone (Europe/Amsterdam) in JS with the current offset.
 * Across a DST change the shift is one hour off for the older part of a window.
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";
import { getUserBalance, getCampaignCallableLeadCount } from "../db/helpers.js";
import { evaluateBalances, getTrunkState } from "../billing/balance-guard.js";
import { getLastOfflineGap } from "../utils/heartbeat.js";
import logger from "../utils/logger.js";

const router = Router();

const HOUSE_TZ = "Europe/Amsterdam";
const MARKET_TZ = "America/Toronto";
const lastGuard = new Map(); // userId -> last completed provider verdict

// Outcomes that mean a human (not a machine) was on the line.
const HUMAN_OUTCOMES = [
  "lead_hangup", "not_interested", "wrong_number", "callback", "not_qualified",
  "appointment_set", "transferred", "interested", "do_not_call", "timeout", "unknown",
];
const POSITIVE_OUTCOMES = ["appointment_set", "transferred", "callback", "interested"];
const ENGAGED_SECONDS = 20; // a human call shorter than this never got past the opener

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------
const cache = new Map();
const TTL_MS = 20_000;

function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.value;
  const value = compute();
  cache.set(key, { ts: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// time helpers
// ---------------------------------------------------------------------------
function tzOffsetMinutes(tz, at = new Date()) {
  const local = new Date(at.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local - utc) / 60000);
}

/** Start of the current day in `tz`, as a UTC ISO string. */
function startOfDayIso(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  const midnightLocalAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  return new Date(midnightLocalAsUtc - tzOffsetMinutes(tz, now) * 60000).toISOString();
}

const utcDay = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(new Date(Date.parse(day + "T00:00:00Z") + n * 864e5));

// ---------------------------------------------------------------------------
// Canadian area codes → province, for the region table
// ---------------------------------------------------------------------------
const AREA = {
  "416": "ON", "647": "ON", "437": "ON", "905": "ON", "289": "ON", "365": "ON", "742": "ON",
  "613": "ON", "343": "ON", "519": "ON", "226": "ON", "548": "ON", "705": "ON", "249": "ON",
  "807": "ON", "683": "ON", "753": "ON", "382": "ON",
  "514": "QC", "438": "QC", "263": "QC", "450": "QC", "579": "QC", "354": "QC",
  "819": "QC", "873": "QC", "418": "QC", "581": "QC", "367": "QC", "468": "QC",
  "604": "BC", "778": "BC", "236": "BC", "672": "BC", "250": "BC",
  "403": "AB", "587": "AB", "825": "AB", "780": "AB", "368": "AB",
  "204": "MB", "431": "MB", "584": "MB", "306": "SK", "639": "SK", "474": "SK",
  "902": "NS/PE", "782": "NS/PE", "506": "NB", "428": "NB", "709": "NL", "879": "NL",
  "867": "YT/NT/NU",
};

/** Accepts a full number or just its first digits ("1416…" / "416…"). */
function regionOf(phone) {
  const p = String(phone || "").replace(/\D/g, "");
  // NANP area codes never start with 1, so a leading 1 is always the country code.
  const ac = p.startsWith("1") ? p.slice(1, 4) : p.slice(0, 3);
  if (ac.length < 3) return "intl";
  return AREA[ac] || (p.startsWith("1") ? "US/other" : "intl");
}

// ---------------------------------------------------------------------------
// counters
// ---------------------------------------------------------------------------
const COUNTERS = [
  "dials", "errors", "sip503", "no_answer", "voicemail", "human", "engaged",
  "appointments", "callbacks", "transfers", "not_interested", "not_qualified",
  "wrong_number", "dnc", "hangups", "positive",
  "cost", "voip_cost", "ai_cost", "vm_cost", "vm_seconds", "seconds", "human_seconds", "ai_seconds",
];

const humanList = HUMAN_OUTCOMES.map((o) => `'${o}'`).join(",");
const positiveList = POSITIVE_OUTCOMES.map((o) => `'${o}'`).join(",");

const AGG = `
  COUNT(*)                                                                  AS dials,
  SUM(outcome = 'error')                                                    AS errors,
  SUM(outcome = 'error' AND error_message LIKE '%503%')                     AS sip503,
  SUM(outcome = 'no_answer')                                                AS no_answer,
  SUM(outcome = 'voicemail')                                                AS voicemail,
  SUM(outcome IN (${humanList}))                                            AS human,
  SUM(outcome IN (${humanList}) AND duration_seconds >= ${ENGAGED_SECONDS}) AS engaged,
  SUM(outcome = 'appointment_set')                                          AS appointments,
  SUM(outcome = 'callback')                                                 AS callbacks,
  SUM(outcome = 'transferred')                                              AS transfers,
  SUM(outcome = 'not_interested')                                           AS not_interested,
  SUM(outcome = 'not_qualified')                                            AS not_qualified,
  SUM(outcome = 'wrong_number')                                             AS wrong_number,
  SUM(outcome = 'do_not_call')                                              AS dnc,
  SUM(outcome = 'lead_hangup')                                              AS hangups,
  SUM(outcome IN (${positiveList}))                                         AS positive,
  COALESCE(SUM(call_cost), 0)                                               AS cost,
  COALESCE(SUM(voip_cost), 0)                                               AS voip_cost,
  COALESCE(SUM(ai_cost), 0)                                                 AS ai_cost,
  COALESCE(SUM(CASE WHEN outcome = 'voicemail' THEN call_cost END), 0)      AS vm_cost,
  COALESCE(SUM(CASE WHEN outcome = 'voicemail' THEN duration_seconds END), 0) AS vm_seconds,
  COALESCE(SUM(duration_seconds), 0)                                        AS seconds,
  COALESCE(SUM(CASE WHEN outcome IN (${humanList}) THEN duration_seconds END), 0) AS human_seconds,
  COALESCE(SUM(ai_duration_seconds), 0)                                     AS ai_seconds
`;

const emptyCounters = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]));

function addInto(target, src) {
  for (const k of COUNTERS) target[k] = (target[k] || 0) + (src[k] || 0);
  return target;
}

/** Turn raw counters into the rates an operator reads. */
function deriveRates(a) {
  const dials = a.dials || 0;
  const connected = dials - (a.errors || 0) - (a.no_answer || 0);
  const human = a.human || 0;
  const appts = a.appointments || 0;
  const pct = (n, d) => (d > 0 ? +(100 * (n || 0) / d).toFixed(1) : 0);
  const per = (n, d) => (d > 0 ? +((n || 0) / d).toFixed(2) : null);
  return {
    ...emptyCounters(),
    ...a,
    connected,
    connect_rate: pct(connected, dials),
    error_rate: pct(a.errors, dials),
    sip503_rate: pct(a.sip503, dials),
    human_rate: pct(human, connected),
    voicemail_rate: pct(a.voicemail, connected),
    engaged_rate: pct(a.engaged, human),
    appt_per_human: pct(appts, human),
    appt_per_dial: pct(appts, dials),
    positive_rate: pct(a.positive, human),
    cost_per_dial: per(a.cost, dials),
    cost_per_human: per(a.cost, human),
    cost_per_appt: per(a.cost, appts),
    vm_cost_share: pct(a.vm_cost, a.cost),
    avg_human_seconds: human ? Math.round((a.human_seconds || 0) / human) : 0,
    avg_vm_seconds: a.voicemail ? Math.round((a.vm_seconds || 0) / a.voicemail) : 0,
    minutes: Math.round((a.seconds || 0) / 60),
  };
}

// ---------------------------------------------------------------------------
// rollups
// ---------------------------------------------------------------------------
let rollupSchemaReady = false;
function ensureRollupSchema(db) {
  if (rollupSchemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS cr_rollup_hourly (
      user_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL,
      campaign_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '',
      ${COUNTERS.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(", ")},
      PRIMARY KEY (user_id, day, hour, campaign_id, agent_id, region)
    );
    CREATE TABLE IF NOT EXISTS cr_rollup_errors (
      user_id TEXT NOT NULL, day TEXT NOT NULL, campaign_id TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (user_id, day, campaign_id, code)
    );
    CREATE TABLE IF NOT EXISTS cr_rollup_days (
      user_id TEXT NOT NULL, day TEXT NOT NULL, built_at TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `);
  rollupSchemaReady = true;
}

function errorCode(msg) {
  return (msg || "").match(/\b([4-6]\d{2})\b/)?.[1]
    || (/econn|etimedout|unreach|fetch failed|socket/i.test(msg || "") ? "NET" : "other");
}

/** Aggregate one UTC day from raw rows and store it. ~1 s per 10k rows. */
function rollupDay(db, userId, day) {
  const from = `${day}T00:00:00.000Z`, to = `${addDays(day, 1)}T00:00:00.000Z`;
  const rows = db.prepare(`
    SELECT CAST(substr(started_at, 12, 2) AS INTEGER) AS hour,
           COALESCE(campaign_id, '') AS campaign_id, COALESCE(agent_id, '') AS agent_id,
           substr(replace(replace(replace(phone,'+',''),'-',''),' ',''), 1, 4) AS p4, ${AGG}
    FROM call_records
    WHERE user_id = ? AND started_at >= ? AND started_at < ?
    GROUP BY hour, campaign_id, agent_id, p4
  `).all(userId, from, to);

  // Collapse area codes to regions (13 values instead of hundreds).
  const merged = new Map();
  for (const r of rows) {
    const region = regionOf(r.p4);
    const key = `${r.hour}|${r.campaign_id}|${r.agent_id}|${region}`;
    const cur = merged.get(key) || { hour: r.hour, campaign_id: r.campaign_id, agent_id: r.agent_id, region, ...emptyCounters() };
    merged.set(key, addInto(cur, r));
  }

  const errRows = db.prepare(`
    SELECT COALESCE(campaign_id, '') AS campaign_id, error_message, COUNT(*) AS n
    FROM call_records
    WHERE user_id = ? AND started_at >= ? AND started_at < ? AND +outcome = 'error'
    GROUP BY campaign_id, error_message
  `).all(userId, from, to);
  const errs = new Map();
  for (const r of errRows) {
    const key = `${r.campaign_id}|${errorCode(r.error_message)}`;
    errs.set(key, (errs.get(key) || 0) + r.n);
  }

  const insH = db.prepare(`
    INSERT OR REPLACE INTO cr_rollup_hourly (user_id, day, hour, campaign_id, agent_id, region, ${COUNTERS.join(",")})
    VALUES (?, ?, ?, ?, ?, ?, ${COUNTERS.map(() => "?").join(",")})
  `);
  const insE = db.prepare("INSERT OR REPLACE INTO cr_rollup_errors (user_id, day, campaign_id, code, n) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM cr_rollup_hourly WHERE user_id = ? AND day = ?").run(userId, day);
    db.prepare("DELETE FROM cr_rollup_errors WHERE user_id = ? AND day = ?").run(userId, day);
    for (const c of merged.values()) insH.run(userId, day, c.hour, c.campaign_id, c.agent_id, c.region, ...COUNTERS.map((k) => c[k] || 0));
    for (const [key, n] of errs) { const [cid, code] = key.split("|"); insE.run(userId, day, cid, code, n); }
    db.prepare("INSERT OR REPLACE INTO cr_rollup_days (user_id, day, built_at) VALUES (?, ?, ?)").run(userId, day, new Date().toISOString());
  })();
  return merged.size;
}

/** Days in [firstDay, lastDay] that have no rollup yet. */
function missingDays(db, userId, firstDay, lastDay) {
  const have = new Set(db.prepare("SELECT day FROM cr_rollup_days WHERE user_id = ? AND day >= ? AND day <= ?")
    .all(userId, firstDay, lastDay).map((r) => r.day));
  const out = [];
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

const warming = new Set();
/** Build missing days one at a time, newest first, yielding between each. */
function warmRollups(userId, days) {
  if (warming.has(userId) || !days.length) return;
  warming.add(userId);
  const queue = [...days].sort().reverse();
  const step = () => {
    const day = queue.shift();
    if (!day) { warming.delete(userId); cache.clear(); logger.info(`[command] rollups complete for user ${userId}`); return; }
    try {
      const t0 = Date.now();
      const n = rollupDay(getDb(), userId, day);
      logger.info(`[command] rolled up ${day}: ${n} cells in ${Date.now() - t0}ms (${queue.length} days left)`);
    } catch (e) {
      logger.warn(`[command] rollup ${day} failed: ${e.message}`);
    }
    setTimeout(step, 250);
  };
  setTimeout(step, 10);
}

/**
 * Last fully-completed UTC day that is safe to roll up. A call that started
 * at 23:59 is only written when it ends, so give the day an hour to settle.
 */
function lastSettledDay() {
  return utcDay(new Date(Date.now() - 864e5 - 36e5));
}

/** Kick off warm-up for every user with calls, shortly after boot. */
export function scheduleRollupWarmup(delayMs = 15_000) {
  setTimeout(() => {
    try {
      const db = getDb();
      ensureRollupSchema(db);
      const last = lastSettledDay(), first = addDays(last, -60);
      for (const { user_id } of db.prepare("SELECT DISTINCT user_id FROM call_records").all()) {
        const missing = missingDays(db, user_id, first, last);
        if (missing.length) {
          logger.info(`[command] warming ${missing.length} rollup day(s) for user ${user_id}`);
          warmRollups(user_id, missing);
        }
      }
    } catch (e) {
      logger.warn(`[command] rollup warm-up failed: ${e.message}`);
    }
  }, delayMs);
}

// ---------------------------------------------------------------------------
// cells → views
// ---------------------------------------------------------------------------
/**
 * A cell is { day, hour (UTC), q (quarter, live only), campaign_id, agent_id, region, ...counters }.
 * Live cells for the current day come from call_records; older days from the rollup.
 */
function liveCells(db, userId, sinceIso, campaignId) {
  const scope = campaignId ? "AND campaign_id = ?" : "";
  const params = campaignId ? [userId, sinceIso, campaignId] : [userId, sinceIso];
  const rows = db.prepare(`
    SELECT substr(started_at, 1, 10) AS day,
           CAST(substr(started_at, 12, 2) AS INTEGER) AS hour,
           CAST(substr(started_at, 15, 2) AS INTEGER) / 15 AS q,
           COALESCE(campaign_id, '') AS campaign_id, COALESCE(agent_id, '') AS agent_id,
           substr(replace(replace(replace(phone,'+',''),'-',''),' ',''), 1, 4) AS p4, ${AGG}
    FROM call_records
    WHERE user_id = ? AND started_at >= ? ${scope}
    GROUP BY day, hour, q, campaign_id, agent_id, p4
  `).all(...params);
  const merged = new Map();
  for (const r of rows) {
    const region = regionOf(r.p4);
    const key = `${r.day}|${r.hour}|${r.q}|${r.campaign_id}|${r.agent_id}|${region}`;
    const cur = merged.get(key) || { day: r.day, hour: r.hour, q: r.q, campaign_id: r.campaign_id, agent_id: r.agent_id, region, ...emptyCounters() };
    merged.set(key, addInto(cur, r));
  }
  const errs = db.prepare(`
    SELECT COALESCE(campaign_id, '') AS campaign_id, error_message, COUNT(*) AS n
    FROM call_records
    WHERE user_id = ? AND started_at >= ? ${scope} AND +outcome = 'error'
    GROUP BY campaign_id, error_message
  `).all(...params).map((r) => ({ campaign_id: r.campaign_id, code: errorCode(r.error_message), n: r.n }));
  return { cells: [...merged.values()], errs };
}

function rollupCells(db, userId, firstDay, lastDay, campaignId) {
  const scope = campaignId ? "AND campaign_id = ?" : "";
  const params = campaignId ? [userId, firstDay, lastDay, campaignId] : [userId, firstDay, lastDay];
  const cells = db.prepare(`
    SELECT day, hour, 0 AS q, campaign_id, agent_id, region, ${COUNTERS.join(",")}
    FROM cr_rollup_hourly WHERE user_id = ? AND day >= ? AND day <= ? ${scope}
  `).all(...params);
  const errs = db.prepare(`
    SELECT campaign_id, code, n FROM cr_rollup_errors WHERE user_id = ? AND day >= ? AND day <= ? ${scope}
  `).all(...params);
  return { cells, errs };
}

function groupBy(cells, keyFn, decorate = (k) => ({ key: k })) {
  const m = new Map();
  for (const c of cells) {
    const k = keyFn(c);
    if (k === undefined || k === null) continue;
    const cur = m.get(k) || { ...decorate(k), ...emptyCounters() };
    m.set(k, addInto(cur, c));
  }
  return [...m.values()].map(deriveRates);
}

const SIP_LABEL = {
  "503": "Service unavailable / throttled", "486": "Busy", "480": "Temporarily unavailable",
  "404": "Number not found", "408": "Request timeout", "403": "Forbidden", "402": "Payment required",
  "500": "Server error", "502": "Bad gateway", "487": "Cancelled", "484": "Address incomplete",
  "603": "Declined", "604": "Does not exist", "428": "Use identity header",
  "NET": "Network / Deepgram unreachable", "other": "Other",
};

function buildOverview(userId, range, campaignId) {
  const db = getDb();
  ensureRollupSchema(db);

  const now = new Date();
  const todayUtc = utcDay(now);
  let cells = [], errs = [], since, bucket, warmingInfo = null;

  if (range === "today") {
    since = startOfDayIso(HOUSE_TZ);
    bucket = "15min";
    ({ cells, errs } = liveCells(db, userId, since, campaignId));
  } else {
    const days = range === "7d" ? 7 : 30;
    bucket = range === "7d" ? "hour" : "day";
    const firstDay = addDays(todayUtc, -days);
    since = `${firstDay}T00:00:00.000Z`;
    const lastRolled = lastSettledDay();

    const missing = missingDays(db, userId, firstDay, lastRolled);
    if (missing.length) {
      warmRollups(userId, missing);
      warmingInfo = { missing_days: missing.length };
    }
    const past = rollupCells(db, userId, firstDay, lastRolled, campaignId);
    // Everything after the last rolled day is live (yesterday-not-yet-settled + today).
    const live = liveCells(db, userId, `${addDays(lastRolled, 1)}T00:00:00.000Z`, campaignId);
    cells = [...past.cells, ...live.cells];
    errs = [...past.errs, ...live.errs];
  }

  const totals = deriveRates(cells.reduce(addInto, emptyCounters()));

  // --- time series (UTC labels; the browser renders them in local time) -----
  const seriesKey = (c) => {
    const hh = String(c.hour).padStart(2, "0");
    if (bucket === "day") return `${c.day}T00:00:00Z`;
    if (bucket === "hour") return `${c.day}T${hh}:00:00Z`;
    return `${c.day}T${hh}:${String((c.q || 0) * 15).padStart(2, "0")}:00Z`;
  };
  const series = groupBy(cells, seriesKey, (k) => ({ t: k })).sort((a, b) => a.t.localeCompare(b.t));

  // --- hour of day / heatmap in house tz ------------------------------------
  const shift = tzOffsetMinutes(HOUSE_TZ) / 60;
  const localHour = (c) => ((c.hour + shift) % 24 + 24) % 24;
  const hoursMap = new Map(groupBy(cells, localHour, (h) => ({ hour: h, label: `${String(h).padStart(2, "0")}:00` })).map((h) => [h.hour, h]));
  const hours = Array.from({ length: 24 }, (_, h) => hoursMap.get(h) || deriveRates({ hour: h, label: `${String(h).padStart(2, "0")}:00` }));

  const heatmap = groupBy(cells, (c) => {
    let h = c.hour + shift, wd = new Date(c.day + "T00:00:00Z").getUTCDay();
    if (h >= 24) { h -= 24; wd = (wd + 1) % 7; }
    if (h < 0)   { h += 24; wd = (wd + 6) % 7; }
    return `${wd}|${h}`;
  }, (k) => { const [wd, h] = k.split("|").map(Number); return { weekday: wd, hour: h }; });

  // --- SIP / error codes -----------------------------------------------------
  const sipAgg = new Map();
  for (const e of errs) sipAgg.set(e.code, (sipAgg.get(e.code) || 0) + e.n);
  const sip = [...sipAgg.entries()]
    .map(([code, n]) => ({ code, label: SIP_LABEL[code] || code, count: n, share: totals.dials ? +(100 * n / totals.dials).toFixed(1) : 0 }))
    .sort((a, b) => b.count - a.count);

  // --- per campaign / agent / region ----------------------------------------
  const campMeta = new Map(db.prepare("SELECT id, name, status, max_concurrent_calls, agent_id FROM campaigns WHERE user_id = ?").all(userId).map((c) => [c.id, c]));
  const campaigns = groupBy(cells, (c) => c.campaign_id || "(none)", (id) => ({ id, ...(campMeta.get(id) || { name: id === "(none)" ? "No campaign" : "Deleted campaign", status: "deleted" }) }))
    .sort((a, b) => b.dials - a.dials);

  const agentMeta = new Map(db.prepare("SELECT id, name, llm_model FROM agents WHERE user_id = ?").all(userId).map((a) => [a.id, a]));
  const agents = groupBy(cells, (c) => c.agent_id || "(none)", (id) => ({ id, ...(agentMeta.get(id) || { name: id === "(none)" ? "No agent" : "Deleted agent" }) }))
    .sort((a, b) => b.dials - a.dials);

  const regions = groupBy(cells, (c) => c.region, (region) => ({ region }))
    .filter((r) => r.dials >= 10)
    .sort((a, b) => b.dials - a.dials);

  // --- pace ------------------------------------------------------------------
  let spend_per_hour = 0;
  if (series.length >= 2) {
    const span = Math.max((Date.parse(series[series.length - 1].t) - Date.parse(series[0].t)) / 36e5, 0.25);
    spend_per_hour = +(totals.cost / span).toFixed(2);
  }
  const scope = campaignId ? "AND campaign_id = ?" : "";
  const hourAgo = new Date(Date.now() - 36e5).toISOString();
  const last_hour = deriveRates(db.prepare(`SELECT ${AGG} FROM call_records WHERE user_id = ? AND started_at >= ? ${scope}`)
    .get(...(campaignId ? [userId, hourAgo, campaignId] : [userId, hourAgo])));

  let remaining = null;
  if (campaignId) {
    try { remaining = getCampaignCallableLeadCount(campaignId); } catch { remaining = null; }
  }

  return {
    range, since, bucket, tz: HOUSE_TZ, market_tz: MARKET_TZ, warming: warmingInfo,
    totals, series, hours, heatmap, sip, campaigns, agents, regions,
    last_hour, spend_per_hour, remaining,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// recommendations — plain rules over the numbers
// ---------------------------------------------------------------------------
function recommend({ totals, hours, campaigns, deepgram, trunk, remaining, spendPerHour }) {
  const out = [];

  if (totals.dials >= 100 && totals.sip503_rate >= 15) {
    const running = campaigns.filter((c) => c.status === "running");
    const conc = running[0]?.max_concurrent_calls;
    const target = conc ? Math.max(5, Math.round(conc * (1 - totals.sip503_rate / 100) * 0.9)) : null;
    out.push({
      level: "critical",
      title: `Carrier is rejecting ${totals.sip503_rate}% of dials (SIP 503)`,
      detail: conc
        ? `Concurrency ${conc} is above what the trunk accepts. Try ${target} — rejected dials cost nothing but burn scheduler time and skew every rate.`
        : "Lower campaign concurrency until the 503 share drops under 5%.",
      metric: `${totals.sip503} of ${totals.dials} dials`,
    });
  }

  if (totals.connected >= 50 && totals.voicemail_rate >= 30) {
    out.push({
      level: "warning",
      title: `${totals.voicemail_rate}% of connected calls are answering machines`,
      detail: `Voicemail cost $${totals.vm_cost.toFixed(2)} (${totals.vm_cost_share}% of spend) at ~${totals.avg_vm_seconds}s each. Concentrate dialing in the hours where the human rate is highest.`,
      metric: `${totals.voicemail} voicemails`,
    });
  }

  const usable = hours.filter((h) => h.dials >= 30);
  if (usable.length >= 3) {
    const best = [...usable].sort((a, b) => b.human_rate - a.human_rate)[0];
    const worst = [...usable].sort((a, b) => a.human_rate - b.human_rate)[0];
    if (best.human_rate - worst.human_rate >= 10) {
      out.push({
        level: "info",
        title: `Best hour ${best.label}: ${best.human_rate}% human — worst ${worst.label}: ${worst.human_rate}%`,
        detail: `${(best.human_rate / Math.max(worst.human_rate, 1)).toFixed(1)}x more humans per connected call. Weight the dial plan toward the strong hours (times are ${HOUSE_TZ}).`,
        metric: `${best.dials} vs ${worst.dials} dials`,
      });
    }
  }

  if (totals.appointments >= 3 && totals.cost_per_appt !== null) {
    out.push({
      level: "info",
      title: `Cost per appointment: $${totals.cost_per_appt.toFixed(2)}`,
      detail: `${totals.appointments} appointments from ${totals.human} human conversations (${totals.appt_per_human}% close rate). Cost per human conversation is $${totals.cost_per_human}.`,
      metric: `$${totals.cost.toFixed(2)} spent`,
    });
  }

  if (deepgram?.configured && typeof deepgram.total === "number" && spendPerHour > 0) {
    const hoursLeft = deepgram.total / Math.max(spendPerHour * 0.9, 0.01);
    if (hoursLeft < 24) {
      out.push({
        level: hoursLeft < 6 ? "critical" : "warning",
        title: `Deepgram credit lasts ~${hoursLeft.toFixed(0)}h at current pace`,
        detail: `$${deepgram.total.toFixed(2)} across ${deepgram.usableKeys} keys; spend rate $${spendPerHour.toFixed(2)}/h.`,
        metric: `${deepgram.usableKeys} keys`,
      });
    }
  }

  if (trunk?.tripped) {
    out.push({
      level: "critical",
      title: "VoIP trunk breaker is tripped",
      detail: `${trunk.reason}. Retry in ${trunk.retryInMinutes} min.`,
      metric: trunk.lastStatus ? `last SIP ${trunk.lastStatus}` : "",
    });
  }

  if (remaining !== null && totals.dials > 0) {
    out.push({
      level: "info",
      title: `${remaining.toLocaleString()} callable leads remaining`,
      detail: `At ${totals.dials.toLocaleString()} dials in this range the pool lasts roughly ${(remaining / Math.max(totals.dials, 1)).toFixed(1)}x this window.`,
      metric: "",
    });
  }

  return out;
}

function sanitizeGuard(g) {
  if (!g) return null;
  return {
    ok: g.ok,
    disabled: !!g.disabled,
    reasons: g.reasons || [],
    deepgram: g.deepgram ? {
      configured: g.deepgram.configured, ok: g.deepgram.ok, total: g.deepgram.total,
      usableKeys: g.deepgram.usableKeys, unreachable: !!g.deepgram.unreachable, audioPathDown: !!g.deepgram.audioPathDown,
    } : null,
    voip: g.voip ? { configured: g.voip.configured, ok: g.voip.ok, balance: g.voip.balance } : null,
    trunk: g.trunk ? {
      ok: g.trunk.ok, tripped: !!g.trunk.tripped, disabled: !!g.trunk.disabled, reason: g.trunk.reason || "",
      retryInMinutes: g.trunk.retryInMinutes ?? null, lastStatus: g.trunk.lastStatus ?? null,
      connectRate: g.trunk.connectRate ?? null,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// GET /overview?range=today|7d|30d&campaign_id=
// ---------------------------------------------------------------------------
router.get("/overview", async (req, res) => {
  const userId = req.user.userId;
  const range = ["today", "7d", "30d"].includes(req.query.range) ? req.query.range : "today";
  const campaignId = req.query.campaign_id || "";

  try {
    const data = cached(`ov:${userId}:${range}:${campaignId}`, () => buildOverview(userId, range, campaignId));

    // Provider state: answer with the last known verdict immediately and let
    // the (HTTP-bound) evaluation refresh it in the background. Only the very
    // first request after boot waits, and never more than 400ms.
    const verdict = evaluateBalances(userId)
      .then((g) => { lastGuard.set(userId, g); return g; })
      .catch((e) => ({ ok: null, reasons: [e.message], trunk: getTrunkState() }));
    let guard = lastGuard.get(userId) || null;
    if (!guard) {
      try {
        guard = await Promise.race([
          verdict,
          new Promise((_, rej) => setTimeout(() => rej(new Error("provider check still running")), 400)),
        ]);
      } catch (e) {
        guard = { ok: null, reasons: [e.message], trunk: getTrunkState() };
      }
    }

    const recommendations = recommend({
      totals: data.totals, hours: data.hours, campaigns: data.campaigns,
      deepgram: guard?.deepgram, trunk: guard?.trunk, remaining: data.remaining, spendPerHour: data.spend_per_hour,
    });

    res.json({ ...data, guard: sanitizeGuard(guard), recommendations, credit: getUserBalance(userId) });
  } catch (err) {
    logger.error(`[command] overview failed: ${err.stack || err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /live — cheap, polled every few seconds
// ---------------------------------------------------------------------------
router.get("/live", (req, res) => {
  const userId = req.user.userId;
  const db = getDb();
  const runners = req.app.locals.campaignRunners || new Map();

  const meta = new Map(db.prepare("SELECT id, name, max_concurrent_calls FROM campaigns WHERE user_id = ?").all(userId).map((r) => [r.id, r]));

  const active = [];
  const runnerSummary = [];
  for (const [campaignId, r] of runners) {
    if (!meta.has(campaignId)) continue;
    const m = meta.get(campaignId);
    const calls = r.activeCalls || [];
    // Stopped runners linger in the map until cleanup; they are not "control" targets.
    if (!r.running && !calls.length && !r.pausedForSchedule && !r.pausedForBalance) continue;
    runnerSummary.push({
      campaignId, name: m.name,
      running: !!r.running,
      pausedFor: r.pausedForBalance ? "balance" : r.pausedForSchedule ? "schedule" : null,
      activeCalls: calls.length, concurrency: m.max_concurrent_calls,
      completedCalls: r.completedCalls || 0,
      remaining: typeof r.getRemainingLeads === "function" ? r.getRemainingLeads() : null,
    });
    for (const c of calls) active.push({ campaignId, campaign: m.name, ...c });
  }

  const m5 = new Date(Date.now() - 5 * 60e3).toISOString();
  const m1 = new Date(Date.now() - 60e3).toISOString();
  const last5 = deriveRates(db.prepare(`SELECT ${AGG} FROM call_records WHERE user_id = ? AND started_at >= ?`).get(userId, m5));
  const last1 = db.prepare("SELECT COUNT(*) n FROM call_records WHERE user_id = ? AND started_at >= ?").get(userId, m1).n;

  const recent = db.prepare(`
    SELECT cr.id, cr.call_id, cr.phone, cr.lead_name, cr.outcome, cr.duration_seconds, cr.started_at,
           cr.call_cost, cr.error_message, c.name AS campaign
    FROM call_records cr LEFT JOIN campaigns c ON c.id = cr.campaign_id
    WHERE cr.user_id = ? ORDER BY cr.started_at DESC LIMIT 25
  `).all(userId);

  const t = getTrunkState();
  res.json({
    now: new Date().toISOString(),
    active, runners: runnerSummary,
    dials_per_min: last1,
    last5, recent,
    trunk: { tripped: !!t.tripped, reason: t.reason || "", lastStatus: t.lastStatus ?? null, connectRate: t.connectRate ?? null, retryInMinutes: t.retryInMinutes ?? null },
    credit: getUserBalance(userId),
    offline_gap: getLastOfflineGap(),
    uptime_seconds: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// GET /appointments?range=today|7d|30d&campaign_id= — the actual results:
// every appointment booked in the range with the lead, the call behind it and
// the recording, plus "hot" leads (callback / interested / transferred) that
// still need a human follow-up.
// ---------------------------------------------------------------------------
function rangeSinceIso(range) {
  if (range === "today") return startOfDayIso(HOUSE_TZ);
  const days = range === "7d" ? 7 : 30;
  return `${addDays(utcDay(new Date()), -days)}T00:00:00.000Z`;
}

router.get("/appointments", (req, res) => {
  const userId = req.user.userId;
  const range = ["today", "7d", "30d"].includes(req.query.range) ? req.query.range : "today";
  const campaignId = req.query.campaign_id || "";
  const db = getDb();

  // Not cached: every query here walks a small index range (≤300 rows), and the
  // panel must reflect a status change or a fresh booking on the next fetch.
  const data = (() => {
    const sinceIso = rangeSinceIso(range);
    // appointments.created_at is SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC).
    const sinceSql = sinceIso.slice(0, 19).replace("T", " ");
    const scope = campaignId ? "AND a.campaign_id = ?" : "";
    const params = campaignId ? [userId, sinceSql, campaignId] : [userId, sinceSql];

    const appointments = db.prepare(`
      SELECT a.id, a.campaign_id, a.lead_id, a.call_id, a.lead_name, a.phone, a.email,
             a.appointment_date, a.appointment_time, a.timezone, a.notes, a.status, a.created_at,
             c.name AS campaign,
             l.first_name, l.last_name, l.company, l.country, l.email AS lead_email, l.status AS lead_status,
             cr.duration_seconds, cr.recording_url, cr.recording_path, cr.call_summary, cr.outcome AS call_outcome,
             cr.id AS call_record_id
      FROM appointments a
      LEFT JOIN campaigns c ON c.id = a.campaign_id
      LEFT JOIN leads l ON l.id = a.lead_id
      LEFT JOIN call_records cr ON cr.call_id = a.call_id AND a.call_id <> ''
      WHERE a.user_id = ? AND a.created_at >= ? ${scope}
      ORDER BY a.created_at DESC
      LIMIT 300
    `).all(...params).map((r) => ({
      ...r,
      created_at_iso: r.created_at ? new Date(r.created_at.replace(" ", "T") + "Z").toISOString() : null,
      email: r.email || r.lead_email || "",
      has_recording: !!(r.recording_url || r.recording_path),
    }));

    const by_status = { scheduled: 0, completed: 0, no_show: 0, cancelled: 0, rescheduled: 0 };
    for (const a of appointments) by_status[a.status] = (by_status[a.status] || 0) + 1;

    const hotScope = campaignId ? "AND cr.campaign_id = ?" : "";
    const hotParams = campaignId ? [userId, sinceIso, campaignId] : [userId, sinceIso];
    const hot_leads = db.prepare(`
      SELECT cr.id, cr.call_id, cr.campaign_id, cr.lead_id, cr.phone, cr.lead_name, cr.outcome, cr.duration_seconds,
             cr.started_at, cr.notes, cr.call_summary, cr.recording_url, cr.recording_path,
             c.name AS campaign, l.email, l.company, l.country
      FROM call_records cr
      LEFT JOIN campaigns c ON c.id = cr.campaign_id
      LEFT JOIN leads l ON l.id = cr.lead_id
      WHERE cr.user_id = ? AND cr.outcome IN ('callback','interested','transferred') AND cr.started_at >= ? ${hotScope}
      ORDER BY cr.started_at DESC
      LIMIT 100
    `).all(...hotParams).map((r) => ({ ...r, has_recording: !!(r.recording_url || r.recording_path) }));

    return { range, since: sinceIso, appointments, by_status, hot_leads };
  })();

  res.json(data);
});

// ---------------------------------------------------------------------------
// GET /inventory/:campaignId — lead pool state
// ---------------------------------------------------------------------------
router.get("/inventory/:campaignId", (req, res) => {
  const userId = req.user.userId;
  const db = getDb();
  const camp = db.prepare("SELECT id, name FROM campaigns WHERE id = ? AND user_id = ?").get(req.params.campaignId, userId);
  if (!camp) return res.status(404).json({ error: "Campaign not found" });

  const data = cached(`inv:${camp.id}`, () => {
    const lists = db.prepare("SELECT list_id FROM campaign_lists WHERE campaign_id = ?").all(camp.id).map((r) => r.list_id);
    if (!lists.length) return { total: 0, by_status: [], by_attempts: [], dnc: 0, callable: 0 };
    const ph = lists.map(() => "?").join(",");
    const by_status = db.prepare(`SELECT status, COUNT(*) n FROM leads WHERE list_id IN (${ph}) GROUP BY status ORDER BY n DESC`).all(...lists);
    const by_attempts = db.prepare(`SELECT attempts, COUNT(*) n FROM leads WHERE list_id IN (${ph}) GROUP BY attempts ORDER BY attempts`).all(...lists);
    const dnc = db.prepare(`SELECT COUNT(*) n FROM leads WHERE list_id IN (${ph}) AND do_not_call = 1`).get(...lists).n;
    const total = by_status.reduce((s, r) => s + r.n, 0);
    return { total, by_status, by_attempts, dnc, callable: getCampaignCallableLeadCount(camp.id) };
  });

  res.json({ campaign: camp, ...data });
});

export default router;
