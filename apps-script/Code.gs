const SPREADSHEET_ID = "replace-this-with-your-spreadsheet-id";
const SHEET_GID = 0;
const SHARED_SECRET = "replace-this-with-a-random-secret";
const DASHBOARD_SHEET_NAME = "Zetamac Dashboard";
const DASHBOARD_DATA_ROW = 6;
const DASHBOARD_CHART_DATA_COLUMN = 27;

const DASHBOARD_HEADERS = [
  "Game number",
  "Played at",
  "Score",
  "Addition (s)",
  "Subtraction (s)",
  "Multiplication (s)",
  "Division (s)",
];

const DASHBOARD_COLORS = {
  score: "#E4572E",
  addition: "#008F95",
  subtraction: "#2E5EAA",
  multiplication: "#F3A712",
  division: "#6A994E",
};

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

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Zetamac Tracker")
    .addItem("Refresh Dashboard", "refreshDashboard")
    .addToUi();
}

function doGet() {
  return jsonResponse_({
    ok: true,
    message:
      "Zetamac tracker webhook is up. POST batches append rows without rewriting existing scores.",
    spreadsheetId: SPREADSHEET_ID,
    sheetGid: SHEET_GID,
  });
}

function doPost(e) {
  let lock = null;
  try {
    const payload = JSON.parse(
      (e && e.postData && e.postData.contents) || "{}",
    );
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
      if (
        seen.ids.has(row.id) ||
        seen.timestampScoreKeys.has(timestampScoreKey)
      ) {
        continue;
      }

      seen.ids.add(row.id);
      seen.timestampScoreKeys.add(timestampScoreKey);
      rowsToAppend.push(row);
    }

    if (rowsToAppend.length) {
      writeRows_(sheet, headerMap, rowsToAppend);
    }

    let dashboardUpdated = false;
    let dashboardError = "";
    if (rowsToAppend.length) {
      try {
        refreshDashboard_(sheet, headerMap);
        dashboardUpdated = true;
      } catch (error) {
        // A chart failure must never cause an already-appended score to be retried.
        dashboardError = String((error && error.message) || error);
        console.error("Could not refresh Zetamac dashboard", error);
      }
    }

    return jsonResponse_({
      ok: true,
      appended: rowsToAppend.length,
      acceptedIds,
      dashboardUpdated,
      dashboardError,
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: String((error && error.message) || error),
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
  const sheet = spreadsheet
    .getSheets()
    .find((candidate) => candidate.getSheetId() === SHEET_GID);
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

  const values = sheet
    .getRange(2, 1, lastRow - 1, BASE_HEADERS.length)
    .getValues();
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

  sheet
    .getRange(startRow, 1, baseRows.length, BASE_HEADERS.length)
    .setValues(baseRows);

  for (const header of EXTRA_HEADERS) {
    const column = headerMap[header];
    if (!column) {
      continue;
    }

    const field = EXTRA_PAYLOAD_FIELDS[header];
    const values = rows.map((row) => [
      row.rawRow[field] === undefined ? "" : row.rawRow[field],
    ]);
    sheet.getRange(startRow, column, values.length, 1).setValues(values);
  }
}

function refreshDashboard() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const dataSheet = getTargetSheet_();
    const headerMap = ensureHeaders_(dataSheet);
    return refreshDashboard_(dataSheet, headerMap);
  } finally {
    lock.releaseLock();
  }
}

function refreshDashboard_(dataSheet, headerMap) {
  const spreadsheet = dataSheet.getParent();
  let dashboard = spreadsheet.getSheetByName(DASHBOARD_SHEET_NAME);
  if (!dashboard) {
    dashboard = spreadsheet.insertSheet(DASHBOARD_SHEET_NAME);
  }

  const rows = getDashboardRows_(dataSheet, headerMap);
  ensureDashboardSize_(
    dashboard,
    DASHBOARD_DATA_ROW + Math.max(rows.length, 1),
    43,
  );
  dashboard.getCharts().forEach((chart) => dashboard.removeChart(chart));
  dashboard.clear();
  dashboard.getRange(1, 1, 1, 8).breakApart().merge();
  dashboard.setHiddenGridlines(true);
  dashboard.setFrozenRows(DASHBOARD_DATA_ROW);

  writeDashboardHeader_(dashboard, rows);
  dashboard
    .getRange(DASHBOARD_DATA_ROW, 1, 1, DASHBOARD_HEADERS.length)
    .setValues([DASHBOARD_HEADERS])
    .setBackground("#DCE8EC")
    .setFontColor("#153243")
    .setFontWeight("bold")
    .setHorizontalAlignment("center");

  if (!rows.length) {
    dashboard
      .getRange(DASHBOARD_DATA_ROW + 1, 1)
      .setValue("No score data is available yet.")
      .setFontColor("#667780");
    formatDashboardColumns_(dashboard);
    return { games: 0, charts: 0 };
  }

  const dataRange = dashboard.getRange(
    DASHBOARD_DATA_ROW + 1,
    1,
    rows.length,
    DASHBOARD_HEADERS.length,
  );
  dataRange.setValues(rows);
  dashboard
    .getRange(DASHBOARD_DATA_ROW + 1, 1, rows.length, 1)
    .setNumberFormat("0");
  dashboard
    .getRange(DASHBOARD_DATA_ROW + 1, 2, rows.length, 1)
    .setNumberFormat("yyyy-mm-dd hh:mm:ss");
  dashboard
    .getRange(DASHBOARD_DATA_ROW + 1, 3, rows.length, 1)
    .setNumberFormat("0");
  dashboard
    .getRange(DASHBOARD_DATA_ROW + 1, 4, rows.length, 4)
    .setNumberFormat("0.000");
  formatDashboardColumns_(dashboard);

  const chartRanges = writeDashboardChartData_(dashboard, rows);
  // Chart builders can inspect stale, empty ranges while cell writes are batched.
  SpreadsheetApp.flush();
  insertDashboardCharts_(dashboard, chartRanges);
  SpreadsheetApp.flush();
  return { games: rows.length, charts: 4 };
}

function ensureDashboardSize_(dashboard, requiredRows, requiredColumns) {
  if (dashboard.getMaxRows() < requiredRows) {
    dashboard.insertRowsAfter(
      dashboard.getMaxRows(),
      requiredRows - dashboard.getMaxRows(),
    );
  }
  if (dashboard.getMaxColumns() < requiredColumns) {
    dashboard.insertColumnsAfter(
      dashboard.getMaxColumns(),
      requiredColumns - dashboard.getMaxColumns(),
    );
  }
}

function getDashboardRows_(dataSheet, headerMap) {
  const lastRow = lastBaseDataRow_(dataSheet);
  if (lastRow < 2) {
    return [];
  }

  const requiredHeaders = [
    "timestamp_ms",
    "iso_utc",
    "score",
    "mean_add_ms",
    "mean_sub_ms",
    "mean_mul_ms",
    "mean_div_ms",
  ];
  const lastColumn = Math.max(
    ...requiredHeaders.map((header) => headerMap[header] || 0),
  );
  const values = dataSheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const games = values
    .map((row) => {
      const rawTimestampMs = row[headerMap.timestamp_ms - 1];
      const rawIso = row[headerMap.iso_utc - 1];
      const rawScore = row[headerMap.score - 1];
      if (rawScore === "" || rawScore === null) {
        return null;
      }

      const timestampMs = playedAtTimestamp_(rawIso, rawTimestampMs);
      const score = Number(rawScore);
      if (!Number.isFinite(timestampMs) || !Number.isFinite(score)) {
        return null;
      }

      return {
        timestampMs,
        score,
        timings: [
          secondsOrBlank_(row[headerMap.mean_add_ms - 1]),
          secondsOrBlank_(row[headerMap.mean_sub_ms - 1]),
          secondsOrBlank_(row[headerMap.mean_mul_ms - 1]),
          secondsOrBlank_(row[headerMap.mean_div_ms - 1]),
        ],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs);

  return games.map((game, index) => [
    index + 1,
    new Date(game.timestampMs),
    game.score,
    ...game.timings,
  ]);
}

function playedAtTimestamp_(rawIso, rawTimestampMs) {
  const isoTimestampMs =
    rawIso instanceof Date
      ? rawIso.getTime()
      : Date.parse(String(rawIso || ""));
  if (Number.isFinite(isoTimestampMs)) {
    return isoTimestampMs;
  }

  if (rawTimestampMs === "" || rawTimestampMs === null) {
    return NaN;
  }
  return Number(rawTimestampMs);
}

function secondsOrBlank_(value) {
  if (value === "" || value === null) {
    return "";
  }
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds / 1000
    : "";
}

function writeDashboardHeader_(dashboard, rows) {
  dashboard
    .getRange(1, 1)
    .setValue("Zetamac Performance Dashboard")
    .setBackground("#153243")
    .setFontColor("#FFFFFF")
    .setFontSize(18)
    .setFontWeight("bold")
    .setHorizontalAlignment("left");
  dashboard.setRowHeight(1, 42);

  dashboard.getRange(2, 1, 1, 2).setValues([["Last refreshed", new Date()]]);
  dashboard.getRange(2, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");

  const scores = rows.map((row) => row[2]);
  const latestScore = rows.length ? rows[rows.length - 1][2] : "";
  const bestScore = scores.length
    ? scores.reduce((best, score) => Math.max(best, score), -Infinity)
    : "";
  const averageScore = scores.length
    ? scores.reduce((total, score) => total + score, 0) / scores.length
    : "";
  dashboard
    .getRange(3, 1, 1, 8)
    .setValues([
      [
        "Games",
        rows.length,
        "Best score",
        bestScore,
        "Average score",
        averageScore,
        "Latest score",
        latestScore,
      ],
    ]);
  dashboard
    .getRange(3, 1, 1, 8)
    .setBackground("#EEF4F5")
    .setFontColor("#153243")
    .setHorizontalAlignment("center");
  dashboard.getRange(3, 1, 1, 8).setFontWeight("bold");
  dashboard.getRange(3, 2, 1, 1).setNumberFormat("0");
  dashboard.getRange(3, 4, 1, 1).setNumberFormat("0");
  dashboard.getRange(3, 6, 1, 1).setNumberFormat("0.0");
  dashboard.getRange(3, 8, 1, 1).setNumberFormat("0");
}

function formatDashboardColumns_(dashboard) {
  dashboard.setColumnWidth(1, 100);
  dashboard.setColumnWidth(2, 165);
  dashboard.setColumnWidth(3, 90);
  dashboard.setColumnWidths(4, 4, 125);
}

function writeDashboardChartData_(dashboard, rows) {
  const timingRows = rows.filter((row) =>
    row.slice(3).some((value) => value !== "" && value !== null),
  );
  const blocks = [
    {
      column: DASHBOARD_CHART_DATA_COLUMN,
      values: [["Played at", "Score"], ...rows.map((row) => [row[1], row[2]])],
    },
    {
      column: DASHBOARD_CHART_DATA_COLUMN + 3,
      values: [
        ["Game number", "Score"],
        ...rows.map((row) => [row[0], row[2]]),
      ],
    },
    {
      column: DASHBOARD_CHART_DATA_COLUMN + 6,
      values: [
        ["Played at", "Addition", "Subtraction", "Multiplication", "Division"],
        ...timingRows.map((row) => [row[1], ...row.slice(3)]),
      ],
    },
    {
      column: DASHBOARD_CHART_DATA_COLUMN + 12,
      values: [
        [
          "Game number",
          "Addition",
          "Subtraction",
          "Multiplication",
          "Division",
        ],
        ...timingRows.map((row) => [row[0], ...row.slice(3)]),
      ],
    },
  ];

  return blocks.map((block) => {
    const range = dashboard.getRange(
      1,
      block.column,
      block.values.length,
      block.values[0].length,
    );
    range.setValues(block.values);
    return range;
  });
}

function insertDashboardCharts_(dashboard, chartRanges) {
  const scoreColors = [DASHBOARD_COLORS.score];
  const timingColors = [
    DASHBOARD_COLORS.addition,
    DASHBOARD_COLORS.subtraction,
    DASHBOARD_COLORS.multiplication,
    DASHBOARD_COLORS.division,
  ];

  insertLineChart_(dashboard, {
    range: chartRanges[0],
    position: [2, 9],
    title: "Score over time",
    horizontalTitle: "Played at",
    verticalTitle: "Score",
    colors: scoreColors,
  });
  insertLineChart_(dashboard, {
    range: chartRanges[1],
    position: [2, 17],
    title: "Score by game number",
    horizontalTitle: "Game number",
    verticalTitle: "Score",
    colors: scoreColors,
  });
  insertLineChart_(dashboard, {
    range: chartRanges[2],
    position: [21, 9],
    title: "Operation time over time",
    horizontalTitle: "Played at",
    verticalTitle: "Average response time (seconds)",
    colors: timingColors,
  });
  insertLineChart_(dashboard, {
    range: chartRanges[3],
    position: [21, 17],
    title: "Operation time by game number",
    horizontalTitle: "Game number",
    verticalTitle: "Average response time (seconds)",
    colors: timingColors,
  });
}

function insertLineChart_(dashboard, config) {
  const builder = dashboard.newChart().asLineChart();
  builder.addRange(config.range);
  builder.setNumHeaders(1);
  builder.setTransposeRowsAndColumns(false);
  builder.setPosition(config.position[0], config.position[1], 0, 0);
  builder.setTitle(config.title);
  builder.setXAxisTitle(config.horizontalTitle);
  builder.setYAxisTitle(config.verticalTitle);
  builder.setColors(config.colors);
  builder.setOption("useFirstColumnAsDomain", true);
  builder.setOption("pointSize", 4);
  builder.setOption("interpolateNulls", true);
  builder.setOption("width", 680);
  builder.setOption("height", 360);

  dashboard.insertChart(builder.build());
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
