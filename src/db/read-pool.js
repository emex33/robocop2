/**
 * Off-thread read queries.
 *
 * better-sqlite3 is synchronous: a 900 ms COUNT over call_records blocks the
 * main thread for 900 ms, and the main thread is also what paces RTP audio
 * for every live call (20 ms frames). Measured 2026-09-11: opening a campaign
 * page froze the loop 0.9 s, the appointments page 1.7 s, billing usage 0.7 s —
 * each one a burst of garbled audio on all 35 lines at once.
 *
 * Heavy dashboard reads go through here instead: a worker thread with its own
 * read-only connection (SQLite WAL allows concurrent readers alongside the
 * writer). The main thread only marshals the result rows.
 *
 *   const rows = await queryAll(sql, params);
 *   const row  = await queryGet(sql, params);
 *
 * Writes and small indexed lookups stay on the main connection.
 */
import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";
import { DB_PATH } from "./schema.js";
import logger from "../utils/logger.js";

const WORKERS = Number(process.env.DB_READ_WORKERS) || 2;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workers = [];
const pending = new Map();
let nextId = 1;
let rr = 0;

function spawn(slot) {
  const w = new Worker(path.join(__dirname, "read-worker.js"), { workerData: { dbPath: DB_PATH } });
  w.on("message", ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  w.on("error", (e) => logger.error(`[read-pool] worker error: ${e.message}`));
  w.on("exit", (code) => {
    // Fail whatever was in flight on this worker and replace it.
    for (const [id, p] of pending) if (p.slot === slot) { pending.delete(id); p.reject(new Error("read worker exited")); }
    if (!shuttingDown) {
      logger.warn(`[read-pool] worker ${slot} exited (${code}), respawning`);
      workers[slot] = spawn(slot);
    }
  });
  w.unref();
  return w;
}

let started = false;
let shuttingDown = false;
function ensureStarted() {
  if (started) return;
  started = true;
  for (let i = 0; i < WORKERS; i++) workers[i] = spawn(i);
}

function run(sql, params, method) {
  ensureStarted();
  const id = nextId++;
  const slot = rr++ % WORKERS;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, slot });
    workers[slot].postMessage({ id, sql, params, method });
  });
}

export const queryAll = (sql, params = []) => run(sql, params, "all");
export const queryGet = (sql, params = []) => run(sql, params, "get");

/** Warm the workers at boot so the first dashboard request does not pay for thread start. */
export function startReadPool() {
  ensureStarted();
  queryGet("SELECT 1 AS ok").catch((e) => logger.error(`[read-pool] self-test failed: ${e.message}`));
}
