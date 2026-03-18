import express from "express";
import cors from "cors";
import multer from "multer";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import logger from "../utils/logger.js";
import { configStore } from "../config/store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * Dashboard Server
 * 
 * Provides:
 * - REST API: config CRUD, lead upload/mapping, campaign control, manual call
 * - WebSocket for real-time call status, logs, transcripts
 * - Static file serving for the dashboard UI
 */
export class DashboardServer {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.wsClients = new Set();

    this.callState = {
      status: "idle",
      results: [],
      activeCalls: [],
      logs: [],
    };

    // Callbacks (set by index.js)
    this.onStartCampaign = null;
    this.onStopCampaign = null;
    this.onCallSingle = null;

    // Temp storage for raw CSV rows before mapping
    this._rawCsvRows = [];
    this._csvColumns = [];

    this._setupMiddleware();
    this._setupRoutes();
    this._setupWebSocket();
  }

  _setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json({ limit: "10mb" }));
    this.app.use(express.static(path.join(__dirname, "public")));
  }

  _setupRoutes() {
    // ===== STATUS =====
    this.app.get("/api/status", (req, res) => {
      res.json({
        status: this.callState.status,
        totalLeads: configStore.getLeads().length,
        completedCalls: this.callState.results.length,
        activeCalls: this.callState.activeCalls.length,
        results: this.callState.results.slice(-50),
      });
    });

    // ===== AGENT CONFIG =====
    this.app.get("/api/config", (req, res) => {
      res.json(configStore.getConfig());
    });

    this.app.put("/api/config", (req, res) => {
      const updated = configStore.updateConfig(req.body);
      this.broadcast("config_updated", updated);
      res.json(updated);
    });

    this.app.post("/api/config/reset", (req, res) => {
      const cfg = configStore.resetConfig();
      this.broadcast("config_updated", cfg);
      res.json(cfg);
    });

    // ===== LEADS =====
    this.app.get("/api/leads", (req, res) => {
      res.json(configStore.getLeads());
    });

    // Upload CSV — returns columns for mapping
    this.app.post("/api/leads/upload", upload.single("file"), (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }
        const content = req.file.buffer.toString("utf-8");
        const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
        if (rows.length === 0) {
          return res.status(400).json({ error: "CSV has no data rows" });
        }
        this._rawCsvRows = rows;
        this._csvColumns = Object.keys(rows[0]);
        const preview = rows.slice(0, 5);
        res.json({
          columns: this._csvColumns,
          totalRows: rows.length,
          preview,
        });
      } catch (e) {
        res.status(400).json({ error: `CSV parse error: ${e.message}` });
      }
    });

    // Get current field mapping
    this.app.get("/api/leads/mapping", (req, res) => {
      res.json({
        mapping: configStore.getFieldMapping(),
        csvColumns: this._csvColumns,
        standardFields: ["phone", "first_name", "last_name", "email", "company", "country", "notes"],
      });
    });

    // Apply field mapping to uploaded CSV → save as leads
    this.app.post("/api/leads/mapping", (req, res) => {
      const { mapping } = req.body;
      if (!mapping || !mapping.phone) {
        return res.status(400).json({ error: "At minimum, 'phone' must be mapped" });
      }
      configStore.setFieldMapping(mapping);
      const leads = configStore.applyMapping(this._rawCsvRows, mapping);
      // Clean phone numbers
      for (const lead of leads) {
        if (lead.phone) lead.phone = lead.phone.replace(/\s+/g, "");
      }
      configStore.setLeads(leads);
      this.broadcast("leads_updated", { count: leads.length });
      res.json({ message: `${leads.length} leads imported`, count: leads.length });
    });

    // Add a single lead manually
    this.app.post("/api/leads/add", (req, res) => {
      const lead = req.body;
      if (!lead.phone) {
        return res.status(400).json({ error: "Phone is required" });
      }
      lead.phone = lead.phone.replace(/\s+/g, "");
      configStore.addLead(lead);
      this.broadcast("leads_updated", { count: configStore.getLeads().length });
      res.json({ message: "Lead added", count: configStore.getLeads().length });
    });

    // Clear all leads
    this.app.delete("/api/leads", (req, res) => {
      configStore.clearLeads();
      this._rawCsvRows = [];
      this._csvColumns = [];
      this.broadcast("leads_updated", { count: 0 });
      res.json({ message: "All leads cleared" });
    });

    // ===== CAMPAIGN =====
    this.app.post("/api/campaign/start", (req, res) => {
      if (this.callState.status === "running") {
        return res.status(400).json({ error: "Campaign already running" });
      }
      const leads = configStore.getLeads();
      if (leads.length === 0) {
        return res.status(400).json({ error: "No leads loaded" });
      }
      if (this.onStartCampaign) {
        this.onStartCampaign();
        res.json({ message: "Campaign started" });
      } else {
        res.status(500).json({ error: "Campaign handler not configured" });
      }
    });

    this.app.post("/api/campaign/stop", (req, res) => {
      if (this.onStopCampaign) {
        this.onStopCampaign();
        res.json({ message: "Campaign stopped" });
      } else {
        res.status(500).json({ error: "Stop handler not configured" });
      }
    });

    // ===== SINGLE CALL =====
    this.app.post("/api/call", (req, res) => {
      const { phone, first_name } = req.body;
      if (!phone) {
        return res.status(400).json({ error: "Phone number required" });
      }
      if (this.onCallSingle) {
        this.onCallSingle({ phone, first_name: first_name || "", name: first_name || "Manual Call" });
        res.json({ message: `Calling ${phone}` });
      } else {
        res.status(500).json({ error: "Call handler not configured" });
      }
    });

    // ===== RESULTS / LOGS =====
    this.app.get("/api/results", (req, res) => {
      res.json(this.callState.results);
    });

    this.app.get("/api/logs", (req, res) => {
      res.json(this.callState.logs.slice(-100));
    });

    // Fallback to dashboard
    this.app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "index.html"));
    });
  }

  _setupWebSocket() {
    this.wss.on("connection", (ws) => {
      this.wsClients.add(ws);
      ws.send(JSON.stringify({ type: "state", data: {
        status: this.callState.status,
        totalLeads: configStore.getLeads().length,
        completedCalls: this.callState.results.length,
        activeCalls: this.callState.activeCalls,
        recentResults: this.callState.results.slice(-20),
        recentLogs: this.callState.logs.slice(-50),
      }}));

      ws.on("close", () => {
        this.wsClients.delete(ws);
      });
    });
  }

  broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  pushLog(level, message, callId = null) {
    const entry = { time: new Date().toISOString(), level, message, callId };
    this.callState.logs.push(entry);
    if (this.callState.logs.length > 500) this.callState.logs = this.callState.logs.slice(-300);
    this.broadcast("log", entry);
  }

  updateCallStatus(callId, status, data = {}) {
    this.broadcast("call_update", { callId, status, ...data });
  }

  addResult(result) {
    this.callState.results.push(result);
    this.broadcast("result", result);
  }

  async start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, "0.0.0.0", () => {
        logger.info(`Dashboard running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }
}
