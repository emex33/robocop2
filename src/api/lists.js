/**
 * Lists API Routes
 * CRUD for lead lists - upload CSV, manage leads
 */

import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { getDb, generateId } from "../db/schema.js";
import { normalizeDialPhone } from "../call/phone.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Short-lived cache for per-list lead COUNT(*). On big lists (160k+ rows) this
// count takes hundreds of ms and blocks the synchronous event loop every time
// the list detail page opens or paginates. It only feeds pagination display.
const listCountCache = new Map();
const LIST_COUNT_TTL_MS = 15_000;

function getListCount(listId, compute) {
  const hit = listCountCache.get(listId);
  if (hit && Date.now() - hit.ts < LIST_COUNT_TTL_MS) return hit.value;
  const value = compute();
  listCountCache.set(listId, { ts: Date.now(), value });
  return value;
}

const importJobs = new Map(); // listId -> { status, imported, total, error? }
const IMPORT_BATCH_SIZE = 10000;

// Bulk-insert speed tuning. The leads table has several indexes and can be very
// large, so index maintenance + per-commit fsync dominate import time. During an
// import we trade durability for speed, then restore safe settings afterwards.
let bulkModeDepth = 0;
function enterBulkMode(db) {
  if (bulkModeDepth === 0) {
    try { db.pragma("synchronous = OFF"); } catch {}
    try { db.pragma("temp_store = MEMORY"); } catch {}
    try { db.pragma("cache_size = -524288"); } catch {} // ~512 MB page cache
  }
  bulkModeDepth++;
}
function exitBulkMode(db) {
  bulkModeDepth = Math.max(0, bulkModeDepth - 1);
  if (bulkModeDepth === 0) {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
    try { db.pragma("synchronous = NORMAL"); } catch {}
    try { db.pragma("cache_size = -65536"); } catch {}
  }
}

function looksLikeHeaderless(columnNames) {
  if (columnNames.length === 0) return false;
  let dataLike = 0;
  for (const col of columnNames) {
    const value = String(col).trim();
    if (/^\+?\d{10,15}$/.test(value.replace(/[\s\-().]/g, ""))) dataLike++;
    else if (/@/.test(value)) dataLike++;
    else if (/^[A-Za-z]{2,20}$/.test(value)) dataLike++;
  }
  return dataLike >= Math.ceil(columnNames.length * 0.5);
}

function parseCsvContent(content) {
  let rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (rows.length === 0) return { rows: [], columns: [], headerless: false };

  let columns = Object.keys(rows[0]);
  if (!looksLikeHeaderless(columns)) {
    return { rows, columns, headerless: false };
  }

  const raw = parse(content, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  // Avoid Math.max(...array) — spreading a very large array overflows the call stack.
  let colCount = 0;
  for (const row of raw) {
    if (row.length > colCount) colCount = row.length;
  }
  columns = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
  rows = raw.map((row) => {
    const obj = {};
    for (let i = 0; i < colCount; i++) {
      obj[columns[i]] = row[i] ?? "";
    }
    return obj;
  });

  return { rows, columns, headerless: true };
}

function buildLeadInsert(db, listId, mapping) {
  const insert = db.prepare(`
    INSERT INTO leads (id, list_id, phone, first_name, last_name, email, company, country, notes, extra_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return (row) => {
    const phone = normalizeDialPhone(row[mapping.phone]) || String(row[mapping.phone] || "").replace(/\s+/g, "");
    if (!phone) return false;

    const extra = {};
    for (const [key, val] of Object.entries(row)) {
      extra[key] = val;
    }

    insert.run(
      generateId(),
      listId,
      phone,
      row[mapping.first_name] || "",
      row[mapping.last_name] || "",
      row[mapping.email] || "",
      row[mapping.company] || "",
      row[mapping.country] || "",
      row[mapping.notes] || "",
      JSON.stringify(extra)
    );
    return true;
  };
}

function runBackgroundImport(listId, rawRows, mapping) {
  importJobs.set(listId, { status: "running", imported: 0, total: rawRows.length });

  const db = getDb();
  const insertLead = buildLeadInsert(db, listId, mapping);
  let imported = 0;
  let offset = 0;
  const startedAt = Date.now();
  enterBulkMode(db);

  const finish = (status, extra = {}) => {
    exitBulkMode(db);
    importJobs.set(listId, { status, imported, total: rawRows.length, ...extra });
  };

  const processBatch = () => {
    try {
      const batch = rawRows.slice(offset, offset + IMPORT_BATCH_SIZE);
      if (batch.length === 0) {
        db.prepare("UPDATE lists SET total_leads = total_leads + ?, updated_at = datetime('now') WHERE id = ?")
          .run(imported, listId);
        listCountCache.delete(listId);
        delete global._csvCache?.[listId];
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        finish("done", { seconds: Number(secs) });
        console.log(`Import done for list ${listId}: ${imported} leads in ${secs}s`);
        return;
      }

      const importBatch = db.transaction((rows) => {
        let count = 0;
        for (const row of rows) {
          if (insertLead(row)) count++;
        }
        return count;
      });

      imported += importBatch(batch);
      offset += IMPORT_BATCH_SIZE;
      importJobs.set(listId, { status: "running", imported, total: rawRows.length });
      setImmediate(processBatch);
    } catch (err) {
      finish("error", { error: err.message });
      console.error(`Import failed for list ${listId}:`, err.message);
    }
  };

  setImmediate(processBatch);
}

// List all lists for current user
router.get("/", (req, res) => {
  const db = getDb();
  const lists = db.prepare(`
    SELECT * FROM lists WHERE user_id = ?
    ORDER BY created_at DESC
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

  const totalCnt = getListCount(req.params.id, () =>
    db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE list_id = ?").get(req.params.id).cnt
  );
  const total = { cnt: totalCnt };
  const leads = db.prepare(
    "SELECT * FROM leads INDEXED BY idx_leads_list_created WHERE list_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
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
    const { rows, columns, headerless } = parseCsvContent(content);
    if (rows.length === 0) return res.status(400).json({ error: "CSV has no data rows" });

    const preview = rows.slice(0, 5);

    // Store raw rows temporarily in memory (keyed by list id)
    if (!global._csvCache) global._csvCache = {};
    global._csvCache[req.params.id] = rows;

    res.json({ columns, totalRows: rows.length, preview, headerless });
  } catch (e) {
    res.status(400).json({ error: `CSV parse error: ${e.message}` });
  }
});

// Poll background import progress (large CSV imports)
router.get("/:id/import-status", (req, res) => {
  const db = getDb();
  const list = db.prepare(
    "SELECT id FROM lists WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });

  const job = importJobs.get(req.params.id);
  if (!job) return res.json({ status: "idle" });
  res.json(job);
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

  const existingJob = importJobs.get(req.params.id);
  if (existingJob?.status === "running") {
    return res.status(409).json({ error: "Import already in progress for this list" });
  }

  // Save mapping
  db.prepare("UPDATE lists SET field_mapping_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(mapping), req.params.id);

  const totalRows = rawRows.length;
  const useBackground = totalRows > 5000;

  if (useBackground) {
    runBackgroundImport(req.params.id, rawRows, mapping);
    return res.json({
      message: `Import started for ${totalRows.toLocaleString()} leads. This runs in the background and may take several minutes.`,
      count: totalRows,
      background: true,
    });
  }

  const insertLead = buildLeadInsert(db, req.params.id, mapping);
  const importLeads = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      if (insertLead(row)) count++;
    }
    return count;
  });

  enterBulkMode(db);
  let imported = 0;
  try {
    imported = importLeads(rawRows);
  } finally {
    exitBulkMode(db);
  }

  db.prepare("UPDATE lists SET total_leads = total_leads + ?, updated_at = datetime('now') WHERE id = ?")
    .run(imported, req.params.id);

  delete global._csvCache[req.params.id];
  listCountCache.delete(req.params.id);

  res.json({ message: `${imported} leads imported`, count: imported, background: false });
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
  `).run(id, req.params.id, normalizeDialPhone(phone) || phone.replace(/\s+/g, ""), first_name || "", last_name || "",
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

  db.prepare("UPDATE lists SET total_leads = MAX(total_leads - 1, 0), updated_at = datetime('now') WHERE id = ?")
    .run(req.params.listId);

  res.json({ message: "Lead deleted" });
});

// Delete a list and all its leads.
//
// Each lead row has ON DELETE SET NULL into call_records. Doing that per row
// scanned the whole call history and froze the dashboard. Clear those links
// once, then delete the leads with foreign keys off for that batch only.
// The event loop is free between batches, so the page keeps answering.
router.delete("/:id", (req, res) => {
  const db = getDb();
  const listId = req.params.id;
  const list = db.prepare(
    "SELECT id FROM lists WHERE id = ? AND user_id = ?"
  ).get(listId, req.user.userId);

  if (!list) return res.status(404).json({ error: "List not found" });

  res.json({ message: "List deletion started" });

  const BATCH = 2000;
  const detachCalls = db.prepare(`
    UPDATE call_records SET lead_id = NULL
    WHERE lead_id IN (SELECT id FROM leads WHERE list_id = ?)
  `);
  const detachAppts = db.prepare(`
    UPDATE appointments SET lead_id = NULL
    WHERE lead_id IN (SELECT id FROM leads WHERE list_id = ?)
  `);
  const deleteLeadBatch = db.prepare(
    "DELETE FROM leads WHERE rowid IN (SELECT rowid FROM leads WHERE list_id = ? LIMIT ?)"
  );

  const finishListDelete = () => {
    db.prepare("DELETE FROM campaign_lists WHERE list_id = ?").run(listId);
    db.prepare("DELETE FROM lists WHERE id = ?").run(listId);
    listCountCache.delete(listId);
    delete global._csvCache?.[listId];
  };

  const deleteLeads = () => {
    let deleted = 0;
    try {
      db.pragma("foreign_keys = OFF");
      deleted = deleteLeadBatch.run(listId, BATCH).changes;
    } catch (err) {
      console.error(`List delete failed for ${listId}:`, err.message);
      return;
    } finally {
      try { db.pragma("foreign_keys = ON"); } catch { /* keep the connection usable */ }
    }
    if (deleted >= BATCH) setTimeout(deleteLeads, 20);
    else finishListDelete();
  };

  setImmediate(() => {
    try {
      detachCalls.run(listId);
      detachAppts.run(listId);
    } catch (err) {
      console.error(`List detach failed for ${listId}:`, err.message);
      return;
    }
    deleteLeads();
  });
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
