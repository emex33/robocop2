/**
 * Database Schema - SQLite with better-sqlite3
 * 
 * Tables: users, agents, campaigns, lists, leads, extensions, call_records
 * All entities are user-scoped for multi-tenancy.
 */

import Database from "better-sqlite3";
import path from "path";
import { existsSync, mkdirSync, copyFileSync, statSync, renameSync } from "fs";
import crypto from "crypto";

const DB_DIR = path.resolve("data");
const LEGACY_DB_PATH = path.join(DB_DIR, "robocop.db");
// The database lives on fast container-local storage (a Docker named volume,
// see docker-compose.yml) when DB_PATH is set. The old location was the
// ./data bind mount, i.e. a OneDrive-synced Windows folder: the same queries
// measured 30x slower there (6.3s vs 0.2s), and every one of those seconds
// froze the dialer because better-sqlite3 is synchronous.
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : LEGACY_DB_PATH;
export { DB_PATH };

let db;

/**
 * One-time move of the database to DB_PATH when it only exists at the legacy
 * location. Copies db + WAL + shm together so a WAL that was not checkpointed
 * before the last shutdown is not lost. The original files are left untouched.
 */
function migrateLegacyDatabase() {
  if (DB_PATH === LEGACY_DB_PATH || existsSync(DB_PATH) || !existsSync(LEGACY_DB_PATH)) return;
  const dir = path.dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  // Copy under a temporary name and rename at the end, so an interrupted copy
  // can never be mistaken for a complete database on the next boot.
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(LEGACY_DB_PATH + suffix)) copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix + ".migrating");
  }
  for (const suffix of ["-wal", "-shm", ""]) {
    if (existsSync(DB_PATH + suffix + ".migrating")) renameSync(DB_PATH + suffix + ".migrating", DB_PATH + suffix);
  }
  const mb = (statSync(DB_PATH).size / 1048576).toFixed(0);
  console.log(`[db] migrated ${mb} MB database from ${LEGACY_DB_PATH} to ${DB_PATH} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export function getDb() {
  if (!db) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    migrateLegacyDatabase();
    const dbDir = path.dirname(DB_PATH);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("wal_autocheckpoint = 1000");
    // This database is large and lives on a OneDrive-synced bind mount, where
    // checkpoints and index builds routinely take longer than a few seconds.
    // A short timeout surfaces as "database is locked" and crash-loops startup.
    db.pragma("busy_timeout = 60000");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("cache_size = -65536"); // 64 MB page cache
    db.pragma("mmap_size = 268435456"); // 256 MB mmap so dashboard reads don't hit disk
    initSchema();

    // Checkpoint WAL on startup to merge pending writes
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (_) {}

    // Periodic WAL checkpoint every 5 minutes to prevent WAL bloat, and let
    // SQLite refresh planner statistics for indexes that need it (cheap; a
    // stale sqlite_stat1 is how the planner picked a 114-second index).
    setInterval(() => {
      try { db.pragma("wal_checkpoint(PASSIVE)"); } catch (_) {}
      try { db.pragma("optimize"); } catch (_) {}
    }, 5 * 60 * 1000).unref();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      company TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mode TEXT DEFAULT 'live_transfer',
      language TEXT DEFAULT 'en',
      company TEXT DEFAULT '',
      tone TEXT DEFAULT 'professional',
      greeting TEXT DEFAULT 'Hi, am I speaking with {{first_name}}?',
      script TEXT NOT NULL DEFAULT '',
      appointment_script TEXT DEFAULT '',
      llm_provider TEXT DEFAULT 'open_ai',
      llm_model TEXT DEFAULT 'gpt-4o-mini',
      llm_temperature REAL DEFAULT 0.7,
      stt_provider TEXT DEFAULT 'deepgram',
      stt_model TEXT DEFAULT 'nova-3',
      tts_provider TEXT DEFAULT 'deepgram',
      tts_model TEXT DEFAULT 'aura-2-thalia-en',
      tts_voice_id TEXT DEFAULT '',
      tts_speed TEXT DEFAULT 'normal',
      functions_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      call_id TEXT DEFAULT '',
      lead_name TEXT DEFAULT '',
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'Europe/London',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      reminder_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'paused',
      type TEXT DEFAULT 'outbound',
      dialer_mode TEXT DEFAULT 'single',
      phone_number TEXT DEFAULT '',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      daily_start_time TEXT DEFAULT '15:00',
      daily_end_time TEXT DEFAULT '00:00',
      timezone TEXT DEFAULT 'Europe/Amsterdam',
      days_of_week TEXT DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]',
      max_concurrent_calls INTEGER DEFAULT 1,
      total_dial_attempts INTEGER DEFAULT 5,
      max_daily_attempts INTEGER DEFAULT 3,
      redial_wait_minutes INTEGER DEFAULT 5,
      campaign_priority INTEGER DEFAULT 5,
      voicemail_as_answered INTEGER DEFAULT 0,
      webhook_url TEXT DEFAULT '',
      enable_success_metric INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      extension TEXT NOT NULL,
      label TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      calls_received INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      field_mapping_json TEXT DEFAULT '{}',
      total_leads INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      company TEXT DEFAULT '',
      country TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      extra_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'new',
      do_not_call INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS campaign_lists (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      PRIMARY KEY (campaign_id, list_id)
    );

    CREATE TABLE IF NOT EXISTS call_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      lead_name TEXT DEFAULT '',
      outcome TEXT DEFAULT 'unknown',
      duration_seconds INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      transcript_json TEXT DEFAULT '[]',
      transferred_to TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      call_summary TEXT DEFAULT '',
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sip_settings (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT DEFAULT 'account',
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      server TEXT DEFAULT '',
      port INTEGER DEFAULT 12835,
      transport TEXT DEFAULT 'udp',
      caller_id TEXT DEFAULT '',
      trunk_username TEXT DEFAULT '',
      trunk_host TEXT DEFAULT '',
      trunk_port INTEGER DEFAULT 12835,
      source_ip TEXT DEFAULT '',
      transfer_uri TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sip_agents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sip_server TEXT NOT NULL,
      sip_port INTEGER DEFAULT 5060,
      sip_transport TEXT DEFAULT 'udp',
      sip_username TEXT NOT NULL,
      sip_password TEXT NOT NULL,
      sip_domain TEXT DEFAULT '',
      caller_id TEXT DEFAULT '',
      status TEXT DEFAULT 'offline',
      can_receive_transfers INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 1,
      max_concurrent_calls INTEGER DEFAULT 1,
      current_calls INTEGER DEFAULT 0,
      last_seen_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_call_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      sip_agent_id TEXT NOT NULL REFERENCES sip_agents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      direction TEXT DEFAULT 'inbound',
      remote_party TEXT NOT NULL,
      status TEXT DEFAULT 'ringing',
      started_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT DEFAULT '',
      ended_at TEXT DEFAULT '',
      duration_seconds INTEGER DEFAULT 0,
      recording_path TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      transfer_from_campaign TEXT DEFAULT '',
      transfer_from_call_id TEXT DEFAULT ''
    );

    -- Agent users table for softphone login (separate from admin users)
    CREATE TABLE IF NOT EXISTS agent_users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sip_agent_id TEXT REFERENCES sip_agents(id) ON DELETE SET NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      role TEXT DEFAULT 'agent',
      is_active INTEGER DEFAULT 1,
      last_login_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(admin_user_id, username)
    );

    CREATE INDEX IF NOT EXISTS idx_sip_settings_user ON sip_settings(user_id);
    CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);
    CREATE INDEX IF NOT EXISTS idx_extensions_campaign ON extensions(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);
    CREATE INDEX IF NOT EXISTS idx_leads_list ON leads(list_id);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
    CREATE INDEX IF NOT EXISTS idx_leads_list_status ON leads(list_id, status, do_not_call);
    CREATE INDEX IF NOT EXISTS idx_leads_list_created ON leads(list_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_list_dnc ON leads(list_id) WHERE do_not_call = 1;
    CREATE INDEX IF NOT EXISTS idx_call_records_user ON call_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_campaign ON call_records(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_outcome ON call_records(outcome);
    CREATE INDEX IF NOT EXISTS idx_call_records_campaign_outcome ON call_records(campaign_id, outcome);
    CREATE INDEX IF NOT EXISTS idx_call_records_created ON call_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_call_records_user_started ON call_records(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_call_records_user_outcome ON call_records(user_id, outcome);
    CREATE INDEX IF NOT EXISTS idx_call_records_campaign_created ON call_records(campaign_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_campaign_lists_list ON campaign_lists(list_id);
    CREATE INDEX IF NOT EXISTS idx_sip_agents_user ON sip_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_sip_agents_status ON sip_agents(status);
    CREATE INDEX IF NOT EXISTS idx_agent_call_records_agent ON agent_call_records(sip_agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_users_admin ON agent_users(admin_user_id);

    -- Billing: user credit balances
    CREATE TABLE IF NOT EXISTS user_credits (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance REAL NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Billing: audit log of all credit changes
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'topup',
      amount REAL NOT NULL DEFAULT 0,
      balance_after REAL NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      reference_id TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON credit_transactions(type);
  `);

  // Migrations: add new columns if they don't exist yet
  const agentCols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (!agentCols.includes("tts_voice_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN tts_voice_id TEXT DEFAULT ''");
  }
  if (!agentCols.includes("tts_speed")) {
    db.exec("ALTER TABLE agents ADD COLUMN tts_speed TEXT DEFAULT 'normal'");
  }
  if (!agentCols.includes("mode")) {
    db.exec("ALTER TABLE agents ADD COLUMN mode TEXT DEFAULT 'live_transfer'");
  }
  // Turn-taking (Flux end-of-turn). Deepgram's default 0.7 makes the agent jump
  // in as soon as the lead pauses for breath; 0.85 waits for a real end of turn.
  if (!agentCols.includes("eot_threshold")) {
    db.exec("ALTER TABLE agents ADD COLUMN eot_threshold REAL DEFAULT 0.85");
  }
  if (!agentCols.includes("eot_timeout_ms")) {
    db.exec("ALTER TABLE agents ADD COLUMN eot_timeout_ms INTEGER DEFAULT 5000");
  }

  // Migration: add trunk_username to sip_settings
  const sipCols = db.prepare("PRAGMA table_info(sip_settings)").all().map(c => c.name);
  if (!sipCols.includes("trunk_username")) {
    db.exec("ALTER TABLE sip_settings ADD COLUMN trunk_username TEXT DEFAULT ''");
  }

  // Migration: add name + is_default to sip_settings (multi-trunk support)
  if (!sipCols.includes("name")) {
    db.exec("ALTER TABLE sip_settings ADD COLUMN name TEXT DEFAULT 'Default'");
  }
  if (!sipCols.includes("is_default")) {
    db.exec("ALTER TABLE sip_settings ADD COLUMN is_default INTEGER DEFAULT 0");
    // Mark the first existing trunk as default
    const first = db.prepare("SELECT id FROM sip_settings LIMIT 1").get();
    if (first) db.prepare("UPDATE sip_settings SET is_default = 1 WHERE id = ?").run(first.id);
  }

  // Migration: drop UNIQUE constraint on sip_settings.user_id (allow multiple trunks per user)
  // SQLite can't drop constraints, so we recreate if needed
  const sipIdxInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sip_settings'").get();
  if (sipIdxInfo && sipIdxInfo.sql && sipIdxInfo.sql.includes("user_id TEXT NOT NULL UNIQUE")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sip_settings_new (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT DEFAULT 'Default',
        is_default INTEGER DEFAULT 0,
        mode TEXT DEFAULT 'account',
        username TEXT DEFAULT '',
        password TEXT DEFAULT '',
        server TEXT DEFAULT '',
        port INTEGER DEFAULT 12835,
        transport TEXT DEFAULT 'udp',
        caller_id TEXT DEFAULT '',
        trunk_username TEXT DEFAULT '',
        trunk_host TEXT DEFAULT '',
        trunk_port INTEGER DEFAULT 12835,
        source_ip TEXT DEFAULT '',
        transfer_uri TEXT DEFAULT '',
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO sip_settings_new SELECT id, user_id, COALESCE(name,'Default'), COALESCE(is_default,0), mode, username, password, server, port, transport, caller_id, trunk_username, trunk_host, trunk_port, source_ip, transfer_uri, updated_at FROM sip_settings;
      DROP TABLE sip_settings;
      ALTER TABLE sip_settings_new RENAME TO sip_settings;
      CREATE INDEX IF NOT EXISTS idx_sip_settings_user ON sip_settings(user_id);
    `);
  }

  // Migration: add sip_settings_id to campaigns
  const campaignCols2 = db.prepare("PRAGMA table_info(campaigns)").all().map(c => c.name);
  if (!campaignCols2.includes("sip_settings_id")) {
    db.exec("ALTER TABLE campaigns ADD COLUMN sip_settings_id TEXT DEFAULT ''");
  }

  // Migration: add recording_path to call_records
  const callCols = db.prepare("PRAGMA table_info(call_records)").all().map(c => c.name);
  if (!callCols.includes("recording_path")) {
    db.exec("ALTER TABLE call_records ADD COLUMN recording_path TEXT DEFAULT ''");
  }

  // Migration: add appointment_script to agents
  if (!agentCols.includes("appointment_script")) {
    db.exec("ALTER TABLE agents ADD COLUMN appointment_script TEXT DEFAULT ''");
  }

  // Migration: add is_super_admin to users
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes("is_super_admin")) {
    db.exec("ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0");
  }

  // Migration: add billing columns to call_records
  if (!callCols.includes("ai_duration_seconds")) {
    db.exec("ALTER TABLE call_records ADD COLUMN ai_duration_seconds REAL DEFAULT 0");
  }
  if (!callCols.includes("call_cost")) {
    db.exec("ALTER TABLE call_records ADD COLUMN call_cost REAL DEFAULT 0");
  }
  if (!callCols.includes("voip_cost")) {
    db.exec("ALTER TABLE call_records ADD COLUMN voip_cost REAL DEFAULT 0");
  }
  if (!callCols.includes("ai_cost")) {
    db.exec("ALTER TABLE call_records ADD COLUMN ai_cost REAL DEFAULT 0");
  }

  // Migration: create appointments table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      call_id TEXT DEFAULT '',
      lead_name TEXT DEFAULT '',
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'Europe/London',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      reminder_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add google_sheet_id and google_drive_folder_id to campaigns
  const campaignCols = db.prepare("PRAGMA table_info(campaigns)").all().map(c => c.name);
  if (!campaignCols.includes("google_sheet_id")) {
    db.exec("ALTER TABLE campaigns ADD COLUMN google_sheet_id TEXT DEFAULT ''");
  }
  if (!campaignCols.includes("google_drive_folder_id")) {
    db.exec("ALTER TABLE campaigns ADD COLUMN google_drive_folder_id TEXT DEFAULT ''");
  }
  // Migration: stats_since — set when a campaign is reset for a re-run. Campaign
  // counters/analytics only count call_records started at or after this time,
  // so a re-run starts from zero without deleting the old call history.
  if (!campaignCols.includes("stats_since")) {
    db.exec("ALTER TABLE campaigns ADD COLUMN stats_since TEXT DEFAULT ''");
  }

  // Migration: add google_sheets_credentials to users
  if (!userCols.includes("google_sheets_credentials")) {
    db.exec("ALTER TABLE users ADD COLUMN google_sheets_credentials TEXT DEFAULT ''");
  }

  // Migration: add recording_url to call_records
  if (!callCols.includes("recording_url")) {
    db.exec("ALTER TABLE call_records ADD COLUMN recording_url TEXT DEFAULT ''");
  }

  // Migration: add deepgram_api_key to users (per-user Deepgram key)
  if (!userCols.includes("deepgram_api_key")) {
    db.exec("ALTER TABLE users ADD COLUMN deepgram_api_key TEXT DEFAULT ''");
  }

  // Migration: deepgram_keys table for multi-key pool with 402 auto-rotation
  db.exec(`
    CREATE TABLE IF NOT EXISTS deepgram_keys (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      api_key TEXT NOT NULL,
      label TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      error_count_402 INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      last_error_at TEXT DEFAULT '',
      last_used_at TEXT DEFAULT '',
      is_current INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_deepgram_keys_user ON deepgram_keys(user_id, status)");

  // Migration: add callback tracking columns to call_records
  if (!callCols.includes("callback_status")) {
    db.exec("ALTER TABLE call_records ADD COLUMN callback_status TEXT DEFAULT ''");
  }
  if (!callCols.includes("callback_notes")) {
    db.exec("ALTER TABLE call_records ADD COLUMN callback_notes TEXT DEFAULT ''");
  }
  if (!callCols.includes("callback_at")) {
    db.exec("ALTER TABLE call_records ADD COLUMN callback_at TEXT DEFAULT ''");
  }

  // Migration: track dial attempts per lead so numbers that permanently fail
  // (disconnected, carrier-rejected) get retired instead of being re-dialed on
  // every campaign restart.
  const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
  if (!leadCols.includes("attempts")) {
    db.exec("ALTER TABLE leads ADD COLUMN attempts INTEGER DEFAULT 0");
  }
  if (!leadCols.includes("last_error")) {
    db.exec("ALTER TABLE leads ADD COLUMN last_error TEXT DEFAULT ''");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_leads_list_attempts ON leads(list_id, attempts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_leads_list_dnc ON leads(list_id) WHERE do_not_call = 1");

  // Performance indexes (Sep 2026). Each one replaces a query that was
  // measured in seconds or minutes on the production database:
  //  - idx_leads_callable: the dialer's "next leads to call" + remaining count
  //    on a 250k list went 6.3s -> 0.02s. Partial index over exactly the rows
  //    the dialer may pick, in the order it picks them. The WHERE text must
  //    stay byte-identical to the predicate in helpers.js for the planner to
  //    use it.
  //  - idx_call_records_user_created: Calls page ordered by created_at was
  //    sorting 1.3M rows through the (user_id, outcome) index: 114s -> 1ms.
  //  - idx_call_records_campaign_started: campaign analytics by day
  //    (30s -> 0.2s) and Calls page filtered by campaign; covers user_id so
  //    the filtered COUNT(*) never touches the table.
  //  - idx_call_records_user_outcome_started: Calls page filtered by outcome.
  //  - idx_credit_transactions_user_created: Billing page (1.1M rows).
  db.exec("UPDATE leads SET attempts = 0 WHERE attempts IS NULL");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_callable ON leads(list_id, attempts, created_at)
    WHERE do_not_call = 0 AND status NOT IN ('completed','contacted','callback','failed')`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_records_user_created ON call_records(user_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_records_campaign_started ON call_records(campaign_id, started_at, outcome, user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_records_user_outcome_started ON call_records(user_id, outcome, started_at)");
  // appointments.call_id → call_records.call_id (recording / summary behind a booking)
  db.exec("CREATE INDEX IF NOT EXISTS idx_call_records_call_id ON call_records(call_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_appointments_user_created ON appointments(user_id, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created ON credit_transactions(user_id, created_at)");

  // Migration: platform_settings table for dynamic cost rates
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Seed default cost rates if not set
  const seedSetting = db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)");
  seedSetting.run("voip_cost_per_min", "0.02");
  seedSetting.run("ai_cost_per_min", "0.40");
  seedSetting.run("voice_engine", "deepgram");
  seedSetting.run("local_voice_agent_url", "ws://voice-agent:8765");
  // Balance guard: pause dialing when a provider account runs dry, resume on top-up
  seedSetting.run("balance_guard_enabled", "true");
  seedSetting.run("deepgram_min_balance", "5");
  seedSetting.run("voip_min_balance", "0");
  seedSetting.run("voip_balance_api_url", "");
  seedSetting.run("voip_balance_api_key", "");
  seedSetting.run("voip_balance_json_path", "balance");
  seedSetting.run("voip_balance_manual", "");

  // Floor for retiring a Deepgram key from the pool (was 0; $5 leaves a buffer so calls never start on a dying key)
  db.prepare("UPDATE platform_settings SET value = '5' WHERE key = 'deepgram_min_balance' AND CAST(value AS REAL) < 3").run();

  // Rebuild planner statistics once after the index set changes. Without
  // fresh stats SQLite kept choosing (user_id, outcome) for an ORDER BY
  // created_at query and sorted the whole table. ~8s on the native volume.
  const ANALYZE_VERSION = "2026-09-10";
  const analyzed = db.prepare("SELECT value FROM platform_settings WHERE key = 'schema_analyze_version'").get();
  if (!analyzed || analyzed.value !== ANALYZE_VERSION) {
    const t0 = Date.now();
    db.exec("ANALYZE");
    db.prepare("INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('schema_analyze_version', ?, datetime('now'))").run(ANALYZE_VERSION);
    console.log(`[db] ANALYZE completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Seed admin user if not exists
  const admin = db.prepare("SELECT id FROM users WHERE email = 'admin'").get();
  if (!admin) {
    const id = crypto.randomBytes(8).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync("Password123123", salt, 64).toString("hex");
    db.prepare(
      "INSERT INTO users (id, email, password_hash, name, company, is_super_admin) VALUES (?, ?, ?, ?, ?, 1)"
    ).run(id, "admin", `${salt}:${hash}`, "Admin", "ROBOCOP");
  } else {
    // Ensure existing admin has super admin flag
    db.prepare("UPDATE users SET is_super_admin = 1 WHERE email = 'admin' AND (is_super_admin IS NULL OR is_super_admin = 0)").run();
  }

  // Ensure every user has a credit balance row
  db.exec(`
    INSERT OR IGNORE INTO user_credits (user_id, balance)
    SELECT id, 0 FROM users WHERE id NOT IN (SELECT user_id FROM user_credits)
  `);
}

/**
 * Hash a password with salt using scrypt.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 */
export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === derived;
}

export function generateId() {
  return crypto.randomBytes(8).toString("hex");
}
