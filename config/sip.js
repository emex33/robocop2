/**
 * SIP Configuration
 * 
 * Reads ONLY from DB (per-user). No .env fallback for SIP settings.
 * Pass a dbSettings object (from getUserSipSettings) to use DB values.
 */

export function getSipConfig(dbSettings) {
  if (!dbSettings) {
    throw new Error("SIP settings must be configured in the database. No .env fallback.");
  }

  const mode = dbSettings.mode || "account";
  const trunkAuth = dbSettings.trunk_auth === "credentials" ? "credentials" : "ip";
  const useCreds = mode === "trunk" && trunkAuth === "credentials";
  const trunkFrom = useCreds
    ? (dbSettings.username || dbSettings.trunk_username || "")
    : (dbSettings.trunk_username || "");

  return {
    mode,
    trunkAuth: mode === "trunk" ? trunkAuth : "credentials",
    username: mode === "trunk" ? trunkFrom : (dbSettings.username || ""),
    authUsername: useCreds ? (dbSettings.username || dbSettings.trunk_username || "") : (dbSettings.username || ""),
    // IP trunks must not send a password, even if one is still stored.
    password: (mode === "account" || useCreds) ? (dbSettings.password || "") : "",
    server: dbSettings.server || "",
    port: dbSettings.port || 12835,
    transport: dbSettings.transport || "udp",
    callerId: dbSettings.caller_id || "",
    transferUri: dbSettings.transfer_uri || "",
    trunkHost: dbSettings.trunk_host || dbSettings.server || "",
    trunkPort: dbSettings.trunk_port || dbSettings.port || 12835,
    sourceIp: dbSettings.source_ip || "",
  };
}

export function getDrachtioConfig() {
  return {
    host: process.env.DRACHTIO_HOST || "127.0.0.1",
    port: parseInt(process.env.DRACHTIO_PORT || "9022"),
    secret: process.env.DRACHTIO_SECRET || "cymru",
  };
}

export function getRtpEngineConfig() {
  return {
    host: process.env.RTPENGINE_HOST || "127.0.0.1",
    port: parseInt(process.env.RTPENGINE_PORT || "22222"),
  };
}
