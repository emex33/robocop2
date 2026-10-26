/**
 * Multi-turn phone-call rehearsal: Google Cloud TTS speaks, AssemblyAI listens.
 * Does not place a SIP INVITE.
 */

import { transcribeAudio } from "./assembly-stt.js";
import { synthesizeSpeech } from "./google-tts.js";

export function normalizeHeard(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function heardContains(heard, expected) {
  const got = normalizeHeard(heard);
  return expected.every((word) => {
    const options = Array.isArray(word) ? word : [word];
    return options.some((opt) => got.includes(normalizeHeard(opt)));
  });
}

export async function runRehearsalCall(script) {
  const events = [];
  const started = Date.now();
  let ok = true;

  const log = (type, data) => {
    events.push({ t: Date.now() - started, type, ...data });
  };

  log("call_init", { id: script.id, language: script.language });

  for (const [i, turn] of script.turns.entries()) {
    const voice = turn.speaker === "agent" ? script.agentVoice : script.leadVoice;
    const { audio } = await synthesizeSpeech(turn.text, {
      languageCode: script.language,
      voice,
    });
    log("tts", {
      turn: i + 1,
      speaker: turn.speaker,
      voice,
      bytes: audio.length,
    });

    if (turn.speaker !== "lead") continue;

    const result = await transcribeAudio(audio, {
      languageCode: script.sttLanguage || script.language.slice(0, 2),
    });
    const match = !turn.expect || heardContains(result.text, turn.expect);
    if (!match) ok = false;
    log("stt", {
      turn: i + 1,
      heard: result.text,
      expect: turn.expect || [],
      match,
      confidence: result.confidence,
    });
  }

  log("call_end", { ok, ms: Date.now() - started });
  return { id: script.id, ok, events };
}
