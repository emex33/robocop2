/**
 * Deepgram API Key Manager
 *
 * Manages a pool of Deepgram API keys per user.
 * A key at or below the low-balance floor is retired immediately and the next
 * healthy key is selected — getKey() is a local DB read, so the swap does not
 * delay the call. A single 402 also retires the key on the spot (no wait).
 */

import { getDb } from "../db/schema.js";
import logger from "../utils/logger.js";

const ERROR_THRESHOLD = 1;

class DeepgramKeyManager {
  /**
   * Get the current active key for a user.
   * Priority: current key from pool > legacy single key from users table > env var
   */
  getKey(userId) {
    const db = getDb();

    const current = db.prepare(
      "SELECT * FROM deepgram_keys WHERE user_id = ? AND is_current = 1 AND status = 'active' LIMIT 1"
    ).get(userId);
    if (current) return { id: current.id, key: current.api_key, label: current.label, source: "pool" };

    const firstActive = db.prepare(
      "SELECT * FROM deepgram_keys WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC LIMIT 1"
    ).get(userId);
    if (firstActive) {
      db.prepare("UPDATE deepgram_keys SET is_current = 1 WHERE id = ?").run(firstActive.id);
      return { id: firstActive.id, key: firstActive.api_key, label: firstActive.label, source: "pool" };
    }

    const userRow = db.prepare("SELECT deepgram_api_key FROM users WHERE id = ?").get(userId);
    if (userRow?.deepgram_api_key) {
      return { id: null, key: userRow.deepgram_api_key, label: "Legacy (single key)", source: "legacy" };
    }

    if (process.env.DEEPGRAM_API_KEY) {
      return { id: null, key: process.env.DEEPGRAM_API_KEY, label: "Environment variable", source: "env" };
    }

    return null;
  }

  /**
   * Report a successful call — resets the error counter for the current key.
   */
  reportSuccess(userId, keyId) {
    if (!keyId) return;
    const db = getDb();
    db.prepare(
      "UPDATE deepgram_keys SET error_count_402 = 0, last_used_at = datetime('now') WHERE id = ?"
    ).run(keyId);
  }

  /**
   * Report a 402 error. Increments counter and auto-rotates if threshold reached.
   * Uses atomic UPDATE to prevent race conditions with concurrent calls.
   * Returns the new key info if rotated, or null if no keys left.
   */
  report402(userId, keyId) {
    const db = getDb();

    if (!keyId) {
      logger.warn(`Deepgram 402 on non-pool key for user ${userId} — cannot auto-rotate`);
      return null;
    }

    const key = db.prepare("SELECT * FROM deepgram_keys WHERE id = ?").get(keyId);
    if (!key || key.status !== "active") return null;

    // Atomic increment — avoids race condition with concurrent calls
    db.prepare(
      "UPDATE deepgram_keys SET error_count_402 = error_count_402 + 1, last_error = '402 Payment Required', last_error_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).run(keyId);

    const updated = db.prepare("SELECT error_count_402 FROM deepgram_keys WHERE id = ?").get(keyId);
    const newCount = updated.error_count_402;

    logger.warn(`Deepgram 402 on key "${key.label || key.id}" (${newCount}/${ERROR_THRESHOLD})`, { userId });

    if (newCount >= ERROR_THRESHOLD) {
      return this.retireKey(userId, keyId, "402 Payment Required");
    }

    return { id: keyId, key: key.api_key, label: key.label, source: "pool", rotated: false };
  }

  /**
   * Report a 401 error — key is invalid/deactivated, mark it immediately.
   * Only acts if key is still active (prevents cascading from concurrent calls).
   */
  report401(userId, keyId) {
    if (!keyId) return null;
    const db = getDb();

    const changed = db.prepare(
      "UPDATE deepgram_keys SET status = 'invalid', is_current = 0, last_error = '401 Unauthorized', last_error_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).run(keyId);

    if (changed.changes === 0) return this.getKey(userId);

    logger.error(`Key "${keyId}" marked INVALID (401 Unauthorized)`, { userId });
    return this._rotateToNext(userId, keyId);
  }

  /**
   * Take a key out of the rotation pool and switch current to the next healthy one.
   * Does not delete the row (so a later top-up can reactivate it). Instant — no HTTP.
   */
  retireKey(userId, keyId, reason = "Low balance") {
    if (!keyId) return this.getKey(userId);
    const db = getDb();
    const key = db.prepare("SELECT * FROM deepgram_keys WHERE id = ?").get(keyId);
    const changed = db.prepare(
      "UPDATE deepgram_keys SET status = 'depleted', is_current = 0, last_error = ?, last_error_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).run(reason, keyId);

    if (changed.changes > 0) {
      logger.warn(`Deepgram key "${key?.label || keyId}" retired from pool (${reason}) — switching to a healthy key`, { userId });
      return this._rotateToNext(userId, keyId);
    }
    return this.getKey(userId);
  }

  /**
   * Rotate to the next active key after the current one fails.
   */
  _rotateToNext(userId, failedKeyId) {
    const db = getDb();

    db.prepare("UPDATE deepgram_keys SET is_current = 0 WHERE user_id = ?").run(userId);

    const next = db.prepare(
      "SELECT * FROM deepgram_keys WHERE user_id = ? AND status = 'active' AND id != ? ORDER BY created_at ASC LIMIT 1"
    ).get(userId, failedKeyId);

    if (next) {
      db.prepare("UPDATE deepgram_keys SET is_current = 1 WHERE id = ?").run(next.id);
      logger.info(`Rotated to key "${next.label || next.id}" for user ${userId}`, { userId });
      return { id: next.id, key: next.api_key, label: next.label, source: "pool", rotated: true };
    }

    logger.error(`No active Deepgram keys remaining for user ${userId}!`, { userId });
    return null;
  }

  /**
   * Get all keys for a user (for dashboard display).
   */
  getAllKeys(userId) {
    const db = getDb();
    return db.prepare(
      "SELECT id, label, status, error_count_402, last_error, last_error_at, last_used_at, is_current, created_at, SUBSTR(api_key, 1, 6) || '...' || SUBSTR(api_key, -4) as masked_key FROM deepgram_keys WHERE user_id = ? ORDER BY is_current DESC, created_at ASC"
    ).all(userId);
  }

  /**
   * Get status summary for a user.
   */
  getStatus(userId) {
    const db = getDb();
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'depleted' THEN 1 ELSE 0 END) as depleted,
        SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused
      FROM deepgram_keys WHERE user_id = ?
    `).get(userId);

    const current = this.getKey(userId);
    return { ...stats, currentKey: current ? { id: current.id, label: current.label, source: current.source } : null };
  }

  /**
   * Reactivate a depleted key (e.g., after adding credits on Deepgram).
   */
  reactivateKey(keyId, userId) {
    const db = getDb();
    db.prepare(
      "UPDATE deepgram_keys SET status = 'active', error_count_402 = 0, last_error = '' WHERE id = ? AND user_id = ?"
    ).run(keyId, userId);
  }
}

export const deepgramKeyManager = new DeepgramKeyManager();
