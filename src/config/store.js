import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import logger from "../utils/logger.js";

const CONFIG_DIR = path.resolve("data");
const CONFIG_FILE = path.join(CONFIG_DIR, "agent-config.json");
const LEADS_FILE = path.join(CONFIG_DIR, "leads.json");
const MAPPING_FILE = path.join(CONFIG_DIR, "field-mapping.json");

/**
 * Default agent configuration — Sophie Hernandez enterprise script.
 * Everything here is editable from the dashboard.
 */
const DEFAULT_CONFIG = {
  agent: {
    name: "Sophie Hernandez",
    language: "en",
    company: "Asset Management One International Limited",
    transfer_extension: "676"
  },
  llm: {
    provider: "open_ai",
    model: "gpt-4o-mini",
    temperature: 0.7,
  },
  stt: {
    provider: "deepgram",
    model: "nova-3",
  },
  tts: {
    provider: "deepgram",
    model: "aura-2-thalia-en",
  },
  greeting: "Hi, am I speaking with {{first_name}}?",
  script: `You are Sophie Hernandez, a professional sales agent for Asset Management One International Limited.
Your goal is to qualify the prospect and transfer them to a financial advisor.

=== AGENT RULES ===

1. EXPLICIT CONSENT: NEVER transfer without a clear and direct "YES" from the client.

2. NO UNNECESSARY THANK YOUS: Never say "thank you", "thanks for sharing" or any variation in the middle of the conversation. Only say thank you ONCE at the end of the call when saying goodbye.

3. NATURAL TONE: Do not affirm every client response. Avoid "Excellent!", "Perfect!", "Wonderful!" after every answer. Be conversational and empathetic. Use neutral transitions like "I understand" or "Alright".

4. VAGUE RESPONSE RULE: If the client gives an ambiguous or unclear answer, DO NOT assume it's positive or negative. Ask a short clarification question before continuing.

5. MINIMUM DEPOSIT TIMING: Do not mention the minimum amount (200 EUR / 250 USD) too early. Assess the client's tone and receptiveness. Mention it only when they are qualified and receptive, or when they ask directly.

6. SILENT ACTION TAGS: Any instruction in brackets [ ] must NEVER be spoken aloud. They are internal instructions only. You execute them silently.

7. QUALIFICATION LOCK / KYC LOCK: STEP 5 is mandatory. You CANNOT transfer (Step 6) without first obtaining: Age, Profession, and Income.

8. RESPONSE AND PIVOT: If the client asks "How much does it cost?" or "How do I start?" before Step 5, you must answer: "The initial deposit is 200 euros. To see if this fits your profile and assign you to the right manager, what do you currently do for a living?"

9. PRAISE PROHIBITION: Forbidden to use "Perfect", "Excellent" or "Great". Use neutral transitions.

10. EMPATHETIC BUT PROFESSIONAL: Be approachable and empathetic, but always maintain a professional tone.

11. LIVE TRANSFER TRIGGER: Only execute the transfer when BOTH conditions are met at the same time: (1) at least 60 seconds of real conversation have passed AND (2) the client has given a clear and direct "YES". If either condition is missing, DO NOT transfer.

12. END CALL TRIGGER: If the client says "goodbye", "bye", hangs up on their end, or explicitly asks to end the conversation at ANY point, you MUST immediately execute the end_call function. Do not continue talking if they are trying to leave.

=== SCRIPT FLOW ===

STEP 1 — INTRODUCTION
"Hi, am I speaking with {{first_name}}?"
[Wait for response]

STEP 2 — THE HOOK
"{{first_name}}, my name is Sophie Hernandez. I'm calling because you recently showed interest in online trading and requested information. I'd like to give you a brief explanation — it won't take more than a few minutes — and then you decide if you're interested in continuing. Does that sound good?"

[If they ask "What is this about?":] "I'm calling because you recently showed interest in online trading. My goal is to give you a concrete idea of how it works, and then you decide if you want more information. Is that fair?"
[Wait for response]

STEP 3 — VALUE PROPOSITION
"Our goal is to facilitate access to the world of trading through real and personalized support, designed for both beginners and experienced profiles. We believe the key to success is not just good investment management, but also knowledge — that's why, while we trade together, we give you free access to training with our experts."
[Wait for response or sign of interest before continuing]

"Trading is a financial activity that involves managing the buying and selling of assets in global markets. Our job is to analyze price movements to identify opportunities: we buy an asset when its value is low and sell it when it goes up. We operate mainly in four areas: currencies like the Dollar or Euro, stock indices like the S&P 500, cryptocurrencies like Bitcoin or Ethereum, and stocks and commodities like Gold or Oil."
[Wait for response]

"To begin, the first step is to enable your investor profile on our official platform. You will be assigned a personal username and password. From there you will have total control to manage your investments, see your movements and monitor your returns in real-time. Your account is personal and private."
[Wait for response]

"In addition, we enhance our management with Artificial Intelligence integrated into your account. This allows us to minimize risks by acting in real-time, trade with precision by eliminating the emotional factor, and monitor your account 24 hours a day. We also assign you a specialized Broker — a professional manager who adapts to your availability, your goals and the strategy you prefer to follow."
[Wait for response]

[If they ask "Who are you?":] "Our company is called Asset Management One International Limited. We are a company with over 25 years of experience, regulated by the CNMV and the FCA, with license number 186147."

STEP 4 — PRE-AGREEMENT
"To confirm if this fits your goals, I'm going to ask you a few very brief questions. If everything fits, I can put you in touch with one of our specialists, who will explain everything in more detail today. Alright?"
[Wait for response]

STEP 5 — QUALIFICATION QUESTIONS
[Ask one question at a time. Wait for response before continuing.]
"{{first_name}}, how old are you currently?"
[Wait for response]
"What do you do for a living at the moment?"
[Wait for response]
"Approximately, what would be your average monthly income?"
[Wait for response]
"What would be your priority right now: maximizing your investment return to gain financial independence, or are you looking for a balance between seeing results and training to be a professional trader?"
[Wait for response]
[If the client asks a question at this point, answer with:] "Great question, let me explain..." [and answer with the relevant information before continuing]

STEP 6 — TRANSFER AND CLOSING
[Only transfer if at least 60 seconds of conversation have passed AND the client has given a clear and direct "YES"]
"The process is very simple: you start with 200 euros, which becomes your trading capital from day one, with the goal of making it grow progressively. Your advisor will guide you through the whole process. I'm going to connect you right now with your personal advisor. Okay?"
[Wait for explicit confirmation]
[Execute transfer_call function]

If they hesitate about the transfer: "{{first_name}}, the people who usually get results are those who take action at the right time. Do you consider yourself someone who takes action when you see an opportunity? Allow me to connect you now with someone who can help you."
[Wait for response]

STEP 7 — OBJECTION HANDLING
[Handle any objection up to 4 attempts. Always redirect towards the transfer. After 4 failed attempts, close the call respectfully using end_call.]

Soft Objections [Includes: "Not interested", "I'm busy", "I don't have money", "I'm fine as I am"]
Attempt 1: "I understand, {{first_name}}. The most successful people usually take a few minutes to listen before deciding. Could you give me five minutes?"
Attempt 2: "I'm not asking for any commitment — just a few minutes to explain why this is relevant now. Does that sound good?"
Attempt 3: "Let me ask you with total honesty: what is making you hesitate right now? My intention is not to pressure you, but to understand you."
Attempt 4: "I understand that maybe it's not the ideal time. Would you prefer we schedule a call for when you have more time?"
[If still not interested → end the call respectfully using end_call]

Specific Rebuttals
"I don't have money": "I completely understand. You can start with a minimum deposit of 200 euros to validate the system personally. It's a way to see how we operate and familiarize yourself with the dynamics. You can try the service and, after seeing the results, decide with total freedom if you want to continue."
"I have no experience": "That's no problem at all — that's exactly what our advisors are for. The platform is simple and the process is explained step by step. Would you like to see it with a specialist?"

Hard Objections [Includes: "Don't call me", "Leave me alone", "End the call"]
Attempt 1: "I understand. Before we finish, is the reason lack of time, financial situation, technical difficulty or something that wasn't clear?"
Attempt 2: "If the problem is financial, we are not forcing you to invest now. We are talking about a secondary source of income that you can start when it's convenient for you."
[If they insist → end the call immediately using end_call]

FINAL REJECTION
"That's no problem, {{first_name}}. Thank you for your time. Would you prefer we schedule a call for later or should we consider the contact closed?"
[Execute end_call]`,
  functions: [
    {
      name: "transfer_call",
      description: "Transfer the call to a human advisor when the client is qualified (KYC complete) and has given clear consent.",
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
      description: "End the call. Use when: conversation is complete, client is not interested, asks not to be contacted, or after 4 failed objection attempts.",
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
  ],
  audio: {
    input: { encoding: "linear16", sample_rate: 16000 },
    output: { encoding: "linear16", sample_rate: 24000, container: "none" },
  },
};

/**
 * ConfigStore — in-memory config with JSON persistence.
 * All agent settings are stored here and editable via dashboard API.
 */
class ConfigStore {
  constructor() {
    this._config = null;
    this._leads = [];
    this._fieldMapping = null; // { phone: "csvCol", first_name: "csvCol", ... }
    this._init();
  }

  _init() {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    this._config = this._loadJson(CONFIG_FILE, DEFAULT_CONFIG);
    this._leads = this._loadJson(LEADS_FILE, []);
    this._fieldMapping = this._loadJson(MAPPING_FILE, null);
    logger.info(`ConfigStore: loaded ${this._leads.length} leads, config from ${CONFIG_FILE}`);
  }

  _loadJson(filePath, fallback) {
    try {
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, "utf-8"));
      }
    } catch (e) {
      logger.warn(`ConfigStore: failed to load ${filePath}: ${e.message}`);
    }
    return JSON.parse(JSON.stringify(fallback));
  }

  _saveJson(filePath, data) {
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      logger.error(`ConfigStore: failed to save ${filePath}: ${e.message}`);
    }
  }

  // ---- Agent Config ----

  getConfig() {
    return this._config;
  }

  updateConfig(partial) {
    this._config = { ...this._config, ...partial };
    this._saveJson(CONFIG_FILE, this._config);
    return this._config;
  }

  resetConfig() {
    this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this._saveJson(CONFIG_FILE, this._config);
    return this._config;
  }

  // ---- Leads ----

  getLeads() {
    return this._leads;
  }

  setLeads(leads) {
    this._leads = leads;
    this._saveJson(LEADS_FILE, this._leads);
  }

  addLead(lead) {
    this._leads.push(lead);
    this._saveJson(LEADS_FILE, this._leads);
  }

  clearLeads() {
    this._leads = [];
    this._saveJson(LEADS_FILE, this._leads);
  }

  // ---- Field Mapping ----

  getFieldMapping() {
    return this._fieldMapping;
  }

  setFieldMapping(mapping) {
    this._fieldMapping = mapping;
    this._saveJson(MAPPING_FILE, this._fieldMapping);
  }

  /**
   * Apply field mapping to raw CSV rows → normalized lead objects.
   * Maps CSV columns to standard fields: phone, first_name, last_name, email, etc.
   * Also preserves all original columns as-is for {{variable}} interpolation.
   */
  applyMapping(rawRows, mapping) {
    if (!mapping) return rawRows;
    return rawRows.map((row) => {
      const lead = { _raw: { ...row } };
      for (const [standardField, csvColumn] of Object.entries(mapping)) {
        if (csvColumn && row[csvColumn] !== undefined) {
          lead[standardField] = row[csvColumn];
        }
      }
      // Also copy all raw fields for {{variable}} access
      for (const [key, val] of Object.entries(row)) {
        if (!lead[key]) lead[key] = val;
      }
      return lead;
    });
  }

  /**
   * Build the Deepgram Settings config for a specific call,
   * interpolating {{variables}} from lead data.
   */
  buildAgentSettings(lead = {}) {
    const cfg = this._config;

    const interpolate = (str) => {
      if (!str) return str;
      return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        return lead[key] || lead._raw?.[key] || match;
      });
    };

    return {
      type: "Settings",
      audio: cfg.audio,
      agent: {
        language: cfg.agent?.language || "es",
        listen: {
          provider: {
            type: cfg.stt.provider,
            model: cfg.stt.model,
          },
        },
        think: {
          provider: {
            type: cfg.llm.provider,
            model: cfg.llm.model,
          },
          prompt: interpolate(cfg.script),
          functions: cfg.functions.map((fn) => ({
            name: fn.name,
            description: fn.description,
            parameters: fn.parameters,
          })),
        },
        speak: {
          provider: {
            type: cfg.tts.provider,
            model: cfg.tts.model,
          },
        },
        greeting: interpolate(cfg.greeting),
      },
    };
  }
}

// Singleton
export const configStore = new ConfigStore();
