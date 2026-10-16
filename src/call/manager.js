import { v4 as uuidv4 } from "uuid";
import logger from "../utils/logger.js";
import { DeepgramAgent } from "../deepgram/agent.js";
import { AudioBridge } from "../audio/bridge.js";
import { getPlatformSetting } from "../db/helpers.js";
import { liveSipError } from "../billing/balance-guard.js";
import { detectVoicemail } from "./voicemail.js";

// Lazy-load configStore only for legacy/fallback usage
let _configStore = null;
async function getConfigStore() {
  if (!_configStore) {
    try {
      const mod = await import("../config/store.js");
      _configStore = mod.configStore;
    } catch (e) { /* ignore if not available */ }
  }
  return _configStore;
}

/**
 * CallManager - Orchestrates a single call lifecycle.
 * 
 * For each call:
 * 1. Creates an AudioBridge (local UDP socket for RTP)
 * 2. Uses SipDialer to place the outbound SIP call
 * 3. Creates a DeepgramAgent (WebSocket to Voice Agent API)
 * 4. Wires audio: lead RTP -> Deepgram STT -> LLM -> Deepgram TTS -> RTP -> lead
 * 5. Handles barge-in, transfer, and hangup
 */
export class CallManager {
  constructor(sipDialer) {
    this.sipDialer = sipDialer;
  }

  /**
   * Execute a call to a single lead.
   * @param {Object} lead - Lead data (phone, first_name, etc.)
   * @param {Object} [options] - Optional: agentSettings, transferExtensions, sipConfig
   * @param {Object} [options.agentSettings] - Pre-built Deepgram agent settings (from DB agent)
   * @param {string[]} [options.transferExtensions] - List of SIP extensions for transfer
   * @param {Object} [options.sipConfig] - SIP config from DB (per-user)
   * @param {Function} [options.onLiveEvent] - Callback for real-time events (type, data)
   * Returns the call result/disposition.
   */
  async callLead(lead, options = {}) {
    const callId = uuidv4().slice(0, 8);
    const raw = lead.first_name || lead.name || "Unknown";
    const displayName = raw.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
    logger.info(`[${callId}] Starting call to ${displayName} (${lead.phone})`);
    
    // Helper to emit live events
    const emit = (type, data = {}) => {
      if (options.onLiveEvent) {
        options.onLiveEvent(type, { callId, leadId: lead.id, phone: lead.phone, name: displayName, ...data });
      }
    };
    
    emit("call_init", { status: "initializing" });

    const audioBridge = new AudioBridge(callId);
    let deepgramAgent = null;
    let sipDialog = null;
    let callResult = { outcome: "unknown", notes: "", transcript: [] };
    let aborted = false;

    // Voicemail auto-hangup. The prompt asks the model to drop answering
    // machines, but it routinely pitched to them for ~40s instead, so the
    // decision is made in code. Screening prompts ("record your name...") are
    // excluded by default: those calls do reach humans and book appointments.
    const voicemailHangupEnabled = getPlatformSetting("voicemail_auto_hangup", "true") !== "false";
    const cutScreenedCalls = getPlatformSetting("voicemail_cut_screened_calls", "false") === "true";
    let answeredAtMs = 0;
    let voicemailFound = null;
    let endForVoicemail = null;

    const abortHandle = {
      callId,
      abort: () => {
        if (aborted) return;
        aborted = true;
        logger.info(`[${callId}] FORCE ABORT — killing SIP + Deepgram`);
        callResult.outcome = "stopped";
        callResult.notes = "Campaign stopped by user";
        try { if (sipDialog) this.sipDialer.hangup(sipDialog).catch(() => {}); } catch (e) { /* ignore */ }
        try { if (deepgramAgent) deepgramAgent.disconnect(); } catch (e) { /* ignore */ }
        try { if (audioBridge) audioBridge.stop(); } catch (e) { /* ignore */ }
      },
    };

    if (options.onCallAbortHandle) {
      options.onCallAbortHandle(abortHandle);
    }

    try {
      // Step 1: Start audio bridge (opens UDP port for RTP)
      emit("audio_bridge", { status: "starting" });
      const localPort = await audioBridge.start();
      const localSdp = audioBridge.generateLocalSdp();
      emit("audio_bridge", { status: "ready", port: localPort });

      // Step 2: Place the SIP call
      emit("sip_dialing", { status: "dialing" });
      logger.info(`[${callId}] Dialing ${lead.phone}...`);
      sipDialog = await this.sipDialer.makeCall(lead.phone, localSdp, options.sipConfig);
      // makeCall only resolves on SIP 200 OK, so this is the true answer moment.
      // Anything before it is ring/reject time that the carrier does not bill.
      callResult.answeredAt = new Date().toISOString();
      answeredAtMs = Date.now();
      emit("sip_connected", { status: "connected" });

      // Parse the remote SDP to get rtpengine/provider RTP endpoint
      if (sipDialog && sipDialog.remote && sipDialog.remote.sdp) {
        const remoteSdp = sipDialog.remote.sdp;
        const remoteEndpoint = this._parseRemoteSdp(remoteSdp);
        if (remoteEndpoint) {
          audioBridge.setRemoteEndpoint(remoteEndpoint.host, remoteEndpoint.port);
        }
      }

      // Step 3: Connect to Deepgram Voice Agent API
      emit("deepgram", { status: "connecting" });
      let agentSettings = options.agentSettings;
      if (!agentSettings) {
        // Legacy fallback: use configStore
        const cs = await getConfigStore();
        if (cs) agentSettings = cs.buildAgentSettings(lead);
      }
      deepgramAgent = new DeepgramAgent(callId, {
        agentSettings,
        responseDelayMs: options.responseDelayMs,
        // AI audio -> play to lead via RTP
        onAudioReceived: (audioBuffer) => {
          audioBridge.sendAudioToLead(Buffer.from(audioBuffer));
        },

        // Lead interrupted — Deepgram stops old TTS and generates new response.
        // Deepgram's VAD fires on "yes", "okay", breaths and room noise too, and
        // a hard flush made Emma stop mid-word every time ("you're cut off").
        // Let up to BARGE_GRACE_FRAMES of the queued audio finish (the tail of
        // the phrase she is on), drop the rest. Short sentences complete; long
        // ones stop within a second like a person who yields the floor.
        onBargeIn: () => {
          emit("barge_in", { status: "user_interrupted" });
          const BARGE_GRACE_FRAMES = 50; // 20 ms frames → 1.0 s
          if (audioBridge.sendQueue.length > BARGE_GRACE_FRAMES) {
            audioBridge.sendQueue.length = BARGE_GRACE_FRAMES;
          }
          audioBridge.audioOutBuffer = Buffer.alloc(0);
        },

        // AI collected the lead's name (cold list) — update DB immediately
        onUpdateLeadInfo: (firstName, lastName, email) => {
          const fullName = [firstName, lastName].filter(Boolean).join(" ");
          logger.info(`[${callId}] Lead info captured: ${fullName}${email ? ` (${email})` : ""}`);
          emit("function_call", { function: "update_lead_info", first_name: firstName, last_name: lastName, email });

          if (firstName) lead.first_name = firstName;
          if (lastName) lead.last_name = lastName;
          if (email) lead.email = email;

          if (lead.id && options.onLeadInfoUpdated) {
            options.onLeadInfoUpdated({ leadId: lead.id, firstName, lastName, email });
          }
        },

        // AI booked an appointment (appointment mode) - SAVE IMMEDIATELY
        onBookAppointment: async (date, time, notes) => {
          logger.info(`[${callId}] Appointment booked: ${date} ${time} - ${notes}`);
          emit("function_call", { function: "book_appointment", date, time, notes });
          callResult.outcome = "appointment_set";
          callResult.notes = `Appointment: ${date} ${time}${notes ? ' - ' + notes : ''}`;
          callResult.appointmentDate = date;
          callResult.appointmentTime = time;
          callResult.appointmentNotes = notes;
          
          // Save appointment IMMEDIATELY via callback (don't wait for call to end)
          if (options.onAppointmentBooked) {
            try {
              const currentName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || displayName;
              await options.onAppointmentBooked({
                callId,
                leadId: lead.id,
                leadName: currentName,
                phone: lead.phone,
                email: lead.email || "",
                date,
                time,
                notes,
              });
              emit("appointment_saved", { date, time });
              logger.info(`[${callId}] Appointment saved to database immediately`);
            } catch (e) {
              logger.error(`[${callId}] Failed to save appointment: ${e.message}`);
            }
          }
        },

        // AI wants to transfer the call
        onTransferRequest: async (reason) => {
          logger.info(`[${callId}] Transfer requested: ${reason}`);
          emit("function_call", { function: "transfer_call", reason });
          callResult.outcome = "transferred";
          callResult.notes = reason;
          try {
            // Pick transfer extension: round-robin from options, or legacy fallback
            let transferExtension = "676";
            if (options.transferExtensions && options.transferExtensions.length > 0) {
              // Simple round-robin using a static counter
              if (!CallManager._extIndex) CallManager._extIndex = 0;
              transferExtension = options.transferExtensions[CallManager._extIndex % options.transferExtensions.length];
              CallManager._extIndex++;
            } else {
              const cs = await getConfigStore();
              if (cs) {
                const config = cs.getConfig();
                transferExtension = config?.agent?.transfer_extension || "676";
              }
            }
            await this.sipDialer.transferCall(sipDialog, transferExtension, options.sipConfig);
            callResult.transferredTo = transferExtension;
            emit("transfer_complete", { extension: transferExtension });
            logger.info(`[${callId}] Call transferred successfully to ${transferExtension}`);
            // Disconnect Deepgram and stop audio bridge so the AI stops processing.
            // Keep the SIP dialog alive — the provider needs it to bridge client ↔ agent.
            try { if (deepgramAgent) deepgramAgent.disconnect(); } catch (e) { /* ignore */ }
            try { if (audioBridge) audioBridge.stop(); } catch (e) { /* ignore */ }
            logger.info(`[${callId}] AI disconnected, SIP dialog kept alive for transfer`);
          } catch (err) {
            logger.error(`[${callId}] Transfer failed: ${err.message}`);
          }
        },

        // AI wants to end the call
        onEndCallRequest: async (outcome, notes, extra = {}) => {
          logger.info(`[${callId}] End call requested: ${outcome} - ${notes}` +
            (extra.wants ? ` | wants: ${extra.wants}` : "") + (extra.callbackTime ? ` | callback: ${extra.callbackTime}` : ""));
          emit("function_call", { function: "end_call", outcome, notes, wants: extra.wants, callback_time: extra.callbackTime });
          callResult.outcome = outcome;
          callResult.clientWants = extra.wants || (outcome === "callback" ? "callback" : "");
          // The model writes "unknown"/"none" when the client gave no time.
          if (/^(unknown|none|n\/a|not given|-)?$/i.test((extra.callbackTime || "").trim())) extra.callbackTime = "";
          callResult.requestedCallback = extra.callbackTime;
          // Put the classification in front of the free-text notes so it is
          // visible everywhere notes are shown, even in old UI views.
          const head = [];
          if (extra.callbackTime) head.push(`CALL BACK: ${extra.callbackTime}`);
          if (extra.emailRequested) head.push("EMAIL REQUESTED");
          callResult.notes = head.length ? `[${head.join(" | ")}] ${notes}` : notes;
          // Give the AI 8 seconds to finish saying goodbye, then hang up
          // This delay allows the AI to speak its final message before disconnecting
          setTimeout(async () => {
            logger.info(`[${callId}] Hanging up SIP call after end_call function`);
            try {
              if (sipDialog) {
                await this.sipDialer.hangup(sipDialog);
              }
            } catch (e) {
              logger.error(`[${callId}] Hangup error: ${e.message}`);
            }
            // Disconnect Deepgram to trigger the promise resolution
            try {
              if (deepgramAgent) {
                deepgramAgent.disconnect();
              }
            } catch (e) { /* ignore */ }
          }, 8000);
        },

        // Track conversation text
        onTranscript: (role, text) => {
          emit("transcript", { role, text });
          callResult.transcript.push({ role, text, time: new Date().toISOString() });

          if (role !== "user" || voicemailFound || !voicemailHangupEnabled) return;
          const hit = detectVoicemail(text, {
            elapsedMs: answeredAtMs ? Date.now() - answeredAtMs : 0,
            includeScreening: cutScreenedCalls,
          });
          if (!hit) return;

          voicemailFound = hit;
          callResult.outcome = "voicemail";
          callResult.notes = `${hit.kind === "screening" ? "Call screening" : "Voicemail"} detected ("${hit.phrase}") — hung up immediately`;
          logger.info(`[${callId}] ${hit.kind} detected ("${hit.phrase}") — hanging up now`);
          emit("voicemail_detected", { phrase: hit.phrase, kind: hit.kind, confidence: hit.confidence });
          // May fire before the wait loop arms the teardown; handled there too.
          if (endForVoicemail) endForVoicemail();
        },

        onError: (err) => {
          emit("error", { message: err.message });
          logger.error(`[${callId}] Deepgram error: ${err.message}`);
        },

        onClose: () => {
          emit("deepgram", { status: "closed" });
          logger.info(`[${callId}] Deepgram connection closed`);
        },
      });

      const voiceEngine = getPlatformSetting("voice_engine", "deepgram");
      const localVoiceUrl = getPlatformSetting("local_voice_agent_url", process.env.LOCAL_VOICE_AGENT_URL || "ws://voice-agent:8765");
      const engineConfig = { engine: voiceEngine, localUrl: localVoiceUrl };
      await deepgramAgent.connect(options.deepgramApiKey, engineConfig);
      emit("deepgram", { status: "connected", engine: voiceEngine });

      // Step 4: Wire lead audio -> Deepgram
      audioBridge.onAudioFromLead = (pcmData) => {
        deepgramAgent.sendAudio(pcmData);
      };

      // Step 5: Wait for call to end
      // The call ends when:
      // - The lead hangs up (SIP BYE)
      // - The AI calls end_call function
      // - The AI calls transfer_call function
      // - An error occurs
      await new Promise((resolve) => {
        let resolved = false;
        const safeResolve = () => {
          if (resolved) return;
          resolved = true;
          clearInterval(inactivityMonitor);
          clearTimeout(callTimeout);
          resolve();
        };

        let lastActivityTime = Date.now();
        
        const origOnTranscript = deepgramAgent.onTranscript;
        deepgramAgent.onTranscript = (role, content) => {
          lastActivityTime = Date.now();
          if (origOnTranscript) origOnTranscript(role, content);
        };
        
        const origOnAudioReceived = deepgramAgent.onAudioReceived;
        deepgramAgent.onAudioReceived = (buffer) => {
          lastActivityTime = Date.now();
          if (origOnAudioReceived) origOnAudioReceived(buffer);
        };
        
        const MAX_INACTIVITY_SEC = 60;
        const inactivityMonitor = setInterval(() => {
          const silenceSeconds = Math.round((Date.now() - lastActivityTime) / 1000);
          if (silenceSeconds >= MAX_INACTIVITY_SEC) {
            logger.warn(`[${callId}] AI inactive for ${silenceSeconds}s — auto-hanging up stuck call`);
            callResult.outcome = "timeout";
            callResult.notes = `Auto-hangup: AI inactive for ${silenceSeconds}s`;
            try {
              if (sipDialog) this.sipDialer.hangup(sipDialog).catch(() => {});
            } catch (e) { /* ignore */ }
            try {
              if (deepgramAgent) deepgramAgent.disconnect();
            } catch (e) { /* ignore */ }
            safeResolve();
          } else if (silenceSeconds >= 10) {
            logger.warn(`[${callId}] No AI activity for ${silenceSeconds}s - LLM may be stuck`);
          }
        }, 5000);
        
        if (sipDialog) {
          sipDialog.on("destroy", () => {
            emit("sip_hangup", { by: "lead" });
            logger.info(`[${callId}] Lead hung up`);
            if (callResult.outcome === "unknown") {
              callResult.outcome = "lead_hangup";
            }
            safeResolve();
          });
        }

        const origOnClose = deepgramAgent.onClose;
        deepgramAgent.onClose = (code, reason) => {
          if (origOnClose) origOnClose(code, reason);
          if (callResult.outcome === "unknown") {
            callResult.outcome = "error";
            callResult.notes = `Voice engine closed unexpectedly (${code}${reason ? `: ${reason}` : ""})`;
            try {
              if (sipDialog) this.sipDialer.hangup(sipDialog).catch(() => {});
            } catch (e) { /* ignore */ }
          }
          safeResolve();
        };

        const callTimeout = setTimeout(() => {
          logger.warn(`[${callId}] Call timeout (10 min)`);
          callResult.outcome = "timeout";
          safeResolve();
        }, 600000);

        // Immediate teardown for a detected machine: no goodbye and none of the
        // 8s grace period end_call allows — every second here is billed for
        // nothing. Armed last because safeResolve() clears the timers above.
        endForVoicemail = () => {
          try {
            audioBridge.sendQueue = [];
            audioBridge.audioOutBuffer = Buffer.alloc(0);
          } catch (e) { /* ignore */ }
          try { if (deepgramAgent) deepgramAgent.disconnect(); } catch (e) { /* ignore */ }
          try { if (sipDialog) this.sipDialer.hangup(sipDialog).catch(() => {}); } catch (e) { /* ignore */ }
          try { if (audioBridge) audioBridge.stop(); } catch (e) { /* ignore */ }
          safeResolve();
        };
        // A machine greeting can be transcribed before this point, i.e. while
        // the agent was still connecting — tear down now in that case.
        if (voicemailFound) endForVoicemail();
      });

    } catch (err) {
      const shown = liveSipError(err.status, err.message);
      if (shown) {
        emit("error", { message: shown });
        logger.error(`[${callId}] Call error: ${shown}`);
      }
      callResult.outcome = "error";
      callResult.notes = err.message;
    } finally {
      // Capture AI speaking duration before cleanup disconnects Deepgram
      if (deepgramAgent) {
        callResult.aiDurationSeconds = deepgramAgent.getAiSpeakingDuration();
        logger.info(`[${callId}] AI speaking duration: ${callResult.aiDurationSeconds.toFixed(2)}s (bytes: ${deepgramAgent._aiAudioBytesReceived})`);
      }
      // Cleanup and get recording path
      const recordingPath = await this._cleanup(sipDialog, deepgramAgent, audioBridge, callId, callResult.outcome);
      if (recordingPath) {
        callResult.recordingPath = recordingPath;
      }
    }

    emit("call_complete", { outcome: callResult.outcome });
    logger.info(`[${callId}] Call complete: ${callResult.outcome}`, { callId });
    callResult.callId = callId;
    return callResult;
  }

  /**
   * Clean up all resources for a call.
   * Returns the recording path if available.
   */
  async _cleanup(sipDialog, deepgramAgent, audioBridge, callId, outcome) {
    let recordingPath = null;
    
    try {
      if (deepgramAgent) deepgramAgent.disconnect();
    } catch (e) { /* ignore */ }
    try {
      if (audioBridge) {
        recordingPath = audioBridge.stop();
      }
    } catch (e) { /* ignore */ }
    // Do NOT destroy the SIP dialog if call was transferred —
    // the provider needs it alive to bridge client ↔ agent
    if (outcome !== "transferred") {
      try {
        if (sipDialog && sipDialog.connected) {
          await sipDialog.destroy().catch(e => {
            logger.debug(`[${callId}] Dialog destroy error (safe to ignore): ${e.message}`);
          });
        }
      } catch (e) { /* ignore */ }
    } else {
      logger.info(`[${callId}] Keeping SIP dialog alive for transfer`);
    }
    logger.info(`[${callId}] Resources cleaned up`);
    
    return recordingPath;
  }

  /**
   * Parse remote SDP to extract the RTP host and port.
   */
  _parseRemoteSdp(sdp) {
    try {
      const lines = sdp.split(/\r?\n/);
      let host = null;
      let port = null;

      for (const line of lines) {
        if (line.startsWith("c=IN IP4 ")) {
          host = line.split(" ")[2];
        }
        if (line.startsWith("m=audio ")) {
          port = parseInt(line.split(" ")[1]);
        }
      }

      if (host && port) {
        return { host, port };
      }
    } catch (err) {
      logger.error(`Failed to parse remote SDP: ${err.message}`);
    }
    return null;
  }
}
