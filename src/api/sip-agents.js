/**
 * SIP Agents API
 * 
 * CRUD operations for SIP agent accounts (human agents with their own SIP credentials).
 */

import express from "express";
import { getDb, generateId } from "../db/schema.js";
import { sipAgentManager } from "../sip-agent/manager.js";

const router = express.Router();

// Get all SIP agents for current user
router.get("/", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  const agents = db.prepare(`
    SELECT id, name, sip_server, sip_port, sip_transport, sip_username, sip_domain,
           caller_id, status, can_receive_transfers, priority, max_concurrent_calls,
           current_calls, last_seen_at, created_at
    FROM sip_agents 
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
  res.json(agents);
});

// Get single SIP agent
router.get("/:id", (req, res) => {
  const db = getDb();
  const agent = db.prepare(`
    SELECT id, name, sip_server, sip_port, sip_transport, sip_username, sip_domain,
           caller_id, status, can_receive_transfers, priority, max_concurrent_calls,
           current_calls, last_seen_at, created_at
    FROM sip_agents 
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.userId);
  
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }
  res.json(agent);
});

// Create new SIP agent
router.post("/", (req, res) => {
  const {
    name, sip_server, sip_port, sip_transport, sip_username, sip_password,
    sip_domain, caller_id, can_receive_transfers, priority, max_concurrent_calls
  } = req.body;

  if (!name || !sip_server || !sip_username || !sip_password) {
    return res.status(400).json({ error: "Name, SIP server, username, and password are required" });
  }

  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO sip_agents (id, user_id, name, sip_server, sip_port, sip_transport,
      sip_username, sip_password, sip_domain, caller_id, can_receive_transfers,
      priority, max_concurrent_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.user.userId, name,
    sip_server, sip_port || 5060, sip_transport || "udp",
    sip_username, sip_password, sip_domain || "",
    caller_id || "", can_receive_transfers ?? 1,
    priority || 1, max_concurrent_calls || 1
  );

  const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(id);
  // Don't return password
  delete agent.sip_password;
  
  res.status(201).json(agent);
});

// Update SIP agent
router.put("/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const allowed = [
    "name", "sip_server", "sip_port", "sip_transport", "sip_username", "sip_password",
    "sip_domain", "caller_id", "can_receive_transfers", "priority", "max_concurrent_calls"
  ];

  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id, req.user.userId);
    db.prepare(`UPDATE sip_agents SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  }

  const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(req.params.id);
  delete agent.sip_password;
  
  res.json(agent);
});

// Delete SIP agent
router.delete("/:id", async (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent not found" });
  }

  // Unregister if online
  if (existing.status === "online") {
    try {
      await sipAgentManager.unregisterAgent(req.params.id);
    } catch (err) {
      // Ignore errors during unregister
    }
  }

  db.prepare("DELETE FROM sip_agents WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Register agent (go online)
router.post("/:id/register", async (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent not found" });
  }

  try {
    await sipAgentManager.registerAgent(req.params.id);
    res.json({ success: true, status: "online" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unregister agent (go offline)
router.post("/:id/unregister", async (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent not found" });
  }

  try {
    await sipAgentManager.unregisterAgent(req.params.id);
    res.json({ success: true, status: "offline" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Make outbound call
router.post("/:id/call", async (req, res) => {
  const { destination } = req.body;
  
  if (!destination) {
    return res.status(400).json({ error: "Destination is required" });
  }

  const db = getDb();
  const existing = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent not found" });
  }

  try {
    const result = await sipAgentManager.makeCall(req.params.id, destination);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Answer incoming call
router.post("/calls/:callId/answer", async (req, res) => {
  try {
    const result = await sipAgentManager.answerCall(req.params.callId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject incoming call
router.post("/calls/:callId/reject", async (req, res) => {
  try {
    const result = await sipAgentManager.rejectCall(req.params.callId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hangup active call
router.post("/calls/:callId/hangup", async (req, res) => {
  try {
    const result = await sipAgentManager.hangupCall(req.params.callId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get available agents for transfer
router.get("/available/transfer", (req, res) => {
  const agents = sipAgentManager.getAvailableAgents(req.user.userId);
  res.json(agents);
});

// Get agent call history
router.get("/:id/calls", (req, res) => {
  const db = getDb();
  const calls = db.prepare(`
    SELECT * FROM agent_call_records 
    WHERE sip_agent_id = ?
    ORDER BY started_at DESC
    LIMIT 100
  `).all(req.params.id);
  res.json(calls);
});

export default router;
