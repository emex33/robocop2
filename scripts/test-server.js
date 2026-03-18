// Quick test: just start the dashboard server without SIP
import { DashboardServer } from '../src/dashboard/server-new.js';
import { getDb } from '../src/db/schema.js';

getDb();
console.log("DB ready");

const dash = new DashboardServer(3000);
dash.start().then(() => {
  console.log("Server listening on http://localhost:3000");
}).catch(err => {
  console.error("Failed to start:", err);
});
