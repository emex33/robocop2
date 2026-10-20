/**
 * Hard cap: the same phone number may be dialed at most 5 times in any
 * rolling hour. The next attempt is blocked until the oldest of those
 * calls falls outside the window.
 *
 * Count is per number (last 10 digits), not per lead, so the same person
 * on two lists still cannot be hammered. In-flight claims cover the gap
 * before the call is written to call_records.
 */

export const MAX_CALLS_PER_HOUR = 5;
export const HOUR_MS = 60 * 60 * 1000;

export function normalizePhoneKey(phone) {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < 7) return "";
  return digits.slice(-10);
}

export function parseCallTime(startedAt) {
  if (!startedAt) return 0;
  const raw = String(startedAt).trim();
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function hourCapMessage(phone, count = MAX_CALLS_PER_HOUR) {
  return `Blocked ${phone}: already called ${count} times in the last hour — maximum is ${MAX_CALLS_PER_HOUR}`;
}

export function createSqliteLoader(getDb) {
  return function loadPersistedStarts(key, userId, now, windowMs = HOUR_MS) {
    if (!key || !userId) return [];
    const cutoff = now - windowMs;
    const isoCutoff = new Date(cutoff).toISOString();
    const sqlCutoff = isoCutoff.slice(0, 19).replace("T", " ");
    const rows = getDb().prepare(`
      SELECT phone, started_at FROM call_records
      WHERE user_id = ?
        AND (
          (instr(started_at, 'T') > 0 AND started_at >= ?)
          OR (instr(started_at, 'T') = 0 AND started_at >= ?)
        )
    `).all(userId, isoCutoff, sqlCutoff);
    return rows
      .filter((row) => normalizePhoneKey(row.phone) === key)
      .map((row) => parseCallTime(row.started_at))
      .filter((t) => t >= cutoff);
  };
}

export function evaluateHourCap({
  phone,
  now = Date.now(),
  max = MAX_CALLS_PER_HOUR,
  windowMs = HOUR_MS,
  persistedStarts = [],
  reservedStarts = [],
} = {}) {
  const key = normalizePhoneKey(phone);
  if (!key) return { key: "", ok: false, count: 0, remaining: 0, reason: "empty" };
  const cutoff = now - windowMs;
  const persisted = persistedStarts.filter((t) => t >= cutoff).length;
  const reserved = reservedStarts.filter((t) => t >= cutoff).length;
  const count = persisted + reserved;
  return {
    key,
    ok: count < max,
    count,
    remaining: Math.max(0, max - count),
    max,
  };
}

export class HourCap {
  constructor({
    max = MAX_CALLS_PER_HOUR,
    windowMs = HOUR_MS,
    loadPersisted = () => [],
  } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.loadPersisted = loadPersisted;
    this.reserved = new Map();
    this.warnAt = new Map();
  }

  reset() {
    this.reserved.clear();
    this.warnAt.clear();
  }

  _reservedStarts(key, now) {
    const cutoff = now - this.windowMs;
    const kept = (this.reserved.get(key) || []).filter((t) => t >= cutoff);
    if (kept.length) this.reserved.set(key, kept);
    else this.reserved.delete(key);
    return kept;
  }

  inspect(phone, userId, now = Date.now()) {
    const key = normalizePhoneKey(phone);
    const persistedStarts = key ? this.loadPersisted(key, userId, now, this.windowMs) : [];
    const reservedStarts = key ? this._reservedStarts(key, now) : [];
    return evaluateHourCap({
      phone,
      now,
      max: this.max,
      windowMs: this.windowMs,
      persistedStarts,
      reservedStarts,
    });
  }

  peek(phone, userId, now = Date.now()) {
    return this.inspect(phone, userId, now);
  }

  claim(phone, userId, now = Date.now()) {
    const state = this.inspect(phone, userId, now);
    if (!state.key) return { ...state, token: 0 };
    if (!state.ok) return { ...state, token: 0 };
    const list = this.reserved.get(state.key) || [];
    list.push(now);
    this.reserved.set(state.key, list);
    return { ...state, ok: true, count: state.count + 1, remaining: state.remaining - 1, token: now };
  }

  release(phone, token) {
    const key = normalizePhoneKey(phone);
    if (!key || !token) return;
    const list = this.reserved.get(key);
    if (!list) return;
    const next = list.filter((t) => t !== token);
    if (next.length) this.reserved.set(key, next);
    else this.reserved.delete(key);
  }

  shouldLogBlock(phone, now = Date.now()) {
    const key = normalizePhoneKey(phone);
    if (!key) return false;
    const prev = this.warnAt.get(key) || 0;
    if (now - prev < 60_000) return false;
    this.warnAt.set(key, now);
    return true;
  }
}

export const hourCap = new HourCap();

export function attachHourCapDatabase(getDb) {
  hourCap.loadPersisted = createSqliteLoader(getDb);
}

/** Dry-run of the dial gate. Never places a SIP call. */
export function dryDial(phone, userId, cap = hourCap, now = Date.now()) {
  const slot = cap.claim(phone, userId, now);
  if (!slot.ok) {
    return {
      outcome: "skipped",
      blocked: true,
      count: slot.count,
      message: hourCapMessage(phone, slot.count || cap.max),
    };
  }
  cap.release(phone, slot.token);
  return { outcome: "dialed", blocked: false, count: slot.count };
}
