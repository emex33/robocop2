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

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/data/recordings";
const IMPORTANT_DAYS = Number(process.env.RECORDING_KEEP_IMPORTANT_DAYS) || 30;
const CONVERSATION_DAYS = Number(process.env.RECORDING_KEEP_CONVERSATION_DAYS) || 3;
const OTHER_HOURS = Number(process.env.RECORDING_KEEP_OTHER_HOURS) || 2;
const ORPHAN_DAYS = 1;
const IMPORTANT_OUTCOMES = ["appointment_set", "callback", "interested", "transferred"];

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600_000, D = 24 * H;

export function runRecordingRetention() {
  const db = getDb();
  const stats = { important: 0, conversation: 0, other: 0, orphan: 0, bytes: 0, missing: 0 };
  const clear = db.prepare("UPDATE call_records SET recording_path = '' WHERE id = ?");

  const remove = (row, bucket) => {
    try {
      const st = fs.statSync(row.recording_path);
      fs.unlinkSync(row.recording_path);
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

  // 1) no-conversation calls: short retention
  const others = db.prepare(`${base} AND outcome NOT IN (${inList}) AND json_array_length(COALESCE(transcript_json,'[]')) < 4 LIMIT 5000`)
    .all(isoAgo(OTHER_HOURS * H), ...IMPORTANT_OUTCOMES);
  for (const r of others) remove(r, "other");

  // 2) real conversations that did not convert
  const convos = db.prepare(`${base} AND outcome NOT IN (${inList}) LIMIT 5000`)
    .all(isoAgo(CONVERSATION_DAYS * D), ...IMPORTANT_OUTCOMES);
  for (const r of convos) remove(r, "conversation");

  // 3) important calls: long retention
  const important = db.prepare(`${base} AND outcome IN (${inList}) LIMIT 5000`)
    .all(isoAgo(IMPORTANT_DAYS * D), ...IMPORTANT_OUTCOMES);
  for (const r of important) remove(r, "important");

  // 4) orphan files (no DB row, e.g. crashed calls) older than ORPHAN_DAYS
  try {
    const known = new Set(
      db.prepare("SELECT recording_path FROM call_records WHERE recording_path <> '' AND started_at >= ?")
        .all(isoAgo((IMPORTANT_DAYS + 1) * D)).map(r => path.basename(r.recording_path))
    );
    const cutoff = Date.now() - ORPHAN_DAYS * D;
    for (const name of fs.readdirSync(RECORDINGS_DIR)) {
      if (known.has(name)) continue;
      const full = path.join(RECORDINGS_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(full); stats.orphan++; stats.bytes += st.size; }
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
  const tick = () => { try { runRecordingRetention(); } catch (e) { logger.error(`[retention] ${e.message}`); } };
  setTimeout(tick, 60_000);
  setInterval(tick, 15 * 60_000);
  logger.info(`[retention] recordings: important ${IMPORTANT_DAYS}d, conversations ${CONVERSATION_DAYS}d, other ${OTHER_HOURS}h`);
}
