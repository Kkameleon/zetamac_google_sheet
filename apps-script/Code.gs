const SPREADSHEET_ID = "replace-this-with-your-spreadsheet-id";
const SHEET_GID = 0;
const SHARED_SECRET = "replace-this-with-a-random-secret";

const BASE_HEADERS = [
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

const EXTRA_HEADERS = [
  "capture_method",
  "problem_log_key",
  "problem_count",
  "abandoned_count",
  "duration_ms",
  "total_errors",
  "wrong_attempts",
  "keystroke_error_rate",
  "attempt_error_rate",
  "add_count",
  "sub_count",
  "mul_count",
  "div_count",
  "mean_add_ms",
  "mean_sub_ms",
  "mean_mul_ms",
  "mean_div_ms",
  "slowest_1",
  "slowest_1_ms",
  "slowest_2",
  "slowest_2_ms",
  "slowest_3",
  "slowest_3_ms",
];

const EXTRA_PAYLOAD_FIELDS = {
  capture_method: "captureMethod",
  problem_log_key: "problemLogKey",
  problem_count: "problemCount",
  abandoned_count: "abandonedCount",
  duration_ms: "durationMs",
  total_errors: "totalErrors",
  wrong_attempts: "wrongAttempts",
  keystroke_error_rate: "keystrokeErrorRate",
  attempt_error_rate: "attemptErrorRate",
  add_count: "addCount",
  sub_count: "subCount",
  mul_count: "mulCount",
  div_count: "divCount",
  mean_add_ms: "meanAddMs",
  mean_sub_ms: "meanSubMs",
  mean_mul_ms: "meanMulMs",
  mean_div_ms: "meanDivMs",
  slowest_1: "slowest1",
  slowest_1_ms: "slowest1Ms",
  slowest_2: "slowest2",
  slowest_2_ms: "slowest2Ms",
  slowest_3: "slowest3",
  slowest_3_ms: "slowest3Ms",
};

function doGet() {
  return jsonResponse_({
    ok: true,
    message: "Zetamac tracker webhook is up. POST batches append rows without rewriting existing scores.",
    spreadsheetId: SPREADSHEET_ID,
    sheetGid: SHEET_GID,
  });
}

function doPost(e) {
  let lock = null;
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return jsonResponse_({ ok: false, error: "unauthorized" });
    }

    if (!Array.isArray(payload.rows) || !payload.rows.length) {
      return jsonResponse_({ ok: false, error: "Expected rows[]" });
    }

    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    const sheet = getTargetSheet_();
    const headerMap = ensureHeaders_(sheet);
    const seen = loadSeen_(sheet, headerMap);
    const rowsToAppend = [];
    const acceptedIds = [];
    const receivedAt = new Date().toISOString();

    for (const rawRow of payload.rows) {
      const row = normalizePayloadRow_(rawRow, payload, receivedAt);
      if (!row) {
        continue;
      }

      acceptedIds.push(row.id);
      const timestampScoreKey = timestampScoreKey_(row.timestampMs, row.score);
      if (seen.ids.has(row.id) || seen.timestampScoreKeys.has(timestampScoreKey)) {
        continue;
      }

      seen.ids.add(row.id);
      seen.timestampScoreKeys.add(timestampScoreKey);
      rowsToAppend.push(row);
    }

    if (rowsToAppend.length) {
      writeRows_(sheet, headerMap, rowsToAppend);
    }

    return jsonResponse_({
      ok: true,
      appended: rowsToAppend.length,
      acceptedIds,
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String(error && error.message || error),
    });
  } finally {
    if (lock && lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function normalizePayloadRow_(rawRow, payload, receivedAt) {
  const timestampMs = Number(rawRow && (rawRow.timestampMs ?? rawRow.t));
  const score = Number(rawRow && (rawRow.score ?? rawRow.s));
  if (!Number.isFinite(timestampMs) || !Number.isFinite(score)) {
    return null;
  }

  const id = String(rawRow.id || `legacy:${timestampMs}:${score}`);
  const iso = rawRow.iso || new Date(timestampMs).toISOString();
  return {
    rawRow,
    id,
    timestampMs,
    iso,
    score,
    deviceName: String(rawRow.deviceName || payload.deviceName || ""),
    source: String(payload.source || "zetamac-tracker"),
    extensionVersion: String(payload.extensionVersion || ""),
    userAgent: String(payload.userAgent || ""),
    receivedAt,
  };
}

function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheets().find((candidate) => candidate.getSheetId() === SHEET_GID);
  return sheet || spreadsheet.getSheets()[0];
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, BASE_HEADERS.length).setValues([BASE_HEADERS]);
  }

  for (let i = 0; i < BASE_HEADERS.length; i += 1) {
    const cell = sheet.getRange(1, i + 1);
    if (!cell.getValue()) {
      cell.setValue(BASE_HEADERS[i]);
    }
  }

  let headerMap = getHeaderMap_(sheet);
  let nextColumn = lastHeaderColumn_(sheet) + 1;
  for (const header of EXTRA_HEADERS) {
    if (!headerMap[header]) {
      sheet.getRange(1, nextColumn).setValue(header);
      headerMap[header] = nextColumn;
      nextColumn += 1;
    }
  }

  return getHeaderMap_(sheet);
}

function getHeaderMap_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), BASE_HEADERS.length);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const headerMap = {};
  headers.forEach((header, index) => {
    const key = String(header || "").trim();
    if (key && !headerMap[key]) {
      headerMap[key] = index + 1;
    }
  });
  return headerMap;
}

function lastHeaderColumn_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), BASE_HEADERS.length);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  for (let i = headers.length - 1; i >= 0; i -= 1) {
    if (headers[i] !== "" && headers[i] !== null) {
      return i + 1;
    }
  }
  return BASE_HEADERS.length;
}

function lastBaseDataRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 1;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, BASE_HEADERS.length).getValues();
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i].some((value) => value !== "" && value !== null)) {
      return i + 2;
    }
  }
  return 1;
}

function loadSeen_(sheet, headerMap) {
  const lastRow = lastBaseDataRow_(sheet);
  const seen = {
    ids: new Set(),
    timestampScoreKeys: new Set(),
  };
  if (lastRow < 2) {
    return seen;
  }

  const idCol = headerMap.id || 1;
  const timestampCol = headerMap.timestamp_ms || 2;
  const scoreCol = headerMap.score || 4;
  const lastCol = Math.max(idCol, timestampCol, scoreCol);
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  for (const row of values) {
    const id = String(row[idCol - 1] || "");
    if (id && id !== "0") {
      seen.ids.add(id);
    }

    const key = timestampScoreKey_(row[timestampCol - 1], row[scoreCol - 1]);
    if (key) {
      seen.timestampScoreKeys.add(key);
    }
  }

  return seen;
}

function timestampScoreKey_(timestampMs, score) {
  const t = Number(timestampMs);
  const s = Number(score);
  if (!Number.isFinite(t) || !Number.isFinite(s)) {
    return "";
  }
  return `${Math.round(t)}:${s}`;
}

function writeRows_(sheet, headerMap, rows) {
  const startRow = lastBaseDataRow_(sheet) + 1;
  const baseRows = rows.map((row) => [
    row.id,
    row.timestampMs,
    row.iso,
    row.score,
    row.deviceName,
    row.source,
    row.extensionVersion,
    row.userAgent,
    row.receivedAt,
  ]);

  sheet.getRange(startRow, 1, baseRows.length, BASE_HEADERS.length).setValues(baseRows);

  for (const header of EXTRA_HEADERS) {
    const column = headerMap[header];
    if (!column) {
      continue;
    }

    const field = EXTRA_PAYLOAD_FIELDS[header];
    const values = rows.map((row) => [row.rawRow[field] === undefined ? "" : row.rawRow[field]]);
    sheet.getRange(startRow, column, values.length, 1).setValues(values);
  }
}

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
