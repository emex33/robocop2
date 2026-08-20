/**
 * Campaigns API Routes
 * CRUD for campaigns - each campaign has an agent, lists, extensions, schedule
 */

import { Router } from "express";
import { getDb, generateId } from "../db/schema.js";
import fs from "fs";
import path from "path";

const router = Router();

// List all campaigns for current user
router.get("/", (req, res) => {
  const db = getDb();
  const campaigns = db.prepare(`
    SELECT c.*, a.name as agent_name, a.script as agent_script, a.mode as agent_mode
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

  const callCounts = {};
  db.prepare(`
    SELECT campaign_id,
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as answered_leads,
      SUM(CASE WHEN outcome NOT IN ('unknown','error') THEN 1 ELSE 0 END) as contacted_leads
    FROM call_records WHERE campaign_id IN (${placeholders})
    GROUP BY campaign_id
  `).all(...campaignIds).forEach(r => { callCounts[r.campaign_id] = r; });

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
router.get("/:id", (req, res) => {
  const db = getDb();
  const campaign = db.prepare(`
    SELECT c.*, a.name as agent_name, a.script as agent_script, a.mode as agent_mode
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

  const callStats = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transferred_calls,
      SUM(CASE WHEN outcome IN ('interested','transferred','appointment_set') THEN 1 ELSE 0 END) as answered_leads,
      SUM(CASE WHEN outcome = 'not_interested' THEN 1 ELSE 0 END) as rejected_leads
    FROM call_records WHERE campaign_id = ?
  `).get(req.params.id);

  const dncCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM leads l
    JOIN campaign_lists cl ON l.list_id = cl.list_id
    WHERE cl.campaign_id = ? AND l.do_not_call = 1
  `).get(req.params.id);

  campaign.total_leads = leadStats.total_leads;
  campaign.total_calls = callStats.total_calls;
  campaign.transferred_calls = callStats.transferred_calls;
  campaign.answered_leads = callStats.answered_leads;
  campaign.rejected_leads = callStats.rejected_leads;
  campaign.dnc_leads = dncCount.cnt;
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

  db.prepare(`
    INSERT INTO campaigns (id, user_id, name, agent_id, type, phone_number)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.user.userId, name, agent_id || null, type || "outbound", phone_number || "");

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

// Get leads for a campaign (from all assigned lists)
router.get("/:id/leads", (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  // Use pre-computed total from lists table instead of counting 289K leads
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(l2.total_leads), 0) as cnt
    FROM campaign_lists cl JOIN lists l2 ON cl.list_id = l2.id
    WHERE cl.campaign_id = ?
  `).get(req.params.id);

  const leads = db.prepare(`
    SELECT l.*, li.name as list_name FROM leads l
    JOIN campaign_lists cl ON l.list_id = cl.list_id
    JOIN lists li ON l.list_id = li.id
    WHERE cl.campaign_id = ?
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);

  res.json({
    leads,
    total: totalRow.cnt,
    page,
    pages: Math.ceil(totalRow.cnt / limit),
  });
});

// Get call records for a campaign
router.get("/:id/calls", (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM call_records WHERE campaign_id = ?"
  ).get(req.params.id);

  const calls = db.prepare(`
    SELECT * FROM call_records
    WHERE campaign_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);

  const result = calls.map(c => ({
    ...c,
    transcript: JSON.parse(c.transcript_json || "[]"),
  }));

  res.json({
    calls: result,
    total: total.cnt,
    page,
    pages: Math.ceil(total.cnt / limit),
  });
});

// Get campaign analytics
router.get("/:id/analytics", (req, res) => {
  const db = getDb();
  const campaignId = req.params.id;

  const summary = db.prepare(`
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
    FROM call_records WHERE campaign_id = ?
  `).get(campaignId);

  // Calls per day (last 30 days)
  const callsByDay = db.prepare(`
    SELECT date(started_at) as day, COUNT(*) as count,
      SUM(CASE WHEN outcome = 'transferred' THEN 1 ELSE 0 END) as transfers
    FROM call_records
    WHERE campaign_id = ? AND started_at >= datetime('now', '-30 days')
    GROUP BY date(started_at)
    ORDER BY day
  `).all(campaignId);

  // Outcome distribution
  const outcomes = db.prepare(`
    SELECT outcome, COUNT(*) as count
    FROM call_records WHERE campaign_id = ?
    GROUP BY outcome
  `).all(campaignId);

  res.json({ summary, callsByDay, outcomes });
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
