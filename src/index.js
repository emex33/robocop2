import "dotenv/config";
import logger from "./utils/logger.js";
import { SipDialer } from "./sip/dialer.js";
import { CallManager } from "./call/manager.js";
import { CallQueue } from "./leads/loader.js";
import { DashboardServer } from "./dashboard/server-new.js";
import { getDb } from "./db/schema.js";
import {
  buildAgentSettingsFromDb,
  getCampaignExtensions,
  getCampaignCallableLeads,
  recordCall,
  updateLeadStatus,
  createAppointment,
  getUserBalance,
  deductCredits,
  getCostRates,
} from "./db/helpers.js";
import { getUserSipSettings, getUserDeepgramKey, getUserDeepgramKeyInfo } from "./api/settings.js";
import { deepgramKeyManager } from "./deepgram/key-manager.js";
import { getSipConfig } from "../config/sip.js";
import { sipAgentManager } from "./sip-agent/manager.js";

/**
 * ROBOCOP - AI Robot Caller (Enterprise Edition)
 * 
 * Entry point. Starts dashboard, connects to drachtio, registers SIP,
 * and runs DB-backed campaigns with per-user agents and lists.
 */

let dashboard;
let sipDialer;
let callManager;
const campaignRunners = new Map(); // campaignId -> { queue, running, userId }

async function main() {
  logger.info("=== ROBOCOP AI Robot Caller v2 ===");
  logger.info("Starting up...");

  // Initialize database
  getDb();
  logger.info("Database initialized");

  // Deepgram key is now per-user (stored in DB). Env var is optional fallback.
  if (!process.env.DEEPGRAM_API_KEY) {
    logger.warn("DEEPGRAM_API_KEY not set in .env — users must configure their key in Settings.");
  }

  // Step 1: Start Dashboard
  dashboard = new DashboardServer(parseInt(process.env.DASHBOARD_PORT || "3000"));
  await dashboard.start();
  logger.info("Dashboard server started");

  // Step 2: Connect to drachtio-server
  sipDialer = new SipDialer();
  try {
    await sipDialer.connect();
    logger.info("Connected to drachtio-server");
    
    // Initialize SIP Agent Manager with the same srf instance
    await sipAgentManager.init(sipDialer.srf);
    logger.info("SIP Agent Manager initialized");
  } catch (err) {
    logger.error(`Failed to connect to drachtio: ${err.message}`);
    logger.error("Make sure drachtio-server is running (docker compose up)");
  }

  // Step 3: Set up call manager (SIP registration happens per-campaign based on user's DB config)
  callManager = new CallManager(sipDialer);

  // Wire up dashboard campaign control callbacks
  dashboard.onStartCampaign = startCampaign;
  dashboard.onStopCampaign = (campaignId, { force = false } = {}) => {
    if (force) {
      forceStopCampaign(campaignId);
    } else {
      softStopCampaign(campaignId);
    }
  };

  logger.info("ROBOCOP ready. Use the dashboard to start calling.");
}

/**
 * Start a campaign - loads leads from DB, calls them sequentially.
 */
async function startCampaign(campaignId, userId) {
  if (campaignRunners.has(campaignId)) return;

  const db = getDb();
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign) {
    logger.error(`Campaign ${campaignId} not found`);
    return;
  }

  const agent = campaign.agent_id
    ? db.prepare("SELECT * FROM agents WHERE id = ?").get(campaign.agent_id)
    : null;

  if (!agent) {
    logger.warn(`Campaign ${campaignId} has no agent assigned`);
    dashboard.pushCampaignLog(campaignId, userId, "warn", "No agent assigned to this campaign");
    return;
  }

  // Check credit balance before starting
  const balance = getUserBalance(userId);
  if (balance <= 0) {
    dashboard.pushCampaignLog(campaignId, userId, "error", `Insufficient credits ($${balance.toFixed(2)}). Add credits to start calling.`);
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }

  const leads = getCampaignCallableLeads(campaignId);
  if (leads.length === 0) {
    dashboard.pushCampaignLog(campaignId, userId, "warn", "No callable leads in this campaign");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }

  const extensions = getCampaignExtensions(campaignId);
  const maxConcurrent = campaign.max_concurrent_calls || 1;
  const delayMs = parseInt(process.env.CALL_DELAY_MS || "5000");

  // Load SIP settings: campaign-specific trunk, or user's default
  const trunkId = campaign.sip_settings_id || null;
  const dbSipSettings = getUserSipSettings(userId, trunkId);
  if (!dbSipSettings) {
    logger.error(`No SIP settings found for user ${userId}. Configure SIP in dashboard Settings.`);
    dashboard.pushCampaignLog(campaignId, userId, "error", "No SIP settings configured. Go to Settings to configure SIP.");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }
  const sipConfig = getSipConfig(dbSipSettings);
  logger.info(`Campaign SIP trunk: "${dbSipSettings.name}" (${dbSipSettings.id}) mode=${sipConfig.mode}, trunkHost=${sipConfig.trunkHost}, server=${sipConfig.server}`);

  // Load per-user Deepgram API key (pool → legacy single → env var)
  let deepgramKeyInfo = getUserDeepgramKeyInfo(userId);
  if (!deepgramKeyInfo) {
    logger.error(`No Deepgram API key for user ${userId}. Configure in Settings.`);
    dashboard.pushCampaignLog(campaignId, userId, "error", "No Deepgram API key configured. Go to Settings to set your API key.");
    db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(campaignId);
    return;
  }
  let deepgramApiKey = deepgramKeyInfo.key;
  logger.info(`Using Deepgram key: "${deepgramKeyInfo.label}" (source: ${deepgramKeyInfo.source})`);

  // Register with SIP provider if account mode (trunk mode skips registration)
  if (sipConfig.mode === "account") {
    try {
      await sipDialer.register(sipConfig);
      logger.info(`SIP registered for campaign (account mode, ${sipConfig.server})`);
    } catch (err) {
      logger.error(`SIP registration failed: ${err.message}`);
      dashboard.pushCampaignLog(campaignId, userId, "error", `SIP registration failed: ${err.message}`);
    }
  }

  const runner = { running: true, userId, logs: [], activeCalls: [], activeAbortHandles: new Map(), completedCalls: 0, totalLeads: leads.length };
  campaignRunners.set(campaignId, runner);
  dashboard.campaignRunners.set(campaignId, runner);

  dashboard.pushCampaignLog(campaignId, userId, "info",
    `Campaign "${campaign.name}" started: ${leads.length} leads, ${extensions.length} extensions`);

  // Build lead queue
  const queue = new CallQueue(leads, maxConcurrent, delayMs);
  runner.queue = queue;

  const results = await queue.start(async (lead) => {
    if (!runner.running || !lead) return { outcome: "skipped" };

    // Per-call credit check
    const currentBalance = getUserBalance(userId);
    if (currentBalance <= 0) {
      dashboard.pushCampaignLog(campaignId, userId, "error", "Credits depleted — stopping campaign.");
      runner.running = false;
      if (runner.queue) { runner.queue.leads = []; runner.queue.stop(); }
      return { outcome: "skipped" };
    }

    const rawName = lead.first_name || lead.name || "Unknown";
    const displayName = rawName.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
    dashboard.pushCampaignLog(campaignId, userId, "info", `Dialing ${displayName} (${lead.phone})`);

    // Track active call
    const activeCall = { leadId: lead.id, phone: lead.phone, name: displayName, startedAt: new Date().toISOString(), status: "dialing" };
    runner.activeCalls.push(activeCall);
    dashboard.broadcastToUser(userId, "call_started", { campaignId, call: activeCall, activeCalls: runner.activeCalls.length, remainingLeads: queue.leads.length });

    // Build agent settings interpolated with this lead's data
    const leadData = { ...lead, ...JSON.parse(lead.extra_json || "{}") };
    const agentSettings = buildAgentSettingsFromDb(agent, leadData);

    const startedAt = new Date().toISOString();
    let result;
    let appointmentAlreadySaved = false;
    
    try {
      result = await callManager.callLead(leadData, { 
        agentSettings, 
        transferExtensions: extensions, 
        sipConfig,
        deepgramApiKey,
        onCallAbortHandle: (handle) => {
          runner.activeAbortHandles.set(handle.callId, handle);
        },
        onLiveEvent: (type, data) => {
          dashboard.broadcastToUser(userId, "live_event", { 
            campaignId, 
            type, 
            ...data,
            time: new Date().toISOString() 
          });
        },
        // Update lead name/info when AI captures it mid-call (cold list)
        onLeadInfoUpdated: ({ leadId, firstName, lastName, email }) => {
          try {
            const db = getDb();
            const updates = [];
            const vals = [];
            if (firstName) { updates.push("first_name = ?"); vals.push(firstName); }
            if (lastName) { updates.push("last_name = ?"); vals.push(lastName); }
            if (email) { updates.push("email = ?"); vals.push(email); }
            if (updates.length > 0) {
              vals.push(leadId);
              db.prepare(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
              const fullName = [firstName, lastName].filter(Boolean).join(" ");
              logger.info(`Lead ${leadId} updated mid-call: ${fullName}${email ? ` (${email})` : ""}`);
            }
          } catch (e) {
            logger.error(`Failed to update lead info: ${e.message}`);
          }
        },
        // CRITICAL: Save appointment IMMEDIATELY when AI books it (don't wait for call end)
        onAppointmentBooked: async (apptData) => {
          try {
            const apptId = createAppointment({
              user_id: userId,
              campaign_id: campaignId,
              lead_id: lead.id,
              call_id: apptData.callId || "",
              lead_name: apptData.leadName,
              phone: apptData.phone,
              email: apptData.email || "",
              appointment_date: apptData.date,
              appointment_time: apptData.time,
              notes: apptData.notes || "",
            });
            appointmentAlreadySaved = true;
            logger.info(`Appointment created IMMEDIATELY: ${apptId} for ${apptData.leadName} on ${apptData.date} ${apptData.time}`);
            dashboard.broadcastToUser(userId, "appointment_created", { 
              appointmentId: apptId, 
              leadName: apptData.leadName, 
              date: apptData.date, 
              time: apptData.time 
            });
          } catch (e) {
            logger.error(`Failed to create appointment immediately: ${e.message}`);
          }
        }
      });
    } catch (err) {
      result = { outcome: "error", notes: err.message, transcript: [] };
    }
    const endedAt = new Date().toISOString();

    // 402/401 detection — auto-rotate Deepgram key if needed
    if (result.outcome === "error" && deepgramKeyInfo.id) {
      const errMsg = (result.notes || "").toLowerCase();
      if (errMsg.includes("402") || errMsg.includes("payment required") || errMsg.includes("insufficient")) {
        const rotated = deepgramKeyManager.report402(userId, deepgramKeyInfo.id);
        if (rotated?.rotated) {
          deepgramKeyInfo = rotated;
          deepgramApiKey = rotated.key;
          dashboard.pushCampaignLog(campaignId, userId, "warn", `Deepgram key depleted (402). Auto-switched to "${rotated.label}".`);
        } else if (!rotated) {
          dashboard.pushCampaignLog(campaignId, userId, "error", "All Deepgram API keys depleted! Add more keys in Settings.");
        }
      } else if (errMsg.includes("401") || errMsg.includes("unauthorized") || errMsg.includes("deactivated")) {
        const rotated = deepgramKeyManager.report401(userId, deepgramKeyInfo.id);
        if (rotated?.rotated) {
          deepgramKeyInfo = rotated;
          deepgramApiKey = rotated.key;
          dashboard.pushCampaignLog(campaignId, userId, "warn", `Deepgram key invalid (401). Auto-switched to "${rotated.label}".`);
        } else if (!rotated) {
          dashboard.pushCampaignLog(campaignId, userId, "error", "All Deepgram API keys invalid! Add more keys in Settings.");
        }
      }
    }
    // Report success to reset error counter
    if (result.outcome !== "error" && deepgramKeyInfo.id) {
      deepgramKeyManager.reportSuccess(userId, deepgramKeyInfo.id);
    }

    // Remove from active calls and abort handles
    runner.activeCalls = runner.activeCalls.filter(c => c.leadId !== lead.id);
    if (result?.callId) runner.activeAbortHandles.delete(result.callId);
    runner.completedCalls++;
    dashboard.broadcastToUser(userId, "call_ended", { campaignId, leadId: lead.id, phone: lead.phone, name: displayName, outcome: result.outcome, duration: Math.round((new Date(endedAt) - new Date(startedAt)) / 1000), activeCalls: runner.activeCalls.length, completedCalls: runner.completedCalls, remainingLeads: queue.leads.length });

    // Calculate duration
    const durationMs = new Date(endedAt) - new Date(startedAt);
    const durationSeconds = Math.round(durationMs / 1000);

    // Calculate costs (dynamic rates from admin settings)
    const aiDurationSec = result.aiDurationSeconds || 0;
    const rates = getCostRates();
    const voipCost = (durationSeconds / 60) * rates.voipCostPerMin;
    const aiCost = (aiDurationSec / 60) * rates.aiCostPerMin;
    const callCost = voipCost + aiCost;

    // Record in DB
    let callRecordId;
    try {
      callRecordId = recordCall({
        campaign_id: campaignId,
        agent_id: agent.id,
        lead_id: lead.id,
        user_id: userId,
        call_id: result.callId || "unknown",
        phone: lead.phone,
        lead_name: displayName,
        outcome: result.outcome,
        duration_seconds: durationSeconds,
        notes: result.notes || "",
        transcript: result.transcript || [],
        transferred_to: result.outcome === "transferred" ? (result.transferredTo || extensions[0] || "") : "",
        error_message: result.outcome === "error" ? (result.notes || "") : "",
        started_at: startedAt,
        ended_at: endedAt,
        recording_path: result.recordingPath || "",
        ai_duration_seconds: aiDurationSec,
        call_cost: callCost,
        voip_cost: voipCost,
        ai_cost: aiCost,
      });
    } catch (e) {
      logger.error(`Failed to record call: ${e.message}`);
    }

    // Fire-and-forget: push transfer to Google Sheets
    if (result.outcome === "transferred" && callRecordId) {
      setTimeout(() => {
        import("./services/google-sheets.js").then(({ pushTransferToSheet }) => {
          pushTransferToSheet({
            id: callRecordId,
            campaign_id: campaignId,
            user_id: userId,
            lead_id: lead.id,
            lead_name: displayName,
            phone: lead.phone,
            email: lead.email || "",
            call_id: result.callId || "",
            transferred_to: result.transferredTo || "",
            notes: result.notes || "",
            status: "transferred",
            duration_seconds: durationSeconds,
            transferred_at: endedAt,
          }).catch(err => {
            logger.error(`Google Sheets transfer push failed: ${err.message}`);
          });
        }).catch(() => {});
      }, 2000);
    }

    // Fire-and-forget: upload recording to Google Drive (waits for ffmpeg to finish)
    if (callRecordId && result.recordingPath) {
      setTimeout(() => {
        import("./services/google-drive.js").then(({ uploadAndLinkRecording }) => {
          uploadAndLinkRecording(callRecordId).catch(err => {
            logger.error(`Drive upload failed: ${err.message}`);
          });
        }).catch(() => {});
      }, 5000);
    }

    // Deduct credits
    if (callCost > 0) {
      try {
        const newBalance = deductCredits(userId, callCost, `Call to ${displayName} (${lead.phone}) - ${durationSeconds}s`, result.callId || "");
        logger.info(`Credits deducted: $${callCost.toFixed(4)} (VoIP: $${voipCost.toFixed(4)}, AI: $${aiCost.toFixed(4)}). Balance: $${newBalance.toFixed(2)}`);
      } catch (e) {
        logger.error(`Failed to deduct credits: ${e.message}`);
      }
    }

    // Update lead status based on call outcome
    try {
      updateLeadStatus(lead.id, result.outcome);
    } catch (e) {
      logger.error(`Failed to update lead status: ${e.message}`);
    }

    // Auto-retry: if SIP error is retryable (busy/unavailable/service down),
    // put the lead back at the end of the queue for one more attempt
    const RETRYABLE_SIP = ["486", "480", "503"];
    const retryMax = 2;
    if (result.outcome === "error" && runner.running) {
      const sipMatch = (result.notes || "").match(/(\d{3})/);
      const sipCode = sipMatch ? sipMatch[1] : null;
      if (sipCode && RETRYABLE_SIP.includes(sipCode)) {
        lead._retryCount = (lead._retryCount || 0) + 1;
        if (lead._retryCount <= retryMax) {
          logger.info(`[${result.callId}] SIP ${sipCode} — queueing retry ${lead._retryCount}/${retryMax} for ${displayName} (${lead.phone})`);
          queue.leads.push(lead);
        } else {
          logger.info(`[${result.callId}] SIP ${sipCode} — max retries reached for ${displayName} (${lead.phone})`);
        }
      }
    }

    // Save appointment if one was booked (fallback - only if not already saved immediately)
    if (!appointmentAlreadySaved && result.outcome === "appointment_set" && result.appointmentDate && result.appointmentTime) {
      try {
        const apptId = createAppointment({
          user_id: userId,
          campaign_id: campaignId,
          lead_id: lead.id,
          call_id: result.callId || "",
          lead_name: displayName,
          phone: lead.phone,
          email: lead.email || "",
          appointment_date: result.appointmentDate,
          appointment_time: result.appointmentTime,
          notes: result.notes || "",
        });
        logger.info(`Appointment created (fallback): ${apptId} for ${displayName} on ${result.appointmentDate} ${result.appointmentTime}`);
        dashboard.broadcastToUser(userId, "appointment_created", { 
          appointmentId: apptId, 
          leadName: displayName, 
          date: result.appointmentDate, 
          time: result.appointmentTime 
        });
      } catch (e) {
        logger.error(`Failed to create appointment: ${e.message}`);
      }
    }

    dashboard.pushCampaignLog(campaignId, userId, "info",
      `Call to ${displayName}: ${result.outcome} (${durationSeconds}s)`);

    // Push real-time update to user
    dashboard.broadcastToUser(userId, "call_result", {
      campaignId,
      phone: lead.phone,
      leadName: displayName,
      outcome: result.outcome,
      duration: durationSeconds,
    });

    return result;
  });

  // Campaign finished
  campaignRunners.delete(campaignId);
  dashboard.campaignRunners.delete(campaignId);

  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);

  const completed = results.filter(r => r && r.outcome !== "skipped").length;
  dashboard.pushCampaignLog(campaignId, userId, "info",
    `Campaign "${campaign.name}" finished: ${completed} calls completed`);

  dashboard.broadcastToUser(userId, "campaign_finished", { campaignId });
}

/**
 * Soft stop — stops dialing new leads but lets active calls finish naturally.
 */
function softStopCampaign(campaignId) {
  const runner = campaignRunners.get(campaignId);
  if (runner) {
    const activeCount = runner.activeCalls?.length || 0;
    logger.info(`Soft-stopping campaign ${campaignId}: ${activeCount} active calls will finish naturally`);
    
    runner.running = false;
    
    if (runner.queue) {
      runner.queue.leads = [];
      runner.queue.stop();
    }
    
    const msg = activeCount > 0
      ? `Campaign stopped — ${activeCount} active call(s) will finish naturally`
      : "Campaign stopped";
    dashboard.pushCampaignLog(campaignId, runner.userId, "info", msg);
  }

  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
  
  logger.info(`Campaign ${campaignId} soft-stopped`);
}

/**
 * Force stop — kills all active SIP + Deepgram connections immediately.
 */
function forceStopCampaign(campaignId) {
  const runner = campaignRunners.get(campaignId);
  if (runner) {
    logger.info(`FORCE stopping campaign ${campaignId}: ${runner.activeCalls?.length || 0} active calls, ${runner.activeAbortHandles?.size || 0} abort handles`);
    
    runner.running = false;
    
    if (runner.queue) {
      runner.queue.leads = [];
      runner.queue.stop();
    }
    
    if (runner.activeAbortHandles && runner.activeAbortHandles.size > 0) {
      logger.info(`Force-killing ${runner.activeAbortHandles.size} active calls`);
      for (const [callId, handle] of runner.activeAbortHandles) {
        try {
          handle.abort();
          logger.info(`Aborted call ${callId}`);
        } catch (e) {
          logger.error(`Failed to abort call ${callId}: ${e.message}`);
        }
      }
      runner.activeAbortHandles.clear();
    }
    
    runner.activeCalls = [];
    
    dashboard.pushCampaignLog(campaignId, runner.userId, "info", "Campaign FORCE stopped — all active calls killed");
    campaignRunners.delete(campaignId);
    dashboard.campaignRunners.delete(campaignId);
    
    dashboard.broadcastToUser(runner.userId, "campaign_finished", { campaignId });
  }

  const db = getDb();
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
    .run(campaignId);
  
  logger.info(`Campaign ${campaignId} force-stopped and set to paused`);
}

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception (kept alive): ${err.message}\n${err.stack}`);
});

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
