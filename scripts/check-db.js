import { getDb } from '../src/db/schema.js';

const db = getDb();
const users = db.prepare("SELECT id, email, name FROM users").all();
console.log("Users:", JSON.stringify(users, null, 2));

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map(t => t.name).join(", "));
