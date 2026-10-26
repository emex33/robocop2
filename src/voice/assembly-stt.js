/**
 * AssemblyAI pre-recorded speech-to-text.
 * Upload a local buffer, then poll the transcript.
 */

const BASE = "https://api.assemblyai.com";

export function getAssemblyKey() {
  return (process.env.ASSEMBLYAI_API_KEY || "").trim();
}

export async function uploadAudio(audio, { apiKey = getAssemblyKey() } = {}) {
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not set");
  if (!audio?.length) throw new Error("audio is required");

  const res = await fetch(`${BASE}/v2/upload`, {
    method: "POST",
    headers: { authorization: apiKey },
    body: audio,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.upload_url) {
    throw new Error(`AssemblyAI upload ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
  }
  return data.upload_url;
}

export async function transcribeUrl(audioUrl, {
  apiKey = getAssemblyKey(),
  languageCode = "en",
  pollMs = 2000,
  timeoutMs = 90000,
} = {}) {
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not set");

  const created = await fetch(`${BASE}/v2/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, language_code: languageCode }),
    signal: AbortSignal.timeout(20000),
  });
  const job = await created.json().catch(() => ({}));
  if (!created.ok || !job.id) {
    throw new Error(`AssemblyAI transcript ${created.status}: ${job.error || JSON.stringify(job).slice(0, 200)}`);
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const poll = await fetch(`${BASE}/v2/transcript/${job.id}`, {
      headers: { authorization: apiKey },
      signal: AbortSignal.timeout(15000),
    });
    const result = await poll.json().catch(() => ({}));
    if (result.status === "completed") {
      return { id: job.id, text: result.text || "", confidence: result.confidence ?? null };
    }
    if (result.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${result.error || "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("AssemblyAI transcription timed out");
}

export async function transcribeAudio(audio, opts = {}) {
  const uploadUrl = await uploadAudio(audio, opts);
  return transcribeUrl(uploadUrl, opts);
}
