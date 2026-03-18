/**
 * Google Drive Service
 * Uploads call recordings to Google Drive and returns shareable links.
 * Uses the same service account credentials as Google Sheets.
 */

import { google } from "googleapis";
import fs from "fs";
import path from "path";
import logger from "../utils/logger.js";
import { getDb } from "../db/schema.js";

function getAuth(credentialsJson) {
  const creds = typeof credentialsJson === "string"
    ? JSON.parse(credentialsJson)
    : credentialsJson;

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
}

async function getDriveClient(credentialsJson) {
  const auth = getAuth(credentialsJson);
  return google.drive({ version: "v3", auth });
}

/**
 * Ensure a subfolder exists inside the campaign folder.
 * Returns the folder ID.
 */
async function ensureFolder(drive, parentFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  return folder.data.id;
}

/**
 * Upload a recording file to Google Drive.
 * Returns { fileId, webViewLink } or null on failure.
 */
export async function uploadRecordingToDrive(recordingPath, metadata = {}) {
  const db = getDb();

  if (!recordingPath || !fs.existsSync(recordingPath)) {
    logger.debug(`Google Drive: recording file not found: ${recordingPath}`);
    return null;
  }

  const userId = metadata.userId;
  if (!userId) {
    logger.warn("Google Drive: no userId provided, skipping upload");
    return null;
  }

  const creds = db.prepare(
    "SELECT google_sheets_credentials FROM users WHERE id = ?"
  ).get(userId);

  if (!creds?.google_sheets_credentials) {
    logger.debug("Google Drive: no Google credentials configured, skipping upload");
    return null;
  }

  let folderId = metadata.driveFolderId;
  if (!folderId) {
    logger.debug("Google Drive: no Drive folder ID configured for campaign, skipping");
    return null;
  }

  try {
    const drive = await getDriveClient(creds.google_sheets_credentials);

    const recordingsFolderId = await ensureFolder(drive, folderId, "Recordings");

    const fileName = `${metadata.leadName || "call"}_${metadata.phone || "unknown"}_${metadata.callId || Date.now()}.wav`;

    const fileMetadata = {
      name: fileName,
      parents: [recordingsFolderId],
      description: [
        metadata.leadName && `Lead: ${metadata.leadName}`,
        metadata.phone && `Phone: ${metadata.phone}`,
        metadata.outcome && `Outcome: ${metadata.outcome}`,
        metadata.campaignName && `Campaign: ${metadata.campaignName}`,
      ].filter(Boolean).join(" | "),
    };

    const media = {
      mimeType: "audio/wav",
      body: fs.createReadStream(recordingPath),
    };

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, webViewLink, webContentLink",
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    const updated = await drive.files.get({
      fileId: file.data.id,
      fields: "webViewLink, webContentLink",
    });

    const link = updated.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;

    logger.info(`Google Drive: uploaded recording ${fileName} -> ${link}`);

    return {
      fileId: file.data.id,
      webViewLink: link,
      webContentLink: updated.data.webContentLink || "",
    };
  } catch (err) {
    logger.error(`Google Drive: upload failed: ${err.message}`);
    return null;
  }
}

/**
 * Upload recording for a call record, update the DB, and update Google Sheets.
 * This is the main entry point called after a call completes.
 */
export async function uploadAndLinkRecording(callRecordId) {
  const db = getDb();

  const record = db.prepare(`
    SELECT cr.*, c.name as campaign_name, c.google_sheet_id, c.google_drive_folder_id,
           c.user_id as campaign_user_id
    FROM call_records cr
    LEFT JOIN campaigns c ON cr.campaign_id = c.id
    WHERE cr.id = ?
  `).get(callRecordId);

  if (!record) {
    logger.warn(`Google Drive: call record ${callRecordId} not found`);
    return null;
  }

  if (!record.recording_path) {
    logger.debug(`Google Drive: no recording for call ${callRecordId}`);
    return null;
  }

  if (!record.google_drive_folder_id) {
    logger.debug(`Google Drive: no Drive folder configured for campaign`);
    return null;
  }

  const result = await uploadRecordingToDrive(record.recording_path, {
    userId: record.user_id || record.campaign_user_id,
    driveFolderId: record.google_drive_folder_id,
    callId: record.call_id,
    leadName: record.lead_name,
    phone: record.phone,
    outcome: record.outcome,
    campaignName: record.campaign_name,
  });

  if (!result) return null;

  db.prepare(
    "UPDATE call_records SET recording_url = ? WHERE id = ?"
  ).run(result.webViewLink, callRecordId);

  logger.info(`Google Drive: linked recording URL for call ${callRecordId}`);

  if (record.google_sheet_id) {
    try {
      const { updateRecordingLinkInSheet } = await import("./google-sheets.js");
      await updateRecordingLinkInSheet(record.call_id, result.webViewLink, record.google_sheet_id, record.user_id || record.campaign_user_id);
    } catch (err) {
      logger.error(`Google Drive: failed to update sheet with recording link: ${err.message}`);
    }
  }

  return result;
}
