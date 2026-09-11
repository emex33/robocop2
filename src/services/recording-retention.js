/**
 * Recording retention.
 *
 * At 35 concurrent lines the recordings folder grows by ~3,500 files/hour, most
 * of them voicemails and no-answers nobody will ever listen to. This job keeps
 * what matters and drops the rest:
 *
 *   appointments / callbacks / interested / transferred  -> RECORDING_KEEP_IMPORTANT_DAYS  (default 30)
 *   real conversations (>= 4 transcript turns)           -> RECORDING_KEEP_CONVERSATION_DAYS (default 3)
 *   everything else (voicemail, no answer, timeout...)   -> RECORDING_KEEP_OTHER_HOURS       (default 2)
 *   files on disk with no call_records row              -> 1 day
 *
 * When a file is deleted, call_records.recording_path is cleared so the UI
 * hides the play button instead of returning 404.
 */
import fs from "fs";
import path from "path";
import { getDb } from "../db/schema.js";
import logger from "../utils/logger.js";
import { noteActivity } from "../utils/loop-monitor.js";
import { queryAll } from "../db/read-pool.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/data/recordings";
const IMPORTANT_DAYS = Number(process.env.RECORDING_KEEP_IMPORTANT_DAYS) || 30;
const CONVERSATION_DAYS = Number(process.env.RECORDING_KEEP_CONVERSATION_DAYS) || 3;
const OTHER_HOURS = Number(process.env.RECORDING_KEEP_OTHER_HOURS) || 2;
const ORPHAN_DAYS = 1;
const IMPORTANT_OUTCOMES = ["appointment_set", "callback", "interested", "transferred"];

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600_000, D = 24 * H;

// Everything here is async on purpose. The recordings folder is a Docker bind
// mount (slow per-file syscalls) with tens of thousands of files; a synchronous
// stat/unlink loop blocked the event loop for seconds, which froze the RTP send
// loop of every live call (choppy audio, missing words) while the job ran.
const fsp = fs.promises;
let running = false;

export async function runRecordingRetention() {
  if (running) return null;
  running = true;
  try {
    return await retentionPass();
  } finally {
    running = false;
  }
}

async function retentionPass() {
  const db = getDb();
  const stats = { important: 0, conversation: 0, other: 0, orphan: 0, bytes: 0, missing: 0 };
  const clear = db.prepare("UPDATE call_records SET recording_path = '' WHERE id = ?");

  const remove = async (row, bucket) => {
    try {
      const st = await fsp.stat(row.recording_path);
      await fsp.unlink(row.recording_path);
      stats.bytes += st.size;
      stats[bucket]++;
    } catch (e) {
      if (e.code === "ENOENT") stats.missing++;
      else { logger.warn(`[retention] could not delete ${row.recording_path}: ${e.message}`); return; }
    }
    clear.run(row.id);
  };

  const inList = IMPORTANT_OUTCOMES.map(() => "?").join(",");
  const base = "SELECT id, recording_path FROM call_records WHERE recording_path <> '' AND started_at < ?";

  // The SELECTs scan a lot of call_records (json_array_length over transcripts
  // measured ~0.8 s) — run them in the read-pool worker, not on the main thread.

  // 1) no-conversation calls: short retention
  const others = await queryAll(`${base} AND outcome NOT IN (${inList}) AND json_array_length(COALESCE(transcript_json,'[]')) < 4 LIMIT 5000`,
    [isoAgo(OTHER_HOURS * H), ...IMPORTANT_OUTCOMES]);
  for (const r of others) await remove(r, "other");

  // 2) real conversations that did not convert
  const convos = await queryAll(`${base} AND outcome NOT IN (${inList}) LIMIT 5000`,
    [isoAgo(CONVERSATION_DAYS * D), ...IMPORTANT_OUTCOMES]);
  for (const r of convos) await remove(r, "conversation");

  // 3) important calls: long retention
  const important = await queryAll(`${base} AND outcome IN (${inList}) LIMIT 5000`,
    [isoAgo(IMPORTANT_DAYS * D), ...IMPORTANT_OUTCOMES]);
  for (const r of important) await remove(r, "important");

  // 4) orphan files (no DB row, e.g. crashed calls) older than ORPHAN_DAYS
  try {
    const known = new Set(
      (await queryAll("SELECT recording_path FROM call_records WHERE recording_path <> '' AND started_at >= ?",
        [isoAgo((IMPORTANT_DAYS + 1) * D)])).map(r => path.basename(r.recording_path))
    );
    const cutoff = Date.now() - ORPHAN_DAYS * D;
    for (const name of await fsp.readdir(RECORDINGS_DIR)) {
      if (known.has(name)) continue;
      const full = path.join(RECORDINGS_DIR, name);
      try {
        const st = await fsp.stat(full);
        if (st.isFile() && st.mtimeMs < cutoff) { await fsp.unlink(full); stats.orphan++; stats.bytes += st.size; }
      } catch {}
    }
  } catch (e) {
    logger.warn(`[retention] orphan scan failed: ${e.message}`);
  }

  const total = stats.important + stats.conversation + stats.other + stats.orphan;
  if (total || stats.missing) {
    logger.info(`[retention] removed ${total} recordings (${(stats.bytes / 1048576).toFixed(0)} MB): ` +
      `${stats.other} no-conversation, ${stats.conversation} conversations >${CONVERSATION_DAYS}d, ` +
      `${stats.important} important >${IMPORTANT_DAYS}d, ${stats.orphan} orphans; ${stats.missing} already gone`);
  }
  return stats;
}

/** Run shortly after boot, then every 15 minutes. */
export function scheduleRecordingRetention() {
  const tick = () => { noteActivity("job: recording retention"); runRecordingRetention().catch((e) => logger.error(`[retention] ${e.message}`)); };
  setTimeout(tick, 60_000);
  setInterval(tick, 15 * 60_000);
  logger.info(`[retention] recordings: important ${IMPORTANT_DAYS}d, conversations ${CONVERSATION_DAYS}d, other ${OTHER_HOURS}h`);
}
