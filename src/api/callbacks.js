/**
 * Callbacks API Routes
 * Manages leads who requested a callback (outcome = 'callback')
 * These are warm leads who were interested but couldn't talk at the time.
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";

const router = Router();

router.get("/", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const { campaign_id, status, search, date_from, date_to, sort = "started_at", order = "desc", page: rawPage, limit: rawLimit } = req.query;

  const page = parseInt(rawPage) || 1;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = ["cr.user_id = ?", "cr.outcome = 'callback'"];
  const params = [userId];

  if (campaign_id) {
    conditions.push("cr.campaign_id = ?");
    params.push(campaign_id);
  }

  if (status === "pending") {
    conditions.push("(cr.callback_status = '' OR cr.callback_status IS NULL OR cr.callback_status = 'pending')");
  } else if (status === "called_back") {
    conditions.push("cr.callback_status = 'called_back'");
  } else if (status === "converted") {
    conditions.push("cr.callback_status = 'converted'");
  } else if (status === "no_answer") {
    conditions.push("cr.callback_status = 'no_answer'");
  } else if (status === "not_interested") {
    conditions.push("cr.callback_status = 'not_interested'");
  }

  if (date_from) {
    conditions.push("cr.started_at >= ?");
    params.push(date_from);
  }
  if (date_to) {
    conditions.push("cr.started_at <= ?");
    params.push(date_to + " 23:59:59");
  }

  if (search) {
    conditions.push("(cr.phone LIKE ? OR cr.lead_name LIKE ? OR cr.call_summary LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const where = conditions.join(" AND ");

  const sortCols = { started_at: "cr.started_at", duration: "cr.duration_seconds", lead_name: "cr.lead_name" };
  const sortCol = sortCols[sort] || "cr.started_at";
  const sortOrder = order === "asc" ? "ASC" : "DESC";

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM call_records cr WHERE ${where}`).get(...params).cnt;

  const records = db.prepare(`
    SELECT cr.id, cr.call_id, cr.phone, cr.lead_name, cr.duration_seconds,
      cr.call_summary, cr.notes, cr.started_at, cr.campaign_id, cr.agent_id,
      cr.callback_status, cr.callback_notes, cr.callback_at,
      cr.recording_url, cr.transcript_json,
      c.name AS campaign_name, a.name AS agent_name,
      l.first_name, l.last_name, l.email, l.company AS lead_company, l.country
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    LEFT JOIN agents a ON cr.agent_id = a.id
    LEFT JOIN leads l ON cr.lead_id = l.id
    WHERE ${where}
    ORDER BY ${sortCol} ${sortOrder}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const callbacks = records.map(r => ({
    ...r,
    lead_name: r.lead_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "",
    callback_status: r.callback_status || "pending",
  }));

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN callback_status = '' OR callback_status IS NULL OR callback_status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN callback_status = 'called_back' THEN 1 ELSE 0 END) as called_back,
      SUM(CASE WHEN callback_status = 'converted' THEN 1 ELSE 0 END) as converted,
      SUM(CASE WHEN callback_status = 'no_answer' THEN 1 ELSE 0 END) as no_answer,
      SUM(CASE WHEN callback_status = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
      AVG(duration_seconds) as avg_duration
    FROM call_records
    WHERE user_id = ? AND outcome = 'callback'
  `).get(userId);

  res.json({
    callbacks,
    total,
    page,
    pages: Math.ceil(total / limit),
    stats: { ...stats, avg_duration: stats.avg_duration ? Math.round(stats.avg_duration) : 0 },
  });
});

router.put("/:id", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;

  const existing = db.prepare(
    "SELECT id FROM call_records WHERE id = ? AND user_id = ? AND outcome = 'callback'"
  ).get(req.params.id, userId);

  if (!existing) return res.status(404).json({ error: "Callback not found" });

  const { callback_status, callback_notes } = req.body;
  const updates = [];
  const values = [];

  if (callback_status !== undefined) {
    updates.push("callback_status = ?");
    values.push(callback_status);
    if (callback_status === "called_back" || callback_status === "converted") {
      updates.push("callback_at = datetime('now')");
    }
  }
  if (callback_notes !== undefined) {
    updates.push("callback_notes = ?");
    values.push(callback_notes);
  }

  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(req.params.id);
  db.prepare(`UPDATE call_records SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare(`
    SELECT cr.id, cr.phone, cr.lead_name, cr.callback_status, cr.callback_notes, cr.callback_at,
      cr.duration_seconds, cr.call_summary, cr.started_at, cr.campaign_id,
      c.name AS campaign_name
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.id = ?
  `).get(req.params.id);

  res.json(updated);
});

router.get("/export/csv", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const { campaign_id, status } = req.query;

  const conditions = ["cr.user_id = ?", "cr.outcome = 'callback'"];
  const params = [userId];

  if (campaign_id) { conditions.push("cr.campaign_id = ?"); params.push(campaign_id); }
  if (status && status !== "all") {
    if (status === "pending") {
      conditions.push("(cr.callback_status = '' OR cr.callback_status IS NULL OR cr.callback_status = 'pending')");
    } else {
      conditions.push("cr.callback_status = ?");
      params.push(status);
    }
  }

  const where = conditions.join(" AND ");
  const records = db.prepare(`
    SELECT cr.*, c.name AS campaign_name, a.name AS agent_name
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    LEFT JOIN agents a ON cr.agent_id = a.id
    WHERE ${where}
    ORDER BY cr.started_at DESC
  `).all(...params);

  const headers = ["Date", "Time", "Name", "Phone", "Campaign", "Duration (s)", "Summary", "Status", "Notes"];
  const rows = records.map(r => [
    r.started_at?.slice(0, 10) || "",
    r.started_at?.slice(11, 19) || "",
    (r.lead_name || "").replace(/"/g, '""'),
    r.phone,
    (r.campaign_name || "").replace(/"/g, '""'),
    r.duration_seconds,
    (r.call_summary || "").replace(/"/g, '""'),
    r.callback_status || "pending",
    (r.callback_notes || "").replace(/"/g, '""'),
  ].map(v => `"${v}"`).join(","));

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=callbacks.csv");
  res.send([headers.join(","), ...rows].join("\n"));
});

export default router;
