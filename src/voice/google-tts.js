/**
 * Google Cloud Text-to-Speech (REST v1 via googleapis).
 * Auth: service account at GOOGLE_APPLICATION_CREDENTIALS.
 * LINEAR16 includes a WAV header.
 */

import { google } from "googleapis";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export function getGoogleCredsPath() {
  return (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
}

export function createTtsClient() {
  const keyFile = getGoogleCredsPath();
  if (!keyFile) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not set");
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: [SCOPE],
  });
  return google.texttospeech({ version: "v1", auth });
}

export async function listVoices({ languageCode } = {}) {
  const tts = createTtsClient();
  const { data } = await tts.voices.list({ languageCode });
  return data.voices || [];
}

export async function synthesizeSpeech(text, {
  languageCode = "en-US",
  voice = "en-US-Neural2-F",
  audioEncoding = "LINEAR16",
  sampleRateHertz = 16000,
} = {}) {
  if (!text?.trim()) throw new Error("text is required");
  const tts = createTtsClient();
  const { data } = await tts.text.synthesize({
    requestBody: {
      input: { text },
      voice: { languageCode, name: voice },
      audioConfig: { audioEncoding, sampleRateHertz },
    },
  });
  if (!data.audioContent) throw new Error("Google TTS returned empty audio");
  const audio = Buffer.from(data.audioContent, "base64");
  if (audio.length < 100) throw new Error("Google TTS audio too small");
  return { audio, voice, languageCode, audioEncoding, sampleRateHertz };
}
