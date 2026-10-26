const VOICES = {
  en: { languageCode: "en-US", voice: "en-US-Chirp3-HD-Aoede" },
  de: { languageCode: "de-DE", voice: "de-DE-Chirp3-HD-Aoede" },
  es: { languageCode: "es-US", voice: "es-US-Chirp3-HD-Aoede" },
  fr: { languageCode: "fr-FR", voice: "fr-FR-Chirp3-HD-Aoede" },
  it: { languageCode: "it-IT", voice: "it-IT-Chirp3-HD-Aoede" },
  nl: { languageCode: "nl-NL", voice: "nl-NL-Chirp3-HD-Aoede" },
};

export function googleVoiceFor(agentSettings) {
  const speak = agentSettings?.agent?.speak?.provider || {};
  const model = String(speak.model || speak.model_id || "").trim();
  if (/^[a-z]{2}-[A-Z]{2}-/.test(model)) {
    return { languageCode: model.slice(0, 5), voice: model };
  }
  const lang = String(agentSettings?.agent?.language || "en").slice(0, 2);
  return VOICES[lang] || VOICES.en;
}

export function pcmFromWav(buf) {
  if (!buf?.length) return Buffer.alloc(0);
  if (buf.toString("ascii", 0, 4) === "RIFF") return buf.subarray(44);
  return buf;
}
