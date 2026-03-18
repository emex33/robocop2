/**
 * Admin API - Super admin routes for managing users and credits
 */

import { Router } from "express";
import { getDb } from "../db/schema.js";
import { addCredits } from "../db/helpers.js";

const router = Router();

// GET /api/admin/users — list all users with credit balance and usage stats
router.get("/users", (req, res) => {
  const db = getDb();

  const users = db.prepare(`
    SELECT
      u.id, u.email, u.name, u.company, u.is_super_admin, u.created_at,
      COALESCE(uc.balance, 0) AS credit_balance,
      COALESCE(cs.total_calls, 0) AS total_calls,
      COALESCE(cs.total_duration, 0) AS total_duration,
      COALESCE(cs.total_ai_duration, 0) AS total_ai_duration,
      COALESCE(cs.total_spent, 0) AS total_spent,
      COALESCE(cs.total_voip_cost, 0) AS total_voip_cost,
      COALESCE(cs.total_ai_cost, 0) AS total_ai_cost,
      COALESCE(tp.total_topups, 0) AS total_topups
    FROM users u
    LEFT JOIN user_credits uc ON u.id = uc.user_id
    LEFT JOIN (
      SELECT user_id,
        COUNT(*) AS total_calls,
        SUM(duration_seconds) AS total_duration,
        SUM(ai_duration_seconds) AS total_ai_duration,
        SUM(call_cost) AS total_spent,
        SUM(voip_cost) AS total_voip_cost,
        SUM(ai_cost) AS total_ai_cost
      FROM call_records GROUP BY user_id
    ) cs ON u.id = cs.user_id
    LEFT JOIN (
      SELECT user_id, SUM(amount) AS total_topups
      FROM credit_transactions WHERE type = 'topup' GROUP BY user_id
    ) tp ON u.id = tp.user_id
    ORDER BY u.created_at DESC
  `).all();

  res.json(users);
});

// GET /api/admin/users/:id — single user detail with recent transactions
router.get("/users/:id", (req, res) => {
  const db = getDb();
  const userId = req.params.id;

  const user = db.prepare(`
    SELECT u.id, u.email, u.name, u.company, u.is_super_admin, u.created_at,
      COALESCE(uc.balance, 0) AS credit_balance
    FROM users u LEFT JOIN user_credits uc ON u.id = uc.user_id
    WHERE u.id = ?
  `).get(userId);

  if (!user) return res.status(404).json({ error: "User not found" });

  const transactions = db.prepare(`
    SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(userId);

  const callStats = db.prepare(`
    SELECT
      COUNT(*) AS total_calls,
      SUM(duration_seconds) AS total_duration,
      SUM(ai_duration_seconds) AS total_ai_duration,
      SUM(call_cost) AS total_spent,
      SUM(voip_cost) AS total_voip_cost,
      SUM(ai_cost) AS total_ai_cost
    FROM call_records WHERE user_id = ?
  `).get(userId);

  res.json({ user, transactions, callStats });
});

// POST /api/admin/users/:id/credits — add credits to a user
router.post("/users/:id/credits", (req, res) => {
  const db = getDb();
  const userId = req.params.id;
  const { amount, description } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: "Amount must be positive" });

  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const newBalance = addCredits(userId, amount, description || "Admin top-up", req.user.userId);
  res.json({ balance: newBalance, message: `$${amount.toFixed(2)} credits added` });
});

// GET /api/admin/billing — global billing overview
router.get("/billing", (req, res) => {
  const db = getDb();

  const overview = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'topup' THEN amount ELSE 0 END), 0) AS total_topups,
      COALESCE(SUM(CASE WHEN type = 'call_charge' THEN ABS(amount) ELSE 0 END), 0) AS total_charges,
      COUNT(CASE WHEN type = 'topup' THEN 1 END) AS topup_count,
      COUNT(CASE WHEN type = 'call_charge' THEN 1 END) AS charge_count
    FROM credit_transactions
  `).get();

  const callTotals = db.prepare(`
    SELECT
      COUNT(*) AS total_calls,
      SUM(duration_seconds) AS total_duration,
      SUM(ai_duration_seconds) AS total_ai_duration,
      SUM(call_cost) AS total_call_cost,
      SUM(voip_cost) AS total_voip_cost,
      SUM(ai_cost) AS total_ai_cost
    FROM call_records
  `).get();

  const totalCreditBalance = db.prepare("SELECT SUM(balance) AS total FROM user_credits").get();

  res.json({
    ...overview,
    ...callTotals,
    total_credit_balance: totalCreditBalance?.total || 0,
  });
});

// GET /api/admin/billing/transactions — all transactions across users
router.get("/billing/transactions", (req, res) => {
  const db = getDb();
  const { type, user_id, page: rawPage, limit: rawLimit } = req.query;

  const page = parseInt(rawPage) || 1;
  const limit = Math.min(parseInt(rawLimit) || 50, 200);
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (type) { conditions.push("ct.type = ?"); params.push(type); }
  if (user_id) { conditions.push("ct.user_id = ?"); params.push(user_id); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM credit_transactions ct ${where}`).get(...params).cnt;

  const transactions = db.prepare(`
    SELECT ct.*, u.email AS user_email, u.name AS user_name
    FROM credit_transactions ct
    LEFT JOIN users u ON ct.user_id = u.id
    ${where}
    ORDER BY ct.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ transactions, total, page, pages: Math.ceil(total / limit) });
});

export default router;
