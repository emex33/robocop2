/**
 * Process heartbeat + offline-gap detection.
 *
 * Robocop can only dial while the process exists. On 10 Sep 2026 Windows Update
 * rebooted the host at 04:30 and Docker Desktop did not come back until 15:55,
 * so the 15:00 window opened with nobody home — and nothing in the dashboard
 * said why. The heartbeat stores "last seen alive" every 30s; on boot we
 * compare it with now and, if the gap is meaningful, log it and keep it so the
 * Command Center can show "Robocop was offline 04:33–15:58".
 */

import { getDb } from "../db/schema.js";
import { getPlatformSetting, setPlatformSetting } from "../db/helpers.js";
import logger from "./logger.js";

const HEARTBEAT_MS = 30_000;
const GAP_THRESHOLD_MS = 3 * 60_000;

function beat() {
  try { setPlatformSetting("heartbeat_at", new Date().toISOString()); } catch {}
}

/**
 * Detect an offline gap since the previous run, record it, start beating.
 * @returns {{from:string,to:string,minutes:number}|null} the gap, if any
 */
export function startHeartbeat() {
  getDb();
  let gap = null;
  const last = getPlatformSetting("heartbeat_at", "");
  const now = new Date();
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && now - lastMs > GAP_THRESHOLD_MS) {
      gap = { from: new Date(lastMs).toISOString(), to: now.toISOString(), minutes: Math.round((now - lastMs) / 60000) };
      logger.warn(`[heartbeat] Robocop was OFFLINE for ${gap.minutes} min (${gap.from} → ${gap.to}). ` +
        "The process was not running — host reboot, Docker Desktop stopped, or container down. " +
        "Campaigns marked 'running' resume with the scheduler within 60s.");
      try { setPlatformSetting("last_offline_gap", JSON.stringify(gap)); } catch {}
    }
  }
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
  return gap;
}

/** Last recorded offline gap (or null). */
export function getLastOfflineGap() {
  try {
    const raw = getPlatformSetting("last_offline_gap", "");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
