import Srf from "drachtio-srf";
import os from "os";
import logger from "../utils/logger.js";
import { getDrachtioConfig, getSipConfig } from "../../config/sip.js";

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
  async connect() {
    const config = getDrachtioConfig();

    return new Promise((resolve, reject) => {
      this.srf.connect({
        host: config.host,
        port: config.port,
        secret: config.secret,
      });

      this.srf.on("connect", (err, hostPort) => {
        if (err) {
          logger.error(`Failed to connect to drachtio: ${err.message}`);
          return reject(err);
        }
        logger.info(`Connected to drachtio at ${hostPort}`);
        this.isConnected = true;
        resolve();
      });

      this.srf.on("error", (err) => {
        logger.error(`Drachtio connection error: ${err.message}`);
        this.isConnected = false;
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
      logger.info(`SIP trunk mode — skipping REGISTER (IP auth via ${sip.trunkHost}:${sip.trunkPort})`);
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
  async makeCall(phoneNumber, localSdp, sipConfig) {
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
    logger.info(`[account] Placing outbound SIP call to ${uri}`);

    const DIAL_TIMEOUT_MS = 60000;

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
      return dialog;
    } catch (err) {
      logger.error(`Failed to call ${phoneNumber}: ${err.status || err.message}`);
      throw err;
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
    const srcIp = sip.sourceIp || this._getLocalIp();
    const srcPort = 5060;

    logger.info(`[trunk] INVITE ${uri}`);
    logger.info(`[trunk] From: "${fromUser}" <sip:${fromUser}@${srcIp}>`);
    logger.info(`[trunk] To: <sip:${phoneNumber}@${destHost}:${destPort}>`);

    const uacOptions = {
      localSdp,
      callingNumber: fromUser,
      headers: {
        "From": `"${fromUser}" <sip:${fromUser}@${srcIp}>`,
        "To": `<sip:${phoneNumber}@${destHost}:${destPort}>`,
        "Contact": `<sip:${fromUser}@${srcIp}:${srcPort}>`,
      },
    };

    if (sip.password && sip.password.trim() !== "") {
      uacOptions.auth = {
        username: sip.username,
        password: sip.password,
      };
      logger.info(`[trunk] Auth enabled for user: ${sip.username}`);
    } else {
      logger.info(`[trunk] IP-based auth (no password)`);
    }

    const DIAL_TIMEOUT_MS = 60000;

    try {
      const dialog = await Promise.race([
        this.srf.createUAC(uri, uacOptions),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Dial timeout: no SIP response in 60s")), DIAL_TIMEOUT_MS)
        ),
      ]);

      logger.info(`Call answered by ${phoneNumber}`);
      return dialog;
    } catch (err) {
      logger.error(`Failed to call ${phoneNumber}: ${err.status || err.message}`);
      throw err;
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
