/**
 * Worker thread that runs read-only SQL against the same SQLite file.
 * See read-pool.js for why this exists.
 */
import { parentPort, workerData } from "worker_threads";
import Database from "better-sqlite3";

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 30000");
db.pragma("cache_size = -65536");
db.pragma("mmap_size = 268435456");
db.pragma("temp_store = MEMORY");

const stmts = new Map();
function prepare(sql) {
  let s = stmts.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmts.set(sql, s);
    if (stmts.size > 200) stmts.delete(stmts.keys().next().value);
  }
  return s;
}

parentPort.on("message", ({ id, sql, params, method }) => {
  try {
    const stmt = prepare(sql);
    const result = method === "get" ? stmt.get(...params) : stmt.all(...params);
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
