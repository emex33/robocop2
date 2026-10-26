/**
 * Admin API - Super admin routes for managing users and credits
 */

import { Router } from "express";
import crypto from "crypto";
import dgram from "dgram";
import { getDb, generateId } from "../db/schema.js";
import { addCredits, getAllPlatformSettings, setPlatformSetting } from "../db/helpers.js";
import { deepgramKeyManager } from "../deepgram/key-manager.js";
import { getSipConfig } from "../../config/sip.js";
import { evaluateBalances, describeBalances, clearBalanceCache, getTrunkState, testDeepgramKey } from "../billing/balance-guard.js";
import { VOICE_ENGINES } from "../voice/engines.js";

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

// GET /api/admin/users/:id/sip — get SIP settings for a user
router.get("/users/:id/sip", (req, res) => {
  const db = getDb();
  const userId = req.params.id;
  const settings = db.prepare("SELECT * FROM sip_settings WHERE user_id = ?").get(userId);
  res.json({
    mode: settings?.mode || "account",
    username: settings?.username || "",
    password: settings?.password ? "********" : "",
    server: settings?.server || "",
    port: settings?.port || 12835,
    transport: settings?.transport || "udp",
    callerId: settings?.caller_id || "",
    trunkUsername: settings?.trunk_username || "",
    trunkHost: settings?.trunk_host || "",
    trunkPort: settings?.trunk_port || 12835,
    sourceIp: settings?.source_ip || "",
    transferUri: settings?.transfer_uri || "",
  });
});

// PUT /api/admin/users/:id/sip — update SIP settings for a user
router.put("/users/:id/sip", (req, res) => {
  const db = getDb();
  const userId = req.params.id;
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const {
    mode, username, password, server, port, transport,
    callerId, trunkUsername, trunkHost, trunkPort, sourceIp, transferUri,
  } = req.body;

  const existing = db.prepare("SELECT id FROM sip_settings WHERE user_id = ?").get(userId);

  if (existing) {
    const sets = [];
    const vals = [];
    if (mode !== undefined) { sets.push("mode = ?"); vals.push(mode); }
    if (username !== undefined) { sets.push("username = ?"); vals.push(username); }
    if (password !== undefined && password !== "********") { sets.push("password = ?"); vals.push(password); }
    if (server !== undefined) { sets.push("server = ?"); vals.push(server); }
    if (port !== undefined) { sets.push("port = ?"); vals.push(parseInt(port)); }
    if (transport !== undefined) { sets.push("transport = ?"); vals.push(transport); }
    if (callerId !== undefined) { sets.push("caller_id = ?"); vals.push(callerId); }
    if (trunkUsername !== undefined) { sets.push("trunk_username = ?"); vals.push(trunkUsername); }
    if (trunkHost !== undefined) { sets.push("trunk_host = ?"); vals.push(trunkHost); }
    if (trunkPort !== undefined) { sets.push("trunk_port = ?"); vals.push(parseInt(trunkPort)); }
    if (sourceIp !== undefined) { sets.push("source_ip = ?"); vals.push(sourceIp); }
    if (transferUri !== undefined) { sets.push("transfer_uri = ?"); vals.push(transferUri); }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      vals.push(userId);
      db.prepare(`UPDATE sip_settings SET ${sets.join(", ")} WHERE user_id = ?`).run(...vals);
    }
  } else {
    db.prepare(`
      INSERT INTO sip_settings (id, user_id, mode, username, password, server, port, transport, caller_id, trunk_username, trunk_host, trunk_port, source_ip, transfer_uri)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomBytes(8).toString("hex"), userId,
      mode || "account", username || "",
      (password && password !== "********") ? password : "",
      server || "", parseInt(port || "12835"), transport || "udp",
      callerId || "", trunkUsername || "", trunkHost || "",
      parseInt(trunkPort || "12835"), sourceIp || "", transferUri || "",
    );
  }

  res.json({ message: "SIP settings saved for user." });
});

// POST /api/admin/users/:id/sip/test — test SIP settings for a user
router.post("/users/:id/sip/test", async (req, res) => {
  const db = getDb();
  const userId = req.params.id;
  const settings = db.prepare("SELECT * FROM sip_settings WHERE user_id = ?").get(userId);
  if (!settings) {
    return res.json({ success: false, logs: [{ time: new Date().toISOString(), level: "error", message: "No SIP settings configured for this user. Save settings first." }] });
  }
  const sip = getSipConfig(settings);
  const logs = [];
  const log = (level, msg) => logs.push({ time: new Date().toISOString(), level, message: msg });

  const isValidIp = (ip) => {
    if (!ip) return false;
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    return parts.every(p => { const n = parseInt(p); return n >= 0 && n <= 255 && String(n) === p; });
  };

  log("info", `SIP Mode: ${sip.mode}`);
  let hasErrors = false;

  if (sip.mode === "account") {
    log("info", `Server: ${sip.server}:${sip.port} (${sip.transport})`);
    log("info", `Username: ${sip.username}`);
    log("info", `Password: ${sip.password ? "***set***" : "NOT SET"}`);
    if (!sip.username) { log("error", "Username is required"); hasErrors = true; }
    if (!sip.password) { log("error", "Password is required"); hasErrors = true; }
    if (!sip.server) { log("error", "Server is required"); hasErrors = true; }
  } else {
    log("info", `Trunk Host: ${sip.trunkHost}:${sip.trunkPort}`);
    const useCreds = sip.trunkAuth === "credentials";
    log("info", `Auth: ${useCreds ? "username and password" : "IP"}`);
    if (!sip.trunkHost) { log("error", "Trunk Host is required"); hasErrors = true; }
    if (useCreds) {
      log("info", `Username: ${sip.username || "(NOT SET)"}`);
      if (!sip.username) { log("error", "Username is required"); hasErrors = true; }
      if (!sip.password) { log("error", "Password is required"); hasErrors = true; }
    } else {
      log("info", `Username: ${sip.username}`);
      log("info", `Source IP: ${sip.sourceIp || "(NOT SET)"}`);
      if (!sip.sourceIp) { log("error", "Source IP is required for IP authentication"); hasErrors = true; }
      if (sip.sourceIp && !isValidIp(sip.sourceIp)) { log("error", `Source IP "${sip.sourceIp}" is invalid`); hasErrors = true; }
    }
  }

  if (hasErrors) return res.json({ success: false, logs });

  const targetHost = sip.mode === "trunk" ? sip.trunkHost : sip.server;
  const targetPort = sip.mode === "trunk" ? sip.trunkPort : sip.port;
  log("info", `Checking UDP reachability to ${targetHost}:${targetPort}...`);

  try {
    const result = await new Promise((resolve) => {
      const client = dgram.createSocket("udp4");
      const branch = `z9hG4bK-${Date.now()}`;
      const tag = `tag-${Date.now()}`;
      const fromUser = sip.username;
      const fromHost = sip.mode === "trunk" ? (sip.sourceIp || "0.0.0.0") : targetHost;
      const optionsMsg = [
        `OPTIONS sip:${targetHost}:${targetPort} SIP/2.0`,
        `Via: SIP/2.0/UDP ${fromHost}:5050;branch=${branch}`,
        `From: <sip:${fromUser}@${fromHost}:5050>;tag=${tag}`,
        `To: <sip:${targetHost}:${targetPort}>`,
        `Call-ID: test-${Date.now()}@robocop`,
        `CSeq: 1 OPTIONS`, `Max-Forwards: 70`, `Content-Length: 0`, ``, ``,
      ].join("\r\n");

      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) { responded = true; client.close(); resolve({ success: false }); }
      }, 10000);
      client.on("message", (msg) => {
        if (responded) return;
        responded = true; clearTimeout(timer);
        const firstLine = msg.toString().split("\r\n")[0];
        const m = firstLine.match(/SIP\/2\.0\s+(\d+)\s+(.*)/);
        client.close();
        resolve({ success: true, statusCode: m ? parseInt(m[1]) : 0, statusText: m ? m[2] : firstLine });
      });
      client.on("error", () => {
        if (!responded) { responded = true; clearTimeout(timer); client.close(); resolve({ success: false }); }
      });
      const buf = Buffer.from(optionsMsg, "utf-8");
      client.send(buf, 0, buf.length, targetPort, targetHost);
    });

    if (result.success) {
      log("success", `Server responded: ${result.statusCode} ${result.statusText}`);
      log("warn", "Note: This only confirms UDP reachability. It does NOT verify credentials or IP whitelist.");
    } else {
      log("error", `No response from ${targetHost}:${targetPort} (timeout). Check host/port/firewall.`);
      return res.json({ success: false, logs });
    }

    if (sip.mode === "trunk") {
      log("info", `--- INVITE preview ---`);
      log("info", `INVITE sip:[number]@${sip.trunkHost}:${sip.trunkPort}`);
      log("info", `From: ${sip.username} <sip:${sip.username}@${sip.sourceIp}:5050>`);
      log("info", `To: [number] <sip:[number]@${sip.trunkHost}:${sip.trunkPort}>`);
      log("info", `Contact: <sip:${sip.username}@${sip.sourceIp}:5050>`);
    }
    return res.json({ success: true, logs });
  } catch (err) {
    log("error", `Test failed: ${err.message}`);
    return res.json({ success: false, logs });
  }
});

// GET /api/admin/settings — get all platform settings (cost rates etc.)
router.get("/settings", (req, res) => {
  const settings = getAllPlatformSettings();
  res.json(settings);
});

// PUT /api/admin/settings — update platform settings
router.put("/settings", (req, res) => {
  const numericKeys = ["voip_cost_per_min", "ai_cost_per_min", "deepgram_min_balance", "voip_min_balance", "voip_balance_manual"];
  const stringKeys = ["voice_engine", "local_voice_agent_url", "balance_guard_enabled", "voip_trunk_breaker", "voip_balance_api_url", "voip_balance_api_key", "voip_balance_json_path"];
  const updates = req.body;
  let count = 0;
  for (const key of numericKeys) {
    if (updates[key] !== undefined) {
      const val = parseFloat(updates[key]);
      if (isNaN(val) || val < 0) return res.status(400).json({ error: `Invalid value for ${key}` });
      setPlatformSetting(key, val.toString());
      count++;
    }
  }
  for (const key of stringKeys) {
    if (updates[key] !== undefined) {
      if (key === "voice_engine" && !VOICE_ENGINES.includes(updates[key])) {
        return res.status(400).json({ error: `voice_engine must be ${VOICE_ENGINES.map((e) => `"${e}"`).join(", ")}` });
      }
      if (key === "balance_guard_enabled" && !["true", "false"].includes(String(updates[key]))) {
        return res.status(400).json({ error: `balance_guard_enabled must be "true" or "false"` });
      }
      if (key === "voip_trunk_breaker" && !["on", "off"].includes(String(updates[key]))) {
        return res.status(400).json({ error: `voip_trunk_breaker must be "on" or "off"` });
      }
      setPlatformSetting(key, updates[key]);
      count++;
    }
  }
  if (count === 0) return res.status(400).json({ error: "No valid settings provided" });
  clearBalanceCache(); // thresholds/endpoints may have changed — re-check on next tick
  res.json({ message: `${count} setting(s) updated`, settings: getAllPlatformSettings() });
});

// GET /api/admin/balances — live provider balances + whether dialing is allowed
router.get("/balances", async (req, res) => {
  const userId = req.query.user_id || req.user?.id;
  if (!userId) return res.status(400).json({ error: "user_id required" });
  if (req.query.refresh === "1") clearBalanceCache();
  try {
    const result = await evaluateBalances(userId);
    res.json({ ...result, trunkDetail: getTrunkState(), summary: describeBalances(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Google Sheets per user =====

// GET /api/admin/users/:id/google-sheets — check if user has credentials
router.get("/users/:id/google-sheets", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT google_sheets_credentials FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });
  let clientEmail = "";
  if (row.google_sheets_credentials) {
    try { clientEmail = JSON.parse(row.google_sheets_credentials).client_email || ""; } catch {}
  }
  res.json({ configured: !!row.google_sheets_credentials, client_email: clientEmail });
});

// PUT /api/admin/users/:id/google-sheets — save credentials for user
router.put("/users/:id/google-sheets", (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { credentials } = req.body;
  if (!credentials) return res.status(400).json({ error: "credentials JSON is required" });
  try {
    const parsed = typeof credentials === "string" ? JSON.parse(credentials) : credentials;
    if (!parsed.client_email || !parsed.private_key) return res.status(400).json({ error: "Invalid service account JSON: missing client_email or private_key" });
    const jsonStr = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
    db.prepare("UPDATE users SET google_sheets_credentials = ? WHERE id = ?").run(jsonStr, req.params.id);
    res.json({ message: "Google Sheets credentials saved", client_email: parsed.client_email });
  } catch (e) {
    return res.status(400).json({ error: `Invalid JSON: ${e.message}` });
  }
});

// DELETE /api/admin/users/:id/google-sheets — remove credentials
router.delete("/users/:id/google-sheets", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE users SET google_sheets_credentials = '' WHERE id = ?").run(req.params.id);
  res.json({ message: "Google Sheets credentials removed" });
});

// ===== Deepgram Keys per user =====

// GET /api/admin/users/:id/deepgram — list keys for a user
router.get("/users/:id/deepgram", (req, res) => {
  const status = deepgramKeyManager.getStatus(req.params.id);
  const keys = deepgramKeyManager.getAllKeys(req.params.id);
  res.json({ ...status, keys });
});

// POST /api/admin/users/:id/deepgram/keys — add a key for a user
router.post("/users/:id/deepgram/keys", (req, res) => {
  const db = getDb();
  const userId = req.params.id;
  const { api_key, label } = req.body;
  if (!api_key) return res.status(400).json({ error: "api_key is required" });
  const existing = db.prepare("SELECT id FROM deepgram_keys WHERE user_id = ? AND api_key = ?").get(userId, api_key);
  if (existing) return res.status(400).json({ error: "This key is already in the pool" });
  const id = generateId();
  const hasKeys = db.prepare("SELECT COUNT(*) as cnt FROM deepgram_keys WHERE user_id = ?").get(userId).cnt;
  db.prepare("INSERT INTO deepgram_keys (id, user_id, api_key, label, status, is_current) VALUES (?, ?, ?, ?, 'active', ?)").run(id, userId, api_key, label || "", hasKeys === 0 ? 1 : 0);
  const keys = deepgramKeyManager.getAllKeys(userId);
  const status = deepgramKeyManager.getStatus(userId);
  res.status(201).json({ message: "Key added", ...status, keys });
});

// DELETE /api/admin/users/:id/deepgram/keys/:keyId — remove a key
router.delete("/users/:id/deepgram/keys/:keyId", (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM deepgram_keys WHERE id = ? AND user_id = ?").run(req.params.keyId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Key not found" });
  const keys = deepgramKeyManager.getAllKeys(req.params.id);
  const status = deepgramKeyManager.getStatus(req.params.id);
  res.json({ message: "Key removed", ...status, keys });
});

// POST /api/admin/users/:id/deepgram/keys/:keyId/set-current — set active key
router.post("/users/:id/deepgram/keys/:keyId/set-current", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE deepgram_keys SET is_current = 0 WHERE user_id = ?").run(req.params.id);
  db.prepare("UPDATE deepgram_keys SET is_current = 1 WHERE id = ? AND user_id = ?").run(req.params.keyId, req.params.id);
  const keys = deepgramKeyManager.getAllKeys(req.params.id);
  const status = deepgramKeyManager.getStatus(req.params.id);
  res.json({ message: "Current key updated", ...status, keys });
});

// POST /api/admin/users/:id/deepgram/keys/:keyId/test — test a key
router.post("/users/:id/deepgram/keys/:keyId/test", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT api_key FROM deepgram_keys WHERE id = ? AND user_id = ?").get(req.params.keyId, req.params.id);
  if (!row) return res.status(404).json({ error: "Key not found" });
  res.json(await testDeepgramKey(row.api_key));
});

// GET /api/admin/users/:id/agents — get agents for a user
router.get("/users/:id/agents", (req, res) => {
  const db = getDb();
  const agents = db.prepare("SELECT id, name, language, mode FROM agents WHERE user_id = ?").all(req.params.id);
  res.json(agents);
});

export default router;
