import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRehearsalCall } from "./call-rehearsal.js";

const EN_CALL = {
  id: "en-recovery-1",
  language: "en-US",
  sttLanguage: "en",
  agentVoice: "en-US-Chirp3-HD-Aoede",
  leadVoice: "en-US-Chirp3-HD-Charon",
  turns: [
    { speaker: "agent", text: "Hello, this is Anna from the recovery office. Am I speaking with Thomas?" },
    { speaker: "lead", text: "Yes, this is Thomas speaking.", expect: ["thomas"] },
    { speaker: "agent", text: "We are calling about your outstanding account. Can we book a callback today at three?" },
    { speaker: "lead", text: "Yes, please call me back at three o'clock.", expect: [["three", "3"]] },
    { speaker: "agent", text: "Perfect. I will book three o'clock today. Thank you, Thomas." },
  ],
};

const DE_CALL = {
  id: "de-recovery-1",
  language: "de-DE",
  sttLanguage: "de",
  agentVoice: "de-DE-Chirp3-HD-Aoede",
  leadVoice: "de-DE-Chirp3-HD-Charon",
  turns: [
    { speaker: "agent", text: "Guten Tag, hier ist Anna von der Inkassostelle. Spreche ich mit Thomas?" },
    { speaker: "lead", text: "Ja, hier ist Thomas.", expect: ["thomas"] },
    { speaker: "agent", text: "Es geht um Ihr offenes Konto. Können wir heute um fünfzehn Uhr zurückrufen?" },
    { speaker: "lead", text: "Ja, rufen Sie mich bitte um fünfzehn Uhr zurück.", expect: [["fünfzehn", "15", "fuenfzehn"], "uhr"] },
    { speaker: "agent", text: "Sehr gut. Ich trage fünfzehn Uhr ein. Vielen Dank, Thomas." },
  ],
};

describe("rehearsal calls (Google TTS + AssemblyAI STT)", () => {
  it("English recovery call: Assembly hears the lead on every turn", async () => {
    const result = await runRehearsalCall(EN_CALL);
    const stt = result.events.filter((e) => e.type === "stt");
    for (const ev of stt) {
      console.log(`[${result.id}] lead: ${ev.heard} (match=${ev.match})`);
    }
    assert.equal(result.ok, true, JSON.stringify(stt.map((e) => e.heard)));
    assert.equal(stt.length, 2);
  });

  it("German recovery call: Assembly hears the lead on every turn", async () => {
    const result = await runRehearsalCall(DE_CALL);
    const stt = result.events.filter((e) => e.type === "stt");
    for (const ev of stt) {
      console.log(`[${result.id}] lead: ${ev.heard} (match=${ev.match})`);
    }
    assert.equal(result.ok, true, JSON.stringify(stt.map((e) => e.heard)));
    assert.equal(stt.length, 2);
  });
});
