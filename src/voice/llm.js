/**
 * Think step for Google / Assembly+Google calls.
 * Prefers Gemini when GEMINI_API_KEY is set, then Groq, then AssemblyAI.
 * Actions are emitted as CALL lines and parsed here.
 */

import logger from "../utils/logger.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const ASSEMBLY_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions";
const ASSEMBLY_MODEL = process.env.ASSEMBLY_LLM_MODEL || "qwen3.5-4b-32k-fast";
const GROQ_ITPM = Math.max(1000, Number(process.env.GROQ_ITPM || 6500));
const GROQ_WINDOW_MS = 60_000;
const GROQ_PROMPT_CHARS = Math.max(400, Number(process.env.GROQ_PROMPT_CHARS || 1400));

export function getGeminiKey() {
  return (process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || "").trim();
}

export function getGroqKey() {
  return (process.env.GROQ_API_KEY || "").trim();
}

export function hasThinkKey() {
  return Boolean(getGeminiKey() || getGroqKey() || process.env.ASSEMBLYAI_API_KEY);
}

export function getLlmModel() {
  if (getGeminiKey()) return GEMINI_MODEL;
  if (getGroqKey()) return GROQ_MODEL;
  return ASSEMBLY_MODEL;
}

export function toolInstructions(functions = []) {
  if (!functions.length) return "";
  const lines = functions.map((fn) => {
    const keys = Object.keys(fn.parameters?.properties || {});
    const hint = keys.length ? ` {${keys.map((k) => `"${k}":"..."`).join(",")}}` : " {}";
    return `- CALL ${fn.name}${hint}  — ${fn.description || fn.name}`;
  });
  return `

[ACTIONS]
When you must take an action, write one line that starts with CALL, then a JSON object, then speak 1-2 short sentences to the customer. Never say the word CALL out loud. Only emit CALL when you actually need the action.
${lines.join("\n")}
`;
}

export function parseAssistantOutput(text, allowedNames = []) {
  const allow = new Set(allowedNames);
  const calls = [];
  const spoken = String(text || "")
    .replace(/^CALL\s+([A-Za-z0-9_]+)\s+(\{[\s\S]*?\})(?:\s|$)/gm, (_, name, json) => {
      if (allow.size && !allow.has(name)) return "";
      try {
        calls.push({ name, args: JSON.parse(json) });
      } catch { /* ignore bad json */ }
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { spoken, calls };
}

export function compactThinkPrompt(prompt, maxChars = GROQ_PROMPT_CHARS) {
  let text = String(prompt || "")
    .replace(/\[[^\]]*(Espera|Wait|Warten)[^\]]*\]/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 16;
  return `${text.slice(0, head).trim()}\n…\n${text.slice(-tail).trim()}`;
}

export function estimateTokens(messages = []) {
  let chars = 0;
  for (const m of messages) chars += String(m?.content || "").length;
  return Math.ceil(chars / 3.5) + 24;
}

export function parseRetryAfterMs(message, retryAfterHeader) {
  const header = Number(retryAfterHeader);
  if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1000);
  const m = String(message || "").match(/try again in ([0-9.]+)\s*s/i);
  if (m) return Math.ceil(Number(m[1]) * 1000);
  return 8000;
}

export function toGeminiPayload(messages = [], maxTokens = 180, temperature = 0.3) {
  let system = "";
  const contents = [];
  for (const m of messages) {
    if (m?.role === "system") {
      system += (system ? "\n" : "") + String(m.content || "");
      continue;
    }
    contents.push({
      role: m?.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m?.content || "") }],
    });
  }
  const payload = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };
  return payload;
}

function errorText(data) {
  return data.error?.message || data.message || data.error || "gateway error";
}

function abortError() {
  return Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function compactMessages(messages = []) {
  return messages.map((m) => {
    if (m?.role !== "system") return m;
    return { ...m, content: compactThinkPrompt(m.content) };
  });
}

function pickContent(msg = {}) {
  return String(msg.content || msg.reasoning || "").trim();
}

function pickGeminiText(data = {}) {
  return (data.candidates || [])
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
}

class GroqTokenGate {
  constructor() {
    this.events = [];
    this.inFlight = 0;
    this.tail = Promise.resolve();
  }

  _used() {
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.t < GROQ_WINDOW_MS);
    return this.events.reduce((sum, e) => sum + e.n, 0) + this.inFlight;
  }

  async acquire(n, signal) {
    const wait = this.tail.then(() => this._wait(n, signal));
    this.tail = wait.catch(() => {});
    await wait;
    this.inFlight += n;
    let released = false;
    return (commit) => {
      if (released) return;
      released = true;
      this.inFlight -= n;
      if (commit) this.events.push({ t: Date.now(), n });
    };
  }

  async _wait(n, signal) {
    let logged = false;
    while (true) {
      if (signal?.aborted) throw abortError();
      const used = this._used();
      if (used + n <= GROQ_ITPM) return;
      const oldest = this.events[0];
      const waitMs = oldest
        ? Math.max(250, GROQ_WINDOW_MS - (Date.now() - oldest.t) + 50)
        : 1000;
      if (!logged) {
        logged = true;
        logger.warn(`Groq ITPM gate waiting ${Math.ceil(waitMs / 1000)}s (used ${used}+${n}/${GROQ_ITPM})`);
      }
      await sleep(Math.min(waitMs, 15000), signal);
    }
  }
}

const groqGate = new GroqTokenGate();

async function geminiComplete({ messages, model, maxTokens, temperature, apiKey, signal }) {
  const packed = compactMessages(messages);
  const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify(toGeminiPayload(packed, maxTokens, temperature)),
    signal: signal || AbortSignal.timeout(25000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${errorText(data)}`);
  const text = pickGeminiText(data);
  logger.info(`Gemini think ok ${text.length} chars model=${model}`);
  return { text, model };
}

async function groqComplete({ messages, model, maxTokens, temperature, apiKey, signal }) {
  const packed = compactMessages(messages);
  const tokens = estimateTokens(packed);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const release = await groqGate.acquire(tokens, signal);
    try {
      const timeout = AbortSignal.timeout(25000);
      const combined = signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : (signal || timeout);
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: packed,
          max_completion_tokens: maxTokens,
          temperature,
          reasoning_effort: "none",
        }),
        signal: combined,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        release(true);
        const text = pickContent(data.choices?.[0]?.message);
        logger.info(`Groq think ok ${text.length} chars est=${tokens} finish=${data.choices?.[0]?.finish_reason || "?"}`);
        return { text, model };
      }
      const err = new Error(`LLM ${res.status}: ${errorText(data)}`);
      release(false);
      if (res.status !== 429) throw err;
      if (/tokens per day|\bTPD\b/i.test(err.message)) {
        logger.error("Groq daily token cap hit — shrinking the prompt or wait for reset");
        throw err;
      }
      lastErr = err;
      const waitMs = parseRetryAfterMs(err.message, res.headers.get("retry-after"));
      logger.warn(`Groq 429, retry ${attempt + 1}/5 in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs, signal);
    } catch (err) {
      release(false);
      if (err.name === "AbortError") throw err;
      if (/tokens per day|\bTPD\b/i.test(err.message || "")) throw err;
      if (!String(err.message || "").includes("LLM 429")) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("LLM 429: Groq rate limit");
}

async function assemblyComplete({ messages, model, maxTokens, temperature, apiKey, signal }) {
  const res = await fetch(ASSEMBLY_URL, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    signal: signal || AbortSignal.timeout(25000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`LLM ${res.status}: ${errorText(data)}`);
  return { text: data.choices?.[0]?.message?.content || "", model };
}

export async function chatComplete({
  messages,
  model,
  maxTokens = 180,
  temperature = 0.3,
  apiKey,
  signal,
} = {}) {
  const explicit = apiKey ? String(apiKey) : "";
  const geminiKey = explicit.startsWith("AQ.") || explicit.startsWith("AIza")
    ? explicit
    : (!explicit ? getGeminiKey() : "");
  if (geminiKey) {
    try {
      return await geminiComplete({
        messages,
        model: model || GEMINI_MODEL,
        maxTokens,
        temperature,
        apiKey: geminiKey,
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      const groqFallback = getGroqKey();
      if (groqFallback && /LLM 403|billing|dunning/i.test(err.message || "")) {
        logger.warn(`Gemini blocked (${String(err.message).slice(0, 80)}) — falling back to Groq`);
        return groqComplete({
          messages,
          model: GROQ_MODEL,
          maxTokens,
          temperature,
          apiKey: groqFallback,
          signal,
        });
      }
      throw err;
    }
  }
  const groqKey = explicit.startsWith("gsk_") ? explicit : (!explicit ? getGroqKey() : "");
  if (groqKey) {
    return groqComplete({
      messages,
      model: model || GROQ_MODEL,
      maxTokens,
      temperature,
      apiKey: groqKey,
      signal,
    });
  }
  const assemblyKey = explicit || process.env.ASSEMBLYAI_API_KEY;
  if (!assemblyKey) throw new Error("GEMINI_API_KEY, GROQ_API_KEY or ASSEMBLYAI_API_KEY is not set");
  return assemblyComplete({
    messages,
    model: model || ASSEMBLY_MODEL,
    maxTokens,
    temperature,
    apiKey: assemblyKey,
    signal,
  });
}
