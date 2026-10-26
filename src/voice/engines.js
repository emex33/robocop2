export const VOICE_ENGINES = ["deepgram", "local", "assembly_google", "google"];

export function skipsDeepgram(engine = "") {
  return engine === "assembly_google" || engine === "google";
}

export function voiceEngineLabel(engine = "") {
  if (engine === "google") return "Google Cloud STT + Google Cloud TTS";
  if (engine === "assembly_google") return "AssemblyAI STT + Google Cloud TTS";
  if (engine === "local") return "Local voice agent";
  return "Deepgram Voice Agent";
}

export function agentClassName(engine = "") {
  if (engine === "google") return "google";
  if (engine === "assembly_google") return "assembly_google";
  return "deepgram";
}
