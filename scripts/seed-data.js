/**
 * Seed script - populates the database with sample data
 * Agents, Campaigns, Lists, Leads, Extensions, Call Records
 */

import { getDb, generateId, hashPassword } from '../src/db/schema.js';

const db = getDb();

// Get admin user
const admin = db.prepare("SELECT id FROM users WHERE email = 'admin'").get();
if (!admin) { console.error("Admin user not found. Run the app first."); process.exit(1); }
const userId = admin.id;

console.log("Seeding data for admin user:", userId);

// ===== AGENTS =====
const agents = [
  {
    id: generateId(),
    name: "Sophie Hernandez",
    language: "en",
    company: "Asset Management Ltd",
    tone: "professional",
    greeting: "Hi, am I speaking with {{first_name}}?",
    script: `You are Sophie Hernandez, a senior financial advisor at Asset Management Ltd. Your goal is to qualify leads for online trading investment opportunities.\n\nRULES:\n- Be professional but friendly\n- Ask about their financial goals\n- Qualify: age, employment, income, investment goals\n- If interested, transfer to a senior advisor\n- If not interested, politely end the call\n\nUse transfer_call when the lead is qualified and interested.\nUse end_call when the lead is not interested or asks to stop.`,
    llm_provider: "open_ai",
    llm_model: "gpt-4o-mini",
    stt_provider: "deepgram",
    stt_model: "nova-3",
    tts_provider: "deepgram",
    tts_model: "aura-2-thalia-en",
  },
  {
    id: generateId(),
    name: "James Mitchell",
    language: "en",
    company: "TechVentures Inc",
    tone: "friendly",
    greeting: "Hey {{first_name}}, this is James from TechVentures, how are you today?",
    script: `You are James Mitchell from TechVentures Inc. You help people explore tech startup investment opportunities.\n\nBe casual and friendly. Ask about their tech interests and investment appetite. If they're qualified, transfer them.`,
    llm_provider: "open_ai",
    llm_model: "gpt-4o-mini",
    stt_provider: "deepgram",
    stt_model: "nova-3",
    tts_provider: "deepgram",
    tts_model: "aura-2-thalia-en",
  },
  {
    id: generateId(),
    name: "Maria Garcia",
    language: "es",
    company: "Inversiones Globales",
    tone: "empathetic",
    greeting: "Hola, ¿hablo con {{first_name}}?",
    script: `Eres Maria Garcia de Inversiones Globales. Ayudas a personas a explorar oportunidades de inversión. Sé empática y profesional.`,
    llm_provider: "open_ai",
    llm_model: "gpt-4o-mini",
    stt_provider: "deepgram",
    stt_model: "nova-3",
    tts_provider: "deepgram",
    tts_model: "aura-2-thalia-en",
  },
];

const defaultFunctions = JSON.stringify([
  { name: "transfer_call", description: "Transfer the call to a human advisor", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "end_call", description: "End the call", parameters: { type: "object", properties: { outcome: { type: "string" }, notes: { type: "string" } }, required: ["outcome"] } },
]);

for (const a of agents) {
  db.prepare(`INSERT OR IGNORE INTO agents (id, user_id, name, language, company, tone, greeting, script, llm_provider, llm_model, stt_provider, stt_model, tts_provider, tts_model, functions_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.id, userId, a.name, a.language, a.company, a.tone, a.greeting, a.script,
    a.llm_provider, a.llm_model, a.stt_provider, a.stt_model, a.tts_provider, a.tts_model, defaultFunctions
  );
}
console.log(`✓ ${agents.length} agents created`);

// ===== LISTS =====
const lists = [
  { id: generateId(), name: "UK Leads - March 2026", description: "UK-based leads for financial services" },
  { id: generateId(), name: "Spain Leads Q1", description: "Spanish-speaking leads" },
  { id: generateId(), name: "Tech Investors", description: "People interested in tech investments" },
];

for (const l of lists) {
  db.prepare("INSERT OR IGNORE INTO lists (id, user_id, name, description) VALUES (?, ?, ?, ?)")
    .run(l.id, userId, l.name, l.description);
}
console.log(`✓ ${lists.length} lists created`);

// ===== LEADS =====
const sampleLeads = [
  { first_name: "Amadou", last_name: "Diack", phone: "34632578253", email: "amadou.diack@email.com", company: "Self-employed", country: "ES", extra: { age: "50", job: "working in a company", income: "around 300 euro", goal: "explore trading" } },
  { first_name: "Julio", last_name: "Nietocid", phone: "34649804255", email: "julio.n@gmail.com", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "clarify account" } },
  { first_name: "Leon", last_name: "Olariu", phone: "34642689248", email: "leon.olariu@hotmail.com", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "start trading online" } },
  { first_name: "Carlos", last_name: "Revuelta Martinez", phone: "34616767691", email: "carlos.rm@outlook.com", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "start trading" } },
  { first_name: "Christian", last_name: "Raman Aranda", phone: "34624045708", email: "c.raman@email.com", company: "", country: "ES", extra: { age: "35", job: "working in the field", income: "1000-1200", goal: "maximize investments" } },
  { first_name: "Carlos", last_name: "Luis Orosco", phone: "34695301084", email: "carlos.orosco@email.com", company: "", country: "ES", extra: { age: "60", job: "Almost retired", income: "Around 1000", goal: "" } },
  { first_name: "Lili", last_name: "Arriaga Romana", phone: "34641192365", email: "", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "Learn about AI" } },
  { first_name: "Juan", last_name: "Carlos Perez", phone: "34643439490", email: "jcperez@email.com", company: "", country: "ES", extra: { age: "65", job: "Jubilado", income: "Mil quinientos eu", goal: "Ganar dinero" } },
  { first_name: "Jhoarismeth", last_name: "P.", phone: "34671934998", email: "jhoaris@gmail.com", company: "", country: "ES", extra: { age: "", job: "Autónomo", income: "1300", goal: "Informarse como" } },
  { first_name: "Rosina", last_name: "Santiago", phone: "34646157243", email: "rosina.s@email.com", company: "", country: "ES", extra: { age: "50", job: "auxiliar", income: "unos mil quinientos", goal: "maximizar el ren" } },
  { first_name: "Abou", last_name: "Naka", phone: "34632282095", email: "", company: "", country: "ES", extra: { age: "41", job: "Working", income: "1300", goal: "Achieve financial" } },
  { first_name: "Ramon", last_name: "Grasolet Serra", phone: "34617378873", email: "ramon.gs@outlook.com", company: "", country: "ES", extra: { age: "49", job: "profesor de auto", income: "entre tres y cinco", goal: "formarse, apren" } },
  { first_name: "Johan", last_name: "Rivas", phone: "34676230328", email: "johan.rivas@email.com", company: "", country: "ES", extra: { age: "44", job: "Automoción", income: "Mil cuatrocientos", goal: "Trader profesión" } },
  { first_name: "Daymar", last_name: "Cadenas", phone: "34641439523", email: "daymar.c@email.com", company: "", country: "ES", extra: { age: "48", job: "Encargada de ur", income: "Mil quinientos", goal: "Aumentar mis ah" } },
  { first_name: "Aaron", last_name: "Pastor Carmona", phone: "34652519275", email: "aaron.pc@email.com", company: "", country: "ES", extra: { age: "39", job: "Electrician", income: "1450", goal: "Buscar resultados" } },
  { first_name: "Pedro", last_name: "Alberto Martin C", phone: "34617720733", email: "", company: "", country: "ES", extra: { age: "54", job: "Tengo una asec", income: "2100 euros", goal: "maximizar el ren" } },
  { first_name: "Aleixa", last_name: "Doylin Garry", phone: "34645763292", email: "aleixa.dg@gmail.com", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "To start online tra" } },
  { first_name: "Saul", last_name: "Makuel Zhumi P", phone: "34624961461", email: "saul.mz@email.com", company: "", country: "ES", extra: { age: "66", job: "Not currently wor", income: "570 euros", goal: "Maximize investm" } },
  { first_name: "Malena", last_name: "Callpa Rodriguez", phone: "34663735550", email: "", company: "", country: "ES", extra: { age: "48", job: "camarera", income: "mil doscientos", goal: "maximizar el ren" } },
  { first_name: "Carlos", last_name: "Galeano", phone: "34615363485", email: "carlos.g@email.com", company: "", country: "ES", extra: { age: "50", job: "carpentry", income: "800-1000 euros", goal: "grow economical" } },
  { first_name: "Gregory", last_name: "Villarreal", phone: "34613580623", email: "greg.v@email.com", company: "", country: "ES", extra: { age: "38", job: "construction", income: "minimum wage", goal: "to have an extra" } },
  { first_name: "Souleymane", last_name: "Coulibaly Coulol", phone: "34632987864", email: "", company: "", country: "ES", extra: { age: "", job: "", income: "", goal: "To learn about ar" } },
  { first_name: "Josep", last_name: "Ma Morales Pol", phone: "34678483298", email: "josep.mp@email.com", company: "", country: "ES", extra: { age: "84", job: "", income: "pension", goal: "to understand on" } },
  { first_name: "Melioda", last_name: "Natsu Dragneel I", phone: "34684226089", email: "melioda@email.com", company: "", country: "ES", extra: { age: "29", job: "Auxiliar de cocin", income: "200 euros", goal: "Comenzar a inve" } },
  { first_name: "Kemiras", last_name: "Jimeno", phone: "34699679148", email: "", company: "", country: "ES", extra: { age: "32", job: "Logistica", income: "Mil seiscientos", goal: "Maximizar el ren" } },
  { first_name: "Meritxell", last_name: "Morral", phone: "34636003281", email: "meritxell.m@email.com", company: "", country: "ES", extra: { age: "", job: "Working", income: "", goal: "To receive perso" } },
  { first_name: "Antonio", last_name: "Plaza", phone: "34606361820", email: "antonio.p@email.com", company: "", country: "ES", extra: { age: "83", job: "owns several bu", income: "unstable, current", goal: "to explore tradi" } },
  { first_name: "David", last_name: "Thompson", phone: "447520656059", email: "david.t@email.co.uk", company: "Barclays", country: "GB", extra: { age: "42", job: "Financial Analyst", income: "55000 GBP", goal: "diversify portfolio" } },
  { first_name: "Emma", last_name: "Wilson", phone: "447891234567", email: "emma.w@outlook.com", company: "NHS", country: "GB", extra: { age: "35", job: "Nurse", income: "32000 GBP", goal: "passive income" } },
  { first_name: "James", last_name: "Brown", phone: "447700123456", email: "j.brown@gmail.com", company: "Self-employed", country: "GB", extra: { age: "51", job: "Plumber", income: "45000 GBP", goal: "retirement savings" } },
];

// Split leads across lists
const leadsPerList = Math.ceil(sampleLeads.length / lists.length);
for (let i = 0; i < sampleLeads.length; i++) {
  const listIdx = Math.floor(i / leadsPerList);
  const listId = lists[Math.min(listIdx, lists.length - 1)].id;
  const l = sampleLeads[i];
  db.prepare(`INSERT INTO leads (id, list_id, phone, first_name, last_name, email, company, country, extra_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    generateId(), listId, l.phone, l.first_name, l.last_name, l.email || "", l.company || "", l.country || "",
    JSON.stringify(l.extra), i % 3 === 0 ? "called" : "new"
  );
}

// Update list counts
for (const l of lists) {
  const cnt = db.prepare("SELECT COUNT(*) as c FROM leads WHERE list_id = ?").get(l.id);
  db.prepare("UPDATE lists SET total_leads = ? WHERE id = ?").run(cnt.c, l.id);
}
console.log(`✓ ${sampleLeads.length} leads created across ${lists.length} lists`);

// ===== CAMPAIGNS =====
const campaigns = [
  {
    id: generateId(),
    name: "Spain Outbound Q1 2026",
    agent_id: agents[0].id,
    status: "paused",
    type: "outbound",
    daily_start_time: "10:00",
    daily_end_time: "19:00",
    timezone: "Europe/Madrid",
    max_concurrent_calls: 2,
    list_ids: [lists[0].id, lists[1].id],
    extensions: ["676", "677", "678"],
  },
  {
    id: generateId(),
    name: "UK Tech Investors",
    agent_id: agents[1].id,
    status: "running",
    type: "outbound",
    daily_start_time: "09:00",
    daily_end_time: "18:00",
    timezone: "Europe/London",
    max_concurrent_calls: 1,
    list_ids: [lists[2].id],
    extensions: ["501", "502"],
  },
  {
    id: generateId(),
    name: "Spanish Campaign",
    agent_id: agents[2].id,
    status: "draft",
    type: "outbound",
    daily_start_time: "10:00",
    daily_end_time: "20:00",
    timezone: "Europe/Madrid",
    max_concurrent_calls: 3,
    list_ids: [lists[1].id],
    extensions: ["700", "701", "702", "703"],
  },
];

for (const c of campaigns) {
  db.prepare(`INSERT OR IGNORE INTO campaigns (id, user_id, name, agent_id, status, type, daily_start_time, daily_end_time, timezone, max_concurrent_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.id, userId, c.name, c.agent_id, c.status, c.type, c.daily_start_time, c.daily_end_time, c.timezone, c.max_concurrent_calls
  );

  // Assign lists
  for (const lid of c.list_ids) {
    db.prepare("INSERT OR IGNORE INTO campaign_lists (campaign_id, list_id) VALUES (?, ?)").run(c.id, lid);
  }

  // Add extensions
  for (const ext of c.extensions) {
    db.prepare("INSERT OR IGNORE INTO extensions (id, campaign_id, extension, active) VALUES (?, ?, ?, 1)")
      .run(generateId(), c.id, ext);
  }
}
console.log(`✓ ${campaigns.length} campaigns created with extensions`);

// ===== CALL RECORDS (with transferred leads) =====
const outcomes = ["transferred", "transferred", "transferred", "interested", "not_interested", "lead_hangup", "no_answer", "callback", "error", "transferred"];
const summaries = [
  "The agent contacted Amadou to discuss online trading opportunities. Client showed strong interest in forex trading, mentioned having some prior experience. Was successfully transferred to a senior advisor for account setup.",
  "The agent Sophie called Julio to discuss investment opportunities. The client expressed interest in learning about cryptocurrency trading. Mentioned having savings of around 2000 euros. Client was qualified and transferred to advisor.",
  "The agent contacted Leon to explain online trading. Client was curious about minimum investment amounts. Showed interest after learning about demo accounts. Successfully transferred.",
  "The agent Sophie contacted Carlos to explain online trading. Client showed moderate interest but wanted more information first.",
  "The agent contacted Christian. Client was not interested at this time, mentioned being too busy with work.",
  "The agent called Carlos Luis. Client listened briefly then hung up.",
  "Call to Lili - no answer after 30 seconds.",
  "The agent Sophie Hernandez contacted Juan to discuss investment. Client requested a callback next week.",
  "Call to Jhoarismeth failed due to network error.",
  "The agent contacted Rosina about investment opportunities. Client was very interested in trading, already had experience with stocks. Age 50, works as auxiliary. Successfully transferred to senior advisor for premium account.",
  "The agent Sophie contacted Abou. Client interested in achieving financial independence. Works full-time, earning 1300. Transferred for account opening.",
  "The agent contacted Ramon about auto trading. Client is a driving instructor earning between 3-5k. Very interested in learning. Transferred.",
  "The agent contacted Johan about trading. Client works in automotive, earns around 1400. Wants to become a professional trader. Transferred to advisor.",
  "The agent contacted Daymar. Works in urban planning, earns around 1500. Wants to grow savings. Transferred.",
  "The agent contacted Aaron. Electrician earning 1450. Looking for better returns on savings. Successfully transferred.",
  "The agent contacted Pedro. Owns a business, earns about 2100 euros. Interested in diversifying. Transferred.",
  "The agent contacted David Thompson from UK. Financial analyst at Barclays, earns 55k GBP. Wants to diversify portfolio into tech. Transferred to senior advisor.",
  "The agent contacted Emma Wilson. NHS nurse earning 32k GBP. Interested in passive income streams. Transferred.",
  "The agent contacted James Brown. Self-employed plumber, 45k GBP. Looking for retirement savings options. Transferred.",
  "The agent contacted Gregory. Construction worker on minimum wage. Wants extra income. Showed interest but not yet transferred.",
];

const now = new Date();
for (let i = 0; i < 30; i++) {
  const leadIdx = i % sampleLeads.length;
  const lead = sampleLeads[leadIdx];
  const campaignIdx = i % campaigns.length;
  const campaign = campaigns[campaignIdx];
  const outcome = outcomes[i % outcomes.length];
  const daysAgo = Math.floor(i / 3);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysAgo);
  startDate.setHours(10 + (i % 9), (i * 7) % 60, (i * 13) % 60);

  const duration = outcome === "no_answer" ? 0 : 30 + Math.floor(Math.random() * 180);
  const endDate = new Date(startDate.getTime() + duration * 1000);

  const transcript = outcome === "no_answer" ? [] : [
    { role: "agent", text: `Hi, am I speaking with ${lead.first_name}?` },
    { role: "user", text: `Yes, this is ${lead.first_name}.` },
    { role: "agent", text: "Great! I'm calling from Asset Management Ltd regarding some exciting investment opportunities. Do you have a moment?" },
    { role: "user", text: outcome === "not_interested" ? "No, I'm not interested, thank you." : "Sure, tell me more." },
    ...(outcome === "transferred" ? [
      { role: "agent", text: "Wonderful! Could you tell me a bit about your current financial goals?" },
      { role: "user", text: lead.extra.goal || "I want to learn about investing." },
      { role: "agent", text: "That's great. And what do you do for work, if you don't mind me asking?" },
      { role: "user", text: lead.extra.job || "I work in the private sector." },
      { role: "agent", text: "I think you'd be a great fit for our premium advisory service. Let me connect you with one of our senior advisors right now." },
      { role: "user", text: "Yes, please do!" },
    ] : []),
  ];

  db.prepare(`INSERT INTO call_records (id, campaign_id, agent_id, lead_id, user_id, call_id, phone, lead_name, outcome, duration_seconds, notes, transcript_json, transferred_to, call_summary, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    generateId(),
    campaign.id,
    campaign.agent_id,
    null,
    userId,
    `call-${generateId().slice(0, 8)}`,
    lead.phone,
    `${lead.first_name} ${lead.last_name}`,
    outcome,
    duration,
    outcome === "transferred" ? "Lead qualified and transferred" : "",
    JSON.stringify(transcript),
    outcome === "transferred" ? campaign.extensions[i % campaign.extensions.length] : "",
    summaries[i % summaries.length],
    startDate.toISOString(),
    endDate.toISOString()
  );
}
console.log("✓ 30 call records created (including transferred leads)");

console.log("\n=== SEED COMPLETE ===");
console.log(`Users: 1 (admin)`);
console.log(`Agents: ${agents.length}`);
console.log(`Lists: ${lists.length}`);
console.log(`Leads: ${sampleLeads.length}`);
console.log(`Campaigns: ${campaigns.length}`);
console.log(`Call Records: 30`);
