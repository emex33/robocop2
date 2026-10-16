import Srf from "drachtio-srf";
import net from "net";
import os from "os";
import logger from "../utils/logger.js";
import { getDrachtioConfig, getSipConfig } from "../../config/sip.js";
import { reportTrunkSuccess, reportTrunkFailure } from "../billing/balance-guard.js";

function isPublicIpv4(ip) {
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) return false;
  const [a, b] = ip.trim().split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return true;
}

const sipLogBurst = { code: 0, count: 0, start: 0 };
function logSipFailure(phoneNumber, err) {
  const status = Number(err.status) || 0;
  const line = `Failed to call ${phoneNumber}: ${err.status || err.message}${err.reason ? ` (${err.reason})` : ""}`;
  if (status !== 486 && status !== 503) {
    logger.error(line);
    return;
  }
  const now = Date.now();
  if (sipLogBurst.code !== status || now - sipLogBurst.start > 60_000) {
    sipLogBurst.code = status;
    sipLogBurst.count = 0;
    sipLogBurst.start = now;
  }
  sipLogBurst.count++;
  if (sipLogBurst.count === 1 || sipLogBurst.count === 8) logger.error(line);
}

function canReach(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/**
 * SIP Dialer - connects to drachtio-server and manages outbound SIP calls.
 * 
 * Handles:
 * - Connection to drachtio-server via ESL-like TCP
 * - SIP REGISTER with your SIP provider (account mode)
 * - IP-based trunk authentication (trunk mode, no REGISTER)
 * - Outbound INVITE (originate calls to leads)
 * - SIP REFER (transfer calls to human agent)
 * - BYE (hangup)
 */
export class SipDialer {
  constructor() {
    this.srf = new Srf();
    this.isConnected = false;
    this.registrationInterval = null;
  }

  /**
   * Connect to drachtio-server.
   */
  async connect({ timeoutMs = 5000 } = {}) {
    const config = getDrachtioConfig();
    const reachable = await canReach(config.host, config.port, Math.min(timeoutMs, 1500));
    if (!reachable) {
      throw new Error(`drachtio not reachable at ${config.host}:${config.port}`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const onConnect = (err, hostPort) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.srf.removeListener("connect", onConnect);
        this.srf.removeListener("error", onError);
        if (err) {
          logger.error(`Failed to connect to drachtio: ${err.message}`);
          return reject(err);
        }
        logger.info(`Connected to drachtio at ${hostPort}`);
        this.isConnected = true;
        resolve();
      };

      const onError = (err) => {
        this.isConnected = false;
        if (settled) return;
        logger.error(`Drachtio connection error: ${err.message}`);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.srf.removeListener("connect", onConnect);
        this.srf.removeListener("error", onError);
        try { this.srf.disconnect(); } catch { /* ignore */ }
        reject(new Error(`Timed out connecting to drachtio at ${config.host}:${config.port}`));
      }, timeoutMs);

      this.srf.on("connect", onConnect);
      this.srf.on("error", onError);

      this.srf.connect({
        host: config.host,
        port: config.port,
        secret: config.secret,
        reconnect: { maxAttempts: 1 },
      });
    });
  }

  /**
   * Register with the SIP provider so we can make outbound calls.
   * Only used in "account" mode. Trunk mode skips registration.
   * @param {object} [sipConfig] - optional SIP config; if omitted uses .env fallback
   */
  async register(sipConfig) {
    const sip = sipConfig || getSipConfig();

    if (sip.mode === "trunk") {
      logger.info(sip.trunkAuth === "credentials"
        ? `SIP trunk mode — credentials auth via ${sip.trunkHost}:${sip.trunkPort} (no REGISTER)`
        : `SIP trunk mode — IP auth via ${sip.trunkHost}:${sip.trunkPort} (no REGISTER)`);
      return;
    }

    try {
      const result = await this.srf.request(`sip:${sip.server}:${sip.port}`, {
        method: "REGISTER",
        headers: {
          "From": `<sip:${sip.username}@${sip.server}:${sip.port}>`,
          "To": `<sip:${sip.username}@${sip.server}:${sip.port}>`,
          "Contact": `<sip:${sip.username}@${sip.server}:${sip.port};transport=${sip.transport}>`,
          "Expires": "3600",
        },
        auth: {
          username: sip.username,
          password: sip.password,
        },
      });

      logger.info(`SIP registration successful with ${sip.server}`);

      // Re-register before expiry
      this.registrationInterval = setInterval(() => {
        this.register(sipConfig).catch((err) => {
          logger.error(`SIP re-registration failed: ${err.message}`);
        });
      }, 300000); // every 5 minutes

      return result;
    } catch (err) {
      logger.error(`SIP registration failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Make an outbound SIP call to a phone number.
   * Returns the SIP dialog (call leg) which provides media events.
   * 
   * @param {string} phoneNumber - The destination phone number
   * @param {object} sdpOpts - SDP options from rtpengine offer
   * @returns {object} { dialog, sdpAnswer }
   */
  async ensureConnected() {
    if (this.isConnected) return;
    await this.connect();
  }

  async makeCall(phoneNumber, localSdp, sipConfig) {
    if (!this.isConnected) {
      await this.ensureConnected();
    }
    const sip = sipConfig || getSipConfig();

    if (sip.mode === "trunk") {
      return this._makeCallTrunk(phoneNumber, localSdp, sip);
    }
    return this._makeCallAccount(phoneNumber, localSdp, sip);
  }

  /**
   * Account mode: INVITE with digest auth (username/password).
   */
  async _makeCallAccount(phoneNumber, localSdp, sip) {
    const uri = `sip:${phoneNumber}@${sip.server}:${sip.port}`;

    const DIAL_TIMEOUT_MS = 60000;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        logger.info(`[account] Placing outbound SIP call to ${uri}`);
      } else {
        logger.info(`[account] INVITE retry ${attempt}/${MAX_RETRIES} for ${phoneNumber}`);
      }

      try {
        const dialog = await Promise.race([
          this.srf.createUAC(uri, {
            localSdp,
            headers: {
              "From": `<sip:${sip.username}@${sip.server}:${sip.port}>`,
              "To": `<sip:${phoneNumber}@${sip.server}>`,
            },
            auth: {
              username: sip.username,
              password: sip.password,
            },
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Dial timeout: no SIP response in 60s")), DIAL_TIMEOUT_MS)
          ),
        ]);

        logger.info(`Call answered by ${phoneNumber}`);
        reportTrunkSuccess();
        return dialog;
      } catch (err) {
        const isTimeout = err.message && err.message.includes("Dial timeout");
        if (isTimeout && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 3000;
          logger.warn(`[account] Dial timeout for ${phoneNumber}, retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        logSipFailure(phoneNumber, err);
        // SipError.message is always "Sip non-success response: <code>". The
        // carrier's own explanation — including "low balance" — lives on
        // err.reason and sometimes in the response body.
        const sipDetail = [err.reason, err.res?.reason, err.res?.body, err.message]
          .filter(Boolean)
          .join(" ");
        reportTrunkFailure(err.status, sipDetail);
        throw err;
      }
    }
  }

  /**
   * Trunk mode: INVITE sent directly to trunk IP.
   * Format per MMDsmart spec:
   *   INVITE sip:[CLD]@[trunkHost]:[trunkPort] SIP/2.0
   *   From: [Username] <sip:[Username]@[SRC_IP]:5050>
   *   To: [CLD] <sip:[CLD]@[trunkHost]:[trunkPort]>
   *   Contact: sip:[Username]@[SRC_IP]:5050
   */
  async _makeCallTrunk(phoneNumber, localSdp, sip) {
    const destHost = sip.trunkHost;
    const destPort = sip.trunkPort;
    const uri = `sip:${phoneNumber}@${destHost}:${destPort}`;
    const fromUser = sip.username || sip.callerId || phoneNumber;
    const srcIp = this._publicSourceIp(sip);
    const srcPort = 5060;

    const uacOptions = {
      localSdp,
      callingNumber: fromUser,
      headers: {
        "From": `"${fromUser}" <sip:${fromUser}@${srcIp}>`,
        "To": `<sip:${phoneNumber}@${destHost}:${destPort}>`,
        "Contact": `<sip:${fromUser}@${srcIp}:${srcPort}>`,
      },
    };

    const authUser = (sip.authUsername || sip.username || "").trim();
    const hasPassword = Boolean(sip.password && sip.password.trim() !== "");
    if (hasPassword && authUser) {
      uacOptions.auth = {
        username: authUser,
        password: sip.password,
      };
    }

    const DIAL_TIMEOUT_MS = 60000;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt === 0) {
        logger.info(`[trunk] INVITE ${uri}`);
        logger.info(`[trunk] From: "${fromUser}" <sip:${fromUser}@${srcIp}>`);
        logger.info(`[trunk] To: <sip:${phoneNumber}@${destHost}:${destPort}>`);
        logger.info(hasPassword && authUser
          ? `[trunk] Credentials auth as ${authUser}`
          : `[trunk] IP auth (no username/password)`);
      } else {
        logger.info(`[trunk] INVITE retry ${attempt}/${MAX_RETRIES} for ${phoneNumber}`);
      }

      try {
        const dialog = await Promise.race([
          this.srf.createUAC(uri, uacOptions),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Dial timeout: no SIP response in 60s")), DIAL_TIMEOUT_MS)
          ),
        ]);

        logger.info(`Call answered by ${phoneNumber}`);
        reportTrunkSuccess();
        return dialog;
      } catch (err) {
        const isTimeout = err.message && err.message.includes("Dial timeout");
        if (isTimeout && attempt < MAX_RETRIES) {
          const backoffMs = (attempt + 1) * 3000;
          logger.warn(`[trunk] Dial timeout for ${phoneNumber}, retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        logSipFailure(phoneNumber, err);
        // SipError.message is always "Sip non-success response: <code>". The
        // carrier's own explanation — including "low balance" — lives on
        // err.reason and sometimes in the response body.
        const sipDetail = [err.reason, err.res?.reason, err.res?.body, err.message]
          .filter(Boolean)
          .join(" ");
        reportTrunkFailure(err.status, sipDetail);
        throw err;
      }
    }
  }

  /**
   * Transfer an active call to another SIP destination via REFER.
   */
  async transferCall(dialog, destination = "676", sipConfig) {
    const sip = sipConfig || getSipConfig();
    let transferUri = destination;
    
    // If destination is just a number, format it as a proper SIP URI
    if (!transferUri.startsWith("sip:")) {
      transferUri = `sip:${transferUri}@${sip.server}`;
    }

    logger.info(`Transferring call to ${transferUri}`);

    try {
      await dialog.request({
        method: "REFER",
        headers: {
          "Refer-To": `<${transferUri}>`,
          "Referred-By": `<${dialog.sip.localUri}>`,
        },
      });
      logger.info(`Call transfer initiated to ${transferUri}`);
    } catch (err) {
      logger.error(`Call transfer failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Hang up a call.
   */
  async hangup(dialog) {
    try {
      if (dialog) {
        if (typeof dialog.destroy === "function") {
          dialog.destroy();
        } else if (typeof dialog.bye === "function") {
          dialog.bye();
        }
        logger.info("Call hung up");
      }
    } catch (err) {
      logger.error(`Hangup error: ${err.message}`);
    }
  }

  /**
   * Address the trunk is allowed to see. A container NIC (172.18.x, 192.168.x)
   * is not that address, and MMD answers 401 IP blocked when From uses it.
   */
  _publicSourceIp(sip) {
    const candidates = [sip?.sourceIp, process.env.EXTERNAL_RTP_IP, process.env.SIP_EXTERNAL_IP, this._getLocalIp()];
    for (const ip of candidates) {
      if (isPublicIpv4(ip)) return ip.trim();
    }
    return (process.env.EXTERNAL_RTP_IP || "").trim() || this._getLocalIp();
  }

  /**
   * Get local IP address for SIP headers.
   */
  _getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface) {
        if (addr.family === "IPv4" && !addr.internal) {
          return addr.address;
        }
      }
    }
    return "127.0.0.1";
  }

  /**
   * Disconnect from drachtio.
   */
  disconnect() {
    if (this.registrationInterval) {
      clearInterval(this.registrationInterval);
    }
    if (this.srf) {
      this.srf.disconnect();
    }
    this.isConnected = false;
    logger.info("Disconnected from drachtio");
  }
}
