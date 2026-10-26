import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAssemblyKey, transcribeAudio, transcribeUrl } from "./assembly-stt.js";
import { getDeepgramKey, synthesizeSpeech } from "./deepgram-tts.js";
import { getGoogleCredsPath, synthesizeSpeech as googleSpeak } from "./google-tts.js";
import { transcribeAudio as googleTranscribe } from "./google-stt.js";
import { GoogleSttStream } from "./google-stt-stream.js";
import { pcmFromWav } from "./google-voices.js";

const PHRASE = "The weather in Berlin is clear and cold today.";
const SAMPLE_URL = "https://assembly.ai/wildfires.mp3";

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assertOverlap(gotText, wantText, min = 6) {
  const got = normalize(gotText);
  const want = normalize(wantText);
  const overlap = want.split(" ").filter((w) => got.includes(w)).length;
  assert.ok(
    overlap >= min,
    `too little overlap (${overlap}) transcript: ${gotText}`
  );
}

describe("AssemblyAI STT + Deepgram TTS", () => {
  it("has an AssemblyAI key in the environment", () => {
    assert.ok(getAssemblyKey(), "ASSEMBLYAI_API_KEY is missing");
  });

  it("has a Deepgram key in the environment", () => {
    assert.ok(getDeepgramKey(), "DEEPGRAM_API_KEY is missing");
  });

  it("AssemblyAI transcribes a public English sample", async () => {
    const result = await transcribeUrl(SAMPLE_URL, { languageCode: "en" });
    const got = normalize(result.text);
    assert.ok(got.length > 20, `transcript too short: ${result.text}`);
    assert.ok(got.includes("wildfire") || got.includes("california") || got.includes("smoke"), `unexpected transcript: ${result.text}`);
  });

  it("Deepgram TTS returns a WAV larger than a header", async () => {
    const { audio, model } = await synthesizeSpeech(PHRASE);
    assert.equal(model, "aura-2-thalia-en");
    assert.ok(audio.length > 1000, `audio too small: ${audio.length}`);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  });

  it("AssemblyAI transcribes Deepgram speech back to the same sentence", async () => {
    const { audio } = await synthesizeSpeech(PHRASE);
    const result = await transcribeAudio(audio, { languageCode: "en" });
    assertOverlap(result.text, PHRASE);
  });
});

describe("AssemblyAI STT + Google Cloud TTS", () => {
  it("has a Google service-account path in the environment", () => {
    assert.ok(getGoogleCredsPath(), "GOOGLE_APPLICATION_CREDENTIALS is missing");
  });

  it("Google Neural2 TTS returns a WAV", async () => {
    const { audio, voice } = await googleSpeak(PHRASE, {
      languageCode: "en-US",
      voice: "en-US-Neural2-F",
    });
    assert.equal(voice, "en-US-Neural2-F");
    assert.ok(audio.length > 1000, `audio too small: ${audio.length}`);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  });

  it("Google Chirp 3 HD TTS returns a WAV", async () => {
    const { audio, voice } = await googleSpeak(PHRASE, {
      languageCode: "en-US",
      voice: "en-US-Chirp3-HD-Aoede",
    });
    assert.equal(voice, "en-US-Chirp3-HD-Aoede");
    assert.ok(audio.length > 1000, `audio too small: ${audio.length}`);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  });

  it("AssemblyAI transcribes Google speech back to the same sentence", async () => {
    const { audio } = await googleSpeak(PHRASE, {
      languageCode: "en-US",
      voice: "en-US-Neural2-F",
    });
    const result = await transcribeAudio(audio, { languageCode: "en" });
    assert.equal(normalize(result.text), normalize(PHRASE));
  });
});

describe("Google Cloud STT + Google Cloud TTS", () => {
  it("Google STT transcribes Google English TTS", async () => {
    const { audio } = await googleSpeak(PHRASE, {
      languageCode: "en-US",
      voice: "en-US-Neural2-F",
    });
    const result = await googleTranscribe(audio, { languageCode: "en-US" });
    assertOverlap(result.text, PHRASE);
  });

  it("Google telephony STT transcribes German TTS", async () => {
    const phrase = "Guten Tag, hier ist Anna von der Inkassostelle.";
    const { audio } = await googleSpeak(phrase, {
      languageCode: "de-DE",
      voice: "de-DE-Neural2-A",
    });
    const result = await googleTranscribe(audio, { languageCode: "de-DE", model: "telephony" });
    assertOverlap(result.text, phrase, 4);
  });

  it("Google streaming STT hears a short English utterance", async () => {
    const { audio } = await googleSpeak(PHRASE, {
      languageCode: "en-US",
      voice: "en-US-Neural2-F",
    });
    const pcm = pcmFromWav(audio);
    const finals = [];
    const stream = new GoogleSttStream("stream-test", {
      languageCode: "en-US",
      onTurn: (ev) => {
        if (ev.end_of_turn && ev.transcript) finals.push(ev.transcript);
      },
    });
    await stream.connect();
    const frame = 640;
    for (let i = 0; i < pcm.length; i += frame) {
      stream.sendAudio(pcm.subarray(i, i + frame));
      await new Promise((r) => setTimeout(r, 20));
    }
    const silence = Buffer.alloc(16000 * 2 * 2);
    for (let i = 0; i < silence.length; i += frame) {
      stream.sendAudio(silence.subarray(i, Math.min(i + frame, silence.length)));
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 1500));
    stream.close();
    assertOverlap(finals.join(" "), PHRASE);
  });
});
