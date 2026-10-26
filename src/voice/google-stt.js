/**
 * Google Cloud Speech-to-Text (REST v1 via googleapis).
 * Live calls use google-stt-stream.js (gRPC streaming, ~300 concurrent sessions).
 */

import { google } from "googleapis";
import { getGoogleCredsPath } from "./google-tts.js";
import { pcmFromWav } from "./google-voices.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const LANG = {
  en: "en-US",
  de: "de-DE",
  es: "es-US",
  fr: "fr-FR",
  it: "it-IT",
  nl: "nl-NL",
};

export function googleSttLanguage(codeOrSettings) {
  if (codeOrSettings && typeof codeOrSettings === "object") {
    const speak = codeOrSettings?.agent?.speak?.provider || {};
    const model = String(speak.model || speak.model_id || "").trim();
    if (/^[a-z]{2}-[A-Z]{2}-/.test(model)) return model.slice(0, 5);
    codeOrSettings = codeOrSettings?.agent?.language || "en";
  }
  const raw = String(codeOrSettings || "en").trim();
  if (/^[a-z]{2}-[A-Z]{2}$/.test(raw)) return raw;
  return LANG[raw.slice(0, 2).toLowerCase()] || LANG.en;
}

export function downsample16to8(pcmBuf) {
  if (!pcmBuf?.length) return Buffer.alloc(0);
  const numOutputSamples = Math.floor(pcmBuf.length / 4);
  const out = Buffer.alloc(numOutputSamples * 2);
  for (let i = 0, j = 0; i < numOutputSamples; i++, j += 4) {
    const s1 = pcmBuf.readInt16LE(j);
    const s2 = j + 2 < pcmBuf.length ? pcmBuf.readInt16LE(j + 2) : s1;
    let avg = Math.round((s1 + s2) / 2);
    if (avg > 32767) avg = 32767;
    if (avg < -32768) avg = -32768;
    out.writeInt16LE(avg, i * 2);
  }
  return out;
}

export function wavSampleRate(buf) {
  if (buf?.length >= 28 && buf.toString("ascii", 0, 4) === "RIFF") {
    return buf.readUInt32LE(24);
  }
  return 0;
}

function createSpeechRest() {
  const keyFile = getGoogleCredsPath();
  if (!keyFile) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set");
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: [SCOPE] });
  return google.speech({ version: "v1", auth });
}

export async function transcribeAudio(audio, {
  languageCode = "en-US",
  sampleRateHertz,
  model,
} = {}) {
  if (!audio?.length) throw new Error("audio is required");
  const rateFromWav = wavSampleRate(audio);
  const pcm = pcmFromWav(audio);
  let rate = sampleRateHertz || rateFromWav || 16000;
  let payload = pcm;
  let chosen = model;
  if (!chosen) chosen = rate === 8000 ? "telephony" : "latest_long";
  if (chosen === "telephony" && rate === 16000) {
    payload = downsample16to8(pcm);
    rate = 8000;
  }
  const speech = createSpeechRest();
  const { data } = await speech.speech.recognize({
    requestBody: {
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: rate,
        languageCode,
        model: chosen,
        enableAutomaticPunctuation: true,
      },
      audio: { content: payload.toString("base64") },
    },
  });
  const text = (data.results || [])
    .map((r) => r.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim();
  return {
    text,
    confidence: data.results?.[0]?.alternatives?.[0]?.confidence ?? null,
    model: chosen,
    languageCode,
  };
}
