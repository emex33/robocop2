/**
 * Event-loop stall monitor.
 *
 * Every live call streams RTP from a 20 ms timer on the main thread. Anything
 * that blocks the event loop for more than ~100 ms (a synchronous SQL query on
 * a 1.3M-row table, a sync filesystem scan on the bind mount, a huge JSON
 * parse) freezes the audio of EVERY active call for that long. This module
 * measures those stalls and names the most likely culprit — the API request or
 * background job that was running when the stall happened — so they can be
 * fixed instead of guessed at.
 */
import logger from "./logger.js";

const CHECK_MS = 50;
const WARN_MS = 250;

let lastActivity = "startup";
let lastActivityAt = Date.now();
let started = false;

/** Record what is about to run on the main thread (API route, job name). */
export function noteActivity(label) {
  lastActivity = label;
  lastActivityAt = Date.now();
}

/** Express middleware: tag each request so stalls can be attributed to it. */
export function activityMiddleware(req, res, next) {
  noteActivity(`${req.method} ${req.originalUrl.split("?")[0]}`);
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    if (ms > 1000) logger.warn(`[slow-request] ${req.method} ${req.originalUrl.split("?")[0]} took ${ms} ms`);
  });
  next();
}

export function startLoopMonitor() {
  if (started) return;
  started = true;
  let last = Date.now();
  let worst = 0, count = 0;
  setInterval(() => {
    const now = Date.now();
    const lag = now - last - CHECK_MS;
    last = now;
    if (lag > WARN_MS) {
      count++;
      if (lag > worst) worst = lag;
      const ago = now - lastActivityAt;
      logger.warn(`[event-loop] blocked ${lag} ms — last activity: ${lastActivity} (${ago} ms ago)`);
    }
  }, CHECK_MS).unref();
  setInterval(() => {
    if (count) {
      logger.warn(`[event-loop] last hour: ${count} stalls >${WARN_MS} ms, worst ${worst} ms`);
      count = 0; worst = 0;
    }
  }, 3600_000).unref();
}
