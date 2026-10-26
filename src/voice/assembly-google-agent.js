import logger from "../utils/logger.js";
import { AssemblyStream } from "./assembly-stream.js";
import { chatComplete, parseAssistantOutput, toolInstructions } from "./llm.js";
import { synthesizeSpeech } from "./google-tts.js";
import { googleVoiceFor, pcmFromWav } from "./google-voices.js";

/**
 * Campaign voice path: Assembly streaming STT → LLM Gateway → Google Cloud TTS.
 * Same callbacks as DeepgramAgent so CallManager can swap engines.
 */
export class AssemblyGoogleAgent {
  constructor(callId, options = {}) {
    this.callId = callId;
    this.agentSettings = options.agentSettings || {};
    this.responseDelayMs = Math.max(0, Math.min(3000, Number(options.responseDelayMs) || 0));
    this.onAudioReceived = options.onAudioReceived || null;
    this.onBargeIn = options.onBargeIn || null;
    this.onTransferRequest = options.onTransferRequest || null;
    this.onBookAppointment = options.onBookAppointment || null;
    this.onUpdateLeadInfo = options.onUpdateLeadInfo || null;
    this.onEndCallRequest = options.onEndCallRequest || null;
    this.onTranscript = options.onTranscript || null;
    this.onError = options.onError || null;
    this.onClose = options.onClose || null;

    this.StreamClass = options.StreamClass || AssemblyStream;
    this.stream = null;
    this.closed = false;
    this.speaking = false;
    this.thinkAbort = null;
    this.history = [];
    this._aiAudioBytesReceived = 0;
    this.voice = googleVoiceFor(this.agentSettings);
    this.functions = this.agentSettings?.agent?.think?.functions || [];
    this.systemPrompt = `${this.agentSettings?.agent?.think?.prompt || ""}${toolInstructions(this.functions)}`;
  }

  async connect() {
    this.stream = new this.StreamClass(this.callId, {
      languageCode: this.voice.languageCode,
      onTurn: (ev) => this._onTurn(ev),
      onError: (err) => { if (this.onError) this.onError(err); },
      onClose: (code, reason) => { if (this.onClose) this.onClose(code, reason); },
    });
    await this.stream.connect();
    const greeting = this.agentSettings?.agent?.greeting;
    if (greeting) {
      this.history.push({ role: "assistant", content: greeting });
      // After connect() returns, CallManager wires RTP → sendAudio.
      // Speak on the next turn so barge-in can hear the lead over the greeting.
      setImmediate(() => {
        if (this.closed) return;
        this._emitTranscript("assistant", greeting);
        this._speak(greeting);
      });
    }
  }

  sendAudio(pcm) {
    if (this.stream) this.stream.sendAudio(pcm);
  }

  getAiSpeakingDuration() {
    return this._aiAudioBytesReceived / 32000;
  }

  disconnect() {
    this.closed = true;
    if (this.thinkAbort) {
      try { this.thinkAbort.abort(); } catch { /* ignore */ }
      this.thinkAbort = null;
    }
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  _emitTranscript(role, text) {
    if (!text) return;
    logger.info(`[${role}]: ${text}`, { callId: this.callId });
    if (this.onTranscript) this.onTranscript(role, text);
  }

  _onTurn(ev) {
    const text = String(ev.transcript || "").trim();
    if (!text) return;

    if (this.speaking && !ev.end_of_turn) {
      this._barge();
      return;
    }
    if (!ev.end_of_turn) return;
    this._handleUser(text);
  }

  _barge() {
    this.speaking = false;
    if (this.thinkAbort) {
      try { this.thinkAbort.abort(); } catch { /* ignore */ }
      this.thinkAbort = null;
    }
    if (this.onBargeIn) this.onBargeIn();
  }

  async _handleUser(text) {
    if (this.closed) return;
    this._emitTranscript("user", text);
    this.history.push({ role: "user", content: text });
    if (this.history.length > 24) this.history = this.history.slice(-24);

    if (this.responseDelayMs) {
      await new Promise((r) => setTimeout(r, this.responseDelayMs));
    }
    if (this.closed) return;

    try {
      if (this.thinkAbort) {
        try { this.thinkAbort.abort(); } catch { /* ignore */ }
      }
      this.thinkAbort = new AbortController();
      const { text: raw } = await chatComplete({
        messages: [{ role: "system", content: this.systemPrompt }, ...this.history],
        signal: this.thinkAbort.signal,
      });
      this.thinkAbort = null;
      if (this.closed) return;

      const allowed = this.functions.map((f) => f.name);
      const { spoken, calls } = parseAssistantOutput(raw, allowed);
      for (const call of calls) await this._runTool(call.name, call.args);
      if (spoken) {
        this.history.push({ role: "assistant", content: spoken });
        this._emitTranscript("assistant", spoken);
        await this._speak(spoken);
      } else {
        logger.warn(`Think returned no speech (${String(raw || "").length} chars)`, { callId: this.callId });
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      logger.error(`Think/TTS failed: ${err.message}`, { callId: this.callId });
      if (/tokens per day|\bTPD\b|LLM 429/i.test(err.message || "")) return;
      if (this.onError) this.onError(err);
    }
  }

  async _runTool(name, args = {}) {
    logger.info(`Function call: ${name}`, { callId: this.callId, args });
    switch (name) {
      case "transfer_call":
        if (this.onTransferRequest) this.onTransferRequest(args.reason || "Lead requested transfer");
        break;
      case "update_lead_info":
        if (this.onUpdateLeadInfo) {
          this.onUpdateLeadInfo(args.first_name || "", args.last_name || "", args.email || "");
        }
        break;
      case "book_appointment":
        if (this.onBookAppointment) {
          this.onBookAppointment(args.date || "", args.time || "", args.notes || "");
        }
        break;
      case "end_call":
        if (this.onEndCallRequest) {
          this.onEndCallRequest(args.outcome || "completed", args.notes || "", {
            wants: args.wants || "",
            callbackTime: args.callback_time || "",
            emailRequested: args.email_requested === true || args.email_requested === "true",
          });
        }
        break;
      default:
        logger.warn(`Unknown function call: ${name}`, { callId: this.callId });
    }
  }

  async _speak(text) {
    if (this.closed || !text) return;
    this.speaking = true;
    try {
      const { audio } = await synthesizeSpeech(text, this.voice);
      if (this.closed || !this.speaking) return;
      const pcm = pcmFromWav(audio);
      this._aiAudioBytesReceived += pcm.length;
      if (this.onAudioReceived) this.onAudioReceived(pcm, 16000);
    } finally {
      this.speaking = false;
    }
  }
}
