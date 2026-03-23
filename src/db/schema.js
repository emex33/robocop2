/**
 * Database Schema - SQLite with better-sqlite3
 * 
 * Tables: users, agents, campaigns, lists, leads, extensions, call_records
 * All entities are user-scoped for multi-tenancy.
 */

import Database from "better-sqlite3";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import crypto from "crypto";

const DB_DIR = path.resolve("data");
const DB_PATH = path.join(DB_DIR, "robocop.db");

let db;

export function getDb() {
  if (!db) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
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
      daily_start_time TEXT DEFAULT '10:00',
      daily_end_time TEXT DEFAULT '19:00',
      timezone TEXT DEFAULT 'Europe/London',
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
    CREATE INDEX IF NOT EXISTS idx_call_records_user ON call_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_campaign ON call_records(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_outcome ON call_records(outcome);
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
