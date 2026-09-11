/**
 * Campaigns API Routes
 * CRUD for campaigns - each campaign has an agent, lists, extensions, schedule
 */

import { Router } from "express";
import { getDb, generateId } from "../db/schema.js";
import { resetCampaignForRerun } from "../db/helpers.js";
import { queryAll, queryGet } from "../db/read-pool.js";
import logger from "../utils/logger.js";
import fs from "fs";
import path from "path";

const router = Router();

/** Calling window every campaign starts with: weekdays, 15:00 to midnight Amsterdam. */
export const DEFAULT_SCHEDULE = Object.freeze({
  daily_start_time: "15:00",
  daily_end_time: "00:00",
  timezone: "Europe/Amsterdam",
  days_of_week: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
});

// better-sqlite3 is synchronous: a full scan of 1M+ call_records (~3s) or
// 250k leads (~10s) freezes HTTP + WebSocket, which the UI shows as a reload.
const statsCache = new Map();
const STATS_TTL_MS = 20_000;
const STATS_MAX_AGE_MS = 10 * 60_000;

// Stale-while-revalidate: an expired entry is returned immediately and
// refreshed right after the response goes out, so a click never waits on a
// COUNT over 300k call records. Only a cold key computes inline.
function getCached(key, compute) {
  const hit = statsCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < STATS_TTL_MS) return hit.value;
  if (hit && now - hit.ts < STATS_MAX_AGE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      setTimeout(() => {
        try { statsCache.set(key, { ts: Date.now(), value: compute() }); }
        catch { hit.refreshing = false; }
      }, 0);
    }
    return hit.value;
  }
  const value = compute();
  statsCache.set(key, { ts: now, value });
  if (statsCache.size > 200) {
    const cutoff = now - STATS_MAX_AGE_MS;
    for (const [k, v] of statsCache) if (v.ts < cutoff) statsCache.delete(k);
  }
  return value;
}

// Same policy for counters computed off-thread (read-pool). The heavy SQL runs
// in a worker, so neither the cold path nor the refresh touches the main
// thread — which is what keeps live-call audio smooth while people browse.
function getCachedAsync(key, computeAsync) {
  const hit = statsCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < STATS_TTL_MS) return Promise.resolve(hit.value);
  if (hit && now - hit.ts < STATS_MAX_AGE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      computeAsync().then((value) => statsCache.set(key, { ts: Date.now(), value }))
        .catch(() => { hit.refreshing = false; });
    }
    return Promise.resolve(hit.value);
  }
  if (hit && hit.inflight) return hit.inflight;
  const inflight = computeAsync().then((value) => {
    statsCache.set(key, { ts: Date.now(), value });
    if (statsCache.size > 200) {
      const cutoff = Date.now() - STATS_MAX_AGE_MS;
      for (const [k, v] of statsCache) if (v.ts < cutoff && !v.inflight) statsCache.delete(k);
    }
    return value;
  });
  statsCache.set(key, { ts: 0, value: undefined, inflight });
  inflight.catch(() => statsCache.delete(key));
  return inflight;
}

/** Drop every cached counter for one campaign (after a reset or bulk change). */
function invalidateCampaignCaches(campaignId) {
  for (const k of statsCache.keys()) {
    if (k.endsWith(`:${campaignId}`) || (k.startsWith("calls:") && k.includes(campaignId))) statsCache.delete(k);
  }
}

/**
 * A campaign reset for a re-run gets `stats_since`; its counters only look at
 * calls started from then on. '' (never reset) matches every record.
 */
function getStatsSince(db, campaignId) {
  return db.prepare("SELECT stats_since FROM campaigns WHERE id = ?").get(campaignId)?.stats_since || "";
}

function getCallCountsByCampaign(db, campaignIds) {
  if (!campaignIds.length) return Promise.resolve({});
  const key = `calls:${campaignIds.slice().sort().join(",")}`;
  return getCachedAsync(key, async () => {
    const callCounts = {};
    const placeholders = campaignIds.map(() => "?").join(",");
    const rows = await queryAll(`
      SELECT cr.campaign_id,
        COUNT(*) as total_calls,
        SUM(CASE WHEN cr.outcome = 'transferred' THEN 1 ELSE 0 END) as answered_leads,
        SUM(CASE WHEN cr.outcome NOT IN ('unknown','error') THEN 1 ELSE 0 END) as contacted_leads
      FROM call_records cr JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.campaign_id IN (${placeholders}) AND cr.started_at >= COALESCE(c.stats_since, '')
      GROUP BY cr.campaign_id
    `, campaignIds);
    rows.forEach(r => { callCounts[r.campaign_id] = r; });
    return callCounts;
  });
}

function getCampaignCallStats(db, campaignId) {
  return getCachedAsync(`cstats:${campaignId}`, () => queryGet(`
    SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END), 0) as transferred_calls,
      COALESCE(SUM(CASE WHEN outcome IN ('interested','transferred','appointment_set') THEN 1 ELSE 0 END), 0) as answered_leads,
      COALESCE(SUM(CASE WHEN outcome = 'not_interested' THEN 1 ELSE 0 END), 0) as rejected_leads
    FROM call_records WHERE campaign_id = ? AND started_at >= ?
  `, [campaignId, getStatsSince(db, campaignId)]));
}

function getCampaignDncCount(db, campaignId) {
  return getCachedAsync(`dnc:${campaignId}`, async () => {
    const lists = db.prepare("SELECT list_id FROM campaign_lists WHERE campaign_id = ?").all(campaignId);
    if (lists.length === 0) return 0;
    let total = 0;
    for (const row of lists) {
      total += (await queryGet("SELECT COUNT(*) as cnt FROM leads WHERE list_id = ? AND do_not_call = 1", [row.list_id])).cnt;
    }
    return total;
  });
}

/**
 * Pre-compute the per-campaign counters for campaigns touched in the last 30
 * days, one campaign per tick so the event loop stays free. Called at boot and
 * periodically; with the stale-while-revalidate cache above this means the
 * campaign list and detail pages never wait on a COUNT.
 */
export function warmCampaignCaches() {
  const db = getDb();
  let rows;
  try {
    rows = db.prepare("SELECT id, user_id FROM campaigns WHERE updated_at >= datetime('now','-30 days') ORDER BY updated_at DESC LIMIT 40").all();
  } catch { return; }
  const byUser = new Map();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r.id]);
  let i = 0;
  const step = async () => {
    if (i < rows.length) {
      const c = rows[i++];
      try { await getCampaignCallStats(db, c.id); await getCampaignDncCount(db, c.id); } catch {}
      setTimeout(step, 150);
    } else {
      // The list page keys its cache by the user's full campaign id set.
      for (const userId of byUser.keys()) {
        try {
          const ids = db.prepare("SELECT id FROM campaigns WHERE user_id = ?").all(userId).map(r => r.id);
          await getCallCountsByCampaign(db, ids);
        } catch {}
      }
    }
  };
  step();
}

// List all campaigns for current user
router.get("/", async (req, res) => {
  const db = getDb();
  const campaigns = db.prepare(`
    SELECT c.*, a.name as agent_name, a.mode as agent_mode
    FROM campaigns c
    LEFT JOIN agents a ON c.agent_id = a.id
    WHERE c.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.userId);

  if (campaigns.length === 0) return res.json([]);

  const campaignIds = campaigns.map(c => c.id);
  const placeholders = campaignIds.map(() => "?").join(",");

  const leadCounts = {};
  db.prepare(`
    SELECT cl.campaign_id, COALESCE(SUM(l2.total_leads), 0) as cnt
    FROM campaign_lists cl JOIN lists l2 ON cl.list_id = l2.id
    WHERE cl.campaign_id IN (${placeholders})
    GROUP BY cl.campaign_id
  `).all(...campaignIds).forEach(r => { leadCounts[r.campaign_id] = r.cnt; });

  let callCounts = {};
  try { callCounts = await getCallCountsByCampaign(db, campaignIds); }
  catch (e) { logger.warn(`campaign counters unavailable: ${e.message}`); }

  const result = campaigns.map(c => ({
    ...c,
    days_of_week: JSON.parse(c.days_of_week || "[]"),
    total_leads: leadCounts[c.id] || 0,
    total_calls: (callCounts[c.id] || {}).total_calls || 0,
    answered_leads: (callCounts[c.id] || {}).answered_leads || 0,
    contacted_leads: (callCounts[c.id] || {}).contacted_leads || 0,
  }));
  res.json(result);
});

// Get single campaign with full details
router.get("/:id", async (req, res) => {
  const db = getDb();
  const campaign = db.prepare(`
    SELECT c.*, a.name as agent_name, a.mode as agent_mode
    FROM campaigns c
    LEFT JOIN agents a ON c.agent_id = a.id
    WHERE c.id = ? AND c.user_id = ?
  `).get(req.params.id, req.user.userId);

  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const leadStats = db.prepare(`
    SELECT COALESCE(SUM(l2.total_leads), 0) as total_leads
    FROM campaign_lists cl JOIN lists l2 ON cl.list_id = l2.id
    WHERE cl.campaign_id = ?
  `).get(req.params.id);

  let callStats = { total_calls: 0, transferred_calls: 0, answered_leads: 0, rejected_leads: 0 }, dncCount = 0;
  try {
    [callStats, dncCount] = await Promise.all([getCampaignCallStats(db, req.params.id), getCampaignDncCount(db, req.params.id)]);
  } catch (e) { logger.warn(`campaign counters unavailable: ${e.message}`); }

  campaign.total_leads = leadStats.total_leads;
  campaign.total_calls = callStats.total_calls;
  campaign.transferred_calls = callStats.transferred_calls;
  campaign.answered_leads = callStats.answered_leads;
  campaign.rejected_leads = callStats.rejected_leads;
  campaign.dnc_leads = dncCount;
  campaign.days_of_week = JSON.parse(campaign.days_of_week || "[]");

  campaign.extensions = db.prepare(
    "SELECT * FROM extensions WHERE campaign_id = ? ORDER BY extension"
  ).all(req.params.id);

  campaign.lists = db.prepare(`
    SELECT l.* FROM lists l
    JOIN campaign_lists cl ON l.id = cl.list_id
    WHERE cl.campaign_id = ?
    ORDER BY l.created_at DESC
  `).all(req.params.id);

  res.json(campaign);
});

// Create campaign
router.post("/", (req, res) => {
  const db = getDb();
  const id = generateId();
  const { name, agent_id, type, phone_number } = req.body;

  if (!name) return res.status(400).json({ error: "Campaign name is required" });

  // House rule for every campaign: Mon–Fri, 15:00 to midnight Amsterdam time.
  // Set explicitly rather than relying on column defaults, because SQLite keeps
  // whatever defaults the table was created with and this DB predates the rule.
  db.prepare(`
    INSERT INTO campaigns (id, user_id, name, agent_id, type, phone_number,
      daily_start_time, daily_end_time, timezone, days_of_week)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.user.userId, name, agent_id || null, type || "outbound", phone_number || "",
    DEFAULT_SCHEDULE.daily_start_time, DEFAULT_SCHEDULE.daily_end_time,
    DEFAULT_SCHEDULE.timezone, JSON.stringify(DEFAULT_SCHEDULE.days_of_week),
  );

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  campaign.days_of_week = JSON.parse(campaign.days_of_week || "[]");
  campaign.extensions = [];
  campaign.lists = [];
  res.status(201).json(campaign);
});

// Update campaign settings
router.put("/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM campaigns WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!existing) return res.status(404).json({ error: "Campaign not found" });

  const fields = [];
  const values = [];
  const allowed = [
    "name", "agent_id", "status", "type", "dialer_mode", "phone_number",
    "start_date", "end_date", "daily_start_time", "daily_end_time", "timezone",
    "max_concurrent_calls", "total_dial_attempts", "max_daily_attempts",
    "redial_wait_minutes", "campaign_priority", "voicemail_as_answered",
    "webhook_url", "enable_success_metric", "google_sheet_id", "google_drive_folder_id", "sip_settings_id",
  ];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (req.body.days_of_week !== undefined) {
    fields.push("days_of_week = ?");
    values.push(JSON.stringify(req.body.days_of_week));
  }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE campaigns SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  campaign.days_of_week = JSON.parse(campaign.days_of_week || "[]");
  res.json(campaign);
});

// Delete campaign
router.delete("/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM campaigns WHERE id = ? AND user_id = ?"
  ).run(req.params.id, req.user.userId);

  if (result.changes === 0) return res.status(404).json({ error: "Campaign not found" });
  res.json({ message: "Campaign deleted" });
});

// ===== Campaign Extensions =====

// Get extensions for a campaign
router.get("/:id/extensions", (req, res) => {
  const db = getDb();
  const extensions = db.prepare(
    "SELECT * FROM extensions WHERE campaign_id = ? ORDER BY extension"
  ).all(req.params.id);
  res.json(extensions);
});

// Add extension to campaign
router.post("/:id/extensions", (req, res) => {
  const db = getDb();
  // Verify campaign belongs to user
  const campaign = db.prepare(
    "SELECT id FROM campaigns WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const { extension, label } = req.body;
  if (!extension) return res.status(400).json({ error: "Extension number is required" });

  // Check limit
  const count = db.prepare(
    "SELECT COUNT(*) as cnt FROM extensions WHERE campaign_id = ?"
  ).get(req.params.id);
  if (count.cnt >= 100) return res.status(400).json({ error: "Maximum 100 extensions per campaign" });

  const id = generateId();
  db.prepare(
    "INSERT INTO extensions (id, campaign_id, extension, label) VALUES (?, ?, ?, ?)"
  ).run(id, req.params.id, extension, label || "");

  const ext = db.prepare("SELECT * FROM extensions WHERE id = ?").get(id);
  res.status(201).json(ext);
});

// Bulk add extensions
router.post("/:id/extensions/bulk", (req, res) => {
  const db = getDb();
  const campaign = db.prepare(
    "SELECT id FROM campaigns WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const { extensions } = req.body; // Array of { extension, label }
  if (!Array.isArray(extensions)) return res.status(400).json({ error: "extensions must be an array" });

  const current = db.prepare(
    "SELECT COUNT(*) as cnt FROM extensions WHERE campaign_id = ?"
  ).get(req.params.id);
  if (current.cnt + extensions.length > 100) {
    return res.status(400).json({ error: `Would exceed 100 extension limit (current: ${current.cnt})` });
  }

  const insert = db.prepare(
    "INSERT INTO extensions (id, campaign_id, extension, label) VALUES (?, ?, ?, ?)"
  );

  const insertMany = db.transaction((exts) => {
    for (const ext of exts) {
      insert.run(generateId(), req.params.id, ext.extension, ext.label || "");
    }
  });

  insertMany(extensions);

  const all = db.prepare(
    "SELECT * FROM extensions WHERE campaign_id = ? ORDER BY extension"
  ).all(req.params.id);
  res.status(201).json(all);
});

// Delete extension
router.delete("/:campaignId/extensions/:extId", (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM extensions WHERE id = ? AND campaign_id = ?")
    .run(req.params.extId, req.params.campaignId);

  if (result.changes === 0) return res.status(404).json({ error: "Extension not found" });
  res.json({ message: "Extension deleted" });
});

// Toggle extension active/inactive
router.patch("/:campaignId/extensions/:extId", (req, res) => {
  const db = getDb();
  const { active } = req.body;
  db.prepare("UPDATE extensions SET active = ? WHERE id = ? AND campaign_id = ?")
    .run(active ? 1 : 0, req.params.extId, req.params.campaignId);

  const ext = db.prepare("SELECT * FROM extensions WHERE id = ?").get(req.params.extId);
  res.json(ext);
});

// ===== Campaign Lists Assignment =====

// Assign a list to a campaign
router.post("/:id/lists", (req, res) => {
  const db = getDb();
  const { list_id } = req.body;
  if (!list_id) return res.status(400).json({ error: "list_id is required" });

  try {
    db.prepare(
      "INSERT INTO campaign_lists (campaign_id, list_id) VALUES (?, ?)"
    ).run(req.params.id, list_id);
    res.status(201).json({ message: "List assigned to campaign" });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "List already assigned" });
    }
    throw e;
  }
});

// Remove a list from a campaign
router.delete("/:id/lists/:listId", (req, res) => {
  const db = getDb();
  db.prepare(
    "DELETE FROM campaign_lists WHERE campaign_id = ? AND list_id = ?"
  ).run(req.params.id, req.params.listId);
  res.json({ message: "List removed from campaign" });
});

// Reset a campaign for a re-run: leads callable again (appointments, DNC and
// invalid numbers protected), counters restart from zero, call history kept.
router.post("/:id/reset", (req, res) => {
  const db = getDb();
  const campaign = db.prepare("SELECT id, name, status FROM campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status === "running") return res.status(409).json({ error: "Pause the campaign before resetting it" });

  const result = resetCampaignForRerun(campaign.id, req.user.userId);
  invalidateCampaignCaches(campaign.id);
  res.json({ message: `Campaign "${campaign.name}" reset`, ...result });
});

// Get leads for a campaign (from all assigned lists)
router.get("/:id/leads", (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const lists = db.prepare(`
    SELECT l.id, l.name, l.total_leads
    FROM lists l
    JOIN campaign_lists cl ON l.id = cl.list_id
    WHERE cl.campaign_id = ?
  `).all(req.params.id);

  const total = lists.reduce((s, l) => s + (l.total_leads || 0), 0);
  if (lists.length === 0) {
    return res.json({ leads: [], total: 0, page, pages: 0 });
  }

  let leads;
  if (lists.length === 1) {
    // Index-backed: idx_leads_list_created. Sorting 250k rows via a JOIN
    // was ~10s; walking the (list_id, created_at) index for 50 rows is ~1ms.
    const list = lists[0];
    leads = db.prepare(`
      SELECT l.*, ? AS list_name FROM leads l INDEXED BY idx_leads_list_created
      WHERE l.list_id = ?
      ORDER BY l.created_at DESC
      LIMIT ? OFFSET ?
    `).all(list.name, list.id, limit, offset);
  } else {
    const nameById = Object.fromEntries(lists.map(l => [l.id, l.name]));
    const take = offset + limit;
    const merged = [];
    const stmt = db.prepare(`
      SELECT l.* FROM leads l INDEXED BY idx_leads_list_created
      WHERE l.list_id = ?
      ORDER BY l.created_at DESC
      LIMIT ?
    `);
    for (const list of lists) {
      for (const row of stmt.all(list.id, take)) {
        merged.push({ ...row, list_name: nameById[list.id] });
      }
    }
    merged.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    leads = merged.slice(offset, offset + limit);
  }

  res.json({
    leads,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  });
});

// Get call records for a campaign
router.get("/:id/calls", async (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const since = getStatsSince(db, req.params.id);
  const [total, calls] = await Promise.all([
    getCachedAsync(`ccount:${req.params.id}`, async () =>
      (await queryGet("SELECT COUNT(*) as cnt FROM call_records WHERE campaign_id = ? AND started_at >= ?", [req.params.id, since])).cnt
    ),
    queryAll(`
      SELECT id, call_id, phone, lead_name, outcome, duration_seconds, notes,
             recording_path, recording_url, started_at, ended_at, created_at
      FROM call_records
      WHERE campaign_id = ? AND started_at >= ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.id, since, limit, offset]),
  ]);

  res.json({
    calls,
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  });
});

// Get campaign analytics
router.get("/:id/analytics", async (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;

  const payload = await getCachedAsync(`analytics:${campaignId}`, async () => {
    const since = getStatsSince(db, campaignId);
    const summary = await queryGet(`
      SELECT
        COUNT(*) as total_calls,
        SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transfers,
        SUM(CASE WHEN outcome = 'interested' THEN 1 ELSE 0 END) as interested,
        SUM(CASE WHEN outcome = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN outcome = 'callback' THEN 1 ELSE 0 END) as callbacks,
        SUM(CASE WHEN outcome = 'do_not_call' THEN 1 ELSE 0 END) as dnc,
        SUM(CASE WHEN outcome = 'lead_hangup' THEN 1 ELSE 0 END) as hangups,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN outcome = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
        AVG(duration_seconds) as avg_duration,
        SUM(duration_seconds) as total_duration
      FROM call_records WHERE campaign_id = ? AND started_at >= ?
    `, [campaignId, since]);

    const callsByDay = await queryAll(`
      SELECT date(started_at) as day, COUNT(*) as count,
        SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transfers
      FROM call_records
      WHERE campaign_id = ? AND started_at >= datetime('now', '-30 days') AND started_at >= ?
      GROUP BY date(started_at)
      ORDER BY day
    `, [campaignId, since]);

    const outcomes = await queryAll(`
      SELECT outcome, COUNT(*) as count
      FROM call_records WHERE campaign_id = ? AND started_at >= ?
      GROUP BY outcome
    `, [campaignId, since]);

    return { summary, callsByDay, outcomes };
  }).catch((e) => { logger.warn(`campaign analytics unavailable: ${e.message}`); return null; });

  if (!payload) return res.status(503).json({ error: "Analytics temporarily unavailable" });
  res.json(payload);
});

// Stream/download a call recording
router.get("/:id/calls/:callId/recording", (req, res) => {
  const db = getDb();
  const { id: campaignId, callId } = req.params;
  
  // Verify the call belongs to this campaign and user
  const call = db.prepare(`
    SELECT cr.*, c.user_id
    FROM call_records cr
    JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.id = ? AND cr.campaign_id = ? AND c.user_id = ?
  `).get(callId, campaignId, req.user.userId);
  
  if (!call) {
    return res.status(404).json({ error: "Call not found" });
  }
  
  if (!call.recording_path) {
    return res.status(404).json({ error: "No recording available for this call" });
  }
  
  // Security: ensure path is within recordings directory
  const recordingsDir = process.env.RECORDINGS_DIR || "/app/data/recordings";
  const fullPath = path.resolve(call.recording_path);
  
  if (!fullPath.startsWith(path.resolve(recordingsDir))) {
    return res.status(403).json({ error: "Invalid recording path" });
  }
  
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "Recording file not found" });
  }
  
  const stat = fs.statSync(fullPath);
  const filename = path.basename(fullPath);
  
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  
  fs.createReadStream(fullPath).pipe(res);
});

export default router;
