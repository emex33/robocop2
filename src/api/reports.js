/**
 * Reports API Routes
 * Transferred leads report with campaign filter and search
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";

const router = Router();

// Get transferred leads report
// Query params: campaign_id, search, page, limit
router.get("/transfers", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const campaignId = req.query.campaign_id || "";
  const search = req.query.search || "";
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  let where = "cr.user_id = ? AND cr.outcome = 'transferred'";
  const params = [userId];

  if (campaignId) {
    where += " AND cr.campaign_id = ?";
    params.push(campaignId);
  }

  if (search) {
    where += " AND (cr.phone LIKE ? OR cr.lead_name LIKE ? OR l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ?)";
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }

  // Count total
  const countSql = `
    SELECT COUNT(*) as cnt FROM call_records cr
    LEFT JOIN leads l ON cr.lead_id = l.id
    WHERE ${where}
  `;
  const total = db.prepare(countSql).get(...params);

  // Fetch records with lead details + campaign name
  const dataSql = `
    SELECT
      cr.id,
      cr.call_id,
      cr.phone,
      cr.lead_name,
      cr.outcome,
      cr.duration_seconds,
      cr.notes,
      cr.transcript_json,
      cr.transferred_to,
      cr.call_summary,
      cr.started_at,
      cr.ended_at,
      cr.campaign_id,
      c.name as campaign_name,
      l.first_name,
      l.last_name,
      l.email,
      l.company as lead_company,
      l.country,
      l.extra_json
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    LEFT JOIN leads l ON cr.lead_id = l.id
    WHERE ${where}
    ORDER BY cr.started_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  const records = db.prepare(dataSql).all(...params);

  // Parse and enrich each record
  const result = records.map(r => {
    const extra = JSON.parse(r.extra_json || "{}");
    const transcript = JSON.parse(r.transcript_json || "[]");

    // Extract KYC info from transcript user lines
    const userLines = transcript.filter(t => t.role === "user").map(t => t.text).join(" ");
    const agentLines = transcript.filter(t => t.role === "agent").map(t => t.text).join(" ");

    // Try to extract age, job, income, goal from the conversation
    const age = extractField(userLines, /\b(\d{2,3})\s*(?:years?\s*old|año)/i)
      || extra.age || "";
    const job = extractField(userLines, /(?:work|job|profession|do for a living)[^.]*?(?:i(?:'m| am)\s+(?:a |an )?)([\w\s]+)/i)
      || extra.job || extra.profession || "";
    const income = extractField(userLines, /(\d[\d,.]+\s*(?:euros?|dollars?|\$|€|usd|eur|pounds?|£))/i)
      || extractField(userLines, /(?:income|salary|earn)[^.]*?(\d[\d,.]+)/i)
      || extra.income || "";
    const goal = extractField(userLines, /(?:goal|priority|looking for|want to)[^.]*?([\w\s,]+)/i)
      || extra.goal || "";

    return {
      id: r.id,
      date: r.started_at ? r.started_at.slice(0, 10) : "",
      time: r.started_at ? r.started_at.slice(11, 19) : "",
      first_name: r.first_name || r.lead_name?.split(" ")[0] || "",
      last_name: r.last_name || r.lead_name?.split(" ").slice(1).join(" ") || "",
      phone: r.phone,
      email: r.email || "",
      age,
      job,
      income,
      goal,
      interested: r.outcome === "transferred" ? "TRUE" : "FALSE",
      call_transferred: r.outcome === "transferred" ? "TRUE" : "FALSE",
      transferred_to: r.transferred_to || "",
      call_summary: r.call_summary || "",
      campaign_name: r.campaign_name || "",
      campaign_id: r.campaign_id || "",
      duration_seconds: r.duration_seconds,
      transcript,
    };
  });

  // Summary stats
  const statsSql = `
    SELECT
      COUNT(*) as total_transfers,
      AVG(cr.duration_seconds) as avg_duration,
      COUNT(DISTINCT cr.campaign_id) as campaigns_count
    FROM call_records cr
    WHERE cr.user_id = ? AND cr.outcome = 'transferred'
  `;
  const stats = db.prepare(statsSql).get(userId);

  res.json({
    transfers: result,
    total: total.cnt,
    page,
    pages: Math.ceil(total.cnt / limit),
    stats,
  });
});

// Export transferred leads as CSV
router.get("/transfers/export", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const campaignId = req.query.campaign_id || "";

  let where = "cr.user_id = ? AND cr.outcome = 'transferred'";
  const params = [userId];

  if (campaignId) {
    where += " AND cr.campaign_id = ?";
    params.push(campaignId);
  }

  const records = db.prepare(`
    SELECT cr.*, c.name as campaign_name, l.first_name, l.last_name, l.email, l.extra_json
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    LEFT JOIN leads l ON cr.lead_id = l.id
    WHERE ${where}
    ORDER BY cr.started_at DESC
  `).all(...params);

  // Build CSV
  const headers = ["Date", "Time", "FirstName", "LastName", "Phone", "Email", "Age", "Job", "Income", "Goal", "Interested", "CallTransferred", "TransferredTo", "CallSummary", "Campaign"];
  const rows = records.map(r => {
    const extra = JSON.parse(r.extra_json || "{}");
    return [
      r.started_at?.slice(0, 10) || "",
      r.started_at?.slice(11, 19) || "",
      r.first_name || r.lead_name?.split(" ")[0] || "",
      r.last_name || "",
      r.phone,
      r.email || "",
      extra.age || "",
      extra.job || extra.profession || "",
      extra.income || "",
      extra.goal || "",
      "TRUE",
      "TRUE",
      r.transferred_to || "",
      (r.call_summary || "").replace(/"/g, '""'),
      r.campaign_name || "",
    ].map(v => `"${v}"`).join(",");
  });

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=transferred-leads.csv");
  res.send(csv);
});

function extractField(text, regex) {
  const match = text.match(regex);
  return match ? match[1]?.trim() : "";
}

export default router;
