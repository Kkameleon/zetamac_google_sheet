const SPREADSHEET_ID_KEY = "SPREADSHEET_ID";
const SHEET_GID_KEY = "SHEET_GID";
const SHARED_SECRET_KEY = "SHARED_SECRET";

function doGet() {
  const config = getConfig_();
  return jsonResponse_({
    ok: true,
    message: "Zetamac Google Sheet Sync webhook is up. Send POST batches to append rows.",
    spreadsheetId: config.spreadsheetId,
    sheetGid: config.sheetGid,
  });
}

function doPost(e) {
  try {
    const config = getConfig_();
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (config.sharedSecret && payload.secret !== config.sharedSecret) {
      return jsonResponse_({ ok: false, error: "unauthorized" });
    }

    if (!Array.isArray(payload.rows) || !payload.rows.length) {
      return jsonResponse_({ ok: false, error: "Expected rows[]" });
    }

    const sheet = getTargetSheet_();
    ensureHeader_(sheet);

    const seenIds = loadSeenIds_(sheet);
    const acceptedIds = [];
    const rowsToAppend = [];
    const receivedAt = new Date().toISOString();

    for (const row of payload.rows) {
      const id = String(row && row.id || "");
      if (!id) {
        continue;
      }

      acceptedIds.push(id);
      if (seenIds.has(id)) {
        continue;
      }

      seenIds.add(id);
      const timestampMs = Number(row.timestampMs || row.t || 0);
      const score = Number(row.score || row.s || 0);
      rowsToAppend.push([
        id,
        timestampMs,
        row.iso || new Date(timestampMs).toISOString(),
        score,
        String(row.deviceName || payload.deviceName || ""),
        String(payload.source || "zetamac-google-sheet"),
        String(payload.extensionVersion || ""),
        String(payload.userAgent || ""),
        receivedAt,
      ]);
    }

    if (rowsToAppend.length) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length)
        .setValues(rowsToAppend);
    }

    return jsonResponse_({
      ok: true,
      appended: rowsToAppend.length,
      acceptedIds: acceptedIds,
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message || error),
    });
  }
}

function getTargetSheet_() {
  const config = getConfig_();
  const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  const sheet = spreadsheet.getSheets().find((candidate) => candidate.getSheetId() === config.sheetGid);
  return sheet || spreadsheet.getSheets()[0];
}

function getConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = String(properties.getProperty(SPREADSHEET_ID_KEY) || "").trim();
  const sheetGidRaw = String(properties.getProperty(SHEET_GID_KEY) || "0").trim();
  const sharedSecret = String(properties.getProperty(SHARED_SECRET_KEY) || "");
  const sheetGid = Number(sheetGidRaw || "0");

  if (!spreadsheetId) {
    throw new Error("Set the SPREADSHEET_ID script property before deploying the web app.");
  }

  if (!Number.isInteger(sheetGid) || sheetGid < 0) {
    throw new Error("Set the SHEET_GID script property to a non-negative integer.");
  }

  if (!sharedSecret) {
    throw new Error("Set the SHARED_SECRET script property before deploying the web app.");
  }

  return {
    spreadsheetId,
    sheetGid,
    sharedSecret,
  };
}

function ensureHeader_(sheet) {
  const header = [
    "id",
    "timestamp_ms",
    "iso_utc",
    "score",
    "device_name",
    "source",
    "extension_version",
    "user_agent",
    "received_at_utc",
  ];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    return;
  }

  const existing = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  if (existing.join("\u0000") !== header.join("\u0000")) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function loadSeenIds_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return new Set();
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  return new Set(values.flat().map(String).filter(Boolean));
}

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
