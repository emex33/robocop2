import WebSocket from "ws";
import logger from "../utils/logger.js";

const STREAM_URL = "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-3-6-pro&mode=balanced";

export class AssemblyStream {
  constructor(callId, { apiKey, onTurn, onBegin, onError, onClose } = {}) {
    this.callId = callId;
    this.apiKey = apiKey || process.env.ASSEMBLYAI_API_KEY;
    this.onTurn = onTurn;
    this.onBegin = onBegin;
    this.onError = onError;
    this.onClose = onClose;
    this.ws = null;
    this.ready = false;
  }

  connect() {
    if (!this.apiKey) return Promise.reject(new Error("ASSEMBLYAI_API_KEY is not set"));
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(STREAM_URL, { headers: { Authorization: this.apiKey } });
      const timer = setTimeout(() => {
        reject(new Error("Assembly streaming connect timeout"));
        try { this.ws.close(); } catch { /* ignore */ }
      }, 15000);

      this.ws.on("open", () => {
        logger.info("Assembly streaming socket open", { callId: this.callId });
      });

      this.ws.on("message", (raw) => {
        let ev;
        try { ev = JSON.parse(raw.toString()); } catch { return; }
        if (ev.type === "Begin") {
          this.ready = true;
          clearTimeout(timer);
          if (this.onBegin) this.onBegin(ev);
          resolve();
        } else if (ev.type === "Turn" && this.onTurn) {
          this.onTurn(ev);
        } else if (ev.type === "Error") {
          const err = new Error(ev.error || ev.message || "Assembly streaming error");
          if (this.onError) this.onError(err);
        }
      });

      this.ws.on("error", (err) => {
        logger.error(`Assembly streaming error: ${err.message}`, { callId: this.callId });
        if (!this.ready) {
          clearTimeout(timer);
          reject(err);
        } else if (this.onError) this.onError(err);
      });

      this.ws.on("close", (code, reason) => {
        this.ready = false;
        if (this.onClose) this.onClose(code, String(reason || ""));
      });
    });
  }

  sendAudio(pcm) {
    if (this.ws && this.ready && this.ws.readyState === WebSocket.OPEN && pcm?.length) {
      this.ws.send(pcm);
    }
  }

  close() {
    this.ready = false;
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "Terminate" }));
      }
      this.ws.close();
    } catch { /* ignore */ }
    this.ws = null;
  }
}
