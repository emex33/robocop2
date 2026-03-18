/**
 * Lists API Routes
 * CRUD for lead lists - upload CSV, manage leads
 */

import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { getDb, generateId } from "../db/schema.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// List all lists for current user
router.get("/", (req, res) => {
  const db = getDb();
  const lists = db.prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM leads WHERE list_id = l.id) as total_leads
    FROM lists l WHERE l.user_id = ?
    ORDER BY l.created_at DESC
  `).all(req.user.userId);

  const result = lists.map(l => ({
    ...l,
    field_mapping: JSON.parse(l.field_mapping_json || "{}"),
  }));
  res.json(result);
});

// Get single list with leads
router.get("/:id", (req, res) => {
  const db = getDb();
  const list = db.prepare(
    "SELECT * FROM lists WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });

  list.field_mapping = JSON.parse(list.field_mapping_json || "{}");

  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const total = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE list_id = ?").get(req.params.id);
  const leads = db.prepare(
    "SELECT * FROM leads WHERE list_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(req.params.id, limit, offset);

  const leadsResult = leads.map(l => ({
    ...l,
    extra: JSON.parse(l.extra_json || "{}"),
  }));

  res.json({
    ...list,
    leads: leadsResult,
    total_leads: total.cnt,
    page,
    pages: Math.ceil(total.cnt / limit),
  });
});

// Create empty list
router.post("/", (req, res) => {
  const db = getDb();
  const id = generateId();
  const { name, description } = req.body;

  if (!name) return res.status(400).json({ error: "List name is required" });

  db.prepare(
    "INSERT INTO lists (id, user_id, name, description) VALUES (?, ?, ?, ?)"
  ).run(id, req.user.userId, name, description || "");

  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(id);
  res.status(201).json(list);
});

// Upload CSV to a list
router.post("/:id/upload", upload.single("file"), (req, res) => {
  const db = getDb();
  const list = db.prepare(
    "SELECT * FROM lists WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const content = req.file.buffer.toString("utf-8");
    const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    if (rows.length === 0) return res.status(400).json({ error: "CSV has no data rows" });

    const columns = Object.keys(rows[0]);
    const preview = rows.slice(0, 5);

    // Store raw rows temporarily in memory (keyed by list id)
    if (!global._csvCache) global._csvCache = {};
    global._csvCache[req.params.id] = rows;

    res.json({ columns, totalRows: rows.length, preview });
  } catch (e) {
    res.status(400).json({ error: `CSV parse error: ${e.message}` });
  }
});

// Apply field mapping and import leads
router.post("/:id/import", (req, res) => {
  const db = getDb();
  const list = db.prepare(
    "SELECT * FROM lists WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });

  const { mapping } = req.body;
  if (!mapping || !mapping.phone) {
    return res.status(400).json({ error: "At minimum, 'phone' must be mapped" });
  }

  const rawRows = global._csvCache?.[req.params.id];
  if (!rawRows) return res.status(400).json({ error: "No CSV uploaded. Upload first, then import." });

  // Save mapping
  db.prepare("UPDATE lists SET field_mapping_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(mapping), req.params.id);

  // Import leads
  const insert = db.prepare(`
    INSERT INTO leads (id, list_id, phone, first_name, last_name, email, company, country, notes, extra_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importLeads = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const phone = (row[mapping.phone] || "").replace(/\s+/g, "");
      if (!phone) continue;

      const extra = {};
      for (const [key, val] of Object.entries(row)) {
        extra[key] = val;
      }

      insert.run(
        generateId(),
        req.params.id,
        phone,
        row[mapping.first_name] || "",
        row[mapping.last_name] || "",
        row[mapping.email] || "",
        row[mapping.company] || "",
        row[mapping.country] || "",
        row[mapping.notes] || "",
        JSON.stringify(extra)
      );
      count++;
    }
    return count;
  });

  const imported = importLeads(rawRows);

  // Update total count
  db.prepare("UPDATE lists SET total_leads = ?, updated_at = datetime('now') WHERE id = ?")
    .run(imported, req.params.id);

  // Clear cache
  delete global._csvCache[req.params.id];

  res.json({ message: `${imported} leads imported`, count: imported });
});

// Add single lead to list
router.post("/:id/leads", (req, res) => {
  const db = getDb();
  const list = db.prepare(
    "SELECT id FROM lists WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });

  const { phone, first_name, last_name, email, company, country, notes } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone is required" });

  const id = generateId();
  db.prepare(`
    INSERT INTO leads (id, list_id, phone, first_name, last_name, email, company, country, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, phone.replace(/\s+/g, ""), first_name || "", last_name || "",
    email || "", company || "", country || "", notes || "");

  // Update count
  const total = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE list_id = ?").get(req.params.id);
  db.prepare("UPDATE lists SET total_leads = ?, updated_at = datetime('now') WHERE id = ?")
    .run(total.cnt, req.params.id);

  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
  res.status(201).json(lead);
});

// Delete a lead
router.delete("/:listId/leads/:leadId", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM leads WHERE id = ? AND list_id = ?")
    .run(req.params.leadId, req.params.listId);

  const total = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE list_id = ?").get(req.params.listId);
  db.prepare("UPDATE lists SET total_leads = ?, updated_at = datetime('now') WHERE id = ?")
    .run(total.cnt, req.params.listId);

  res.json({ message: "Lead deleted" });
});

// Delete a list and all its leads
router.delete("/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM lists WHERE id = ? AND user_id = ?"
  ).run(req.params.id, req.user.userId);

  if (result.changes === 0) return res.status(404).json({ error: "List not found" });
  res.json({ message: "List and all leads deleted" });
});

// Update list info
router.put("/:id", (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  const fields = [];
  const values = [];

  if (name !== undefined) { fields.push("name = ?"); values.push(name); }
  if (description !== undefined) { fields.push("description = ?"); values.push(description); }
  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id, req.user.userId);

  db.prepare(`UPDATE lists SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);

  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(req.params.id);
  res.json(list);
});

export default router;
