import { getDb } from '../src/db/schema.js';
getDb();

import { DashboardServer } from '../src/dashboard/server-new.js';
const dash = new DashboardServer(3001);

// Log all registered routes
function printRoutes(app) {
  app._router.stack.forEach(r => {
    if (r.route) {
      console.log(`ROUTE: ${Object.keys(r.route.methods).join(',')} ${r.route.path}`);
    } else if (r.name === 'router') {
      console.log(`ROUTER at ${r.regexp}`);
    } else {
      console.log(`MIDDLEWARE: ${r.name}`);
    }
  });
}

await dash.start();
console.log("Server on http://localhost:3001");
printRoutes(dash.app);
