import WebSocket from "ws";
import logger from "../utils/logger.js";
import { getOutboundProxyUrl, isProxyQuotaBody, isTransientProxyError, newProxyAgent, proxyDescription } from "../net/outbound-proxy.js";

/**
 * Deepgram Voice Agent API client.
 * 
 * Manages a single WebSocket connection to the Voice Agent API for one call.
 * - Sends binary audio (lead's voice) to Deepgram
 * - Receives binary audio (AI voice) from Deepgram
 * - Receives JSON events (UserStartedSpeaking, ConversationText, FunctionCallRequest, etc.)
 * 
 * Settings are passed in at construction time (from ConfigStore.buildAgentSettings).
 */
export class DeepgramAgent {
  constructor(callId, options = {}) {
    this.callId = callId;
    this.ws = null;
    this.isConnected = false;
    this.keepAliveInterval = null;

    // Per-call agent settings (built by ConfigStore.buildAgentSettings with lead interpolation)
    this.agentSettings = options.agentSettings || null;

    // Callbacks (set by CallManager)
    this.onAudioReceived = options.onAudioReceived || null;
    this.onBargeIn = options.onBargeIn || null;
    this.onTransferRequest = options.onTransferRequest || null;
    this.onBookAppointment = options.onBookAppointment || null;
    this.onUpdateLeadInfo = options.onUpdateLeadInfo || null;
    this.onEndCallRequest = options.onEndCallRequest || null;
    this.onTranscript = options.onTranscript || null;
    this.onError = options.onError || null;
    this.onClose = options.onClose || null;

    // AI speaking duration tracking (for billing)
    // Track via binary audio bytes received (24kHz, 16-bit = 48000 bytes/sec)
    this._aiSpeakingStart = null;
    this._aiTotalSpeakingMs = 0;
    this._aiAudioBytesReceived = 0;

    // Human-like reaction pause: Deepgram starts streaming the reply ~300ms after
    // the lead stops talking, which sounds like an IVR pouncing. We hold the first
    // audio of each reply that follows a lead turn for responseDelayMs before
    // playing it. If the lead resumes talking during the hold, the held audio is
    // dropped (normal barge-in). The greeting and mid-reply chunks are never held.
    this.responseDelayMs = Math.max(0, Math.min(3000, Number(options.responseDelayMs) || 0));
    this._leadTurnPending = false;
    // True between replies (after AgentAudioDone / barge-in, and at call start).
    // The hold may only start at a reply boundary — never in the middle of a
    // streaming reply, or a lead's "hello?" over the AI would cut the AI's audio.
    this._atReplyBoundary = true;
    this._holdBuffer = [];
    this._holdTimer = null;
  }

  /** Route AI audio through the reaction-pause hold when appropriate. */
  _dispatchAudio(data) {
    if (!this.onAudioReceived) return;
    if (this._holdTimer) { this._holdBuffer.push(data); return; }
    if (this.responseDelayMs > 0 && this._leadTurnPending && this._atReplyBoundary) {
      this._holdBuffer.push(data);
      this._holdTimer = setTimeout(() => this._releaseHold(), this.responseDelayMs);
      return;
    }
    this._atReplyBoundary = false;
    this._leadTurnPending = false;
    this.onAudioReceived(data);
  }

  _releaseHold() {
    this._holdTimer = null;
    this._leadTurnPending = false;
    this._atReplyBoundary = false;
    const chunks = this._holdBuffer;
    this._holdBuffer = [];
    if (!this.onAudioReceived) return;
    for (const c of chunks) this.onAudioReceived(c);
  }

  _dropHold() {
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    this._holdBuffer = [];
  }

  /**
   * Connect to Voice Agent API (Deepgram cloud or local server).
   * @param {string} overrideApiKey - Deepgram API key (ignored for local engine)
   * @param {object} engineConfig - { engine: "deepgram"|"local", localUrl: "ws://..." }
   */
  connect(overrideApiKey, engineConfig) {
    return new Promise((resolve, reject) => {
      const isLocal = engineConfig?.engine === "local";
      const url = isLocal
        ? (engineConfig.localUrl || process.env.LOCAL_VOICE_AGENT_URL || "ws://localhost:8765")
        : (process.env.DEEPGRAM_VOICE_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse");
      const apiKey = overrideApiKey || process.env.DEEPGRAM_API_KEY;

      if (!isLocal && !apiKey) {
        return reject(new Error("No Deepgram API key configured. Set it in Settings or .env"));
      }

      logger.info(`Connecting to ${isLocal ? "Local" : "Deepgram"} Voice Agent at ${url}...`, { callId: this.callId });

      this._settingsResolve = resolve;
      this._settingsReject = reject;

      const maxAttempts = !isLocal && getOutboundProxyUrl() ? 3 : 1;
      let attempt = 0;
      let skipProxy = false;
      let hold402 = false;

      const openSocket = () => {
      attempt += 1;
      const wsOptions = isLocal ? {} : { headers: { authorization: `token ${apiKey}` } };
      if (!isLocal && !skipProxy) {
        const agent = newProxyAgent();
        if (agent) {
          wsOptions.agent = agent;
          const where = proxyDescription();
          logger.info(`Deepgram using a new proxy exit via ${where ? where.host : "proxy"}`, { callId: this.callId });
        }
      } else if (!isLocal && skipProxy) {
        logger.warn("Deepgram proxy is out of bandwidth, connecting directly", { callId: this.callId });
      }
      this.ws = new WebSocket(url, wsOptions);

      this.ws.on("open", () => {
        logger.info("Deepgram WebSocket connected", { callId: this.callId });
        this.isConnected = true;
        this._sendSettings();
        this._startKeepAlive();
        // Do NOT resolve here — wait for SettingsApplied before allowing audio
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) {
          this._aiAudioBytesReceived += data.length;
          this._dispatchAudio(data);
        } else {
          this._handleJsonMessage(JSON.parse(data.toString()));
        }
      });

      this.ws.on("error", (err) => {
        if (!this.isConnected && !skipProxy && /Unexpected server response: 402/.test(err.message || "")) {
          hold402 = true;
          return;
        }
        if (!this.isConnected && attempt < maxAttempts && isTransientProxyError(err)) {
          logger.warn(`Deepgram proxy exit failed (${err.message}), trying another IP`, { callId: this.callId });
          const failed = this.ws;
          failed.removeAllListeners();
          try { failed.terminate(); } catch { /* already closed */ }
          openSocket();
          return;
        }
        logger.error(`Deepgram WebSocket error: ${err.message}`, { callId: this.callId });
        if (this.onError) this.onError(err);
        if (this._settingsReject) {
          this._settingsReject(err);
          this._settingsReject = null;
          this._settingsResolve = null;
        }
      });

      this.ws.on("unexpected-response", (req, res) => {
        const status = res.statusCode;
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (status === 402 && isProxyQuotaBody(body) && !skipProxy) {
            skipProxy = true;
            logger.warn("Webshare proxy refused Deepgram (bandwidth limit). Connecting directly.", { callId: this.callId });
            const failed = this.ws;
            failed.removeAllListeners();
            hold402 = false;
            try { failed.terminate(); } catch { /* already closed */ }
            openSocket();
            return;
          }
          hold402 = false;
          const errMsg = `Deepgram ${status}: ${body || res.statusMessage}`;
          logger.error(errMsg, { callId: this.callId });
          const err = new Error(errMsg);
          err.statusCode = status;
          if (this.onError) this.onError(err);
          if (this._settingsReject) {
            this._settingsReject(err);
            this._settingsReject = null;
            this._settingsResolve = null;
          }
        });
      });

      this.ws.on("close", (code, reason) => {
        if (hold402) return;
        logger.info(`Deepgram WebSocket closed: ${code} ${reason}`, { callId: this.callId });
        this.isConnected = false;
        this._stopKeepAlive();
        // If we never got SettingsApplied, reject the connect promise
        if (this._settingsReject) {
          this._settingsReject(new Error(`Deepgram closed before SettingsApplied (code ${code})`));
          this._settingsReject = null;
          this._settingsResolve = null;
        }
        if (this.onClose) this.onClose(code, reason);
      });
      };
      openSocket();
    });
  }

  /**
   * Send raw PCM audio from the lead to Deepgram for STT.
   */
  sendAudio(audioBuffer) {
    if (this.ws && this.isConnected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioBuffer);
    }
  }

  /**
   * Get total AI speaking duration in seconds (for billing).
   */
  getAiSpeakingDuration() {
    // Primary: calculate from actual audio bytes received (linear16 @ 24kHz = 48000 bytes/sec)
    if (this._aiAudioBytesReceived > 0) {
      return this._aiAudioBytesReceived / 48000;
    }
    // Fallback: event-based tracking
    let total = this._aiTotalSpeakingMs;
    if (this._aiSpeakingStart) {
      total += Date.now() - this._aiSpeakingStart;
    }
    return total / 1000;
  }

  /**
   * Disconnect from Deepgram.
   */
  disconnect() {
    this._dropHold();
    if (this._aiSpeakingStart) {
      this._aiTotalSpeakingMs += Date.now() - this._aiSpeakingStart;
      this._aiSpeakingStart = null;
    }
    this._stopKeepAlive();
    if (this.ws) {
      this.isConnected = false;
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send the Settings message to configure the agent.
   * Uses pre-built settings from ConfigStore (with lead variable interpolation).
   */
  _sendSettings() {
    if (!this.agentSettings) {
      logger.error("No agent settings provided — cannot configure Deepgram", { callId: this.callId });
      return;
    }

    logger.info("Sending agent settings to Deepgram", { callId: this.callId });
    logger.info(`Agent settings JSON: ${JSON.stringify(this.agentSettings)}`, { callId: this.callId });
    this.ws.send(JSON.stringify(this.agentSettings));
  }

  /**
   * Handle JSON events from Deepgram Voice Agent API.
   */
  _handleJsonMessage(msg) {
    const type = msg.type;

    switch (type) {
      case "Welcome":
        logger.info("Deepgram agent welcomed", { callId: this.callId });
        break;

      case "SettingsApplied":
        logger.info("Deepgram agent settings applied", { callId: this.callId });
        // NOW it's safe to send audio — resolve the connect() promise
        if (this._settingsResolve) {
          this._settingsResolve();
          this._settingsResolve = null;
        }
        break;

      case "ConversationText":
        logger.info(`[${msg.role}]: ${msg.content}`, { callId: this.callId });
        if (msg.role === "user") this._leadTurnPending = true;
        if (this.onTranscript) this.onTranscript(msg.role, msg.content);
        break;

      case "UserStartedSpeaking": {
        logger.info("Lead started speaking (barge-in)", { callId: this.callId });
        // Flush whatever is queued for playback first (standard barge-in)...
        if (this.onBargeIn) this.onBargeIn();
        // ...then, if we were holding the start of a reply, let it play instead of
        // silently discarding it. VAD fires on breaths and background noise too;
        // dropping the reply made the agent go mute ("she didn't say anything").
        // If the lead really is talking, Deepgram stops streaming the reply and
        // only the held fragment plays — like a person who starts and yields.
        if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; this._releaseHold(); }
        this._leadTurnPending = true;
        this._atReplyBoundary = true;
        break;
      }

      case "AgentStartedSpeaking":
        logger.info("AI started speaking", { callId: this.callId });
        this._aiSpeakingStart = Date.now();
        break;

      case "AgentAudioDone":
        logger.info("AI finished speaking", { callId: this.callId });
        this._atReplyBoundary = true;
        if (this._aiSpeakingStart) {
          this._aiTotalSpeakingMs += Date.now() - this._aiSpeakingStart;
          this._aiSpeakingStart = null;
        }
        break;

      case "AgentThinking":
        logger.info("AI thinking (LLM processing)...", { callId: this.callId });
        break;

      case "FunctionCallRequest":
        this._handleFunctionCall(msg);
        break;

      case "Error":
        logger.error(`Deepgram agent error: ${JSON.stringify(msg)}`, { callId: this.callId });
        if (this.onError) this.onError(new Error(msg.message || "Deepgram agent error"));
        break;

      default:
        logger.debug(`Deepgram event: ${type}`, { callId: this.callId });
    }
  }

  /**
   * Handle function call requests from the AI (V1 format).
   * V1 sends: { type: "FunctionCallRequest", functions: [{ id, name, arguments, client_side }] }
   */
  _handleFunctionCall(msg) {
    const functions = msg.functions || [];
    for (const fn of functions) {
      const { id, name, arguments: argsStr } = fn;
      let args = {};
      try { args = argsStr ? JSON.parse(argsStr) : {}; } catch (e) { args = {}; }
      logger.info(`Function call: ${name}`, { callId: this.callId, args });

      switch (name) {
        case "transfer_call":
          if (this.onTransferRequest) {
            this.onTransferRequest(args.reason || "Lead requested transfer");
          }
          this._sendFunctionResponse(id, name, "Transferring call now. Please let the customer know.");
          break;

        case "update_lead_info":
          if (this.onUpdateLeadInfo) {
            this.onUpdateLeadInfo(args.first_name || "", args.last_name || "", args.email || "");
          }
          this._sendFunctionResponse(id, name, "Lead info updated. Continue the conversation naturally without mentioning that you saved anything.");
          break;

        case "book_appointment":
          if (this.onBookAppointment) {
            this.onBookAppointment(args.date || "", args.time || "", args.notes || "");
          }
          this._sendFunctionResponse(id, name, "Appointment saved. Now speak a friendly goodbye to the customer confirming the appointment date and time, then the call will end automatically.");
          break;

        case "end_call":
          if (this.onEndCallRequest) {
            this.onEndCallRequest(args.outcome || "completed", args.notes || "", {
              wants: args.wants || "",
              callbackTime: args.callback_time || "",
              emailRequested: args.email_requested === true || args.email_requested === "true",
            });
          }
          this._sendFunctionResponse(id, name, "Call will end in a few seconds. Speak your final goodbye message now.");
          break;

        default:
          logger.warn(`Unknown function call: ${name}`, { callId: this.callId });
          this._sendFunctionResponse(id, name, "Function not implemented.");
      }
    }
  }

  /**
   * Send a function call response back to Deepgram (V1 format).
   * V1 expects: { type: "FunctionCallResponse", id, name, content }
   */
  _sendFunctionResponse(id, name, content) {
    const response = {
      type: "FunctionCallResponse",
      id,
      name,
      content,
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(response));
    }
  }

  /**
   * Keep the WebSocket alive with periodic pings.
   */
  _startKeepAlive() {
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 8000);
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }
}
