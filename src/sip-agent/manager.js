/**
 * SIP Agent Manager
 * 
 * Manages SIP registrations and calls for human agents.
 * Each agent has their own SIP account that registers to their provider.
 * 
 * Architecture:
 * - Agent enters SIP credentials in dashboard
 * - Backend registers to their SIP server using drachtio
 * - Incoming calls are received and streamed to agent's browser via WebSocket
 * - Agent can answer/hangup/make calls from the browser
 */

import Srf from "drachtio-srf";
import { getDb, generateId } from "../db/schema.js";
import logger from "../utils/logger.js";
import { AgentAudioBridge } from "./audio-bridge.js";

class SipAgentManager {
  constructor() {
    this.srf = null;
    this.registrations = new Map(); // agentId -> registration handle
    this.activeCalls = new Map(); // callId -> { dialog, audioBridge, agentId }
    this.agentSockets = new Map(); // agentId -> WebSocket connection
    this.reregisterTimers = new Map(); // agentId -> timer
    this.keepAliveTimers = new Map(); // agentId -> OPTIONS keep-alive timer
  }

  /**
   * Initialize with drachtio connection
   */
  async init(srf) {
    this.srf = srf;
    
    // Handle incoming INVITE (calls to registered agents)
    this.srf.invite(async (req, res) => {
      await this._handleIncomingCall(req, res);
    });
    
    logger.info("SIP Agent Manager initialized");
  }

  /**
   * Register a SIP agent to their provider
   */
  async registerAgent(agentId) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(agentId);
    
    if (!agent) {
      throw new Error("Agent not found");
    }

    // Clear any existing re-registration timer
    if (this.reregisterTimers.has(agentId)) {
      clearInterval(this.reregisterTimers.get(agentId));
      this.reregisterTimers.delete(agentId);
    }

    const externalIp = process.env.EXTERNAL_RTP_IP || "127.0.0.1";
    const sipUri = `sip:${agent.sip_server}:${agent.sip_port}`;
    const fromTo = `<sip:${agent.sip_username}@${agent.sip_server}>`;
    // Contact should point to OUR server where we receive calls
    const contactUri = `<sip:${agent.sip_username}@${externalIp}:5060>`;

    logger.info(`Registering SIP agent: ${agent.name} -> ${sipUri}`);
    logger.info(`  From/To: ${fromTo}`);
    logger.info(`  Contact: ${contactUri}`);
    logger.info(`  Auth user: ${agent.sip_username}`);

    try {
      // Use srf.request() method like the main SipDialer does
      const result = await this.srf.request(sipUri, {
        method: "REGISTER",
        headers: {
          "From": fromTo,
          "To": fromTo,
          "Contact": contactUri,
          "Expires": "120",
          "Allow": "INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE",
          "User-Agent": "ROBOCOP-Softphone/1.0",
        },
        auth: {
          username: agent.sip_username,
          password: agent.sip_password,
        },
      });

      this.registrations.set(agentId, { agent, result });
      
      // Update status in DB
      db.prepare("UPDATE sip_agents SET status = 'online', last_seen_at = datetime('now') WHERE id = ?").run(agentId);
      
      // Re-register every 20 seconds (before Expires: 30 timeout)
      const reregTimer = setInterval(() => this._reregister(agentId), 20 * 1000);
      this.reregisterTimers.set(agentId, reregTimer);
      
      // Send OPTIONS keep-alive every 15 seconds to keep NAT open
      const keepAliveTimer = setInterval(() => this._sendKeepAlive(agentId), 15 * 1000);
      this.keepAliveTimers.set(agentId, keepAliveTimer);
      
      logger.info(`SIP agent registered successfully: ${agent.name}`);
      
      // Notify agent's browser
      this._notifyAgent(agentId, { type: "registration", status: "registered" });
      
      return { success: true, status: "registered" };
    } catch (err) {
      logger.error(`Failed to register SIP agent ${agent.name}: ${err.message}`);
      logger.error(`Registration error details: ${JSON.stringify(err)}`);
      db.prepare("UPDATE sip_agents SET status = 'error', last_seen_at = datetime('now') WHERE id = ?").run(agentId);
      throw err;
    }
  }

  /**
   * Unregister a SIP agent
   */
  async unregisterAgent(agentId) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(agentId);
    
    if (!agent) return;

    // Clear re-registration timer
    if (this.reregisterTimers.has(agentId)) {
      clearInterval(this.reregisterTimers.get(agentId));
      this.reregisterTimers.delete(agentId);
    }
    
    // Clear keep-alive timer
    if (this.keepAliveTimers.has(agentId)) {
      clearInterval(this.keepAliveTimers.get(agentId));
      this.keepAliveTimers.delete(agentId);
    }

    // Unregister from SIP server
    const reg = this.registrations.get(agentId);
    if (reg) {
      try {
        // Send REGISTER with Expires: 0 to unregister
        const externalIp = process.env.EXTERNAL_RTP_IP || "127.0.0.1";
        const sipUri = `sip:${agent.sip_server}:${agent.sip_port}`;
        const fromTo = `<sip:${agent.sip_username}@${agent.sip_server}:${agent.sip_port}>`;
        const contactUri = `<sip:${agent.sip_username}@${externalIp}:5060>`;
        
        await this.srf.request(sipUri, {
          method: "REGISTER",
          headers: {
            "From": fromTo,
            "To": fromTo,
            "Contact": contactUri,
            "Expires": "0",
          },
          auth: {
            username: agent.sip_username,
            password: agent.sip_password,
          },
        });
      } catch (err) {
        logger.warn(`Error unregistering agent ${agent.name}: ${err.message}`);
      }
      this.registrations.delete(agentId);
    }

    db.prepare("UPDATE sip_agents SET status = 'offline', last_seen_at = datetime('now') WHERE id = ?").run(agentId);
    logger.info(`SIP agent unregistered: ${agent.name}`);
    
    this._notifyAgent(agentId, { type: "registration", status: "unregistered" });
  }

  /**
   * Re-register to keep the registration alive (without unregistering first)
   */
  async _reregister(agentId) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(agentId);
    
    if (!agent) return;

    const externalIp = process.env.EXTERNAL_RTP_IP || "127.0.0.1";
    const sipUri = `sip:${agent.sip_server}:${agent.sip_port}`;
    const fromTo = `<sip:${agent.sip_username}@${agent.sip_server}>`;
    const contactUri = `<sip:${agent.sip_username}@${externalIp}:5060>`;

    try {
      await this.srf.request(sipUri, {
        method: "REGISTER",
        headers: {
          "From": fromTo,
          "To": fromTo,
          "Contact": contactUri,
          "Expires": "120",
          "Allow": "INVITE, ACK, CANCEL, BYE, NOTIFY, REFER, MESSAGE, OPTIONS, INFO, SUBSCRIBE",
          "User-Agent": "ROBOCOP-Softphone/1.0",
        },
        auth: {
          username: agent.sip_username,
          password: agent.sip_password,
        },
      });
      
      db.prepare("UPDATE sip_agents SET last_seen_at = datetime('now') WHERE id = ?").run(agentId);
      logger.info(`SIP agent re-registered: ${agent.name}`);
    } catch (err) {
      logger.error(`Re-registration failed for agent ${agentId}: ${err.message}`);
      // If re-registration fails, try full registration
      try {
        await this.registerAgent(agentId);
      } catch (e) {
        logger.error(`Full re-registration also failed: ${e.message}`);
      }
    }
  }

  /**
   * Send OPTIONS keep-alive to maintain NAT binding
   */
  async _sendKeepAlive(agentId) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(agentId);
    
    if (!agent || agent.status !== 'online') return;

    const sipUri = `sip:${agent.sip_server}:${agent.sip_port}`;

    try {
      await this.srf.request(sipUri, {
        method: "OPTIONS",
        headers: {
          "From": `<sip:${agent.sip_username}@${agent.sip_server}>`,
          "To": `<sip:${agent.sip_server}>`,
          "User-Agent": "ROBOCOP-Softphone/1.0",
        },
      });
      // Don't log every keep-alive to reduce noise
    } catch (err) {
      // OPTIONS failure is not critical, just log at debug level
      logger.warn(`Keep-alive failed for ${agent.name}: ${err.message}`);
    }
  }

  /**
   * Handle incoming call to a registered agent
   */
  async _handleIncomingCall(req, res) {
    const toUri = req.getParsedHeader("To").uri;
    const fromUri = req.getParsedHeader("From").uri;
    
    logger.info(`Incoming call: ${fromUri} -> ${toUri}`);

    // Find the agent this call is for
    const db = getDb();
    const agents = db.prepare("SELECT * FROM sip_agents WHERE status = 'online'").all();
    
    let targetAgent = null;
    for (const agent of agents) {
      if (toUri.includes(agent.sip_username)) {
        targetAgent = agent;
        break;
      }
    }

    if (!targetAgent) {
      logger.warn(`No online agent found for incoming call to ${toUri}`);
      res.send(404);
      return;
    }

    // Check if agent has a connected browser
    if (!this.agentSockets.has(targetAgent.id)) {
      logger.warn(`Agent ${targetAgent.name} has no connected browser`);
      res.send(480); // Temporarily Unavailable
      return;
    }

    const callId = generateId();
    
    // Create audio bridge for this call
    const audioBridge = new AgentAudioBridge(callId);
    const localPort = await audioBridge.start();
    const localSdp = audioBridge.generateLocalSdp();

    // Send 180 Ringing
    res.send(180);

    // Notify agent's browser about incoming call
    this._notifyAgent(targetAgent.id, {
      type: "incoming_call",
      callId,
      from: fromUri,
      to: toUri,
    });

    // Store pending call info
    this.activeCalls.set(callId, {
      req,
      res,
      audioBridge,
      agentId: targetAgent.id,
      status: "ringing",
      localSdp,
      from: fromUri,
      to: toUri,
    });

    // Create call record
    db.prepare(`
      INSERT INTO agent_call_records (id, sip_agent_id, user_id, call_id, direction, remote_party, status)
      VALUES (?, ?, ?, ?, 'inbound', ?, 'ringing')
    `).run(generateId(), targetAgent.id, targetAgent.user_id, callId, fromUri);

    // Auto-reject after 30 seconds if not answered
    setTimeout(() => {
      const call = this.activeCalls.get(callId);
      if (call && call.status === "ringing") {
        this._rejectCall(callId, 486); // Busy Here
      }
    }, 30000);
  }

  /**
   * Answer an incoming call (called from browser)
   */
  async answerCall(callId) {
    const call = this.activeCalls.get(callId);
    if (!call || call.status !== "ringing") {
      throw new Error("Call not found or not ringing");
    }

    const { req, res, audioBridge, agentId, localSdp } = call;

    try {
      // Answer with 200 OK
      const dialog = await this.srf.createUAS(req, res, {
        localSdp,
      });

      // Parse remote SDP to get RTP endpoint
      const remoteSdp = dialog.remote.sdp;
      const remoteHost = this._extractSdpHost(remoteSdp);
      const remotePort = this._extractSdpPort(remoteSdp);
      
      audioBridge.setRemoteEndpoint(remoteHost, remotePort);

      // Connect audio bridge to agent's browser WebSocket
      const agentSocket = this.agentSockets.get(agentId);
      if (agentSocket) {
        audioBridge.onAudioFromRemote = (pcmData) => {
          // Send audio to browser
          if (agentSocket.readyState === 1) { // OPEN
            agentSocket.send(pcmData);
          }
        };
      }

      call.dialog = dialog;
      call.status = "active";

      // Update call record
      const db = getDb();
      db.prepare("UPDATE agent_call_records SET status = 'active', answered_at = datetime('now') WHERE call_id = ?").run(callId);

      // Handle dialog events
      dialog.on("destroy", () => {
        this._endCall(callId, "remote_hangup");
      });

      this._notifyAgent(agentId, { type: "call_answered", callId });
      
      logger.info(`Call answered: ${callId}`);
      return { success: true };
    } catch (err) {
      logger.error(`Failed to answer call ${callId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Reject/decline an incoming call
   */
  async _rejectCall(callId, code = 486) {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    const { res, audioBridge, agentId } = call;

    try {
      res.send(code);
    } catch (err) {
      logger.warn(`Error rejecting call: ${err.message}`);
    }

    audioBridge.stop();
    this.activeCalls.delete(callId);

    const db = getDb();
    db.prepare("UPDATE agent_call_records SET status = 'rejected', ended_at = datetime('now') WHERE call_id = ?").run(callId);

    this._notifyAgent(agentId, { type: "call_rejected", callId });
  }

  /**
   * Reject call from browser
   */
  async rejectCall(callId) {
    await this._rejectCall(callId, 486);
    return { success: true };
  }

  /**
   * End/hangup an active call or cancel a dialing call
   */
  async hangupCall(callId) {
    const call = this.activeCalls.get(callId);
    if (!call) return { success: true };

    if (call.status === "dialing") {
      // Cancel outbound call that hasn't connected yet
      call.status = "cancelled";
      if (call.cancelFn) {
        call.cancelFn();
        logger.info(`Outbound call cancelled: ${callId}`);
      }
      call.audioBridge.stop();
      this.activeCalls.delete(callId);

      const db = getDb();
      db.prepare("UPDATE agent_call_records SET status = 'cancelled', ended_at = datetime('now') WHERE call_id = ?").run(callId);
      this._notifyAgent(call.agentId, { type: "call_ended", callId, reason: "cancelled" });
      return { success: true };
    }

    await this._endCall(callId, "agent_hangup");
    return { success: true };
  }

  /**
   * Internal: end a call
   */
  async _endCall(callId, reason) {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    const { dialog, audioBridge, agentId } = call;

    try {
      if (dialog) {
        dialog.destroy();
      }
    } catch (err) {
      logger.warn(`Error destroying dialog: ${err.message}`);
    }

    const recordingPath = audioBridge.stop();
    this.activeCalls.delete(callId);

    const db = getDb();
    db.prepare(`
      UPDATE agent_call_records 
      SET status = 'completed', ended_at = datetime('now'), recording_path = ?
      WHERE call_id = ?
    `).run(recordingPath || "", callId);

    this._notifyAgent(agentId, { type: "call_ended", callId, reason });
    logger.info(`Call ended: ${callId} (${reason})`);
  }

  /**
   * Make an outbound call from agent
   */
  async makeCall(agentId, destination) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ?").get(agentId);
    
    if (!agent || agent.status !== "online") {
      throw new Error("Agent not online");
    }

    const callId = generateId();
    
    // Create audio bridge
    const audioBridge = new AgentAudioBridge(callId);
    const localPort = await audioBridge.start();
    const localSdp = audioBridge.generateLocalSdp();

    // Format destination as SIP URI if needed
    let destUri = destination;
    if (!destination.startsWith("sip:")) {
      destUri = `sip:${destination}@${agent.sip_server}:${agent.sip_port}`;
    }

    const fromUri = `sip:${agent.sip_username}@${agent.sip_server}`;

    logger.info(`Agent ${agent.name} making call to ${destUri}`);

    // Store the call as "dialing" immediately so it can be cancelled
    this.activeCalls.set(callId, {
      dialog: null,
      cancelFn: null,
      audioBridge,
      agentId,
      status: "dialing",
      from: fromUri,
      to: destUri,
    });

    // Create call record
    db.prepare(`
      INSERT INTO agent_call_records (id, sip_agent_id, user_id, call_id, direction, remote_party, status)
      VALUES (?, ?, ?, ?, 'outbound', ?, 'dialing')
    `).run(generateId(), agent.id, agent.user_id, callId, destination);

    // Fire off the INVITE asynchronously — notify browser via WS when it connects or fails
    this.srf.createUAC(destUri, {
      localSdp,
      headers: {
        "From": `<${fromUri}>`,
        "Contact": `<sip:${agent.sip_username}@${process.env.EXTERNAL_RTP_IP}:5060>`,
      },
      auth: {
        username: agent.sip_username,
        password: agent.sip_password,
      },
      cbRequest: (err, req) => {
        // req.cancel() can be called to send a SIP CANCEL
        if (!err && req) {
          const call = this.activeCalls.get(callId);
          if (call) {
            call.cancelFn = () => {
              try { req.cancel(); } catch (e) { logger.warn(`Cancel error: ${e.message}`); }
            };
          }
        }
      },
    }).then((dialog) => {
      const call = this.activeCalls.get(callId);
      if (!call || call.status === "cancelled") {
        // Call was cancelled while ringing
        try { dialog.destroy(); } catch (e) {}
        audioBridge.stop();
        return;
      }

      // Parse remote SDP
      const remoteSdp = dialog.remote.sdp;
      const remoteHost = this._extractSdpHost(remoteSdp);
      const remotePort = this._extractSdpPort(remoteSdp);
      audioBridge.setRemoteEndpoint(remoteHost, remotePort);

      // Connect audio to browser
      const agentSocket = this.agentSockets.get(agentId);
      if (agentSocket) {
        audioBridge.onAudioFromRemote = (pcmData) => {
          if (agentSocket.readyState === 1) agentSocket.send(pcmData);
        };
      }

      call.dialog = dialog;
      call.status = "active";

      db.prepare("UPDATE agent_call_records SET status = 'active', answered_at = datetime('now') WHERE call_id = ?").run(callId);

      dialog.on("destroy", () => {
        this._endCall(callId, "remote_hangup");
      });

      this._notifyAgent(agentId, { type: "call_connected", callId, destination });
      logger.info(`Outbound call connected: ${callId}`);
    }).catch((err) => {
      const call = this.activeCalls.get(callId);
      if (call && call.status === "cancelled") {
        // Expected — we cancelled it
        return;
      }
      audioBridge.stop();
      this.activeCalls.delete(callId);
      db.prepare("UPDATE agent_call_records SET status = 'failed', ended_at = datetime('now') WHERE call_id = ?").run(callId);
      this._notifyAgent(agentId, { type: "call_failed", callId, error: err.message });
      logger.error(`Failed to make call ${callId}: ${err.message}`);
    });

    // Return immediately with the callId so the frontend can track/cancel it
    return { success: true, callId };
  }

  /**
   * Transfer a call to an online SIP agent
   * Called when AI needs to transfer to a human agent
   */
  async transferToAgent(sourceCallId, targetAgentId) {
    const db = getDb();
    const agent = db.prepare("SELECT * FROM sip_agents WHERE id = ? AND status = 'online'").get(targetAgentId);
    
    if (!agent) {
      throw new Error("Target agent not available");
    }

    // The transfer is handled by making a new call to the agent
    // and bridging the audio streams
    // This is a simplified implementation - full transfer would use REFER

    this._notifyAgent(targetAgentId, {
      type: "transfer_incoming",
      fromCallId: sourceCallId,
    });

    return { success: true, agentId: targetAgentId, agentName: agent.name };
  }

  /**
   * Get available agents for transfer
   */
  getAvailableAgents(userId) {
    const db = getDb();
    return db.prepare(`
      SELECT id, name, status, current_calls, max_concurrent_calls 
      FROM sip_agents 
      WHERE user_id = ? AND status = 'online' AND can_receive_transfers = 1
        AND current_calls < max_concurrent_calls
      ORDER BY priority DESC
    `).all(userId);
  }

  /**
   * Connect agent's browser WebSocket for audio
   */
  connectAgentSocket(agentId, ws) {
    this.agentSockets.set(agentId, ws);
    
    ws.on("message", (data) => {
      // Audio from browser -> send to active call
      const call = Array.from(this.activeCalls.values()).find(c => c.agentId === agentId && c.status === "active");
      if (call && call.audioBridge) {
        call.audioBridge.sendAudioToRemote(data);
      }
    });

    ws.on("close", () => {
      this.agentSockets.delete(agentId);
      // Optionally unregister when browser disconnects
    });

    logger.info(`Agent ${agentId} browser connected`);
  }

  /**
   * Send notification to agent's browser
   */
  _notifyAgent(agentId, message) {
    const ws = this.agentSockets.get(agentId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Extract host from SDP
   */
  _extractSdpHost(sdp) {
    const match = sdp.match(/c=IN IP4 (\S+)/);
    return match ? match[1] : "127.0.0.1";
  }

  /**
   * Extract port from SDP
   */
  _extractSdpPort(sdp) {
    const match = sdp.match(/m=audio (\d+)/);
    return match ? parseInt(match[1], 10) : 5004;
  }
}

export const sipAgentManager = new SipAgentManager();
