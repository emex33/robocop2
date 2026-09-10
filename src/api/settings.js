import { Router } from "express";
import dgram from "dgram";
import dns from "dns";
import { getDb, generateId } from "../db/schema.js";
import { getSipConfig } from "../../config/sip.js";
import { deepgramKeyManager } from "../deepgram/key-manager.js";
import { testDeepgramKey } from "../billing/balance-guard.js";

const router = Router();

function getUserSipSettings(userId, trunkId) {
  const db = getDb();
  if (trunkId) {
    return db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(trunkId, userId) || null;
  }
  return db.prepare("SELECT * FROM sip_settings WHERE user_id = ? AND is_default = 1").get(userId)
    || db.prepare("SELECT * FROM sip_settings WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(userId)
    || null;
}

const isValidIp = (ip) => {
  if (!ip) return true;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => { const n = parseInt(p); return n >= 0 && n <= 255 && String(n) === p; });
};

function maskTrunk(row) {
  return {
    id: row.id,
    name: row.name || "Unnamed",
    is_default: row.is_default,
    mode: row.mode,
    username: row.username || "",
    password: row.password ? "********" : "",
    server: row.server || "",
    port: row.port || 5060,
    transport: row.transport || "udp",
    callerId: row.caller_id || "",
    trunkUsername: row.trunk_username || "",
    trunkHost: row.trunk_host || "",
    trunkPort: row.trunk_port || 5060,
    sourceIp: row.source_ip || "",
    transferUri: row.transfer_uri || "",
    updated_at: row.updated_at,
  };
}

// GET /api/settings/sip — list all trunks
router.get("/sip", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM sip_settings WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC").all(req.user.userId);
  res.json(rows.map(maskTrunk));
});

// GET /api/settings/sip/:id — get single trunk
router.get("/sip/:trunkId", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(req.params.trunkId, req.user.userId);
  if (!row) return res.status(404).json({ error: "Trunk not found" });
  res.json(maskTrunk(row));
});

// POST /api/settings/sip — create new trunk
router.post("/sip", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const { name, mode, username, password, server, port, transport, callerId, trunkUsername, trunkHost, trunkPort, sourceIp, transferUri, is_default } = req.body;

  if (!name) return res.status(400).json({ error: "Trunk name is required" });
  if (sourceIp && !isValidIp(sourceIp)) return res.status(400).json({ error: `Invalid Source IP: "${sourceIp}"` });
  if (trunkHost && !isValidIp(trunkHost) && !/^[a-zA-Z0-9.-]+$/.test(trunkHost)) return res.status(400).json({ error: `Invalid Trunk Host: "${trunkHost}"` });

  const id = generateId();
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM sip_settings WHERE user_id = ?").get(userId);
  const makeDefault = is_default || existing.cnt === 0 ? 1 : 0;

  if (makeDefault) {
    db.prepare("UPDATE sip_settings SET is_default = 0 WHERE user_id = ?").run(userId);
  }

  db.prepare(`
    INSERT INTO sip_settings (id, user_id, name, is_default, mode, username, password, server, port, transport, caller_id, trunk_username, trunk_host, trunk_port, source_ip, transfer_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, name, makeDefault, mode || "trunk", username || "", password || "", server || "", parseInt(port || "5060"), transport || "udp", callerId || "", trunkUsername || "", trunkHost || "", parseInt(trunkPort || "5060"), sourceIp || "", transferUri || "");

  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ?").get(id);
  res.status(201).json(maskTrunk(row));
});

// PUT /api/settings/sip/:id — update trunk
router.put("/sip/:trunkId", (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const existing = db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(req.params.trunkId, userId);
  if (!existing) return res.status(404).json({ error: "Trunk not found" });

  const { name, mode, username, password, server, port, transport, callerId, trunkUsername, trunkHost, trunkPort, sourceIp, transferUri, is_default } = req.body;

  if (sourceIp && !isValidIp(sourceIp)) return res.status(400).json({ error: `Invalid Source IP: "${sourceIp}"` });
  if (trunkHost && !isValidIp(trunkHost) && !/^[a-zA-Z0-9.-]+$/.test(trunkHost)) return res.status(400).json({ error: `Invalid Trunk Host: "${trunkHost}"` });

  const sets = [];
  const vals = [];

  if (name !== undefined) { sets.push("name = ?"); vals.push(name); }
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

  if (is_default) {
    db.prepare("UPDATE sip_settings SET is_default = 0 WHERE user_id = ?").run(userId);
    sets.push("is_default = 1");
  }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.trunkId);
    db.prepare(`UPDATE sip_settings SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ?").get(req.params.trunkId);
  res.json(maskTrunk(row));
});

// DELETE /api/settings/sip/:id — delete trunk
router.delete("/sip/:trunkId", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(req.params.trunkId, req.user.userId);
  if (!row) return res.status(404).json({ error: "Trunk not found" });

  db.prepare("DELETE FROM sip_settings WHERE id = ?").run(req.params.trunkId);

  if (row.is_default) {
    const next = db.prepare("SELECT id FROM sip_settings WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(req.user.userId);
    if (next) db.prepare("UPDATE sip_settings SET is_default = 1 WHERE id = ?").run(next.id);
  }

  // Clear references in campaigns
  db.prepare("UPDATE campaigns SET sip_settings_id = '' WHERE sip_settings_id = ?").run(req.params.trunkId);

  res.json({ message: "Trunk deleted" });
});

// POST /api/settings/sip/:id/default — set as default
router.post("/sip/:trunkId/default", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(req.params.trunkId, req.user.userId);
  if (!row) return res.status(404).json({ error: "Trunk not found" });

  db.prepare("UPDATE sip_settings SET is_default = 0 WHERE user_id = ?").run(req.user.userId);
  db.prepare("UPDATE sip_settings SET is_default = 1 WHERE id = ?").run(req.params.trunkId);

  res.json({ message: "Default trunk updated" });
});

// POST /api/settings/sip/:id/test — test a specific trunk
router.post("/sip/:trunkId/test", async (req, res) => {
  const db = getDb();
  const settings = db.prepare("SELECT * FROM sip_settings WHERE id = ? AND user_id = ?").get(req.params.trunkId, req.user.userId);
  if (!settings) return res.json({ success: false, logs: [{ level: "error", message: "Trunk not found" }] });

  const sip = getSipConfig(settings);
  const logs = [];
  const log = (level, msg) => logs.push({ time: new Date().toISOString(), level, message: msg });

  log("info", `Testing trunk: ${settings.name}`);
  log("info", `SIP Mode: ${sip.mode}`);
  let hasErrors = false;

  if (sip.mode === "account") {
    log("info", `Server: ${sip.server}:${sip.port} (${sip.transport})`);
    log("info", `Username: ${sip.username}`);
    if (!sip.username) { log("error", "Username is required"); hasErrors = true; }
    if (!sip.password) { log("error", "Password is required"); hasErrors = true; }
    if (!sip.server) { log("error", "Server is required"); hasErrors = true; }
  } else {
    log("info", `Trunk Host: ${sip.trunkHost}:${sip.trunkPort}`);
    log("info", `Source IP: ${sip.sourceIp || "(NOT SET)"}`);
    if (!sip.trunkHost) { log("error", "Trunk Host is required"); hasErrors = true; }
    if (!sip.sourceIp) { log("error", "Source IP is required for trunk mode"); hasErrors = true; }
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
      const fromUser = sip.username || "robocop";
      const fromHost = sip.mode === "trunk" ? (sip.sourceIp || "0.0.0.0") : targetHost;

      const optionsMsg = [
        `OPTIONS sip:${targetHost}:${targetPort} SIP/2.0`,
        `Via: SIP/2.0/UDP ${fromHost}:5050;branch=${branch}`,
        `From: <sip:${fromUser}@${fromHost}:5050>;tag=${tag}`,
        `To: <sip:${targetHost}:${targetPort}>`,
        `Call-ID: test-${Date.now()}@robocop`,
        `CSeq: 1 OPTIONS`,
        `Max-Forwards: 70`,
        `Content-Length: 0`,
        ``, ``,
      ].join("\r\n");

      let responded = false;
      const timer = setTimeout(() => { if (!responded) { responded = true; client.close(); resolve({ success: false }); } }, 10000);

      client.on("message", (msg) => {
        if (responded) return;
        responded = true; clearTimeout(timer);
        const firstLine = msg.toString().split("\r\n")[0];
        const m = firstLine.match(/SIP\/2\.0\s+(\d+)\s+(.*)/);
        client.close();
        resolve({ success: true, statusCode: m ? parseInt(m[1]) : 0, statusText: m ? m[2] : firstLine });
      });

      client.on("error", () => { if (!responded) { responded = true; clearTimeout(timer); client.close(); resolve({ success: false }); } });

      const buf = Buffer.from(optionsMsg, "utf-8");
      client.send(buf, 0, buf.length, targetPort, targetHost);
    });

    if (result.success) {
      log("success", `Server responded: ${result.statusCode} ${result.statusText}`);
    } else {
      log("error", `No response from ${targetHost}:${targetPort} (timeout).`);
      return res.json({ success: false, logs });
    }

    return res.json({ success: true, logs });
  } catch (err) {
    log("error", `Test failed: ${err.message}`);
    return res.json({ success: false, logs });
  }
});

// Legacy: keep /sip/test working as test-default
router.post("/sip/test", async (req, res) => {
  const settings = getUserSipSettings(req.user.userId);
  if (!settings) return res.json({ success: false, logs: [{ level: "error", message: "No SIP settings configured." }] });
  req.params.trunkId = settings.id;
  const db = getDb();
  // Forward to the trunk-specific test
  const row = db.prepare("SELECT * FROM sip_settings WHERE id = ?").get(settings.id);
  if (!row) return res.json({ success: false, logs: [{ level: "error", message: "Default trunk not found" }] });

  const sip = getSipConfig(row);
  const logs = [];
  const log = (level, msg) => logs.push({ level, message: msg });
  log("info", `Testing default trunk: ${row.name}`);
  log("info", `Mode: ${sip.mode}, Host: ${sip.mode === "trunk" ? sip.trunkHost : sip.server}`);
  log("success", "Use the trunk-specific test button instead.");
  return res.json({ success: true, logs });
});

// ===== Deepgram API Keys (multi-key pool with 402 auto-rotation) =====

router.get("/deepgram", (req, res) => {
  const status = deepgramKeyManager.getStatus(req.user.userId);
  const keys = deepgramKeyManager.getAllKeys(req.user.userId);
  res.json({ ...status, keys });
});

router.post("/deepgram/keys", (req, res) => {
  const db = getDb();
  const { api_key, label } = req.body;
  if (!api_key) return res.status(400).json({ error: "api_key is required" });

  const existing = db.prepare(
    "SELECT id FROM deepgram_keys WHERE user_id = ? AND api_key = ?"
  ).get(req.user.userId, api_key);
  if (existing) return res.status(400).json({ error: "This key is already in your pool" });

  const id = generateId();
  const hasKeys = db.prepare("SELECT COUNT(*) as cnt FROM deepgram_keys WHERE user_id = ?").get(req.user.userId).cnt;

  db.prepare(
    "INSERT INTO deepgram_keys (id, user_id, api_key, label, status, is_current) VALUES (?, ?, ?, ?, 'active', ?)"
  ).run(id, req.user.userId, api_key, label || "", hasKeys === 0 ? 1 : 0);

  const keys = deepgramKeyManager.getAllKeys(req.user.userId);
  const status = deepgramKeyManager.getStatus(req.user.userId);
  res.status(201).json({ message: "Key added", ...status, keys });
});

router.put("/deepgram/keys/:keyId", (req, res) => {
  const db = getDb();
  const { label } = req.body;

  const existing = db.prepare(
    "SELECT id FROM deepgram_keys WHERE id = ? AND user_id = ?"
  ).get(req.params.keyId, req.user.userId);
  if (!existing) return res.status(404).json({ error: "Key not found" });

  if (label !== undefined) {
    db.prepare("UPDATE deepgram_keys SET label = ? WHERE id = ?").run(label, req.params.keyId);
  }

  res.json({ message: "Key updated" });
});

router.delete("/deepgram/keys/:keyId", (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM deepgram_keys WHERE id = ? AND user_id = ?"
  ).run(req.params.keyId, req.user.userId);

  if (result.changes === 0) return res.status(404).json({ error: "Key not found" });

  const keys = deepgramKeyManager.getAllKeys(req.user.userId);
  const status = deepgramKeyManager.getStatus(req.user.userId);
  res.json({ message: "Key removed", ...status, keys });
});

router.post("/deepgram/keys/:keyId/activate", (req, res) => {
  deepgramKeyManager.reactivateKey(req.params.keyId, req.user.userId);
  const keys = deepgramKeyManager.getAllKeys(req.user.userId);
  const status = deepgramKeyManager.getStatus(req.user.userId);
  res.json({ message: "Key reactivated", ...status, keys });
});

router.post("/deepgram/keys/:keyId/set-current", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE deepgram_keys SET is_current = 0 WHERE user_id = ?").run(req.user.userId);
  db.prepare("UPDATE deepgram_keys SET is_current = 1 WHERE id = ? AND user_id = ?").run(req.params.keyId, req.user.userId);

  const keys = deepgramKeyManager.getAllKeys(req.user.userId);
  const status = deepgramKeyManager.getStatus(req.user.userId);
  res.json({ message: "Current key updated", ...status, keys });
});

router.post("/deepgram/keys/:keyId/test", async (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT api_key FROM deepgram_keys WHERE id = ? AND user_id = ?").get(req.params.keyId, req.user.userId);
  if (!row) return res.status(404).json({ error: "Key not found" });

  res.json(await testDeepgramKey(row.api_key));
});

// ===== Google Sheets Credentials =====

import { testSheetConnection } from "../services/google-sheets.js";

/**
 * GET /api/settings/google-sheets - Check if credentials are configured
 */
router.get("/google-sheets", (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT google_sheets_credentials FROM users WHERE id = ?").get(req.user.userId);
  const hasCreds = !!(row?.google_sheets_credentials);
  res.json({ configured: hasCreds });
});

/**
 * PUT /api/settings/google-sheets - Save service account credentials JSON
 */
router.put("/google-sheets", (req, res) => {
  const db = getDb();
  const { credentials } = req.body;

  if (!credentials) {
    return res.status(400).json({ error: "credentials JSON is required" });
  }

  try {
    const parsed = typeof credentials === "string" ? JSON.parse(credentials) : credentials;
    if (!parsed.client_email || !parsed.private_key) {
      return res.status(400).json({ error: "Invalid service account JSON: missing client_email or private_key" });
    }

    const jsonStr = typeof credentials === "string" ? credentials : JSON.stringify(credentials);
    db.prepare("UPDATE users SET google_sheets_credentials = ? WHERE id = ?").run(jsonStr, req.user.userId);

    res.json({ message: "Google Sheets credentials saved", client_email: parsed.client_email });
  } catch (e) {
    return res.status(400).json({ error: `Invalid JSON: ${e.message}` });
  }
});

/**
 * DELETE /api/settings/google-sheets - Remove credentials
 */
router.delete("/google-sheets", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE users SET google_sheets_credentials = '' WHERE id = ?").run(req.user.userId);
  res.json({ message: "Google Sheets credentials removed" });
});

/**
 * POST /api/settings/google-sheets/test - Test connection to a specific sheet
 */
router.post("/google-sheets/test", async (req, res) => {
  const db = getDb();
  const { spreadsheet_id } = req.body;

  if (!spreadsheet_id) {
    return res.status(400).json({ error: "spreadsheet_id is required" });
  }

  const row = db.prepare("SELECT google_sheets_credentials FROM users WHERE id = ?").get(req.user.userId);
  if (!row?.google_sheets_credentials) {
    return res.status(400).json({ error: "No Google Sheets credentials configured. Upload service account JSON first." });
  }

  try {
    const result = await testSheetConnection(row.google_sheets_credentials, spreadsheet_id);
    res.json({ success: true, title: result.title, sheets: result.sheets });
  } catch (e) {
    res.status(400).json({ error: `Connection failed: ${e.message}` });
  }
});

// Export helpers for other modules
export { getUserSipSettings };

export function getUserDeepgramKey(userId) {
  const keyInfo = deepgramKeyManager.getKey(userId);
  return keyInfo ? keyInfo.key : "";
}

export function getUserDeepgramKeyInfo(userId) {
  return deepgramKeyManager.getKey(userId);
}

export default router;
