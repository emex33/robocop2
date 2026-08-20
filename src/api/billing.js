/**
 * Billing API - User-facing credit balance, transactions, usage
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";
import { getUserBalance } from "../db/helpers.js";

const router = Router();

const usageCache = new Map();
const USAGE_CACHE_TTL = 60_000; // 1 minute

// GET /api/billing/balance — current user's credit balance
router.get("/balance", (req, res) => {
  const balance = getUserBalance(req.user.userId);
  res.json({ balance });
});

// GET /api/billing/transactions — user's transaction history
router.get("/transactions", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const { type, page: rawPage, limit: rawLimit, date_from, date_to } = req.query;

  const page = parseInt(rawPage) || 1;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = ["ct.user_id = ?"];
  const params = [userId];

  if (type) { conditions.push("ct.type = ?"); params.push(type); }
  if (date_from) { conditions.push("ct.created_at >= ?"); params.push(date_from); }
  if (date_to) { conditions.push("ct.created_at <= ?"); params.push(date_to + " 23:59:59"); }

  const where = conditions.join(" AND ");

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM credit_transactions ct WHERE ${where}`).get(...params).cnt;

  const transactions = db.prepare(`
    SELECT * FROM credit_transactions ct
    WHERE ${where}
    ORDER BY ct.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/billing/usage — user's usage summary
router.get("/usage", (req, res) => {
  const userId = req.user.userId;

  const cached = usageCache.get(userId);
  if (cached && Date.now() - cached.ts < USAGE_CACHE_TTL) {
    cached.data.balance = getUserBalance(userId);
    return res.json(cached.data);
  }

  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_calls,
      COALESCE(SUM(duration_seconds), 0) AS total_duration,
      COALESCE(SUM(ai_duration_seconds), 0) AS total_ai_duration,
      COALESCE(SUM(call_cost), 0) AS total_cost,
      COALESCE(SUM(voip_cost), 0) AS total_voip_cost,
      COALESCE(SUM(ai_cost), 0) AS total_ai_cost
    FROM call_records WHERE user_id = ? AND started_at >= datetime('now', '-30 days')
  `).get(userId);

  const byDay = db.prepare(`
    SELECT
      DATE(started_at) AS day,
      COUNT(*) AS calls,
      SUM(duration_seconds) AS duration,
      SUM(ai_duration_seconds) AS ai_duration,
      SUM(call_cost) AS cost
    FROM call_records
    WHERE user_id = ? AND started_at >= datetime('now', '-30 days')
    GROUP BY DATE(started_at)
    ORDER BY day DESC
  `).all(userId);

  const byCampaign = db.prepare(`
    SELECT
      c.name AS campaign_name,
      COUNT(*) AS calls,
      SUM(cr.duration_seconds) AS duration,
      SUM(cr.ai_duration_seconds) AS ai_duration,
      SUM(cr.call_cost) AS cost
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.user_id = ? AND cr.started_at >= datetime('now', '-30 days')
    GROUP BY cr.campaign_id
    ORDER BY cost DESC
    LIMIT 20
  `).all(userId);

  const balance = getUserBalance(userId);

  const data = { balance, totals, byDay, byCampaign };
  usageCache.set(userId, { ts: Date.now(), data });
  res.json(data);
});

export default router;
