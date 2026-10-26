import { SpeechClient } from "@google-cloud/speech";
import logger from "../utils/logger.js";
import { getGoogleCredsPath } from "./google-tts.js";
import { downsample16to8, googleSttLanguage } from "./google-stt.js";

const STREAM_REFRESH_MS = 4.5 * 60 * 1000;
const WRITE_MAX = 24 * 1024;
const FINAL_STABLE_MS = 1600;
const SPEECH_RMS = 350;

let sharedClient = null;

function getClient() {
  const keyFile = getGoogleCredsPath();
  if (!keyFile) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set");
  if (!sharedClient) {
    sharedClient = new SpeechClient({ keyFilename: keyFile });
  }
  return sharedClient;
}

/**
 * Live STT: Google streamingRecognize.
 * Default quota is 300 concurrent sessions (vs Assembly streaming ~5).
 * Streams are refreshed before Google's 5-minute cap.
 */
export class GoogleSttStream {
  constructor(callId, { languageCode, onTurn, onError, onClose } = {}) {
    this.callId = callId;
    this.languageCode = googleSttLanguage(languageCode || "en-US");
    this.onTurn = onTurn;
    this.onError = onError;
    this.onClose = onClose;
    this.stream = null;
    this.ready = false;
    this.closed = false;
    this.pending16 = Buffer.alloc(0);
    this.refreshTimer = null;
    this.mode = "latest_long";
    this.generation = 0;
    this.partial = "";
    this.partialTimer = null;
    this.lastFinal = "";
    this.lastSpeechAt = 0;
  }

  async connect() {
    getClient();
    this._openStream();
  }

  sendAudio(pcm16) {
    if (this.closed || !pcm16?.length) return;
    if (pcmHasSpeech(pcm16)) this.lastSpeechAt = Date.now();
    this.pending16 = Buffer.concat([this.pending16, pcm16]);
    this._flush();
  }

  close() {
    this.closed = true;
    this.ready = false;
    this._clearPartialTimer();
    if (this.partial) this._emitFinal(this.partial);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    try { stream.end(); } catch { /* ignore */ }
    try { stream.destroy(); } catch { /* ignore */ }
  }

  _openStream() {
    if (this.closed) return;
    const prev = this.stream;
    this.stream = null;
    this.ready = false;
    const gen = ++this.generation;
    const telephony = this.mode === "telephony";
    const recognizeStream = getClient().streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: telephony ? 8000 : 16000,
        languageCode: this.languageCode,
        model: telephony ? "telephony" : "latest_long",
        enableAutomaticPunctuation: true,
      },
      interimResults: true,
      singleUtterance: false,
    });

    recognizeStream.on("data", (data) => {
      if (this.closed || gen !== this.generation) return;
      const result = data.results?.[0];
      const transcript = String(result?.alternatives?.[0]?.transcript || "").trim();
      if (!transcript) return;
      this._onTranscript(transcript, !!result.isFinal);
    });

    recognizeStream.on("error", (err) => {
      if (this.closed || gen !== this.generation) return;
      const msg = String(err.message || err);
      logger.error(`Google STT stream error: ${msg}`, { callId: this.callId, mode: this.mode });
      if (this.mode === "telephony" && /model|INVALID_ARGUMENT|not supported/i.test(msg)) {
        this.mode = "latest_long";
        this._openStream();
        return;
      }
      if (/exceeded|maximum allowed stream duration|audio timeout/i.test(msg)) {
        this._openStream();
        return;
      }
      this.ready = false;
      if (this.onError) this.onError(err);
    });

    recognizeStream.on("close", () => {
      if (this.closed || gen !== this.generation) return;
      this.ready = false;
      if (this.onClose) this.onClose(1000, "google-stt-closed");
    });

    this.stream = recognizeStream;
    this.ready = true;
    if (prev) {
      try { prev.end(); } catch { /* ignore */ }
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this._openStream(), STREAM_REFRESH_MS);
    logger.info(`Google STT stream open (${this.mode} ${this.languageCode})`, { callId: this.callId });
    this._flush();
  }

  _onTranscript(transcript, isFinal) {
    if (isFinal) {
      this._clearPartialTimer();
      this._emitFinal(transcript);
      return;
    }
    this.partial = transcript;
    if (this.onTurn) this.onTurn({ transcript, end_of_turn: false });
    this._armFinalTimer();
  }

  _armFinalTimer() {
    this._clearPartialTimer();
    this.partialTimer = setTimeout(() => {
      if (!this.partial) return;
      if (Date.now() - this.lastSpeechAt < FINAL_STABLE_MS) {
        this._armFinalTimer();
        return;
      }
      this._emitFinal(this.partial);
    }, FINAL_STABLE_MS);
  }

  _emitFinal(text) {
    const t = String(text || "").trim();
    if (!t) return;
    const prev = this.lastFinal.toLowerCase();
    const next = t.toLowerCase();
    if (prev && prev === next) return;
    this.lastFinal = t;
    this.partial = "";
    if (this.onTurn) this.onTurn({ transcript: t, end_of_turn: true });
  }

  _clearPartialTimer() {
    if (!this.partialTimer) return;
    clearTimeout(this.partialTimer);
    this.partialTimer = null;
  }

  _flush() {
    if (!this.ready || !this.stream || this.closed) return;
    const align = this.mode === "telephony" ? 4 : 2;
    const aligned = this.pending16.length - (this.pending16.length % align);
    if (aligned < align) return;
    let chunk = this.pending16.subarray(0, aligned);
    this.pending16 = this.pending16.subarray(aligned);
    if (this.mode === "telephony") chunk = downsample16to8(chunk);
    try {
      for (let i = 0; i < chunk.length; i += WRITE_MAX) {
        if (!this.stream.writable) break;
        this.stream.write(chunk.subarray(i, i + WRITE_MAX));
      }
    } catch (err) {
      logger.error(`Google STT write failed: ${err.message}`, { callId: this.callId });
    }
  }
}

function pcmHasSpeech(pcm16) {
  const n = Math.floor(pcm16.length / 2);
  if (n < 8) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n) > SPEECH_RMS;
}
