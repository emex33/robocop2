/**
 * Agent Users API - Manage softphone agent logins
 * 
 * Agents have separate credentials from admin users.
 * Each agent can be linked to a SIP account for softphone use.
 */

import { Router } from "express";
import jwt from "jsonwebtoken";
import { getDb, generateId, hashPassword, verifyPassword } from "../db/schema.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "robocop-secret-change-me";

// Get all agent users for this admin
router.get("/", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  
  const agents = db.prepare(`
    SELECT au.id, au.username, au.name, au.email, au.role, au.is_active,
           au.sip_agent_id, au.last_login_at, au.created_at,
           sa.name as sip_agent_name, sa.status as sip_agent_status
    FROM agent_users au
    LEFT JOIN sip_agents sa ON au.sip_agent_id = sa.id
    WHERE au.admin_user_id = ?
    ORDER BY au.created_at DESC
  `).all(userId);
  
  res.json(agents);
});

// Get single agent user
router.get("/:id", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  
  const agent = db.prepare(`
    SELECT au.id, au.username, au.name, au.email, au.role, au.is_active,
           au.sip_agent_id, au.last_login_at, au.created_at,
           sa.name as sip_agent_name, sa.status as sip_agent_status
    FROM agent_users au
    LEFT JOIN sip_agents sa ON au.sip_agent_id = sa.id
    WHERE au.id = ? AND au.admin_user_id = ?
  `).get(req.params.id, userId);
  
  if (!agent) {
    return res.status(404).json({ error: "Agent user not found" });
  }
  res.json(agent);
});

// Create new agent user
router.post("/", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  const { username, password, name, email, role, sip_agent_id } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  
  // Check if username already exists for this admin
  const existing = db.prepare(
    "SELECT id FROM agent_users WHERE admin_user_id = ? AND username = ?"
  ).get(userId, username);
  
  if (existing) {
    return res.status(400).json({ error: "Username already exists" });
  }
  
  // Validate sip_agent_id if provided
  if (sip_agent_id) {
    const sipAgent = db.prepare(
      "SELECT id FROM sip_agents WHERE id = ? AND user_id = ?"
    ).get(sip_agent_id, userId);
    
    if (!sipAgent) {
      return res.status(400).json({ error: "Invalid SIP agent ID" });
    }
  }
  
  const id = generateId();
  const passwordHash = hashPassword(password);
  
  db.prepare(`
    INSERT INTO agent_users (id, admin_user_id, username, password_hash, name, email, role, sip_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, username, passwordHash, name || username, email || "", role || "agent", sip_agent_id || null);
  
  const agent = db.prepare(`
    SELECT au.id, au.username, au.name, au.email, au.role, au.is_active,
           au.sip_agent_id, au.created_at,
           sa.name as sip_agent_name
    FROM agent_users au
    LEFT JOIN sip_agents sa ON au.sip_agent_id = sa.id
    WHERE au.id = ?
  `).get(id);
  
  res.status(201).json(agent);
});

// Update agent user
router.put("/:id", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  const { username, password, name, email, role, sip_agent_id, is_active } = req.body;
  
  const existing = db.prepare(
    "SELECT id FROM agent_users WHERE id = ? AND admin_user_id = ?"
  ).get(req.params.id, userId);
  
  if (!existing) {
    return res.status(404).json({ error: "Agent user not found" });
  }
  
  // Check for username conflict
  if (username) {
    const conflict = db.prepare(
      "SELECT id FROM agent_users WHERE admin_user_id = ? AND username = ? AND id != ?"
    ).get(userId, username, req.params.id);
    
    if (conflict) {
      return res.status(400).json({ error: "Username already exists" });
    }
  }
  
  // Validate sip_agent_id if provided
  if (sip_agent_id) {
    const sipAgent = db.prepare(
      "SELECT id FROM sip_agents WHERE id = ? AND user_id = ?"
    ).get(sip_agent_id, userId);
    
    if (!sipAgent) {
      return res.status(400).json({ error: "Invalid SIP agent ID" });
    }
  }
  
  const updates = [];
  const values = [];
  
  if (username !== undefined) { updates.push("username = ?"); values.push(username); }
  if (name !== undefined) { updates.push("name = ?"); values.push(name); }
  if (email !== undefined) { updates.push("email = ?"); values.push(email); }
  if (role !== undefined) { updates.push("role = ?"); values.push(role); }
  if (sip_agent_id !== undefined) { updates.push("sip_agent_id = ?"); values.push(sip_agent_id || null); }
  if (is_active !== undefined) { updates.push("is_active = ?"); values.push(is_active ? 1 : 0); }
  if (password) { updates.push("password_hash = ?"); values.push(hashPassword(password)); }
  
  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    
    db.prepare(`UPDATE agent_users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }
  
  const agent = db.prepare(`
    SELECT au.id, au.username, au.name, au.email, au.role, au.is_active,
           au.sip_agent_id, au.created_at,
           sa.name as sip_agent_name
    FROM agent_users au
    LEFT JOIN sip_agents sa ON au.sip_agent_id = sa.id
    WHERE au.id = ?
  `).get(req.params.id);
  
  res.json(agent);
});

// Delete agent user
router.delete("/:id", (req, res) => {
  const db = getDb();
  const userId = req.user?.userId;
  
  const result = db.prepare(
    "DELETE FROM agent_users WHERE id = ? AND admin_user_id = ?"
  ).run(req.params.id, userId);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: "Agent user not found" });
  }
  
  res.json({ success: true });
});

// Agent login endpoint (public, no auth required)
router.post("/login", (req, res) => {
  const db = getDb();
  const { username, password, admin_code } = req.body;
  
  if (!username || !password || !admin_code) {
    return res.status(400).json({ error: "Username, password, and admin code are required" });
  }
  
  // admin_code is the admin user's ID or a special code
  // Find the admin user first
  const adminUser = db.prepare("SELECT id FROM users WHERE id = ?").get(admin_code);
  if (!adminUser) {
    return res.status(401).json({ error: "Invalid admin code" });
  }
  
  // Find the agent user
  const agent = db.prepare(`
    SELECT au.*, sa.id as sip_agent_id, sa.name as sip_agent_name,
           sa.sip_server, sa.sip_port, sa.sip_username
    FROM agent_users au
    LEFT JOIN sip_agents sa ON au.sip_agent_id = sa.id
    WHERE au.admin_user_id = ? AND au.username = ? AND au.is_active = 1
  `).get(admin_code, username);
  
  if (!agent) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  
  if (!verifyPassword(password, agent.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  
  // Update last login
  db.prepare("UPDATE agent_users SET last_login_at = datetime('now') WHERE id = ?").run(agent.id);
  
  // Generate JWT token for agent
  const token = jwt.sign(
    { 
      agentUserId: agent.id, 
      adminUserId: admin_code,
      sipAgentId: agent.sip_agent_id,
      username: agent.username,
      name: agent.name,
      role: "agent"
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
  
  res.json({
    token,
    agent: {
      id: agent.id,
      username: agent.username,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      sip_agent_id: agent.sip_agent_id,
      sip_agent_name: agent.sip_agent_name,
    }
  });
});

export default router;
