/**
 * DB Helpers - Build Deepgram agent settings from DB agent records
 */

import { getDb, generateId } from "./schema.js";

/**
 * Build Deepgram Voice Agent settings from a DB agent record and lead data.
 */
function toTitleCase(str) {
  if (!str || typeof str !== "string") return str;
  return str.toLowerCase().replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

const NAME_FIELDS = new Set(["name", "first_name", "last_name", "full_name", "lead_name"]);

export function buildAgentSettingsFromDb(agent, lead = {}) {
  // Dynamic time-of-day greeting (Spanish/English)
  const hour = new Date().getHours();
  const agentLang = agent.language || "en";
  if (agentLang === "es") {
    lead.saludo = hour < 13 ? "buenos días" : hour < 20 ? "buenas tardes" : "buenas noches";
  } else {
    lead.saludo = hour < 12 ? "good morning" : hour < 18 ? "good afternoon" : "good evening";
  }

  const interpolate = (str) => {
    if (!str) return str;
    return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      let val = lead[key] || lead.extra?.[key] || match;
      if (NAME_FIELDS.has(key) && typeof val === "string" && val !== match) {
        val = toTitleCase(val);
      }
      return val;
    });
  };

  const functions = JSON.parse(agent.functions_json || "[]");
  const lang = agent.language || "en";

  // Build STT language: use "multi" for multilingual, or specific language code
  const sttLanguage = lang === "multi" ? "multi" : lang;

  // Inject strict language instruction into the prompt so LLM never mixes languages
  const LANG_NAMES = {
    en: "English", es: "Spanish", fr: "French", de: "German",
    it: "Italian", nl: "Dutch", ja: "Japanese", multi: null,
  };
  const langName = LANG_NAMES[lang];
  
  // Use appropriate script based on agent mode
  const agentMode = agent.mode || "live_transfer";
  const rawScript = agentMode === "appointment" 
    ? (agent.appointment_script || agent.script || "") 
    : (agent.script || "");
  const userPrompt = interpolate(rawScript);
  
  // Generate dynamic date reference for the AI
  const today = new Date();
  const formatDate = (d) => d.toISOString().split('T')[0];
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  // Calculate next occurrence of each weekday
  const getNextWeekday = (targetDay) => {
    const current = today.getDay();
    let daysUntil = targetDay - current;
    if (daysUntil <= 0) daysUntil += 7; // next week if today or past
    return addDays(today, daysUntil);
  };
  
  const dateReference = `
[CURRENT DATE REFERENCE - USE THESE EXACT DATES]
Today: ${formatDate(today)} (${dayNames[today.getDay()]})
Tomorrow: ${formatDate(addDays(today, 1))} (${dayNames[addDays(today, 1).getDay()]})
Day after tomorrow: ${formatDate(addDays(today, 2))}
Next Monday: ${formatDate(getNextWeekday(1))}
Next Tuesday: ${formatDate(getNextWeekday(2))}
Next Wednesday: ${formatDate(getNextWeekday(3))}
Next Thursday: ${formatDate(getNextWeekday(4))}
Next Friday: ${formatDate(getNextWeekday(5))}
Next Saturday: ${formatDate(getNextWeekday(6))}
Next Sunday: ${formatDate(getNextWeekday(0))}
IMPORTANT: When client says "el lunes" or "Monday", use the date for Next Monday shown above. Do NOT calculate dates yourself - use these exact values.
`;

  const langInstruction = langName
    ? `\n\n[LANGUAGE RULE] You MUST speak ONLY in ${langName}. Every word you say must be in ${langName}. Never mix languages. Never switch to English or any other language, even if the user speaks a different language. This rule overrides all other instructions.`
    : "";
  const fullPrompt = userPrompt + dateReference + langInstruction;

  // Determine STT model and version (Flux requires v2)
  const sttModel = agent.stt_model || "nova-3";
  const isFlux = sttModel.startsWith("flux-");
  
  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: 16000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      language: lang,
      listen: {
        provider: {
          type: agent.stt_provider || "deepgram",
          model: sttModel,
          ...(isFlux ? { version: "v2" } : {}),
          ...(!isFlux && { language: sttLanguage }),
        },
      },
      think: {
        provider: {
          type: agent.llm_provider || "open_ai",
          model: agent.llm_model || "gpt-4o-mini",
        },
        prompt: fullPrompt,
        functions: functions.map((fn) => ({
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        })),
      },
      speak: {
        provider: buildSpeakProvider(agent),
      },
      greeting: interpolate(agent.greeting || ""),
    },
  };
}

/**
 * Build the speak.provider object with correct field names per TTS provider.
 * - Deepgram: { type, model }
 * - Cartesia: { type, model_id, voice: { mode, id } }
 * - ElevenLabs: { type, model_id, voice_id }
 * - OpenAI TTS: { type, model, voice }
 * - AWS Polly: { type, voice, engine, language_code }
 */
function buildSpeakProvider(agent) {
  const type = agent.tts_provider || "deepgram";
  const model = agent.tts_model || "aura-2-thalia-en";

  switch (type) {
    case "eleven_labs":
      return {
        type,
        model_id: model,
        ...(agent.tts_voice_id && { voice_id: agent.tts_voice_id }),
      };
    case "cartesia":
      return {
        type,
        model_id: model,
        ...(agent.tts_voice_id && {
          voice: { mode: "id", id: agent.tts_voice_id },
        }),
        ...(agent.language && { language: agent.language }),
      };
    case "open_ai":
      return {
        type,
        model,
        ...(agent.tts_voice && { voice: agent.tts_voice }),
      };
    case "aws_polly":
      return {
        type,
        voice: model,
        ...(agent.tts_engine && { engine: agent.tts_engine }),
        ...(agent.tts_language_code && { language_code: agent.tts_language_code }),
      };
    default: // deepgram
      return { type, model };
  }
}

/**
 * Update a lead's status after a call based on the call outcome.
 * Also sets do_not_call flag if the lead requested it.
 */
export function updateLeadStatus(leadId, callOutcome) {
  if (!leadId) return;
  const db = getDb();

  // Map call outcome to lead status
  const statusMap = {
    transferred: "completed",
    appointment_set: "completed",
    interested: "contacted",
    not_interested: "completed",
    callback: "callback",
    do_not_call: "completed",
    lead_hangup: "contacted",
    no_answer: "no_answer",
    voicemail: "voicemail",
    timeout: "no_answer",
    error: "new",       // keep as new so it gets retried
    unknown: "contacted",
  };

  const newStatus = statusMap[callOutcome] || "contacted";

  db.prepare(
    "UPDATE leads SET status = ?, do_not_call = CASE WHEN ? = 'do_not_call' THEN 1 ELSE do_not_call END WHERE id = ?"
  ).run(newStatus, callOutcome, leadId);
}

/**
 * Get active transfer extensions for a campaign (round-robin list).
 */
export function getCampaignExtensions(campaignId) {
  const db = getDb();
  const exts = db.prepare(
    "SELECT extension FROM extensions WHERE campaign_id = ? AND active = 1 ORDER BY extension"
  ).all(campaignId);
  return exts.map(e => e.extension);
}

/**
 * Get all leads for a campaign that are eligible to call.
 */
export function getCampaignCallableLeads(campaignId) {
  const db = getDb();
  return db.prepare(`
    SELECT l.* FROM leads l
    JOIN campaign_lists cl ON l.list_id = cl.list_id
    WHERE cl.campaign_id = ? AND l.do_not_call = 0
      AND l.status NOT IN ('completed', 'contacted', 'voicemail', 'no_answer', 'callback')
    ORDER BY l.created_at ASC
  `).all(campaignId);
}

/**
 * Generate an AI-style call summary from the transcript.
 * Extracts key info: KYC data (age, job, income, goal), interest level, and outcome.
 */
export function generateCallSummary(transcript, leadName, outcome) {
  if (!transcript || transcript.length === 0) return "";

  const lines = transcript.map(t => `${t.role}: ${t.text}`);
  const fullText = lines.join(" ");

  // Extract KYC data from conversation
  const agentLines = transcript.filter(t => t.role === "agent").map(t => t.text).join(" ");
  const userLines = transcript.filter(t => t.role === "user").map(t => t.text).join(" ");

  // Build summary parts
  const parts = [];
  parts.push(`The agent contacted ${leadName || "the lead"}`);

  // Try to detect discussion topics
  if (/trad/i.test(fullText)) parts.push("to discuss trading/investment opportunities");
  if (/online/i.test(fullText)) parts.push("regarding online trading");

  // Detect KYC info shared
  const kycParts = [];
  const ageMatch = userLines.match(/\b(\d{2,3})\b.*(?:year|old|age)/i) || userLines.match(/(?:age|year|old).*?\b(\d{2,3})\b/i);
  if (ageMatch) kycParts.push(`age: ${ageMatch[1]}`);

  // Detect interest
  if (outcome === "transferred") {
    parts.push("The client showed interest and was successfully transferred to an advisor.");
  } else if (outcome === "interested") {
    parts.push("The client expressed interest.");
  } else if (outcome === "not_interested") {
    parts.push("The client was not interested.");
  } else if (outcome === "callback") {
    parts.push("The client requested a callback.");
  } else if (outcome === "do_not_call") {
    parts.push("The client requested not to be contacted again.");
  }

  // Count exchanges
  const exchanges = transcript.length;
  parts.push(`Conversation had ${exchanges} exchanges over the call.`);

  return parts.join(". ") + ".";
}

/**
 * Record a call result in the database.
 */
export function recordCall(data) {
  const db = getDb();
  const id = data.id || generateId();

  // Generate call summary if not provided
  const summary = data.call_summary || generateCallSummary(
    data.transcript || [], data.lead_name || "", data.outcome || "unknown"
  );

  db.prepare(`
    INSERT INTO call_records (id, campaign_id, agent_id, lead_id, user_id, call_id, phone, lead_name, outcome, duration_seconds, notes, transcript_json, transferred_to, error_message, call_summary, started_at, ended_at, recording_path, recording_url, ai_duration_seconds, call_cost, voip_cost, ai_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.campaign_id || null,
    data.agent_id || null,
    data.lead_id || null,
    data.user_id,
    data.call_id,
    data.phone,
    data.lead_name || "",
    data.outcome || "unknown",
    data.duration_seconds || 0,
    data.notes || "",
    JSON.stringify(data.transcript || []),
    data.transferred_to || "",
    data.error_message || "",
    summary,
    data.started_at || new Date().toISOString(),
    data.ended_at || new Date().toISOString(),
    data.recording_path || "",
    data.recording_url || "",
    data.ai_duration_seconds || 0,
    data.call_cost || 0,
    data.voip_cost || 0,
    data.ai_cost || 0
  );
  return id;
}

/**
 * Get a user's credit balance, creating the row if needed.
 */
export function getUserBalance(userId) {
  const db = getDb();
  let row = db.prepare("SELECT balance FROM user_credits WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare("INSERT INTO user_credits (user_id, balance) VALUES (?, 0)").run(userId);
    row = { balance: 0 };
  }
  return row.balance;
}

/**
 * Deduct credits from a user's balance and log the transaction.
 * Returns the new balance.
 */
export function deductCredits(userId, amount, description, referenceId = "") {
  const db = getDb();
  const deduct = db.transaction(() => {
    getUserBalance(userId); // ensure row exists
    db.prepare("UPDATE user_credits SET balance = balance - ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(amount, userId);
    const newBalance = db.prepare("SELECT balance FROM user_credits WHERE user_id = ?").get(userId).balance;
    const id = generateId();
    db.prepare(
      "INSERT INTO credit_transactions (id, user_id, type, amount, balance_after, description, reference_id) VALUES (?, ?, 'call_charge', ?, ?, ?, ?)"
    ).run(id, userId, -amount, newBalance, description, referenceId);
    return newBalance;
  });
  return deduct();
}

/**
 * Get a platform setting by key.
 */
export function getPlatformSetting(key, defaultValue = "") {
  const db = getDb();
  const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

/**
 * Get all platform settings as a key-value object.
 */
export function getAllPlatformSettings() {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM platform_settings").all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

/**
 * Set a platform setting (upsert).
 */
export function setPlatformSetting(key, value) {
  const db = getDb();
  db.prepare(
    "INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(key, String(value));
}

/**
 * Get cost rates as numbers for billing calculations.
 */
export function getCostRates() {
  const voip = parseFloat(getPlatformSetting("voip_cost_per_min", "0.02"));
  const ai = parseFloat(getPlatformSetting("ai_cost_per_min", "0.40"));
  return { voipCostPerMin: voip, aiCostPerMin: ai };
}

/**
 * Add credits to a user's balance (admin top-up).
 */
export function addCredits(userId, amount, description, createdBy = "") {
  const db = getDb();
  const topup = db.transaction(() => {
    getUserBalance(userId); // ensure row exists
    db.prepare("UPDATE user_credits SET balance = balance + ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(amount, userId);
    const newBalance = db.prepare("SELECT balance FROM user_credits WHERE user_id = ?").get(userId).balance;
    const id = generateId();
    db.prepare(
      "INSERT INTO credit_transactions (id, user_id, type, amount, balance_after, description, reference_id, created_by) VALUES (?, ?, 'topup', ?, ?, ?, '', ?)"
    ).run(id, userId, amount, newBalance, description, createdBy);
    return newBalance;
  });
  return topup();
}

/**
 * Create an appointment record in the database,
 * then async-push to Google Sheets if the campaign has one linked.
 */
export function createAppointment(data) {
  const db = getDb();
  const id = data.id || generateId();

  db.prepare(`
    INSERT INTO appointments (id, user_id, campaign_id, lead_id, call_id, lead_name, phone, email,
      appointment_date, appointment_time, timezone, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
  `).run(
    id,
    data.user_id,
    data.campaign_id || null,
    data.lead_id || null,
    data.call_id || "",
    data.lead_name || "",
    data.phone,
    data.email || "",
    data.appointment_date,
    data.appointment_time,
    data.timezone || "Europe/London",
    data.notes || ""
  );

  // Fire-and-forget push to Google Sheets
  import("../services/google-sheets.js").then(({ pushAppointmentToSheet }) => {
    pushAppointmentToSheet(id).catch(() => {});
  }).catch(() => {});

  return id;
}
