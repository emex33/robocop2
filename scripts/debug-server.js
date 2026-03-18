import express from 'express';
import { getDb } from '../src/db/schema.js';

// Initialize DB
getDb();

// Test importing routes
console.log("Importing auth routes...");
const authMod = await import('../src/api/auth.js');
console.log("auth default export type:", typeof authMod.default);
console.log("auth default export:", authMod.default);

console.log("Importing agents routes...");
const agentsMod = await import('../src/api/agents.js');
console.log("agents default export type:", typeof agentsMod.default);

const app = express();
app.use(express.json());

// Mount manually
app.use("/api/auth", authMod.default);

app.listen(3000, () => {
  console.log("Test server on http://localhost:3000");
});
