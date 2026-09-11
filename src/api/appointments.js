/**
 * Appointments API Routes
 * CRUD for appointments - scheduled meetings from AI calls
 */

import { Router } from "express";
import { getDb, generateId } from "../db/schema.js";
import { queryAll } from "../db/read-pool.js";
import { pushAppointmentToSheet, updateAppointmentInSheet } from "../services/google-sheets.js";

const router = Router();

// List all appointments for current user
router.get("/", async (req, res) => {
  const { status, from, to, campaign_id } = req.query;
  
  let query = `
    SELECT a.*, c.name as campaign_name,
      l.first_name, l.last_name, l.email as lead_email, l.phone as lead_phone,
      l.company as lead_company, l.country as lead_country, l.notes as lead_notes,
      l.extra_json as lead_extra, l.status as lead_status
    FROM appointments a
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    LEFT JOIN leads l ON a.lead_id = l.id
    WHERE a.user_id = ?
  `;
  const params = [req.user.userId];
  
  if (status) {
    query += " AND a.status = ?";
    params.push(status);
  }
  if (from) {
    query += " AND a.appointment_date >= ?";
    params.push(from);
  }
  if (to) {
    query += " AND a.appointment_date <= ?";
    params.push(to);
  }
  if (campaign_id) {
    query += " AND a.campaign_id = ?";
    params.push(campaign_id);
  }
  
  query += " ORDER BY a.appointment_date ASC, a.appointment_time ASC";

  // Off the main thread: this join over every appointment blocked the loop
  // ~1.7 s per page load, freezing live-call audio.
  try {
    res.json(await queryAll(query, params));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single appointment
router.get("/:id", (req, res) => {
  const db = getDb();
  const appointment = db.prepare(`
    SELECT a.*, c.name as campaign_name,
      l.first_name, l.last_name, l.email as lead_email, l.phone as lead_phone,
      l.company as lead_company, l.country as lead_country, l.notes as lead_notes,
      l.extra_json as lead_extra, l.status as lead_status
    FROM appointments a
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    LEFT JOIN leads l ON a.lead_id = l.id
    WHERE a.id = ? AND a.user_id = ?
  `).get(req.params.id, req.user.userId);
  
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });
  res.json(appointment);
});

// Create appointment (usually called from call handler, but can be manual)
router.post("/", (req, res) => {
  const db = getDb();
  const id = generateId();
  const {
    campaign_id, lead_id, call_id, lead_name, phone, email,
    appointment_date, appointment_time, timezone, notes,
  } = req.body;
  
  if (!phone || !appointment_date || !appointment_time) {
    return res.status(400).json({ error: "Phone, date, and time are required" });
  }
  
  db.prepare(`
    INSERT INTO appointments (id, user_id, campaign_id, lead_id, call_id, lead_name, phone, email,
      appointment_date, appointment_time, timezone, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
  `).run(
    id, req.user.userId,
    campaign_id || null,
    lead_id || null,
    call_id || "",
    lead_name || "",
    phone,
    email || "",
    appointment_date,
    appointment_time,
    timezone || "Europe/London",
    notes || ""
  );
  
  const appointment = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);

  pushAppointmentToSheet(id).catch(() => {});

  res.status(201).json(appointment);
});

// Update appointment (change status, reschedule, etc.)
router.put("/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM appointments WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);
  
  if (!existing) return res.status(404).json({ error: "Appointment not found" });
  
  const fields = [];
  const values = [];
  const allowed = [
    "lead_name", "phone", "email", "appointment_date", "appointment_time",
    "timezone", "notes", "status", "reminder_sent"
  ];
  
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }
  
  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });
  
  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  
  db.prepare(`UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  
  const appointment = db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);

  updateAppointmentInSheet(req.params.id).catch(() => {});

  res.json(appointment);
});

// Delete appointment
router.delete("/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM appointments WHERE id = ? AND user_id = ?"
  ).run(req.params.id, req.user.userId);
  
  if (result.changes === 0) return res.status(404).json({ error: "Appointment not found" });
  res.json({ message: "Appointment deleted" });
});

// Get appointment stats
router.get("/stats/summary", (req, res) => {
  const db = getDb();
  
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show,
      SUM(CASE WHEN appointment_date = date('now') THEN 1 ELSE 0 END) as today,
      SUM(CASE WHEN appointment_date > date('now') AND appointment_date <= date('now', '+7 days') THEN 1 ELSE 0 END) as this_week
    FROM appointments WHERE user_id = ?
  `).get(req.user.userId);
  
  res.json(stats);
});

export default router;
