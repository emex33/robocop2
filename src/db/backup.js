/**
 * Nightly SQLite backup.
 *
 * The live database lives on a Docker volume (fast, but invisible from
 * Windows). Once a night — 03:30 Amsterdam, well outside calling hours — a
 * consistent copy is written to ./data/backups (the bind mount the user can
 * see and that OneDrive syncs). better-sqlite3's online backup API copies in
 * small page batches between event-loop turns, so nothing blocks.
 * Only the newest KEEP copies are retained.
 */

import path from "path";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from "fs";
import { getDb, DB_PATH } from "./schema.js";
import logger from "../utils/logger.js";

const BACKUP_DIR = path.resolve("data", "backups");
const KEEP = 2;
const HOUSE_TZ = "Europe/Amsterdam";
const RUN_AT = { hour: 3, minute: 30 };

let running = false;

function houseParts(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: HOUSE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, minute: Number(o.minute) };
}

export async function runBackup(reason = "scheduled") {
  if (running) return null;
  running = true;
  const t0 = Date.now();
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
    const { day } = houseParts();
    const dest = path.join(BACKUP_DIR, `robocop-${day}.db`);
    const tmp = dest + ".partial";
    if (existsSync(tmp)) unlinkSync(tmp);
    await getDb().backup(tmp);
    if (existsSync(dest)) unlinkSync(dest);
    renameSync(tmp, dest);
    const mb = (statSync(dest).size / 1048576).toFixed(0);
    logger.info(`[backup] ${reason}: wrote ${dest} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s from ${DB_PATH}`);
    prune();
    return dest;
  } catch (e) {
    logger.error(`[backup] failed: ${e.message}`);
    return null;
  } finally {
    running = false;
  }
}

function prune() {
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => /^robocop-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse();
  for (const f of files.slice(KEEP)) {
    try { unlinkSync(path.join(BACKUP_DIR, f)); logger.info(`[backup] pruned ${f}`); } catch {}
  }
}

/** Check once a minute; fire at RUN_AT house time, at most once per day. */
export function scheduleNightlyBackup() {
  let lastDay = "";
  setInterval(() => {
    const { day, hour, minute } = houseParts();
    if (day !== lastDay && hour === RUN_AT.hour && minute >= RUN_AT.minute) {
      lastDay = day;
      runBackup("nightly").catch(() => {});
    }
  }, 60_000).unref();
  logger.info(`[backup] nightly copy scheduled at ${String(RUN_AT.hour).padStart(2, "0")}:${String(RUN_AT.minute).padStart(2, "0")} ${HOUSE_TZ} → ${BACKUP_DIR} (keep ${KEEP})`);
}
