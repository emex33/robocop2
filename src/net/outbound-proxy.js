import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getPlatformSetting } from "../db/helpers.js";

/**
 * Outbound proxy for Deepgram only.
 *
 * Webshare's "-rotate" username assigns a new exit IP to each TCP connection.
 * A fresh agent per call is what makes the next call leave from a different IP.
 * SIP and RTP cannot use this proxy: it rejects a connection to the trunk and
 * does not support UDP.
 */

export function getOutboundProxyUrl() {
  if (getPlatformSetting("proxy_enabled", "off") !== "on") return "";
  return (getPlatformSetting("proxy_url", "") || process.env.OUTBOUND_PROXY_URL || "").trim();
}

export function proxyDescription() {
  const url = getOutboundProxyUrl();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { host: parsed.host, protocol: parsed.protocol.replace(":", "") };
  } catch {
    return null;
  }
}

export function newProxyAgent() {
  const url = getOutboundProxyUrl();
  if (!url) return null;
  return new HttpsProxyAgent(url);
}

/** A rotating exit sometimes breaks TLS. The next connection gets a different IP. */
export function isTransientProxyError(err) {
  const msg = `${err?.code || ""} ${err?.message || ""}`;
  return /self-signed|certificate|CERT_|EPROTO|wrong version|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|EAI_AGAIN|ENETUNREACH|timed out|timeout/i.test(msg);
}

export function isDeepgramUrl(url) {
  try {
    return new URL(url).hostname === "deepgram.com" || new URL(url).hostname.endsWith(".deepgram.com");
  } catch {
    return false;
  }
}

/**
 * fetch-shaped response. Uses the rotating proxy for Deepgram when it is on,
 * and a normal connection otherwise.
 */
export function proxyFetch(url, options = {}, attempt = 1) {
  const timeoutMs = options.timeoutMs || 15000;
  const agent = isDeepgramUrl(url) || options.forceProxy ? newProxyAgent() : null;
  if (!agent) {
    const { timeoutMs: _drop, forceProxy: _force, ...rest } = options;
    return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || "GET",
      headers: options.headers,
      agent,
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || "",
          json: async () => JSON.parse(body),
          text: async () => body,
        });
      });
    });
    req.on("error", (err) => {
      if (attempt < 3 && isTransientProxyError(err)) {
        resolve(proxyFetch(url, options, attempt + 1));
        return;
      }
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Two exit IPs through the saved proxy. A bad exit is skipped and another IP is tried. */
export async function probeProxyRotation() {
  const url = getOutboundProxyUrl();
  if (!url) throw new Error("Proxy is off or no proxy URL is saved");
  const once = () => new Promise((resolve, reject) => {
    const req = https.request("https://ipv4.webshare.io/", {
      agent: new HttpsProxyAgent(url),
      signal: AbortSignal.timeout(15000),
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").trim();
        if (res.statusCode === 200 && /^\d{1,3}(\.\d{1,3}){3}$/.test(body)) resolve(body);
        else reject(new Error(`Proxy check returned ${res.statusCode || "no status"}`));
      });
    });
    req.on("error", reject);
    req.end();
  });

  const ips = [];
  let lastError = null;
  for (let attempt = 0; attempt < 6 && ips.length < 2; attempt++) {
    try {
      const ip = await once();
      if (!ips.includes(ip)) ips.push(ip);
    } catch (err) {
      lastError = err;
    }
  }
  if (ips.length < 2) {
    throw new Error(lastError?.message || "Proxy did not return two exit IPs");
  }
  return { ips, rotated: true };
}
