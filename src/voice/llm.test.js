import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAssistantOutput, toolInstructions, parseRetryAfterMs, estimateTokens, compactThinkPrompt, toGeminiPayload } from "./llm.js";
import { googleVoiceFor, pcmFromWav } from "./google-voices.js";
import { googleSttLanguage } from "./google-stt.js";
import { skipsDeepgram, VOICE_ENGINES } from "./engines.js";

describe("assembly+google helpers", () => {
  it("maps German agents to Chirp 3 German", () => {
    const v = googleVoiceFor({ agent: { language: "de", speak: { provider: {} } } });
    assert.equal(v.languageCode, "de-DE");
    assert.equal(v.voice, "de-DE-Chirp3-HD-Aoede");
  });

  it("keeps an explicit Google voice name", () => {
    const v = googleVoiceFor({
      agent: { language: "de", speak: { provider: { model: "en-US-Neural2-F" } } },
    });
    assert.equal(v.voice, "en-US-Neural2-F");
  });

  it("parses CALL lines and leaves the spoken sentence", () => {
    const raw = `CALL book_appointment {"date":"2026-10-22","time":"15:00","notes":"callback"}
Sehr gut, ich trage fünfzehn Uhr ein.`;
    const { spoken, calls } = parseAssistantOutput(raw, ["book_appointment", "end_call"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "book_appointment");
    assert.equal(calls[0].args.time, "15:00");
    assert.match(spoken, /fünfzehn|Sehr gut/i);
  });

  it("lists CALL instructions for agent functions", () => {
    const text = toolInstructions([{ name: "end_call", description: "Hang up", parameters: { properties: { outcome: {} } } }]);
    assert.match(text, /CALL end_call/);
  });

  it("strips a WAV header", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40), Buffer.from("DATA")]);
    assert.equal(pcmFromWav(wav).toString(), "DATA");
  });

  it("maps agent language to a Google STT locale", () => {
    assert.equal(googleSttLanguage("de"), "de-DE");
    assert.equal(googleSttLanguage({ agent: { language: "de" } }), "de-DE");
  });

  it("treats google engines as Deepgram-skip", () => {
    assert.equal(skipsDeepgram("google"), true);
    assert.equal(skipsDeepgram("assembly_google"), true);
    assert.equal(skipsDeepgram("deepgram"), false);
    assert.ok(VOICE_ENGINES.includes("google"));
  });

  it("parses Groq retry-after from the error text", () => {
    assert.equal(parseRetryAfterMs("Please try again in 9.702857142s.", null), 9703);
    assert.equal(parseRetryAfterMs("x", "2"), 2000);
  });

  it("estimates tokens from message size", () => {
    const n = estimateTokens([{ role: "system", content: "x".repeat(3500) }]);
    assert.ok(n >= 1000 && n <= 1200);
  });

  it("maps chat messages into Gemini generateContent payload", () => {
    const payload = toGeminiPayload([
      { role: "system", content: "Speak Spanish" },
      { role: "assistant", content: "Hola Jaime?" },
      { role: "user", content: "Dígame." },
    ], 80, 0.2);
    assert.equal(payload.systemInstruction.parts[0].text, "Speak Spanish");
    assert.equal(payload.contents[0].role, "model");
    assert.equal(payload.contents[1].role, "user");
    assert.equal(payload.generationConfig.maxOutputTokens, 80);
  });

  it("compacts a long think prompt under the cap", () => {
    const raw = `${"## Role\nBe Sophie.\n".repeat(80)}[Espera] pad\n## Límites de Sophie Hernandez\nNo inventes.`;
    const compact = compactThinkPrompt(raw, 400);
    assert.ok(compact.length <= 400);
    assert.match(compact, /Role|Sophie/);
    assert.doesNotMatch(compact, /Espera/);
  });
});
