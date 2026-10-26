/**
 * Deepgram Aura-2 text-to-speech (REST).
 * Returns a WAV buffer (linear16).
 */

const SPEAK_URL = "https://api.deepgram.com/v1/speak";

export function getDeepgramKey() {
  return (process.env.DEEPGRAM_API_KEY || "").trim();
}

export async function synthesizeSpeech(text, {
  apiKey = getDeepgramKey(),
  model = "aura-2-thalia-en",
  encoding = "linear16",
  container = "wav",
  sampleRate = 16000,
} = {}) {
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not set");
  if (!text?.trim()) throw new Error("text is required");

  const url = `${SPEAK_URL}?model=${encodeURIComponent(model)}&encoding=${encoding}&container=${container}&sample_rate=${sampleRate}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Deepgram TTS ${res.status}: ${body.slice(0, 200)}`);
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 100) throw new Error("Deepgram TTS returned empty audio");
  return { audio, model, encoding, container, sampleRate };
}
