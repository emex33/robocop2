/**
 * Balance Guard
 *
 * Stops dialing when an upstream provider runs out of money, and lets the
 * scheduler resume automatically once it is topped up again.
 *
 *   - Deepgram: live balance summed across the user's API key pool.
 *   - VoIP (MMDsmart): balance from a configured HTTP endpoint, or a figure
 *     maintained manually in platform settings when no API is available.
 *
 * Results are cached because the scheduler evaluates this every minute.
 *
 * Fail-open: if a balance cannot be determined (network error, no config), the
 * guard allows dialing. It only pauses on a positively-known zero balance, so a
 * provider outage never silently halts a campaign.
 */

import { getDb } from "../db/schema.js";
import { getPlatformSetting } from "../db/helpers.js";
import { deepgramKeyManager } from "../deepgram/key-manager.js";
import logger from "../utils/logger.js";

const BALANCE_TTL_MS = 5 * 60 * 1000;
const DEEPGRAM_TTL_MS = 60 * 1000; // pool refresh every minute so a $5 key is swapped before it dies mid-campaign
const cache = new Map(); // cacheKey -> { ts, value }

async function withCache(cacheKey, compute, ttl = BALANCE_TTL_MS) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ttl) return hit.value;
  const value = await compute();
  cache.set(cacheKey, { ts: Date.now(), value });
  return value;
}

/** Force the next evaluation to re-query the providers (e.g. after a top-up). */
export function clearBalanceCache() {
  cache.clear();
}

function numericSetting(key, fallback) {
  const raw = getPlatformSetting(key, String(fallback));
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a dot-separated path out of a JSON object. */
function pickPath(obj, path) {
  return path.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
}

const HTTP_TIMEOUT_MS = 10_000;

/**
 * fetch with a hard deadline. Without this a single stalled provider request
 * hangs the scheduler tick forever, which silently disables calling-window
 * enforcement (campaigns then dial around the clock).
 */
async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

/**
 * Live Deepgram balance for one API key (sums all projects on that key).
 * Returns null when the balance could not be read.
 */
async function deepgramKeyBalance(apiKey) {
  const headers = { Authorization: `Token ${apiKey}` };
  const projectsRes = await fetchWithTimeout("https://api.deepgram.com/v1/projects", { headers });
  if (!projectsRes.ok) {
    if (projectsRes.status === 401) return 0; // key revoked → no usable funds
    return null;
  }
  const { projects = [] } = await projectsRes.json();
  let total = 0;
  for (const p of projects) {
    const res = await fetchWithTimeout(`https://api.deepgram.com/v1/projects/${p.project_id}/balances`, { headers });
    if (!res.ok) return null;
    const { balances = [] } = await res.json();
    total += balances.reduce((sum, b) => sum + (b.amount || 0), 0);
  }
  return total;
}

/**
 * Total usable Deepgram balance across the user's key pool.
 *
 * Also self-heals the pool: a key previously auto-marked "depleted" that now has
 * funds again is reactivated, which is what allows dialing to resume after a top-up.
 */
async function checkDeepgram(userId) {
  const minBalance = numericSetting("deepgram_min_balance", 5);
  const db = getDb();
  const keys = db.prepare(
    "SELECT id, label, status, api_key FROM deepgram_keys WHERE user_id = ?"
  ).all(userId);

  if (keys.length === 0) {
    return { configured: false, ok: true, total: 0, usableKeys: 0, reactivated: [] };
  }

  let total = 0;
  let usableKeys = 0;
  let unknown = 0;
  const reactivated = [];
  const deactivated = [];

  for (const k of keys) {
    let balance;
    try {
      balance = await deepgramKeyBalance(k.api_key);
    } catch (err) {
      balance = null;
      logger.warn(`[balance-guard] Deepgram balance check failed for "${k.label || k.id}": ${err.message}`);
    }

    if (balance === null) { unknown++; continue; }

    const hasFunds = balance > minBalance;

    if (hasFunds && k.status === "depleted") {
      deepgramKeyManager.reactivateKey(k.id, userId);
      reactivated.push(k.label || k.id);
      logger.info(`[balance-guard] Reactivated Deepgram key "${k.label || k.id}" — balance $${balance.toFixed(2)}`);
    }

    // Retire a key that has run dry before the rotator hands it out. Without this
    // the pool only learns a key is empty by failing live calls with a 402.
    if (!hasFunds && k.status === "active") {
      deepgramKeyManager.retireKey(userId, k.id, `Balance $${balance.toFixed(2)} at or below $${minBalance.toFixed(2)}`);
      deactivated.push(k.label || k.id);
      logger.warn(`[balance-guard] Retired Deepgram key "${k.label || k.id}" — $${balance.toFixed(2)} (floor $${minBalance.toFixed(2)}) — next call uses a healthy key`);
    }

    // Only count keys the rotator is allowed to use.
    const usable = hasFunds && k.status !== "invalid";
    if (usable) {
      usableKeys++;
      total += balance;
    }
  }

  // Every key failed to report → treat as unknown and fail open.
  if (unknown === keys.length) {
    return { configured: true, ok: true, total: null, usableKeys: null, unknown, reactivated, deactivated };
  }

  return {
    configured: true,
    ok: usableKeys > 0,
    total,
    usableKeys,
    unknown,
    reactivated,
    deactivated,
    minBalance,
  };
}

/**
 * VoIP (MMDsmart) balance.
 *
 * Preferred: set `voip_balance_api_url` (plus optional `voip_balance_api_key` and
 * `voip_balance_json_path`) in platform settings.
 * Fallback: maintain `voip_balance_manual` by hand.
 */
async function checkVoip() {
  const minBalance = numericSetting("voip_min_balance", 0);
  const apiUrl = getPlatformSetting("voip_balance_api_url", "").trim();

  if (apiUrl) {
    const apiKey = getPlatformSetting("voip_balance_api_key", "").trim();
    const jsonPath = getPlatformSetting("voip_balance_json_path", "balance").trim() || "balance";
    try {
      const res = await fetchWithTimeout(apiUrl, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) {
        logger.warn(`[balance-guard] VoIP balance API returned HTTP ${res.status}`);
        return { configured: true, ok: true, balance: null, source: "api", error: `HTTP ${res.status}` };
      }
      const body = await res.json();
      const raw = pickPath(body, jsonPath);
      const balance = parseFloat(raw);
      if (!Number.isFinite(balance)) {
        logger.warn(`[balance-guard] VoIP balance API: no number at path "${jsonPath}"`);
        return { configured: true, ok: true, balance: null, source: "api", error: "unparseable response" };
      }
      return { configured: true, ok: balance > minBalance, balance, source: "api", minBalance };
    } catch (err) {
      logger.warn(`[balance-guard] VoIP balance API unreachable: ${err.message}`);
      return { configured: true, ok: true, balance: null, source: "api", error: err.message };
    }
  }

  const manualRaw = getPlatformSetting("voip_balance_manual", "").trim();
  if (manualRaw !== "") {
    const balance = parseFloat(manualRaw);
    if (Number.isFinite(balance)) {
      return { configured: true, ok: balance > minBalance, balance, source: "manual", minBalance };
    }
  }

  return { configured: false, ok: true, balance: null, source: "none" };
}

/* ----------------------------------------------------------------------------
 * VoIP trunk circuit breaker
 *
 * MMDsmart publishes no balance endpoint, so the only reliable signal that the
 * VoIP account is dry is the trunk itself refusing to place calls. This tracks
 * SIP rejections and trips a breaker so we stop burning through leads against a
 * dead trunk (every refused INVITE would otherwise mark a lead as attempted).
 *
 * A 402 trips instantly. Softer codes (403/503/auth) need a run of consecutive
 * failures, so a single odd rejection doesn't halt a campaign.
 *
 * The breaker is half-open: after a cool-down it clears itself and lets the
 * scheduler dial again. If the trunk is still dry it trips within a few calls
 * and the cool-down doubles, so no API or manual reset is needed to recover.
 * -------------------------------------------------------------------------- */

const FUNDS_CODES = new Set([402]);              // explicit "pay up"
const TRUNK_BLOCK_CODES = new Set([401, 403, 407, 503]); // rejected / unavailable / auth
// Answers about the *number*, not the trunk: busy, no answer, invalid, declined.
// Long runs of these are normal on cold lists, and each one actually proves the
// trunk is routing fine — so they clear the breaker's counters.
const PER_LEAD_CODES = new Set([404, 408, 410, 480, 484, 486, 487, 600, 603, 604]);
const CONSECUTIVE_BLOCK_TRIP = 5;
const CONSECUTIVE_ANY_TRIP = 12;
const BASE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Rolling window of recent attempts. The consecutive-code rules miss the case where
// a carrier rejects almost everything while sprinkling in codes that look per-lead
// (a 50% "busy" rate is not real busy signals), so also watch the connect rate.
const WINDOW_SIZE = 100;
const WINDOW_MIN_SAMPLE = 40;
const WINDOW_TRIP_RATE = 0.10;   // below this connect rate the trunk is unusable
const WINDOW_CLEAR_RATE = 0.25;  // needs a sustained recovery, not one lucky call

const trunk = {
  consecutiveBlocks: 0,
  consecutiveFailures: 0,
  trippedAt: null,
  reason: "",
  tripCount: 0,
  lastStatus: null,
  lastFailureAt: null,
  window: [],   // true = connected, false = failed
  connects: 0,
};

function pushWindow(connected) {
  trunk.window.push(connected);
  if (connected) trunk.connects++;
  if (trunk.window.length > WINDOW_SIZE) {
    if (trunk.window.shift()) trunk.connects--;
  }
}

/** Connect rate over the rolling window, or null until there's a usable sample. */
function windowRate() {
  if (trunk.window.length < WINDOW_MIN_SAMPLE) return null;
  return trunk.connects / trunk.window.length;
}

function tripTrunk(reason) {
  if (trunk.trippedAt) return;
  trunk.trippedAt = Date.now();
  trunk.tripCount++;
  trunk.reason = reason;
  logger.error(`[balance-guard] VoIP trunk breaker TRIPPED: ${reason}`);
}

/**
 * Call after any successfully placed call.
 *
 * A single connect is NOT enough to clear a tripped breaker: when a carrier is
 * rejecting ~97% of traffic the occasional call still gets through, and clearing on
 * that makes the campaign flap between paused and dialing. Require the rolling
 * connect rate to actually recover.
 */
export function reportTrunkSuccess() {
  trunk.consecutiveBlocks = 0;
  trunk.consecutiveFailures = 0;
  pushWindow(true);

  if (trunk.trippedAt) {
    const rate = windowRate();
    if (rate === null || rate >= WINDOW_CLEAR_RATE) {
      logger.info(`[balance-guard] VoIP trunk recovered (connect rate ${rate === null ? "n/a" : Math.round(rate * 100) + "%"}) — breaker cleared`);
      trunk.trippedAt = null;
      trunk.reason = "";
      trunk.tripCount = 0;
    }
  }
}

/**
 * Call when a dial attempt fails. `status` is the SIP response code when known.
 * Per-lead outcomes (busy, no answer, unallocated number) are ignored — they say
 * nothing about the trunk.
 */
export function reportTrunkFailure(status, message = "") {
  const code = Number(status) || null;
  trunk.lastStatus = code;
  trunk.lastFailureAt = Date.now();

  pushWindow(false);

  // A pathological connect rate means the carrier is refusing traffic regardless of
  // which codes it returns.
  const rate = windowRate();
  if (rate !== null && rate < WINDOW_TRIP_RATE) {
    tripTrunk(`VoIP trunk connect rate collapsed to ${Math.round(rate * 100)}% over the last ${trunk.window.length} calls — carrier is refusing traffic`);
    return;
  }

  // The trunk answered about this specific number — it's alive and routing.
  if (code && PER_LEAD_CODES.has(code)) {
    trunk.consecutiveBlocks = 0;
    trunk.consecutiveFailures = 0;
    return;
  }

  trunk.consecutiveFailures++;

  if (code && FUNDS_CODES.has(code)) {
    tripTrunk(`SIP ${code} Payment Required from VoIP trunk — account out of funds`);
    return;
  }

  if (code && TRUNK_BLOCK_CODES.has(code)) {
    trunk.consecutiveBlocks++;
    if (trunk.consecutiveBlocks >= CONSECUTIVE_BLOCK_TRIP) {
      tripTrunk(`VoIP trunk rejected ${trunk.consecutiveBlocks} consecutive calls (last: SIP ${code}) — likely out of funds or blocked`);
    }
    return;
  }

  if (trunk.consecutiveFailures >= CONSECUTIVE_ANY_TRIP) {
    tripTrunk(`${trunk.consecutiveFailures} consecutive calls failed to connect${message ? ` (last: ${message})` : ""} — VoIP trunk unreachable`);
  }
}

/** Live breaker state. Expires its own cool-down so dialing can resume. */
function checkTrunk() {
  if (!trunk.trippedAt) {
    return { ok: true, tripped: false, lastStatus: trunk.lastStatus };
  }

  const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** (trunk.tripCount - 1), MAX_COOLDOWN_MS);
  const elapsed = Date.now() - trunk.trippedAt;
  if (elapsed >= cooldown) {
    logger.info(`[balance-guard] VoIP breaker cool-down elapsed (${Math.round(cooldown / 60000)}m) — retrying trunk`);
    trunk.trippedAt = null;
    trunk.reason = "";
    trunk.consecutiveBlocks = 0;
    trunk.consecutiveFailures = 0;
    // Start the rate sample fresh, otherwise the old failures re-trip immediately.
    trunk.window = [];
    trunk.connects = 0;
    return { ok: true, tripped: false, retrying: true, lastStatus: trunk.lastStatus };
  }

  const rate = windowRate();
  return {
    ok: false,
    tripped: true,
    reason: trunk.reason,
    retryInMinutes: Math.ceil((cooldown - elapsed) / 60000),
    lastStatus: trunk.lastStatus,
    connectRate: rate === null ? null : Math.round(rate * 100),
  };
}

/** Breaker state for dashboards / diagnostics. */
export function getTrunkState() {
  return { ...trunk, ...checkTrunk() };
}

/**
 * Evaluate every provider balance for a user.
 * Returns { ok, reasons[], deepgram, voip } — `ok: false` means stop dialing.
 */
export async function evaluateBalances(userId) {
  const guardEnabled = getPlatformSetting("balance_guard_enabled", "true") === "true";

  // Always refresh the Deepgram pool (retire ≤ $5, reactivate topped-up keys)
  // even when the pause-guard is off, so campaigns never start a call on a dying key.
  const deepgram = await withCache(`dg:${userId}`, () =>
    checkDeepgram(userId).catch((err) => {
      logger.warn(`[balance-guard] Deepgram check error: ${err.message}`);
      return { configured: true, ok: true, total: null, error: err.message };
    }),
  DEEPGRAM_TTL_MS);

  if (!guardEnabled) {
    return { ok: true, disabled: true, reasons: [], deepgram, voip: null };
  }

  const voip = await withCache(`voip`, checkVoip, BALANCE_TTL_MS);

  const trunkState = checkTrunk();

  const reasons = [];
  if (!deepgram.ok) {
    reasons.push(
      `All Deepgram API keys are out of balance (no key above $${(deepgram.minBalance ?? 0).toFixed(2)})`
    );
  }
  if (!voip.ok) {
    reasons.push(
      `VoIP balance is $${Number(voip.balance).toFixed(2)} (minimum $${(voip.minBalance ?? 0).toFixed(2)})`
    );
  }
  if (!trunkState.ok) {
    reasons.push(`${trunkState.reason} — retrying in ${trunkState.retryInMinutes} min`);
  }

  return { ok: reasons.length === 0, reasons, deepgram, voip, trunk: trunkState };
}

/** Human-readable one-liner for logs and campaign feeds. */
export function describeBalances(result) {
  if (!result || result.disabled) return "balance guard disabled";
  const parts = [];
  const dg = result.deepgram;
  if (dg?.configured) {
    parts.push(
      dg.total === null
        ? "Deepgram: unknown"
        : `Deepgram: $${dg.total.toFixed(2)} across ${dg.usableKeys} key(s)`
    );
  }
  const voip = result.voip;
  if (voip?.configured) {
    parts.push(voip.balance === null ? "VoIP: unknown" : `VoIP: $${Number(voip.balance).toFixed(2)}`);
  }
  if (result.trunk) {
    parts.push(result.trunk.tripped ? "VoIP trunk: REFUSING CALLS" : "VoIP trunk: ok");
  }
  return parts.join(" | ") || "no provider balances configured";
}
