/**
 * Calls API - Full call log with filters, search, export
 * Scoped per user_id for multi-tenancy
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";

const router = Router();

// Short-lived cache for the expensive COUNT(*) on call_records. Counting the
// full (500k+ row) table takes ~1s and, because better-sqlite3 is synchronous,
// blocks the whole event loop on every Calls-page load. The total only feeds
// pagination, so a few seconds of staleness is harmless.
const countCache = new Map();
const COUNT_TTL_MS = 15_000;
const COUNT_MAX_AGE_MS = 10 * 60_000;

// Stale-while-revalidate: a known total is returned at once and refreshed
// after the response when older than the TTL; only a never-seen filter shape
// counts inline.
function getCachedCount(key, compute) {
  const hit = countCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < COUNT_TTL_MS) return hit.value;
  if (hit && now - hit.ts < COUNT_MAX_AGE_MS) {
    if (!hit.refreshing) {
      hit.refreshing = true;
      setTimeout(() => {
        try { countCache.set(key, { ts: Date.now(), value: compute() }); }
        catch { hit.refreshing = false; }
      }, 0);
    }
    return hit.value;
  }
  const value = compute();
  countCache.set(key, { ts: now, value });
  // Prevent unbounded growth from many distinct filter combinations.
  if (countCache.size > 500) {
    const cutoff = now - COUNT_MAX_AGE_MS;
    for (const [k, v] of countCache) if (v.ts < cutoff) countCache.delete(k);
  }
  return value;
}

// Free-text search cannot use an index (LIKE '%x%'), so it is bounded: a
// pure-digit term only searches the phone column, and the total is capped at
// SEARCH_COUNT_CAP matches instead of scanning all 1.3M rows to count them.
const SEARCH_COUNT_CAP = 2000;

// GET /api/calls - paginated call logs with filters
router.get("/", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const {
    campaign_id,
    outcome,
    search,
    date_from,
    date_to,
    min_duration,
    max_duration,
    sort = "started_at",
    order = "desc",
    page: rawPage,
    limit: rawLimit,
  } = req.query;

  const page = parseInt(rawPage) || 1;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = ["cr.user_id = ?"];
  const params = [userId];

  if (campaign_id) {
    conditions.push("cr.campaign_id = ?");
    params.push(campaign_id);
  }

  if (outcome) {
    const outcomes = outcome.split(",");
    conditions.push(`cr.outcome IN (${outcomes.map(() => "?").join(",")})`);
    params.push(...outcomes);
  }

  if (date_from) {
    conditions.push("cr.started_at >= ?");
    params.push(date_from);
  }

  if (date_to) {
    conditions.push("cr.started_at <= ?");
    params.push(date_to + " 23:59:59");
  }

  if (min_duration) {
    conditions.push("cr.duration_seconds >= ?");
    params.push(parseInt(min_duration));
  }

  if (max_duration) {
    conditions.push("cr.duration_seconds <= ?");
    params.push(parseInt(max_duration));
  }

  const term = String(search || "").trim();
  if (term) {
    const s = `%${term}%`;
    if (/^[\d\s()+-]+$/.test(term)) {
      // Phone-number search: one column, digits only.
      conditions.push("cr.phone LIKE ?");
      params.push(`%${term.replace(/\D/g, "")}%`);
    } else {
      conditions.push(
        "(cr.lead_name LIKE ? OR cr.phone LIKE ? OR cr.notes LIKE ? OR cr.call_summary LIKE ?)"
      );
      params.push(s, s, s, s);
    }
  }

  const where = conditions.join(" AND ");

  // Allowed sort columns
  const sortCols = {
    started_at: "cr.started_at",
    duration: "cr.duration_seconds",
    outcome: "cr.outcome",
    phone: "cr.phone",
    lead_name: "cr.lead_name",
  };
  const sortCol = sortCols[sort] || "cr.started_at";
  const sortOrder = order === "asc" ? "ASC" : "DESC";

  // Total count (cached — see countCache above). Keyed by the filter shape so
  // different filters/searches get their own cached total.
  const countKey = `${userId}|${where}|${JSON.stringify(params)}`;
  const total = getCachedCount(countKey, () => term
    ? db.prepare(`SELECT COUNT(*) as cnt FROM (SELECT 1 FROM call_records cr WHERE ${where} LIMIT ${SEARCH_COUNT_CAP})`).get(...params).cnt
    : db.prepare(`SELECT COUNT(*) as cnt FROM call_records cr WHERE ${where}`).get(...params).cnt
  );

  // Fetch records
  const dataParams = [...params, limit, offset];
  const records = db
    .prepare(
      `SELECT
        cr.id, cr.call_id, cr.phone, cr.lead_name, cr.outcome,
        cr.duration_seconds, cr.ai_duration_seconds, cr.notes,
        cr.transferred_to, cr.error_message, cr.call_summary,
        cr.recording_path, cr.recording_url, cr.started_at, cr.ended_at,
        cr.campaign_id, cr.agent_id,
        cr.call_cost, cr.voip_cost, cr.ai_cost,
        c.name AS campaign_name,
        a.name AS agent_name,
        l.first_name, l.last_name, l.email, l.company AS lead_company, l.country
      FROM call_records cr
      LEFT JOIN campaigns c ON cr.campaign_id = c.id
      LEFT JOIN agents a ON cr.agent_id = a.id
      LEFT JOIN leads l ON cr.lead_id = l.id
      WHERE ${where}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?`
    )
    .all(...dataParams);

  const calls = records.map((r) => ({
    id: r.id,
    call_id: r.call_id,
    phone: r.phone,
    lead_name: r.lead_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "",
    email: r.email || "",
    lead_company: r.lead_company || "",
    country: r.country || "",
    outcome: r.outcome,
    duration_seconds: r.duration_seconds,
    ai_duration_seconds: r.ai_duration_seconds || 0,
    notes: r.notes || "",
    call_summary: r.call_summary || "",
    transferred_to: r.transferred_to || "",
    error_message: r.error_message || "",
    recording_path: r.recording_path || "",
    recording_url: r.recording_url || "",
    started_at: r.started_at || "",
    ended_at: r.ended_at || "",
    campaign_id: r.campaign_id || "",
    campaign_name: r.campaign_name || "",
    agent_id: r.agent_id || "",
    agent_name: r.agent_name || "",
    call_cost: r.call_cost || 0,
    voip_cost: r.voip_cost || 0,
    ai_cost: r.ai_cost || 0,
    transcript: [],
  }));

  // Compute lightweight stats from the total count (skip full table scan)
  const stats = { total_calls: total };

  res.json({
    calls,
    total,
    page,
    pages: Math.ceil(total / limit),
    stats,
  });
});

// GET /api/calls/:id - single call detail with full transcript
router.get("/:id", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;

  const record = db
    .prepare(
      `SELECT
        cr.*, c.name AS campaign_name, a.name AS agent_name,
        l.first_name, l.last_name, l.email, l.company AS lead_company,
        l.country, l.extra_json
      FROM call_records cr
      LEFT JOIN campaigns c ON cr.campaign_id = c.id
      LEFT JOIN agents a ON cr.agent_id = a.id
      LEFT JOIN leads l ON cr.lead_id = l.id
      WHERE cr.id = ? AND cr.user_id = ?`
    )
    .get(req.params.id, userId);

  if (!record) return res.status(404).json({ error: "Call not found" });

  res.json({
    ...record,
    transcript: JSON.parse(record.transcript_json || "[]"),
    extra: JSON.parse(record.extra_json || "{}"),
    campaign_name: record.campaign_name || "",
    agent_name: record.agent_name || "",
  });
});

// GET /api/calls/export/csv - export filtered calls as CSV
router.get("/export/csv", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const { campaign_id, outcome, date_from, date_to } = req.query;

  const conditions = ["cr.user_id = ?"];
  const params = [userId];

  if (campaign_id) { conditions.push("cr.campaign_id = ?"); params.push(campaign_id); }
  if (outcome) {
    const outcomes = outcome.split(",");
    conditions.push(`cr.outcome IN (${outcomes.map(() => "?").join(",")})`);
    params.push(...outcomes);
  }
  if (date_from) { conditions.push("cr.started_at >= ?"); params.push(date_from); }
  if (date_to) { conditions.push("cr.started_at <= ?"); params.push(date_to + " 23:59:59"); }

  const where = conditions.join(" AND ");

  const records = db
    .prepare(
      `SELECT cr.*, c.name AS campaign_name, a.name AS agent_name,
              l.first_name, l.last_name, l.email
       FROM call_records cr
       LEFT JOIN campaigns c ON cr.campaign_id = c.id
       LEFT JOIN agents a ON cr.agent_id = a.id
       LEFT JOIN leads l ON cr.lead_id = l.id
       WHERE ${where}
       ORDER BY cr.started_at DESC`
    )
    .all(...params);

  const headers = ["Date","Time","Phone","Lead Name","Email","Campaign","AI Agent","Outcome","Duration (s)","Transferred To","Summary","Notes"];
  const rows = records.map((r) => {
    return [
      r.started_at?.slice(0, 10) || "",
      r.started_at?.slice(11, 19) || "",
      r.phone,
      r.lead_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "",
      r.email || "",
      r.campaign_name || "",
      r.agent_name || "",
      r.outcome,
      r.duration_seconds,
      r.transferred_to || "",
      (r.call_summary || "").replace(/"/g, '""'),
      (r.notes || "").replace(/"/g, '""'),
    ].map((v) => `"${v}"`).join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=call-logs.csv");
  res.send(csv);
});

export default router;
