/**
 * Balance Guard
 *
 * Stops dialing when an upstream provider runs out of money, and retries
 * every few minutes so a mid-window top-up starts calling again the same day.
 *
 *   - Deepgram: live balance summed across the user's API key pool.
 *   - VoIP (MMDsmart): balance from a configured HTTP endpoint, or a figure
 *     maintained manually in platform settings when no API is available.
 *
 * Results are cached because the scheduler evaluates this every minute.
 *
 * Mostly fail-open: if a balance cannot be read but the provider answered, the
 * guard allows dialing, so a flaky balance endpoint never halts a campaign.
 *
 * The exception is an unreachable Deepgram. No route to Deepgram means no
 * speech and no AI, so dialing on would connect real leads to silence — there
 * the guard fails closed and retries every minute instead.
 */

import { getDb } from "../db/schema.js";
import { getPlatformSetting } from "../db/helpers.js";
import { deepgramKeyManager } from "../deepgram/key-manager.js";
import logger from "../utils/logger.js";

const BALANCE_TTL_MS = 5 * 60 * 1000;
const DEEPGRAM_TTL_MS = 60 * 1000; // pool refresh every minute so a $5 key is swapped before it dies mid-campaign
const cache = new Map(); // cacheKey -> { ts, value }
const unreachableStreak = new Map(); // userId -> consecutive "Deepgram unreachable" probes

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
 * True when a request never reached the provider at all (DNS, refused, dropped,
 * timed out) as opposed to being answered with an error status.
 *
 * The difference decides whether we may keep dialing: an HTTP error still means
 * Deepgram is there and the balance is merely unknown, but an unreachable host
 * means no call can be transcribed.
 */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH",
  "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function isUnreachableError(err) {
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const codes = [err.code, err.cause?.code, err.cause?.cause?.code].filter(Boolean);
  if (codes.some((c) => UNREACHABLE_CODES.has(c))) return true;
  return /fetch failed|network|socket hang up/i.test(err.message || "");
}

/**
 * fetch with a hard deadline. Without this a single stalled provider request
 * hangs the scheduler tick forever, which silently disables calling-window
 * enforcement (campaigns then dial around the clock).
 */
async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

/**
 * Hosts that serve the Management API, in preference order.
 *
 * Deepgram serves it on both api.deepgram.com and manage.deepgram.com. Those
 * sit on different networks — during the Sept outage api.deepgram.com was
 * unroutable from this server while manage.deepgram.com answered normally — so
 * trying both is what lets the pool still be audited during a partial block.
 */
const MANAGEMENT_HOSTS = ["https://api.deepgram.com", "https://manage.deepgram.com"];

/**
 * Last host that actually answered, tried first next time.
 *
 * Without this every cycle re-pays the 10s timeout on the dead host before
 * falling through to the live one — for eight keys that is the difference
 * between fitting the scheduler's deadline and blowing straight past it.
 */
let preferredManagementHost = null;

function managementHosts() {
  if (!preferredManagementHost) return MANAGEMENT_HOSTS;
  return [preferredManagementHost, ...MANAGEMENT_HOSTS.filter((h) => h !== preferredManagementHost)];
}

/** Host that carries live call audio; if this is down, dialing is pointless. */
function voiceAgentHost() {
  const url = process.env.DEEPGRAM_VOICE_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
  try {
    return new URL(url).host;
  } catch {
    return "agent.deepgram.com";
  }
}

/**
 * Live Deepgram balance for one API key (sums all projects on that key).
 * Returns null when the balance could not be read, 0 when the key is dead.
 * Throws only when no management host could be reached at all.
 */
async function deepgramKeyBalance(apiKey) {
  const headers = { Authorization: `Token ${apiKey}` };
  let lastError = null;

  for (const host of managementHosts()) {
    let projectsRes;
    try {
      projectsRes = await fetchWithTimeout(`${host}/v1/projects`, { headers });
    } catch (err) {
      lastError = err;
      continue; // host unroutable — try the next one
    }

    preferredManagementHost = host;

    if (!projectsRes.ok) {
      // Revoked, deactivated or otherwise refused: the host answered, so this is
      // a verdict about the key rather than about the network.
      if (projectsRes.status === 401 || projectsRes.status === 403) return 0;
      return null;
    }

    const { projects = [] } = await projectsRes.json();
    let total = 0;
    for (const p of projects) {
      const res = await fetchWithTimeout(`${host}/v1/projects/${p.project_id}/balances`, { headers });
      if (!res.ok) return null;
      const { balances = [] } = await res.json();
      total += balances.reduce((sum, b) => sum + (b.amount || 0), 0);
    }
    return total;
  }

  throw lastError || new Error("No Deepgram management host reachable");
}

/**
 * One-off key check behind the dashboard "Test" button.
 *
 * Tries every management host, so a blocked api.deepgram.com does not make a
 * perfectly good key show "fetch failed" in red. When nothing is reachable it
 * says so plainly: that is a verdict about the network, not about the key.
 */
export async function testDeepgramKey(apiKey) {
  const headers = { Authorization: `Token ${apiKey}` };
  let lastError = null;

  for (const host of managementHosts()) {
    let r;
    try {
      r = await fetchWithTimeout(`${host}/v1/projects`, { headers });
    } catch (err) {
      lastError = err;
      continue;
    }
    preferredManagementHost = host;
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      let balance = null;
      try { balance = await deepgramKeyBalance(apiKey); } catch { /* shown as unknown */ }
      return {
        success: true,
        status: r.status,
        project: data.projects?.[0]?.name || "Unknown",
        balance,
        host: new URL(host).host,
      };
    }

    const rejected = r.status === 401 || r.status === 403;
    return {
      success: false,
      status: r.status,
      error: rejected
        ? "Rejected by Deepgram — key is deactivated or invalid"
        : (data.details || data.message || r.statusText),
      host: new URL(host).host,
    };
  }

  const code = lastError?.cause?.code || lastError?.name || "network error";
  return {
    success: false,
    status: null,
    unreachable: true,
    error: `Could not reach Deepgram from this server (${code}) — key not tested`,
  };
}

/**
 * Can this server actually open a call leg to Deepgram?
 *
 * Balances now read from manage.deepgram.com, which stayed up when the audio
 * host did not. Without a separate probe the guard would see healthy balances
 * and happily dial into an unusable audio path — which is precisely the
 * dead-air failure it exists to prevent.
 */
async function voiceAgentReachable() {
  const host = voiceAgentHost();
  try {
    // Any HTTP answer (even 400/401) proves the host is routable.
    await fetchWithTimeout(`https://${host}/v1/agent/converse`, { method: "GET" });
    return true;
  } catch (err) {
    if (isUnreachableError(err)) return false;
    return true; // answered with something — the route is alive
  }
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
  let unreachable = 0;
  const reactivated = [];
  const deactivated = [];

  // Started now and awaited at the end so it overlaps the balance reads rather
  // than adding its own timeout on top of them.
  const audioProbe = voiceAgentReachable();

  // Probed in parallel: one round trip for the whole pool instead of one each.
  // Serial checks at 10s apiece meant 8 keys took 80s, which blew the
  // scheduler's 20s deadline — and a timed-out evaluation was treated as "no
  // verdict" and let the campaign dial unguarded, defeating the whole check.
  const probes = await Promise.all(keys.map(async (k) => {
    try {
      return { k, balance: await deepgramKeyBalance(k.api_key), unreachable: false };
    } catch (err) {
      logger.warn(`[balance-guard] Deepgram balance check failed for "${k.label || k.id}": ${err.message}`);
      return { k, balance: null, unreachable: isUnreachableError(err) };
    }
  }));

  for (const probe of probes) {
    const k = probe.k;
    const balance = probe.balance;
    if (probe.unreachable) unreachable++;

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

  // Deepgram is not reachable from this host at all. This is the one balance
  // failure we must NOT fail open on: without Deepgram there is no speech and no
  // AI, so every call connects to silence. Before this check existed an 8-day
  // network block to Deepgram's API ranges put ~83k leads through to dead air,
  // burning carrier minutes the whole time. Stop dialing; the scheduler re-checks
  // each minute, so calling resumes on its own the moment the route is back.
  if (unreachable > 0 && unreachable === keys.length) {
    return {
      configured: true, ok: false, unreachable: true, total: null,
      usableKeys: 0, unknown, reactivated, deactivated,
    };
  }

  // Balances readable but the audio path is not: funded keys are useless if no
  // call can stream to Deepgram.
  if (!(await audioProbe)) {
    return {
      configured: true, ok: false, unreachable: true, audioPathDown: true,
      total, usableKeys, unknown, reactivated, deactivated, minBalance,
    };
  }

  // Reachable but unreadable (HTTP errors) → balance genuinely unknown, fail open.
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
 * Funds (402, or a 486/etc whose reason says "low balance") retry every 5
 * minutes and never back off — a top-up mid-window should start dialing again
 * the same afternoon. Trunk blocks (403/503/auth) still need consecutive
 * failures and still escalate, so a carrier outage doesn't flap.
 * -------------------------------------------------------------------------- */

const FUNDS_CODES = new Set([402]);              // explicit "pay up"
const TRUNK_BLOCK_CODES = new Set([401, 403, 407, 503]); // rejected / unavailable / auth

/**
 * Carriers rarely send 402. MMDsmart rejects an unfunded account with
 * "486 rpc error: code = Unknown desc = authorize reply low balance", which
 * looks identical to a busy line unless the reason phrase is read.
 */
const FUNDS_REASON_RE = /low balance|insufficient\s+(funds|balance|credit)|not enough\s+(funds|credit|balance)|no\s+balance|out of credit|negative balance|payment required|balance\s+(is\s+)?(too\s+)?low/i;

/**
 * An unfunded account is not a failing trunk: nothing improves by waiting
 * longer, and the moment it is topped up we want to be dialing again. So a
 * funds trip retries on a short fixed interval and never escalates — otherwise
 * a mid-afternoon top-up sat unused because the breaker had already backed off
 * to its two-hour ceiling and wrote off the rest of the day.
 */
const FUNDS_RETRY_MS = 5 * 60 * 1000;
const CONSECUTIVE_FUNDS_TRIP = 3;
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
  consecutiveFunds: 0,
  trippedAt: null,
  reason: "",
  kind: null,   // "funds" = unpaid account (short retry) | "block" = failing trunk
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

/**
 * Operator switch. When the carrier is known to be funded and healthy, a run
 * of bare 503s is not a reason to stop the floor — the operator would rather
 * keep dialing through it. Off = never trip, never hold campaigns for the trunk.
 */
function breakerEnabled() {
  return getPlatformSetting("voip_trunk_breaker", "on") !== "off";
}

function tripTrunk(reason, kind = "block") {
  if (!breakerEnabled()) {
    logger.warn(`[balance-guard] VoIP trunk would trip (${reason}) — breaker is OFF, continuing to dial`);
    trunk.consecutiveBlocks = 0;
    trunk.consecutiveFailures = 0;
    trunk.consecutiveFunds = 0;
    return;
  }
  if (trunk.trippedAt) return;
  trunk.trippedAt = Date.now();
  trunk.kind = kind;
  // Funds trips deliberately skip the counter so they never back off.
  if (kind !== "funds") trunk.tripCount++;
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
  trunk.consecutiveFunds = 0;
  pushWindow(true);

  if (trunk.trippedAt) {
    const rate = windowRate();
    if (rate === null || rate >= WINDOW_CLEAR_RATE) {
      logger.info(`[balance-guard] VoIP trunk recovered (connect rate ${rate === null ? "n/a" : Math.round(rate * 100) + "%"}) — breaker cleared`);
      trunk.trippedAt = null;
      trunk.reason = "";
      trunk.kind = null;
      trunk.tripCount = 0;
    }
    return;
  }

  // Forget past trips once the trunk has proved itself healthy again.
  //
  // tripCount previously only ever grew: it is reset when a success arrives
  // while the breaker is still tripped, but a tripped breaker stops dialing, so
  // that success could never happen. Recovery instead came from the cool-down
  // expiring, which left tripCount untouched — so every trip doubled the next
  // wait until it pinned at the 2h ceiling. A carrier hiccup that cleared in
  // minutes then parked dialing for the rest of the calling window.
  if (trunk.tripCount > 0) {
    const rate = windowRate();
    if (rate !== null && rate >= WINDOW_CLEAR_RATE) {
      logger.info(`[balance-guard] VoIP trunk healthy again (connect rate ${Math.round(rate * 100)}% over ${trunk.window.length} calls) — trip history reset`);
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

  // Checked first, and before the per-lead codes below: the carrier reports an
  // unfunded account as a 486, which would otherwise be waved through as a busy
  // line until 40 calls had been wasted proving the obvious.
  const reasonText = String(message || "").trim();
  const looksLikeFunds = (code && FUNDS_CODES.has(code)) || FUNDS_REASON_RE.test(reasonText);
  if (looksLikeFunds) {
    trunk.consecutiveFunds++;
    const detail = reasonText ? ` (carrier said: "${reasonText}")` : (code ? ` (SIP ${code})` : "");
    // 402 is unambiguous "pay up". Phrase-matched 486s wait for a short run so one
    // garbled busy signal cannot pause the day.
    if ((code && FUNDS_CODES.has(code)) || trunk.consecutiveFunds >= CONSECUTIVE_FUNDS_TRIP) {
      tripTrunk(
        `VoIP account is out of funds${detail} — top up to resume; retrying every ${FUNDS_RETRY_MS / 60000} min`,
        "funds"
      );
    }
    return;
  }
  trunk.consecutiveFunds = 0;

  // A pathological connect rate means the carrier is refusing traffic regardless of
  // which codes it returns.
  const rate = windowRate();
  if (rate !== null && rate < WINDOW_TRIP_RATE) {
    // MMDsmart reports an empty account as 486. If nothing is connecting and
    // the last code was 486, this is almost certainly funds — retry in minutes,
    // not hours, so a top-up the same afternoon is not wasted.
    const kind = code === 486 ? "funds" : "block";
    const retryNote = kind === "funds"
      ? ` — top up to resume; retrying every ${FUNDS_RETRY_MS / 60000} min`
      : "";
    tripTrunk(
      `VoIP trunk connect rate collapsed to ${Math.round(rate * 100)}% over the last ${trunk.window.length} calls — carrier is refusing traffic${retryNote}`,
      kind
    );
    return;
  }

  // The trunk answered about this specific number — it's alive and routing.
  if (code && PER_LEAD_CODES.has(code)) {
    trunk.consecutiveBlocks = 0;
    trunk.consecutiveFailures = 0;
    return;
  }

  trunk.consecutiveFailures++;

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
  if (!breakerEnabled()) {
    if (trunk.trippedAt) {
      logger.info("[balance-guard] VoIP breaker switched OFF — clearing trip and resuming");
      trunk.trippedAt = null; trunk.reason = ""; trunk.kind = null;
    }
    const rate = windowRate();
    return { ok: true, tripped: false, disabled: true, lastStatus: trunk.lastStatus, connectRate: rate === null ? null : Math.round(rate * 100) };
  }
  if (!trunk.trippedAt) {
    return { ok: true, tripped: false, lastStatus: trunk.lastStatus };
  }

  const cooldown = trunk.kind === "funds"
    ? FUNDS_RETRY_MS
    : Math.min(BASE_COOLDOWN_MS * 2 ** (trunk.tripCount - 1), MAX_COOLDOWN_MS);
  const elapsed = Date.now() - trunk.trippedAt;
  if (elapsed >= cooldown) {
    logger.info(`[balance-guard] VoIP breaker cool-down elapsed (${Math.round(cooldown / 60000)}m) — retrying trunk`);
    trunk.trippedAt = null;
    trunk.reason = "";
    trunk.kind = null;
    trunk.consecutiveBlocks = 0;
    trunk.consecutiveFailures = 0;
    trunk.consecutiveFunds = 0;
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
  let deepgram = await withCache(`dg:${userId}`, () =>
    checkDeepgram(userId).catch((err) => {
      logger.warn(`[balance-guard] Deepgram check error: ${err.message}`);
      return { configured: true, ok: true, total: null, error: err.message };
    }),
  DEEPGRAM_TTL_MS);

  // Hysteresis for "unreachable": one failed probe (a DNS hiccup, a 2s
  // timeout) used to pause every campaign, dump its dial buffer, then restart
  // it a minute later — visible as "campaign stuck" and a fresh "Starting call
  // queue" in the logs. Only act once the route has been down on two
  // consecutive fresh probes (>= 1 minute apart). A genuine outage still stops
  // dialing within ~2 minutes; live calls already signal failure on their own.
  if (deepgram.unreachable && !deepgram.ok) {
    cache.delete(`dg:${userId}`); // force a real re-probe on the next tick
    const n = (unreachableStreak.get(userId) || 0) + 1;
    unreachableStreak.set(userId, n);
    if (n < 2) {
      logger.warn(`[balance-guard] Deepgram probe failed once for user ${userId} — not pausing yet (needs 2 consecutive)`);
      deepgram = { ...deepgram, ok: true, provisional: true };
    }
  } else {
    unreachableStreak.delete(userId);
  }

  if (!guardEnabled) {
    return { ok: true, disabled: true, reasons: [], deepgram, voip: null };
  }

  const voip = await withCache(`voip`, checkVoip, BALANCE_TTL_MS);

  const trunkState = checkTrunk();

  const reasons = [];
  if (!deepgram.ok) {
    reasons.push(
      deepgram.audioPathDown
        ? `Deepgram audio host (${voiceAgentHost()}) is unreachable — calls would connect to silence; retrying every minute`
        : deepgram.unreachable
          ? "Deepgram is unreachable from this server — calls would connect to silence; retrying every minute"
          : `All Deepgram API keys are out of balance (no key above $${(deepgram.minBalance ?? 0).toFixed(2)})`
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
