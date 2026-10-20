import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  MAX_CALLS_PER_HOUR,
  HOUR_MS,
  HourCap,
  normalizePhoneKey,
  parseCallTime,
  evaluateHourCap,
  hourCapMessage,
  dryDial,
  createSqliteLoader,
} from "./hour-cap.js";

const PHONE = "+49 170 1234567";
const USER = "user-test";

describe("normalizePhoneKey", () => {
  it("treats formatted, national and E.164 German numbers as the same key", () => {
    const key = normalizePhoneKey(PHONE);
    assert.equal(key, "1701234567");
    assert.equal(normalizePhoneKey("491701234567"), key);
    assert.equal(normalizePhoneKey("01701234567"), key);
    assert.equal(normalizePhoneKey("00 49 170-1234567"), key);
  });

  it("rejects empty or too-short values", () => {
    assert.equal(normalizePhoneKey(""), "");
    assert.equal(normalizePhoneKey("123"), "");
    assert.equal(normalizePhoneKey("not-a-phone"), "");
  });
});

describe("parseCallTime", () => {
  it("reads ISO and SQLite datetime strings", () => {
    const iso = parseCallTime("2026-10-20T14:00:00.000Z");
    const sql = parseCallTime("2026-10-20 14:00:00");
    assert.ok(iso > 0);
    assert.ok(sql > 0);
    assert.equal(iso, Date.parse("2026-10-20T14:00:00.000Z"));
    assert.equal(sql, Date.parse("2026-10-20T14:00:00Z"));
  });
});

describe("evaluateHourCap", () => {
  const now = Date.parse("2026-10-20T16:00:00Z");

  it("allows the first five and blocks the sixth", () => {
    const starts = [1, 2, 3, 4, 5].map((n) => now - n * 60_000);
    const atFive = evaluateHourCap({ phone: PHONE, now, persistedStarts: starts });
    assert.equal(atFive.ok, false);
    assert.equal(atFive.count, 5);
    assert.equal(atFive.remaining, 0);

    const atFour = evaluateHourCap({ phone: PHONE, now, persistedStarts: starts.slice(1) });
    assert.equal(atFour.ok, true);
    assert.equal(atFour.count, 4);
    assert.equal(atFour.remaining, 1);
  });

  it("ignores calls older than one hour", () => {
    const starts = [now - HOUR_MS - 1, now - 10_000];
    const state = evaluateHourCap({ phone: PHONE, now, persistedStarts: starts });
    assert.equal(state.ok, true);
    assert.equal(state.count, 1);
  });

  it("counts in-flight reservations toward the cap", () => {
    const state = evaluateHourCap({
      phone: PHONE,
      now,
      persistedStarts: [now - 1000, now - 2000, now - 3000],
      reservedStarts: [now - 4000, now - 5000],
    });
    assert.equal(state.ok, false);
    assert.equal(state.count, 5);
  });
});

describe("HourCap claim/release", () => {
  let cap;
  const now = Date.parse("2026-10-20T16:00:00Z");

  beforeEach(() => {
    cap = new HourCap({ loadPersisted: () => [] });
  });

  it("lets five claims through and blocks the sixth", () => {
    const tokens = [];
    for (let i = 0; i < MAX_CALLS_PER_HOUR; i++) {
      const slot = cap.claim(PHONE, USER, now + i);
      assert.equal(slot.ok, true, `claim ${i + 1} should succeed`);
      tokens.push(slot.token);
    }
    const blocked = cap.claim(PHONE, USER, now + 10);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.count, 5);
    assert.match(hourCapMessage(PHONE, blocked.count), /Blocked/);
    assert.match(hourCapMessage(PHONE, blocked.count), /5 times/);
    assert.match(hourCapMessage(PHONE, blocked.count), /hour/);
    cap.release(PHONE, tokens[0]);
    const afterRelease = cap.claim(PHONE, USER, now + 11);
    assert.equal(afterRelease.ok, true);
  });

  it("does not share the cap across different numbers", () => {
    for (let i = 0; i < 5; i++) cap.claim(PHONE, USER, now + i);
    const other = cap.claim("491609998877", USER, now + 20);
    assert.equal(other.ok, true);
  });

  it("allows the number again after the hour window", () => {
    for (let i = 0; i < 5; i++) cap.claim(PHONE, USER, now + i);
    const later = cap.claim(PHONE, USER, now + HOUR_MS + 1);
    assert.equal(later.ok, true);
  });

  it("rate-limits the yellow warning to once a minute", () => {
    assert.equal(cap.shouldLogBlock(PHONE, now), true);
    assert.equal(cap.shouldLogBlock(PHONE, now + 1000), false);
    assert.equal(cap.shouldLogBlock(PHONE, now + 60_000), true);
  });
});

describe("dry dial (no SIP)", () => {
  it("dials five times then blocks", () => {
    const persisted = [];
    const cap = new HourCap({
      loadPersisted: () => persisted,
    });
    const results = [];
    for (let i = 0; i < 6; i++) {
      const decision = dryDial(PHONE, USER, cap, Date.parse("2026-10-20T16:00:00Z") + i);
      if (decision.outcome === "dialed") persisted.push(Date.parse("2026-10-20T16:00:00Z") + i);
      results.push(decision);
    }
    assert.equal(results.filter((r) => r.outcome === "dialed").length, 5);
    assert.equal(results[5].blocked, true);
    assert.equal(results[5].outcome, "skipped");
    assert.match(results[5].message, /maximum is 5/);
  });
});

describe("sqlite loader smoke", () => {
  it("counts only matching phones inside the hour", async () => {
    let Database;
    try {
      ({ default: Database } = await import("better-sqlite3"));
    } catch {
      return;
    }
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE call_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        started_at TEXT NOT NULL
      )
    `);
    const now = Date.parse("2026-10-20T16:00:00Z");
    const insert = db.prepare("INSERT INTO call_records (id, user_id, phone, started_at) VALUES (?, ?, ?, ?)");
    insert.run("1", USER, "+49 170 1234567", new Date(now - 10 * 60_000).toISOString());
    insert.run("2", USER, "491701234567", "2026-10-20 15:20:00");
    insert.run("3", USER, "01701234567", new Date(now - 20 * 60_000).toISOString());
    insert.run("4", USER, "491701234567", new Date(now - 30 * 60_000).toISOString());
    insert.run("5", USER, "491701234567", new Date(now - 40 * 60_000).toISOString());
    insert.run("old", USER, "491701234567", new Date(now - HOUR_MS - 60_000).toISOString());
    insert.run("other", USER, "491609998877", new Date(now - 5 * 60_000).toISOString());

    const cap = new HourCap({ loadPersisted: createSqliteLoader(() => db) });
    const peek = cap.peek(PHONE, USER, now);
    assert.equal(peek.count, 5);
    assert.equal(peek.ok, false);

    const sixth = cap.claim(PHONE, USER, now);
    assert.equal(sixth.ok, false);

    const other = cap.claim("491609998877", USER, now);
    assert.equal(other.ok, true);
    db.close();
  });
});
