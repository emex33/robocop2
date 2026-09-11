/**
 * Dashboard Server v2 - Enterprise Edition
 * 
 * Serves React frontend + REST API + WebSocket for real-time updates
 * Multi-user, DB-backed, campaign/agent/list management
 */

import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import logger from "../utils/logger.js";
import { activityMiddleware } from "../utils/loop-monitor.js";

import authRoutes from "../api/auth.js";
import agentRoutes from "../api/agents.js";
import campaignRoutes, { warmCampaignCaches } from "../api/campaigns.js";
import listRoutes from "../api/lists.js";
import analyticsRoutes, { warmDashboard } from "../api/analytics.js";
import reportRoutes from "../api/reports.js";
import settingsRoutes from "../api/settings.js";
import appointmentRoutes from "../api/appointments.js";
import sipAgentRoutes from "../api/sip-agents.js";
import agentUsersRoutes from "../api/agent-users.js";
import callsRoutes from "../api/calls.js";
import adminRoutes from "../api/admin.js";
import billingRoutes from "../api/billing.js";
import callbackRoutes from "../api/callbacks.js";
import commandRoutes, { scheduleRollupWarmup } from "../api/command.js";
import { authMiddleware, superAdminMiddleware } from "../db/auth.js";
import { getDb } from "../db/schema.js";
import { getUserBalance } from "../db/helpers.js";
import { sipAgentManager } from "../sip-agent/manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "robocop-secret-change-me";

export class DashboardServer {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.wsClients = new Map(); // userId -> Set<ws>

    // Campaign runtime state (managed by index.js)
    this.campaignRunners = new Map(); // campaignId -> { status, ... }
    // Route modules read live runner state through app.locals.
    this.app.locals.campaignRunners = this.campaignRunners;

    // Callbacks (set by index.js)
    this.onStartCampaign = null;
    this.onStopCampaign = null;

    this._setupMiddleware();
    this._setupRoutes();
    this._setupWebSocket();
  }

  _setupMiddleware() {
    this.app.use(cors());
    this.app.use(activityMiddleware);
    this.app.use(express.json({ limit: "10mb" }));
    // Serve React build
    this.app.use(express.static(path.join(__dirname, "public", "dist")));
  }

  _setupRoutes() {
    // Public auth routes
    this.app.use("/api/auth", authRoutes);

    // Protected routes
    this.app.use("/api/agents", authMiddleware, agentRoutes);
    this.app.use("/api/campaigns", authMiddleware, campaignRoutes);
    this.app.use("/api/lists", authMiddleware, listRoutes);
    this.app.use("/api/analytics", authMiddleware, analyticsRoutes);
    this.app.use("/api/reports", authMiddleware, reportRoutes);
    this.app.use("/api/settings", authMiddleware, settingsRoutes);
    this.app.use("/api/appointments", authMiddleware, appointmentRoutes);
    this.app.use("/api/sip-agents", authMiddleware, sipAgentRoutes);
    this.app.use("/api/agent-users", authMiddleware, agentUsersRoutes);
    this.app.use("/api/calls", authMiddleware, callsRoutes);
    this.app.use("/api/billing", authMiddleware, billingRoutes);
    this.app.use("/api/callbacks", authMiddleware, callbackRoutes);
    this.app.use("/api/command", authMiddleware, commandRoutes);
    this.app.use("/api/admin", authMiddleware, superAdminMiddleware, adminRoutes);
    
    // Public agent login endpoint (no auth required)
    this.app.post("/api/agent-login", (req, res, next) => {
      // Forward to agent-users login handler
      req.url = "/login";
      agentUsersRoutes(req, res, next);
    });

    // ===== Campaign Control =====
    this.app.post("/api/campaigns/:id/start", authMiddleware, (req, res) => {
      const db = getDb();
      const campaign = db.prepare(
        "SELECT * FROM campaigns WHERE id = ? AND user_id = ?"
      ).get(req.params.id, req.user.userId);

      if (!campaign) return res.status(404).json({ error: "Campaign not found" });

      if (this.campaignRunners.has(req.params.id)) {
        return res.status(400).json({ error: "Campaign already running" });
      }

      // Check credit balance
      const balance = getUserBalance(req.user.userId);
      if (balance <= 0) {
        return res.status(403).json({ error: `Insufficient credits ($${balance.toFixed(2)}). Add credits to start calling.` });
      }

      // Update status in DB
      db.prepare("UPDATE campaigns SET status = 'running', updated_at = datetime('now') WHERE id = ?")
        .run(req.params.id);

      if (this.onStartCampaign) {
        this.onStartCampaign(req.params.id, req.user.userId);
        res.json({ message: "Campaign started" });
      } else {
        res.status(500).json({ error: "Campaign handler not configured" });
      }
    });

    this.app.post("/api/campaigns/:id/stop", authMiddleware, (req, res) => {
      const force = req.query.force === "true" || req.body?.force === true;

      const db = getDb();
      db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
        .run(req.params.id);

      if (this.onStopCampaign) {
        this.onStopCampaign(req.params.id, { force });
        res.json({ message: force ? "Campaign force-stopped — all calls killed" : "Campaign stopped — active calls finishing" });
      } else {
        res.status(500).json({ error: "Stop handler not configured" });
      }
    });

    // Campaign runtime status
    this.app.get("/api/campaigns/:id/status", authMiddleware, (req, res) => {
      const runner = this.campaignRunners.get(req.params.id);
      if (!runner) return res.json({ running: false });
      res.json({
        running: !!runner.running,
        activeCalls: runner.activeCalls || [],
        completedCalls: runner.completedCalls || 0,
        totalLeads: runner.totalLeads || 0,
        remainingLeads: runner.getRemainingLeads
          ? runner.getRemainingLeads()
          : (runner.queue?.leads?.length || 0),
      });
    });

    // WebSocket-pushed logs for a campaign
    this.app.get("/api/campaigns/:id/logs", authMiddleware, (req, res) => {
      const runner = this.campaignRunners.get(req.params.id);
      res.json(runner?.logs?.slice(-100) || []);
    });

    // SPA fallback - serve React app for all non-API routes
    this.app.get("*", (req, res) => {
      if (req.path.startsWith("/api/")) {
        return res.status(404).json({ error: "Not found" });
      }
      const indexPath = path.join(__dirname, "public", "dist", "index.html");
      res.sendFile(indexPath, (err) => {
        if (err) res.status(500).send("Dashboard not built. Run: cd dashboard-ui && npm run build");
      });
    });
  }

  _setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      // Try to authenticate from query param
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      const agentId = url.searchParams.get("agentId"); // For softphone audio connection

      let userId = null;
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          userId = decoded.userId || decoded.adminUserId;
        } catch (e) {
          // Invalid token, still allow connection but no user context
        }
      }

      ws._userId = userId;

      if (userId) {
        if (!this.wsClients.has(userId)) {
          this.wsClients.set(userId, new Set());
        }
        this.wsClients.get(userId).add(ws);
      }

      // If this is a softphone audio connection, register it with SIP agent manager
      if (agentId && userId) {
        sipAgentManager.connectAgentSocket(agentId, ws);
        logger.info(`Softphone WebSocket connected for agent ${agentId}`);
      }

      ws.on("close", () => {
        if (userId && this.wsClients.has(userId)) {
          this.wsClients.get(userId).delete(ws);
          if (this.wsClients.get(userId).size === 0) {
            this.wsClients.delete(userId);
          }
        }
      });
    });
  }

  /**
   * Broadcast to all WebSocket clients of a specific user.
   */
  broadcastToUser(userId, type, data) {
    const clients = this.wsClients.get(userId);
    if (!clients) return;
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  /**
   * Broadcast to all connected WebSocket clients.
   */
  broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const [, clients] of this.wsClients) {
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    }
  }

  /**
   * Push a log entry for a campaign to its user.
   */
  pushCampaignLog(campaignId, userId, level, message, callId = null) {
    const entry = { time: new Date().toISOString(), level, message, callId, campaignId };

    // Store in runner
    const runner = this.campaignRunners.get(campaignId);
    if (runner) {
      if (!runner.logs) runner.logs = [];
      runner.logs.push(entry);
      if (runner.logs.length > 500) runner.logs = runner.logs.slice(-300);
    }

    // Push to user via WS
    this.broadcastToUser(userId, "campaign_log", entry);
  }

  async start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, "0.0.0.0", () => {
        logger.info(`Dashboard running at http://localhost:${this.port}`);
        // Pre-aggregate past days for the Command Center so 7d/30d views stay fast.
        scheduleRollupWarmup();
        // Keep the Dashboard and campaign counters warm: first at boot, then
        // every 5 minutes, so no click ever pays for a cold COUNT.
        const warm = () => {
          try {
            for (const u of getDb().prepare("SELECT id FROM users").all()) warmDashboard(u.id);
            warmCampaignCaches();
          } catch (e) {
            logger.warn(`[warm] cache warm-up failed: ${e.message}`);
          }
        };
        setTimeout(warm, 3_000).unref();
        setInterval(warm, 5 * 60_000).unref();
        resolve();
      });
    });
  }
}
