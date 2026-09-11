/**
 * Analytics API Routes
 * Dashboard-level analytics across all campaigns for a user
 * Uses in-memory caching to avoid blocking the event loop on 200k+ records
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";
import { queryAll, queryGet } from "../db/read-pool.js";

const router = Router();

const analyticsCache = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds
const CACHE_MAX_AGE_MS = 15 * 60_000;

// Stale-while-revalidate: serve the last result instantly and rebuild it
// right after responding when it is older than the TTL. Only a cold cache
// (first request after a restart) computes inline.
// All SQL runs in the read-pool worker (see db/read-pool.js): a rebuild is ten
// aggregates over 30 days of call_records and used to freeze the main thread —
// and with it every live call's audio — for a second or more every 30 s while
// the dashboard was open.
function getCached(userId, rebuild) {
  const entry = analyticsCache.get(userId);
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age >= CACHE_MAX_AGE_MS) return null;
  if (age >= CACHE_TTL_MS && !entry.refreshing) {
    entry.refreshing = true;
    rebuild().then((data) => analyticsCache.set(userId, { ts: Date.now(), data }))
      .catch(() => { entry.refreshing = false; });
  }
  return entry.data;
}

/** Pre-compute the dashboard for a user so the first click after boot is warm. */
export function warmDashboard(userId) {
  buildDashboard(userId).then((data) => analyticsCache.set(userId, { ts: Date.now(), data })).catch(() => {});
}

const inflight = new Map();
router.get("/dashboard", async (req, res) => {
  const userId = req.user.userId;

  const cached = getCached(userId, () => buildDashboard(userId));
  if (cached) return res.json(cached);

  try {
    let p = inflight.get(userId);
    if (!p) {
      p = buildDashboard(userId).finally(() => inflight.delete(userId));
      inflight.set(userId, p);
    }
    const result = await p;
    analyticsCache.set(userId, { ts: Date.now(), data: result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function buildDashboard(userId) {

  const stats = await queryGet(`
    SELECT
      (SELECT COUNT(*) FROM campaigns WHERE user_id = ?) as total_campaigns,
      (SELECT COUNT(*) FROM campaigns WHERE user_id = ? AND status = 'running') as active_campaigns,
      (SELECT COUNT(*) FROM agents WHERE user_id = ?) as total_agents
  `, [userId, userId, userId]);

  const leadCount = await queryGet(`
    SELECT COALESCE(SUM(total_leads), 0) as total_leads FROM lists WHERE user_id = ?
  `, [userId]);
  stats.total_leads = leadCount.total_leads;

  // Single combined query for today + 7-day stats (avoids two full scans)
  const todayStats = await queryGet(`
    SELECT
      COUNT(*) as calls_today,
      SUM(CASE WHEN outcome NOT IN ('error','no_answer') THEN 1 ELSE 0 END) as answered_today,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transfers_today,
      SUM(CASE WHEN outcome = 'appointment_set' THEN 1 ELSE 0 END) as appointments_today,
      SUM(CASE WHEN outcome = 'callback' THEN 1 ELSE 0 END) as callbacks_today,
      SUM(CASE WHEN outcome = 'voicemail' THEN 1 ELSE 0 END) as voicemail_today,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors_today,
      AVG(duration_seconds) as avg_duration_today,
      SUM(duration_seconds) as total_duration_today,
      SUM(call_cost) as cost_today
    FROM call_records
    WHERE user_id = ? AND started_at >= date('now')
  `, [userId]);

  // Combined 30-day stats + outcome counts + duration buckets in ONE query
  const combined = await queryGet(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome NOT IN ('error','no_answer') THEN 1 ELSE 0 END) as answered_calls,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as total_transfers,
      SUM(CASE WHEN outcome = 'appointment_set' THEN 1 ELSE 0 END) as total_appointments,
      SUM(CASE WHEN outcome = 'interested' THEN 1 ELSE 0 END) as total_interested,
      SUM(CASE WHEN outcome = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested,
      SUM(CASE WHEN outcome = 'callback' THEN 1 ELSE 0 END) as total_callbacks,
      SUM(CASE WHEN outcome = 'lead_hangup' THEN 1 ELSE 0 END) as total_hangups,
      SUM(CASE WHEN outcome = 'voicemail' THEN 1 ELSE 0 END) as total_voicemail,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as total_errors,
      SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as total_no_answer,
      SUM(CASE WHEN outcome = 'timeout' THEN 1 ELSE 0 END) as total_timeouts,
      SUM(CASE WHEN outcome = 'do_not_call' THEN 1 ELSE 0 END) as total_dnc,
      AVG(duration_seconds) as avg_duration,
      MAX(duration_seconds) as max_duration,
      SUM(duration_seconds) as total_duration,
      SUM(call_cost) as total_cost,
      SUM(voip_cost) as total_voip_cost,
      SUM(ai_cost) as total_ai_cost,
      SUM(CASE WHEN duration_seconds <= 10 THEN 1 ELSE 0 END) as "bucket_0_10",
      SUM(CASE WHEN duration_seconds > 10 AND duration_seconds <= 30 THEN 1 ELSE 0 END) as "bucket_11_30",
      SUM(CASE WHEN duration_seconds > 30 AND duration_seconds <= 60 THEN 1 ELSE 0 END) as "bucket_31_60",
      SUM(CASE WHEN duration_seconds > 60 AND duration_seconds <= 120 THEN 1 ELSE 0 END) as "bucket_1_2m",
      SUM(CASE WHEN duration_seconds > 120 AND duration_seconds <= 300 THEN 1 ELSE 0 END) as "bucket_2_5m",
      SUM(CASE WHEN duration_seconds > 300 THEN 1 ELSE 0 END) as "bucket_5m_plus"
    FROM call_records WHERE user_id = ? AND started_at >= datetime('now', '-30 days')
  `, [userId]);

  const callStats = { ...combined };
  delete callStats.bucket_0_10; delete callStats.bucket_11_30; delete callStats.bucket_31_60;
  delete callStats.bucket_1_2m; delete callStats.bucket_2_5m; delete callStats.bucket_5m_plus;

  const total = callStats.total_calls || 1;
  callStats.transfer_rate = (callStats.total_transfers / total * 100);
  callStats.appointment_rate = (callStats.total_appointments / total * 100);
  callStats.answer_rate = (callStats.answered_calls / total * 100);

  const durationBuckets = {
    "0-10s": combined.bucket_0_10,
    "11-30s": combined.bucket_11_30,
    "31-60s": combined.bucket_31_60,
    "1-2m": combined.bucket_1_2m,
    "2-5m": combined.bucket_2_5m,
    "5m+": combined.bucket_5m_plus,
  };

  // Build outcomes from the combined counts instead of a separate query
  const outcomes = [
    { outcome: "error", count: combined.total_errors },
    { outcome: "voicemail", count: combined.total_voicemail },
    { outcome: "transferred", count: combined.total_transfers },
    { outcome: "not_interested", count: combined.total_not_interested },
    { outcome: "lead_hangup", count: combined.total_hangups },
    { outcome: "no_answer", count: combined.total_no_answer },
    { outcome: "interested", count: combined.total_interested },
    { outcome: "callback", count: combined.total_callbacks },
    { outcome: "appointment_set", count: combined.total_appointments },
    { outcome: "timeout", count: combined.total_timeouts },
    { outcome: "do_not_call", count: combined.total_dnc },
  ].filter(o => o.count > 0).sort((a, b) => b.count - a.count);

  const callsByDay = await queryAll(`
    SELECT date(started_at) as day, COUNT(*) as calls,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transfers,
      SUM(CASE WHEN outcome = 'appointment_set' THEN 1 ELSE 0 END) as appointments,
      SUM(CASE WHEN outcome NOT IN ('error','no_answer') THEN 1 ELSE 0 END) as answered,
      SUM(CASE WHEN outcome IN ('interested','transferred','appointment_set') THEN 1 ELSE 0 END) as successful,
      SUM(call_cost) as cost
    FROM call_records
    WHERE user_id = ? AND started_at >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day
  `, [userId]);

  const callsByHour = await queryAll(`
    SELECT strftime('%H', started_at) as hour, COUNT(*) as calls,
      SUM(CASE WHEN outcome NOT IN ('error','no_answer') THEN 1 ELSE 0 END) as answered
    FROM call_records
    WHERE user_id = ? AND started_at >= date('now')
    GROUP BY hour ORDER BY hour
  `, [userId]);

  const errorBreakdown = await queryAll(`
    SELECT error_message, COUNT(*) as count
    FROM call_records WHERE user_id = ? AND started_at >= datetime('now', '-7 days') AND +outcome = 'error'
    GROUP BY error_message ORDER BY count DESC LIMIT 10
  `, [userId]);

  const topCampaigns = await queryAll(`
    SELECT c.name, c.id as campaign_id, COUNT(cr.id) as total_calls,
      SUM(CASE WHEN cr.outcome NOT IN ('error','no_answer') THEN 1 ELSE 0 END) as answered,
      SUM(CASE WHEN cr.outcome = 'transferred' THEN 1 ELSE 0 END) as transfers,
      SUM(CASE WHEN cr.outcome = 'appointment_set' THEN 1 ELSE 0 END) as appointments,
      SUM(cr.call_cost) as cost,
      AVG(cr.duration_seconds) as avg_duration
    FROM call_records cr
    JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.user_id = ? AND cr.started_at >= datetime('now', '-30 days')
    GROUP BY cr.campaign_id
    ORDER BY total_calls DESC LIMIT 10
  `, [userId]);

  const recentCalls = await queryAll(`
    SELECT cr.id, cr.call_id, cr.phone, cr.lead_name, cr.outcome, cr.duration_seconds,
      cr.started_at, cr.call_cost, cr.error_message, c.name as campaign_name
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.user_id = ?
    ORDER BY cr.started_at DESC LIMIT 10
  `, [userId]);

  const appointmentStats = await queryGet(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM appointments WHERE user_id = ?
  `, [userId]);

  const result = {
    stats,
    callStats,
    callsByDay,
    callsByHour,
    outcomes,
    errorBreakdown,
    topCampaigns,
    recentCalls,
    todayStats,
    appointmentStats,
    durationBuckets,
  };

  return result;
}

export default router;
