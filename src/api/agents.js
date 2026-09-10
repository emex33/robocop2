/**
 * Agents API Routes
 * CRUD for AI agents - each agent has script, tone, LLM/STT/TTS settings
 */

import { Router } from "express";
import { getDb, generateId } from "../db/schema.js";
import WebSocket from "ws";

const router = Router();

// List all agents for the current user
router.get("/", (req, res) => {
  const db = getDb();
  const agents = db.prepare(
    "SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC"
  ).all(req.user.userId);

  // Parse functions_json
  const result = agents.map(a => ({
    ...a,
    functions: JSON.parse(a.functions_json || "[]"),
  }));
  res.json(result);
});

// Get single agent
router.get("/:id", (req, res) => {
  const db = getDb();
  const agent = db.prepare(
    "SELECT * FROM agents WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!agent) return res.status(404).json({ error: "Agent not found" });

  agent.functions = JSON.parse(agent.functions_json || "[]");
  res.json(agent);
});

// Create agent
router.post("/", (req, res) => {
  const db = getDb();
  const id = generateId();
  const {
    name, mode, language, company, tone, greeting, script, appointment_script,
    llm_provider, llm_model, llm_temperature,
    stt_provider, stt_model,
    tts_provider, tts_model, tts_voice_id, tts_speed,
    eot_threshold, eot_timeout_ms, response_delay_ms,
    functions,
  } = req.body;

  if (!name) return res.status(400).json({ error: "Agent name is required" });

  const agentMode = mode || "live_transfer";
  const functionsJson = JSON.stringify(functions || getDefaultFunctions(agentMode));

  db.prepare(`
    INSERT INTO agents (id, user_id, name, mode, language, company, tone, greeting, script, appointment_script,
      llm_provider, llm_model, llm_temperature, stt_provider, stt_model,
      tts_provider, tts_model, tts_voice_id, tts_speed, eot_threshold, eot_timeout_ms, response_delay_ms, functions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.user.userId,
    name,
    agentMode,
    language || "en",
    company || "",
    tone || "professional",
    greeting || "Hi, am I speaking with {{first_name}}?",
    script || "",
    appointment_script || "",
    llm_provider || "open_ai",
    llm_model || "gpt-4o-mini",
    llm_temperature ?? 0.7,
    stt_provider || "deepgram",
    stt_model || "nova-3",
    tts_provider || "deepgram",
    tts_model || "aura-2-thalia-en",
    tts_voice_id || "",
    tts_speed || "normal",
    eot_threshold ?? 0.85,
    eot_timeout_ms ?? 5000,
    response_delay_ms ?? 600,
    functionsJson
  );

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  agent.functions = JSON.parse(agent.functions_json || "[]");
  res.status(201).json(agent);
});

// Update agent
router.put("/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare(
    "SELECT * FROM agents WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!existing) return res.status(404).json({ error: "Agent not found" });

  const fields = [];
  const values = [];
  const allowed = [
    "name", "mode", "language", "company", "tone", "greeting", "script", "appointment_script",
    "llm_provider", "llm_model", "llm_temperature",
    "stt_provider", "stt_model", "tts_provider", "tts_model",
    "tts_voice_id", "tts_speed", "eot_threshold", "eot_timeout_ms", "response_delay_ms",
  ];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  // If mode changed, auto-update functions to match the new mode
  if (req.body.mode !== undefined && req.body.mode !== existing.mode) {
    const newFunctions = getDefaultFunctions(req.body.mode);
    fields.push("functions_json = ?");
    values.push(JSON.stringify(newFunctions));
  } else if (req.body.functions !== undefined) {
    fields.push("functions_json = ?");
    values.push(JSON.stringify(req.body.functions));
  }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
  agent.functions = JSON.parse(agent.functions_json || "[]");
  res.json(agent);
});

// Delete agent
router.delete("/:id", (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM agents WHERE id = ? AND user_id = ?"
  ).run(req.params.id, req.user.userId);

  if (result.changes === 0) return res.status(404).json({ error: "Agent not found" });
  res.json({ message: "Agent deleted" });
});

// Duplicate agent
router.post("/:id/duplicate", (req, res) => {
  const db = getDb();
  const source = db.prepare(
    "SELECT * FROM agents WHERE id = ? AND user_id = ?"
  ).get(req.params.id, req.user.userId);

  if (!source) return res.status(404).json({ error: "Agent not found" });

  const newId = generateId();
  db.prepare(`
    INSERT INTO agents (id, user_id, name, mode, language, company, tone, greeting, script, appointment_script,
      llm_provider, llm_model, llm_temperature, stt_provider, stt_model,
      tts_provider, tts_model, tts_voice_id, tts_speed, eot_threshold, eot_timeout_ms, response_delay_ms, functions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId, req.user.userId,
    source.name + " (copy)", source.mode || "live_transfer",
    source.language, source.company, source.tone,
    source.greeting, source.script, source.appointment_script || "",
    source.llm_provider, source.llm_model, source.llm_temperature,
    source.stt_provider, source.stt_model, source.tts_provider, source.tts_model,
    source.tts_voice_id || "", source.tts_speed || "normal",
    source.eot_threshold ?? 0.85, source.eot_timeout_ms ?? 5000, source.response_delay_ms ?? 600,
    source.functions_json
  );

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(newId);
  agent.functions = JSON.parse(agent.functions_json || "[]");
  res.status(201).json(agent);
});

// Test agent configuration against Deepgram Voice Agent API
router.post("/test", async (req, res) => {
  const {
    language, greeting, script,
    llm_provider, llm_model,
    stt_provider, stt_model,
    tts_provider, tts_model, tts_voice_id, tts_speed,
    eot_threshold, eot_timeout_ms,
  } = req.body;

  const logs = [];
  const log = (level, msg) => logs.push({ time: new Date().toISOString(), level, message: msg });

  log("info", "Building agent settings...");

  const lang = language || "en";
  const sttLanguage = lang === "multi" ? "multi" : lang;

  // Inject strict language enforcement into prompt
  const LANG_NAMES = {
    en: "English", es: "Spanish", fr: "French", de: "German",
    it: "Italian", nl: "Dutch", ja: "Japanese", multi: null,
  };
  const langName = LANG_NAMES[lang];
  const userPrompt = script || "You are a helpful assistant. Say hello.";
  const langInstruction = langName
    ? `\n\n[LANGUAGE RULE] You MUST speak ONLY in ${langName}. Every word must be in ${langName}. Never mix languages.`
    : "";

  // Build speak provider
  const speakProvider = { type: tts_provider || "deepgram" };
  if (tts_provider === "cartesia") {
    speakProvider.model_id = tts_model || "sonic-2";
    if (tts_voice_id) speakProvider.voice = { mode: "id", id: tts_voice_id };
    if (lang) speakProvider.language = lang;
    if (tts_speed && tts_speed !== "normal") speakProvider.speed = tts_speed;
  } else if (tts_provider === "eleven_labs") {
    speakProvider.model_id = tts_model || "eleven_turbo_v2_5";
    if (tts_voice_id) speakProvider.voice_id = tts_voice_id;
  } else {
    speakProvider.model = tts_model || "aura-2-thalia-en";
  }

  // Determine if using Flux (requires version: v2, no language param)
  const sttModelToUse = stt_model || "nova-3";
  const isFlux = sttModelToUse.startsWith("flux-");
  const eotThreshold = Math.min(1, Math.max(0.5, Number(eot_threshold) || 0.85));
  const eotTimeoutMs = Math.round(Math.min(60000, Math.max(500, Number(eot_timeout_ms) || 5000)));

  const settings = {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: 16000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      language: lang,
      listen: {
        provider: { 
          type: stt_provider || "deepgram", 
          model: sttModelToUse,
          ...(isFlux
            ? { version: "v2", eot_threshold: eotThreshold, eot_timeout_ms: eotTimeoutMs }
            : { language: sttLanguage }),
        },
      },
      think: {
        provider: { type: llm_provider || "open_ai", model: llm_model || "gpt-4o-mini" },
        prompt: userPrompt + langInstruction,
        functions: [],
      },
      speak: { provider: speakProvider },
      greeting: greeting || "Hello, this is a test.",
    },
  };

  log("info", `Settings built: LLM=${llm_provider}/${llm_model}, STT=${stt_provider}/${stt_model}, TTS=${tts_provider}/${tts_model}`);
  log("info", `Language: ${language || "en"}, Greeting: "${(greeting || "Hello, this is a test.").slice(0, 60)}..."`);

  let apiKey;
  try {
    const { getUserDeepgramKeyInfo } = await import("./settings.js");
    const keyInfo = getUserDeepgramKeyInfo(req.user.userId);
    if (keyInfo) {
      apiKey = keyInfo.key;
      log("info", `Using Deepgram key: "${keyInfo.label}" (source: ${keyInfo.source})`);
    }
  } catch (e) { /* ignore */ }
  if (!apiKey) {
    const db2 = getDb();
    const userRow = db2.prepare("SELECT deepgram_api_key FROM users WHERE id = ?").get(req.user.userId);
    apiKey = userRow?.deepgram_api_key || process.env.DEEPGRAM_API_KEY;
  }
  if (!apiKey) {
    log("error", "No Deepgram API key configured. Set it in Settings or .env");
    return res.json({ success: false, logs });
  }

  log("info", "Connecting to Deepgram Voice Agent API...");

  try {
    const result = await new Promise((resolve, reject) => {
      const url = process.env.DEEPGRAM_VOICE_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
      const ws = new WebSocket(url, { headers: { authorization: `token ${apiKey}` } });

      let welcomed = false;
      let settingsApplied = false;
      let gotAudio = false;
      let gotGreeting = false;
      let audioChunks = 0;

      const timeout = setTimeout(() => {
        log("error", "Timeout: no response from Deepgram after 15s");
        ws.close();
        resolve({ success: false });
      }, 15000);

      ws.on("open", () => {
        log("success", "WebSocket connected to Deepgram");
        log("info", "Sending agent settings...");
        ws.send(JSON.stringify(settings));
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          audioChunks++;
          if (!gotAudio) {
            gotAudio = true;
            log("success", `TTS audio received (${tts_provider}/${tts_model} is working)`);
          }
          return;
        }

        const msg = JSON.parse(data.toString());

        if (msg.type === "Welcome") {
          welcomed = true;
          log("success", "Deepgram welcomed connection (API key valid)");
        } else if (msg.type === "SettingsApplied") {
          settingsApplied = true;
          log("success", "Settings applied successfully (all providers accepted)");
          log("info", "Waiting for greeting audio...");
        } else if (msg.type === "ConversationText" && msg.role === "assistant") {
          gotGreeting = true;
          log("success", `Greeting generated: "${msg.content}"`);
        } else if (msg.type === "AgentAudioDone") {
          log("success", `Greeting audio complete (${audioChunks} chunks received)`);
          clearTimeout(timeout);
          ws.close();
          resolve({
            success: true,
            welcomed,
            settingsApplied,
            gotAudio,
            gotGreeting,
            audioChunks,
          });
        } else if (msg.type === "Error") {
          log("error", `Deepgram error: ${msg.description || msg.message} (code: ${msg.code || "unknown"})`);
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false, error: msg.description || msg.message });
        }
      });

      ws.on("error", (err) => {
        log("error", `WebSocket error: ${err.message}`);
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });

      ws.on("close", (code) => {
        if (!gotAudio && settingsApplied) {
          log("error", `Connection closed (code ${code}) before audio was received — TTS model may be invalid`);
        }
        clearTimeout(timeout);
        resolve({
          success: gotAudio && settingsApplied,
          welcomed,
          settingsApplied,
          gotAudio,
          gotGreeting,
          audioChunks,
        });
      });
    });

    if (result.success) {
      log("success", "All checks passed! Configuration is valid.");
    } else if (!result.error) {
      log("error", "Test failed — check the logs above for details.");
    }

    return res.json({ success: result.success, logs });
  } catch (err) {
    log("error", `Unexpected error: ${err.message}`);
    return res.json({ success: false, logs });
  }
});

function getDefaultFunctions(mode = "live_transfer") {
  if (mode === "appointment") {
    return [
      {
        name: "update_lead_info",
        description: "Update the lead's name and other info once the client tells you their name during the call. Call this as soon as you learn the client's first name or full name.",
        parameters: {
          type: "object",
          properties: {
            first_name: { type: "string", description: "Client's first name" },
            last_name: { type: "string", description: "Client's last name (if provided)" },
            email: { type: "string", description: "Client's email address (if provided)" },
          },
          required: ["first_name"],
        },
      },
      {
        name: "book_appointment",
        description: "Book an appointment when the client has agreed to a meeting. Collect the preferred date, time, and any notes.",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Preferred appointment date (e.g. 2026-03-10)" },
            time: { type: "string", description: "Preferred appointment time (e.g. 14:00)" },
            notes: { type: "string", description: "Any additional notes or details about the appointment" },
          },
          required: ["date", "time"],
        },
      },
      {
        name: "end_call",
        description: "End the call. Use when: conversation is complete, client is not interested, or after failed objection attempts.",
        parameters: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: ["appointment_set", "not_interested", "callback", "do_not_call", "no_answer", "voicemail"],
              description: "Result/disposition of the call",
            },
            notes: { type: "string", description: "Brief notes about the call" },
          },
          required: ["outcome"],
        },
      },
    ];
  }

  // Default: live_transfer mode
  return [
    {
      name: "transfer_call",
      description: "Transfer the call to a human advisor when the client is qualified and has given clear consent.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Reason for the transfer" },
          age: { type: "string", description: "Age of the prospect" },
          profession: { type: "string", description: "Profession of the prospect" },
          income: { type: "string", description: "Approximate monthly income" },
        },
        required: ["reason"],
      },
    },
    {
      name: "end_call",
      description: "End the call. Use when: conversation is complete, client is not interested, or after failed objection attempts.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: ["interested", "not_interested", "callback", "do_not_call", "no_answer", "voicemail"],
            description: "Result/disposition of the call",
          },
          notes: { type: "string", description: "Brief notes about the call" },
        },
        required: ["outcome"],
      },
    },
  ];
}

export default router;
