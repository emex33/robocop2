/**
 * Auth Module - JWT-based authentication
 */

import jwt from "jsonwebtoken";
import { getDb, hashPassword, verifyPassword, generateId } from "./schema.js";

const JWT_SECRET = process.env.JWT_SECRET || "robocop-secret-change-me";
const JWT_EXPIRES = "7d";

/**
 * Register a new user.
 */
export function registerUser(email, password, name, company = "") {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new Error("Email already registered");

  const id = generateId();
  const passwordHash = hashPassword(password);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, name, company) VALUES (?, ?, ?, ?, ?)"
  ).run(id, email.toLowerCase(), passwordHash, name, company);

  // Initialize credit balance for new user
  db.prepare("INSERT OR IGNORE INTO user_credits (user_id, balance) VALUES (?, 0)").run(id);

  return { id, email: email.toLowerCase(), name, company };
}

/**
 * Login and return JWT token.
 */
export function loginUser(email, password) {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (!user) throw new Error("Invalid email or password");

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error("Invalid email or password");
  }

  const isSuperAdmin = user.is_super_admin === 1;
  const token = jwt.sign(
    { userId: user.id, email: user.email, name: user.name, isSuperAdmin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  return {
    token,
    user: { id: user.id, email: user.email, name: user.name, company: user.company, isSuperAdmin },
  };
}

/**
 * Express middleware to verify JWT token.
 * Adds req.user = { userId, email, name }
 */
export function authMiddleware(req, res, next) {
  let token = null;

  // Try Authorization header first
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    token = header.slice(7);
  }

  // Fallback: token from query param (for CSV export / direct browser download)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Agent tokens use adminUserId instead of userId — normalize so API routes work
    if (decoded.adminUserId && !decoded.userId) {
      decoded.userId = decoded.adminUserId;
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Express middleware to require super admin access.
 */
export function superAdminMiddleware(req, res, next) {
  if (!req.user || !req.user.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}

/**
 * Get user profile.
 */
export function getUserProfile(userId) {
  const db = getDb();
  const user = db.prepare("SELECT id, email, name, company, is_super_admin, created_at FROM users WHERE id = ?").get(userId);
  if (user) {
    user.isSuperAdmin = user.is_super_admin === 1;
  }
  return user;
}

/**
 * Update user profile.
 */
export function updateUserProfile(userId, updates) {
  const db = getDb();
  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.company !== undefined) { fields.push("company = ?"); values.push(updates.company); }
  if (updates.password) {
    fields.push("password_hash = ?");
    values.push(hashPassword(updates.password));
  }
  if (fields.length === 0) return getUserProfile(userId);

  fields.push("updated_at = datetime('now')");
  values.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getUserProfile(userId);
}
