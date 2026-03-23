/**
 * Google Sheets Service
 * Pushes appointment + lead data to a campaign's linked Google Sheet.
 * Uses a service account for auth (credentials JSON stored per-user in DB).
 */

import { google } from "googleapis";
import logger from "../utils/logger.js";
import { getDb } from "../db/schema.js";

const HEADER_ROW = [
  "Appointment ID",
  "Status",
  "Date",
  "Time",
  "Timezone",
  "Lead Name",
  "First Name",
  "Last Name",
  "Phone",
  "Email",
  "Company",
  "Country",
  "Notes",
  "Campaign",
  "Call ID",
  "Lead Status",
  "Extra Data",
  "Created At",
  "Recording",
];

function getAuth(credentialsJson) {
  const creds = typeof credentialsJson === "string"
    ? JSON.parse(credentialsJson)
    : credentialsJson;

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient(credentialsJson) {
  const auth = getAuth(credentialsJson);
  return google.sheets({ version: "v4", auth });
}

/**
 * Ensure the sheet has a header row. If the first row is empty, write headers.
 * Also extends existing headers if they're missing the Recording column.
 */
async function ensureHeaders(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A1:S1",
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1:S1",
      valueInputOption: "RAW",
      requestBody: { values: [HEADER_ROW] },
    });
    logger.info(`Google Sheets: wrote headers to ${spreadsheetId}`);
  } else if (firstRow.length < HEADER_ROW.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1:S1",
      valueInputOption: "RAW",
      requestBody: { values: [HEADER_ROW] },
    });
    logger.info(`Google Sheets: updated headers with new columns in ${spreadsheetId}`);
  }
}

/**
 * Build a row from appointment + lead data.
 */
function buildRow(appointment, lead, campaignName, recordingUrl) {
  return [
    appointment.id || "",
    appointment.status || "scheduled",
    appointment.appointment_date || "",
    appointment.appointment_time || "",
    appointment.timezone || "",
    appointment.lead_name || "",
    lead?.first_name || "",
    lead?.last_name || "",
    appointment.phone || lead?.phone || "",
    appointment.email || lead?.email || "",
    lead?.company || "",
    lead?.country || "",
    appointment.notes || lead?.notes || "",
    campaignName || "",
    appointment.call_id || "",
    lead?.status || "",
    lead?.extra_json && lead.extra_json !== "{}" ? lead.extra_json : "",
    appointment.created_at || new Date().toISOString(),
    recordingUrl || "",
  ];
}

/**
 * Push a single appointment row to the linked Google Sheet.
 */
export async function pushAppointmentToSheet(appointmentId) {
  const db = getDb();

  const appt = db.prepare(`
    SELECT a.*, c.name as campaign_name, c.google_sheet_id, c.user_id as campaign_user_id
    FROM appointments a
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.id = ?
  `).get(appointmentId);

  if (!appt) {
    logger.warn(`Google Sheets: appointment ${appointmentId} not found`);
    return;
  }

  if (!appt.google_sheet_id) {
    logger.debug(`Google Sheets: campaign has no linked sheet, skipping`);
    return;
  }

  const userId = appt.user_id || appt.campaign_user_id;
  const creds = db.prepare(
    "SELECT google_sheets_credentials FROM users WHERE id = ?"
  ).get(userId);

  if (!creds?.google_sheets_credentials) {
    logger.warn(`Google Sheets: no credentials for user ${userId}`);
    return;
  }

  let lead = null;
  if (appt.lead_id) {
    lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(appt.lead_id);
  }

  let recordingUrl = "";
  if (appt.call_id) {
    const callRec = db.prepare(
      "SELECT recording_url FROM call_records WHERE call_id = ? LIMIT 1"
    ).get(appt.call_id);
    recordingUrl = callRec?.recording_url || "";
  }

  try {
    const sheets = await getSheetsClient(creds.google_sheets_credentials);
    await ensureHeaders(sheets, appt.google_sheet_id);

    const row = buildRow(appt, lead, appt.campaign_name, recordingUrl);

    await sheets.spreadsheets.values.append({
      spreadsheetId: appt.google_sheet_id,
      range: "Sheet1!A:S",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    logger.info(`Google Sheets: pushed appointment ${appointmentId} to sheet ${appt.google_sheet_id}`);
  } catch (err) {
    logger.error(`Google Sheets: failed to push appointment ${appointmentId}: ${err.message}`);
  }
}

/**
 * Update a row in the sheet when appointment status changes (e.g. showed/no_show).
 */
export async function updateAppointmentInSheet(appointmentId) {
  const db = getDb();

  const appt = db.prepare(`
    SELECT a.*, c.name as campaign_name, c.google_sheet_id, c.user_id as campaign_user_id
    FROM appointments a
    LEFT JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.id = ?
  `).get(appointmentId);

  if (!appt?.google_sheet_id) return;

  const userId = appt.user_id || appt.campaign_user_id;
  const creds = db.prepare(
    "SELECT google_sheets_credentials FROM users WHERE id = ?"
  ).get(userId);

  if (!creds?.google_sheets_credentials) return;

  try {
    const sheets = await getSheetsClient(creds.google_sheets_credentials);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: appt.google_sheet_id,
      range: "Sheet1!A:A",
    });

    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === appointmentId) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      logger.debug(`Google Sheets: appointment ${appointmentId} not found in sheet, appending`);
      await pushAppointmentToSheet(appointmentId);
      return;
    }

    let lead = null;
    if (appt.lead_id) {
      lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(appt.lead_id);
    }

    let recordingUrl = "";
    if (appt.call_id) {
      const callRec = db.prepare(
        "SELECT recording_url FROM call_records WHERE call_id = ? LIMIT 1"
      ).get(appt.call_id);
      recordingUrl = callRec?.recording_url || "";
    }

    const row = buildRow(appt, lead, appt.campaign_name, recordingUrl);

    await sheets.spreadsheets.values.update({
      spreadsheetId: appt.google_sheet_id,
      range: `Sheet1!A${rowIndex}:S${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });

    logger.info(`Google Sheets: updated appointment ${appointmentId} at row ${rowIndex}`);
  } catch (err) {
    logger.error(`Google Sheets: failed to update appointment ${appointmentId}: ${err.message}`);
  }
}

/**
 * Update the recording link for a specific call in the Google Sheet.
 * Finds the row by Call ID (column O) and updates the Recording column (S).
 */
export async function updateRecordingLinkInSheet(callId, recordingUrl, spreadsheetId, userId) {
  if (!callId || !recordingUrl || !spreadsheetId || !userId) return;

  const db = getDb();
  const creds = db.prepare(
    "SELECT google_sheets_credentials FROM users WHERE id = ?"
  ).get(userId);

  if (!creds?.google_sheets_credentials) return;

  try {
    const sheets = await getSheetsClient(creds.google_sheets_credentials);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!O:O",
    });

    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === callId) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      logger.debug(`Google Sheets: call ${callId} not found in sheet for recording link update`);
      return;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!S${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[recordingUrl]] },
    });

    logger.info(`Google Sheets: updated recording link for call ${callId} at row ${rowIndex}`);
  } catch (err) {
    logger.error(`Google Sheets: failed to update recording link for call ${callId}: ${err.message}`);
  }
}

const TRANSFER_HEADER_ROW = [
  "Transfer ID",
  "Status",
  "Transferred To",
  "Lead Name",
  "First Name",
  "Last Name",
  "Phone",
  "Email",
  "Company",
  "Country",
  "Notes",
  "Campaign",
  "Call ID",
  "Call Duration (s)",
  "Extra Data",
  "Transferred At",
  "Recording",
];

async function ensureTransferSheet(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = meta.data.sheets.map(s => s.properties.title);

  if (!sheetNames.includes("Transfers")) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: "Transfers" } } }],
      },
    });
    logger.info(`Google Sheets: created "Transfers" tab in ${spreadsheetId}`);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Transfers!A1:Q1",
  });

  const firstRow = res.data.values?.[0];
  if (!firstRow || firstRow.length === 0 || firstRow.length < TRANSFER_HEADER_ROW.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Transfers!A1:Q1",
      valueInputOption: "RAW",
      requestBody: { values: [TRANSFER_HEADER_ROW] },
    });
    logger.info(`Google Sheets: wrote transfer headers to ${spreadsheetId}`);
  }
}

function buildTransferRow(transfer, lead, campaignName, recordingUrl) {
  return [
    transfer.id || "",
    transfer.status || "transferred",
    transfer.transferred_to || "",
    transfer.lead_name || "",
    lead?.first_name || "",
    lead?.last_name || "",
    transfer.phone || lead?.phone || "",
    transfer.email || lead?.email || "",
    lead?.company || "",
    lead?.country || "",
    transfer.notes || "",
    campaignName || "",
    transfer.call_id || "",
    transfer.duration_seconds || "",
    lead?.extra_json && lead.extra_json !== "{}" ? lead.extra_json : "",
    transfer.transferred_at || new Date().toISOString(),
    recordingUrl || "",
  ];
}

/**
 * Push a live transfer row to the "Transfers" tab in the linked Google Sheet.
 */
export async function pushTransferToSheet(transferData) {
  const db = getDb();

  const campaign = db.prepare(
    "SELECT name, google_sheet_id, user_id FROM campaigns WHERE id = ?"
  ).get(transferData.campaign_id);

  if (!campaign?.google_sheet_id) {
    logger.debug("Google Sheets: campaign has no linked sheet, skipping transfer push");
    return;
  }

  const creds = db.prepare(
    "SELECT google_sheets_credentials FROM users WHERE id = ?"
  ).get(transferData.user_id || campaign.user_id);

  if (!creds?.google_sheets_credentials) {
    logger.warn(`Google Sheets: no credentials for user, skipping transfer push`);
    return;
  }

  let lead = null;
  if (transferData.lead_id) {
    lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(transferData.lead_id);
  }

  let recordingUrl = "";
  if (transferData.call_id) {
    const callRec = db.prepare(
      "SELECT recording_url FROM call_records WHERE call_id = ? LIMIT 1"
    ).get(transferData.call_id);
    recordingUrl = callRec?.recording_url || "";
  }

  try {
    const sheets = await getSheetsClient(creds.google_sheets_credentials);
    await ensureTransferSheet(sheets, campaign.google_sheet_id);

    const row = buildTransferRow(transferData, lead, campaign.name, recordingUrl);

    await sheets.spreadsheets.values.append({
      spreadsheetId: campaign.google_sheet_id,
      range: "Transfers!A:Q",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    logger.info(`Google Sheets: pushed transfer to "Transfers" tab in ${campaign.google_sheet_id}`);
  } catch (err) {
    logger.error(`Google Sheets: failed to push transfer: ${err.message}`);
  }
}

/**
 * Test connection to a Google Sheet (validates credentials + sheet access).
 */
export async function testSheetConnection(credentialsJson, spreadsheetId) {
  const sheets = await getSheetsClient(credentialsJson);
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return { title: res.data.properties.title, sheets: res.data.sheets.map(s => s.properties.title) };
}
