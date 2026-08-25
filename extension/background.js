const REMOTE_SETTINGS_KEY = "remoteExport";
const REMOTE_DEVICE_NAME_KEY = "remoteDeviceName";
const REMOTE_QUEUE_KEY = "remoteQueue";
const REMOTE_UPLOADED_KEY = "remoteUploadedIds";
const REMOTE_STATUS_KEY = "remoteStatus";
const SCORES_KEY = "scores";

const MAX_QUEUE = 10000;
const MAX_UPLOADED_IDS = 20000;
const MAX_BATCH_SIZE = 50;
const MAX_LOCAL_ROWS = 10000;
const DOM_FALLBACK_DELAY_MS = 4000;
const RECENT_RESULT_MS = 90000;
const GOOGLE_WEB_APP_RE = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/(?:exec|dev)(?:[?#].*)?$/i;
const ZETAMAC_MATCHES = ["*://zetamac.com/*", "*://*.zetamac.com/*"];
const ZETAMAC_LOG_URLS = ["https://arithmetic.zetamac.com/log"];
const NUMBER_ROW_FIELDS = [
  "problemCount",
  "abandonedCount",
  "durationMs",
  "totalErrors",
  "wrongAttempts",
  "keystrokeErrorRate",
  "attemptErrorRate",
  "addCount",
  "subCount",
  "mulCount",
  "divCount",
  "meanAddMs",
  "meanSubMs",
  "meanMulMs",
  "meanDivMs",
  "slowest1Ms",
  "slowest2Ms",
  "slowest3Ms",
];
const STRING_ROW_FIELDS = [
  "captureMethod",
  "problemLogKey",
  "slowest1",
  "slowest2",
  "slowest3",
];

let flushPromise = null;
let zetaLogListenerRegistered = false;
const REGISTERED_SCRIPT_ID = "zetamac-content";

async function ensureContentScriptRegistration() {
  const script = {
    id: REGISTERED_SCRIPT_ID,
    js: ["content/content.js"],
    matches: ZETAMAC_MATCHES,
    allFrames: true,
    runAt: "document_end",
    persistAcrossSessions: true,
  };

  try {
    const existing = await browser.scripting.getRegisteredContentScripts({
      ids: [REGISTERED_SCRIPT_ID],
    });

    if (existing.length) {
      await browser.scripting.updateContentScripts([script]);
    } else {
      await browser.scripting.registerContentScripts([script]);
    }
  } catch (error) {
    console.error("Failed to register persistent content script", error);
  }
}

async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await browser.tabs.query({
      url: ZETAMAC_MATCHES,
    });
  } catch (error) {
    console.error("Failed to query Zetamac tabs", error);
    return;
  }

  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) =>
        browser.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["content/content.js"],
        }).catch((error) => {
          console.error("Failed to inject into tab", tab.id, error);
        })
      )
  );
}

function isZetamacUrl(url) {
  return typeof url === "string" && /^https?:\/\/([^.]+\.)?zetamac\.com\//i.test(url);
}

async function injectTabIfNeeded(tabId, url) {
  if (!Number.isInteger(tabId) || !isZetamacUrl(url)) {
    return;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/content.js"],
    });
  } catch (error) {
    console.error("Failed to inject into tab", tabId, error);
  }
}

function handleTabNavigation(tabId, url) {
  injectTabIfNeeded(tabId, url).catch(console.error);
}

async function handleTabActivation(activeInfo) {
  try {
    const tab = await browser.tabs.get(activeInfo.tabId);
    handleTabNavigation(tab.id, tab.url || "");
  } catch (error) {
    console.error("Failed to inspect activated tab", error);
  }
}

function normalizedNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeRow(row) {
  const t = Number(row && row.t);
  const s = Number(row && row.s);
  if (!Number.isFinite(t) || !Number.isFinite(s)) {
    return null;
  }

  const normalized = {
    id: String(row.id || `legacy:${t}:${s}`),
    t,
    s,
  };

  for (const field of NUMBER_ROW_FIELDS) {
    const value = normalizedNumber(row[field]);
    if (value !== null) {
      normalized[field] = value;
    }
  }

  for (const field of STRING_ROW_FIELDS) {
    const value = normalizedString(row[field]);
    if (value) {
      normalized[field] = value;
    }
  }

  return normalized;
}

function firstFormValue(formData, key) {
  const value = formData && formData[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function decodeRawFormData(requestBody) {
  const raw = requestBody && Array.isArray(requestBody.raw) ? requestBody.raw : [];
  const decoder = new TextDecoder();
  let text = "";

  for (const part of raw) {
    if (part.bytes) {
      text += decoder.decode(part.bytes, { stream: true });
    }
  }
  text += decoder.decode();

  if (!text) {
    return {};
  }

  const params = new URLSearchParams(text);
  const formData = {};
  for (const [key, value] of params.entries()) {
    if (!formData[key]) {
      formData[key] = [];
    }
    formData[key].push(value);
  }
  return formData;
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function detectOp(problem) {
  if (typeof problem !== "string") {
    return null;
  }
  if (problem.includes("+")) return "add";
  if (problem.includes("\u00d7") || problem.includes("*")) return "mul";
  if (problem.includes("\u00f7") || problem.includes("/")) return "div";
  if (problem.includes("-")) return "sub";
  return null;
}

function entryLength(entry) {
  if (Array.isArray(entry)) {
    return entry.length;
  }
  if (entry === null || entry === undefined) {
    return 0;
  }
  return String(entry).length;
}

function computeProblemStats(problemLog) {
  const completed = problemLog.filter((entry) => Number(entry?.timeMs) >= 0);
  const buckets = {
    add: [],
    sub: [],
    mul: [],
    div: [],
  };
  let totalErrors = 0;
  let wrongAttempts = 0;
  let durationMs = 0;

  for (const entry of completed) {
    const timeMs = Number(entry.timeMs);
    if (Number.isFinite(timeMs)) {
      durationMs += timeMs;
    }

    const op = detectOp(entry?.problem);
    if (op && Number.isFinite(timeMs)) {
      buckets[op].push(timeMs);
    }

    const expected = String(entry?.answer ?? "").length;
    const typed = entryLength(entry?.entry);
    const errors = Math.max(0, typed - expected);
    totalErrors += errors;
    if (errors > 0) {
      wrongAttempts += 1;
    }
  }

  const mean = (values) => values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;

  const score = completed.length;
  const keystrokeDenominator = score + totalErrors;
  const slowest = [...completed]
    .filter((entry) => Number.isFinite(Number(entry?.timeMs)))
    .sort((a, b) => Number(b.timeMs) - Number(a.timeMs))
    .slice(0, 3);

  return {
    score,
    problemCount: score,
    abandonedCount: Math.max(0, problemLog.length - completed.length),
    durationMs,
    totalErrors,
    wrongAttempts,
    keystrokeErrorRate: keystrokeDenominator ? Number((totalErrors / keystrokeDenominator).toFixed(4)) : 0,
    attemptErrorRate: score ? Number((wrongAttempts / score).toFixed(4)) : 0,
    addCount: buckets.add.length,
    subCount: buckets.sub.length,
    mulCount: buckets.mul.length,
    divCount: buckets.div.length,
    meanAddMs: mean(buckets.add),
    meanSubMs: mean(buckets.sub),
    meanMulMs: mean(buckets.mul),
    meanDivMs: mean(buckets.div),
    slowest1: String(slowest[0]?.problem || ""),
    slowest1Ms: normalizedNumber(slowest[0]?.timeMs),
    slowest2: String(slowest[1]?.problem || ""),
    slowest2Ms: normalizedNumber(slowest[1]?.timeMs),
    slowest3: String(slowest[2]?.problem || ""),
    slowest3Ms: normalizedNumber(slowest[2]?.timeMs),
  };
}

function rowFromZetamacLog(details) {
  const requestBody = details && details.requestBody;
  const formData = requestBody?.formData || decodeRawFormData(requestBody);
  const problemLogStr = firstFormValue(formData, "problemLog");
  if (!problemLogStr) {
    return null;
  }

  let problemLog;
  try {
    problemLog = JSON.parse(problemLogStr);
  } catch (error) {
    console.warn("Zetamac log had an unparsable problemLog", error);
    return null;
  }

  if (!Array.isArray(problemLog)) {
    return null;
  }

  const stats = computeProblemStats(problemLog);
  if (!stats.score) {
    return null;
  }

  const key = String(firstFormValue(formData, "key") || "");
  const t = Number.isFinite(details.timeStamp) ? Math.round(details.timeStamp) : Date.now();
  return normalizeRow({
    id: `log:${stableHash(`${key}\u0000${problemLogStr}`)}`,
    t,
    s: stats.score,
    captureMethod: "network",
    problemLogKey: key,
    ...stats,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSettings(settings) {
  return {
    webhookUrl: typeof settings?.webhookUrl === "string" ? settings.webhookUrl.trim() : "",
    secret: typeof settings?.secret === "string" ? settings.secret : "",
    deviceName: typeof settings?.deviceName === "string" ? settings.deviceName.trim() : "",
  };
}

async function getRemoteSettings() {
  const [syncResult, localResult] = await Promise.all([
    browser.storage.sync.get({ [REMOTE_SETTINGS_KEY]: {} }),
    browser.storage.local.get({ [REMOTE_DEVICE_NAME_KEY]: "" }),
  ]);
  const rawSettings = syncResult[REMOTE_SETTINGS_KEY] || {};
  const synced = normalizeSettings(rawSettings);
  let deviceName = typeof localResult[REMOTE_DEVICE_NAME_KEY] === "string"
    ? localResult[REMOTE_DEVICE_NAME_KEY].trim()
    : "";
  const migrations = [];

  if (!deviceName && synced.deviceName) {
    deviceName = synced.deviceName;
    migrations.push(browser.storage.local.set({ [REMOTE_DEVICE_NAME_KEY]: deviceName }));
  }
  if (Object.prototype.hasOwnProperty.call(rawSettings, "deviceName")) {
    migrations.push(browser.storage.sync.set({
      [REMOTE_SETTINGS_KEY]: {
        webhookUrl: synced.webhookUrl,
        secret: synced.secret,
      },
    }));
  }
  if (migrations.length) {
    await Promise.all(migrations);
  }

  return { ...synced, deviceName };
}

async function setRemoteSettings(settings) {
  const next = normalizeSettings(settings);
  if (next.webhookUrl && !GOOGLE_WEB_APP_RE.test(next.webhookUrl)) {
    throw new Error("Webhook URL must be a deployed Google Apps Script /exec URL.");
  }

  await Promise.all([
    browser.storage.sync.set({
      [REMOTE_SETTINGS_KEY]: {
        webhookUrl: next.webhookUrl,
        secret: next.secret,
      },
    }),
    browser.storage.local.set({ [REMOTE_DEVICE_NAME_KEY]: next.deviceName }),
  ]);
  return next;
}

async function getQueue() {
  const result = await browser.storage.local.get({ [REMOTE_QUEUE_KEY]: [] });
  const queue = Array.isArray(result[REMOTE_QUEUE_KEY]) ? result[REMOTE_QUEUE_KEY] : [];
  return queue.map(normalizeRow).filter(Boolean);
}

async function setQueue(rows) {
  await browser.storage.local.set({ [REMOTE_QUEUE_KEY]: rows.slice(-MAX_QUEUE) });
}

async function getUploadedIds() {
  const result = await browser.storage.local.get({ [REMOTE_UPLOADED_KEY]: [] });
  return Array.isArray(result[REMOTE_UPLOADED_KEY]) ? result[REMOTE_UPLOADED_KEY].map(String) : [];
}

async function setUploadedIds(ids) {
  await browser.storage.local.set({ [REMOTE_UPLOADED_KEY]: ids.slice(-MAX_UPLOADED_IDS) });
}

async function getRemoteStatus() {
  const [settings, localState] = await Promise.all([
    getRemoteSettings(),
    browser.storage.local.get({
      [REMOTE_QUEUE_KEY]: [],
      [REMOTE_UPLOADED_KEY]: [],
      [REMOTE_STATUS_KEY]: {},
    }),
  ]);

  const status = localState[REMOTE_STATUS_KEY] || {};
  const pending = Array.isArray(localState[REMOTE_QUEUE_KEY]) ? localState[REMOTE_QUEUE_KEY].length : 0;
  const uploaded = Array.isArray(localState[REMOTE_UPLOADED_KEY]) ? localState[REMOTE_UPLOADED_KEY].length : 0;

  return {
    configured: Boolean(settings.webhookUrl),
    webhookUrl: settings.webhookUrl,
    deviceName: settings.deviceName,
    pendingCount: pending,
    uploadedCount: uploaded,
    uploading: Boolean(status.uploading),
    lastAttemptAt: status.lastAttemptAt || null,
    lastSuccessAt: status.lastSuccessAt || null,
    lastError: status.lastError || "",
    lastResponse: status.lastResponse || "",
  };
}

async function setRemoteStatus(patch) {
  const result = await browser.storage.local.get({ [REMOTE_STATUS_KEY]: {} });
  const next = { ...(result[REMOTE_STATUS_KEY] || {}), ...patch };
  await browser.storage.local.set({ [REMOTE_STATUS_KEY]: next });
  return next;
}

async function getScores() {
  const result = await browser.storage.local.get({ [SCORES_KEY]: [] });
  return Array.isArray(result[SCORES_KEY]) ? result[SCORES_KEY] : [];
}

async function setScores(rows) {
  await browser.storage.local.set({ [SCORES_KEY]: rows.slice(-MAX_LOCAL_ROWS) });
}

function sameRecentScore(a, b) {
  return a && b && a.s === b.s && Math.abs(Number(a.t) - Number(b.t)) <= RECENT_RESULT_MS;
}

function findRecentNetworkScore(scores, row) {
  return scores
    .map(normalizeRow)
    .filter(Boolean)
    .some((existing) => existing.captureMethod === "network" && sameRecentScore(existing, row));
}

async function removeQueuedIds(ids) {
  if (!ids.length) {
    return;
  }

  const idsToRemove = new Set(ids);
  const queue = (await getQueue()).filter((row) => !idsToRemove.has(row.id));
  await setQueue(queue);
}

async function saveRecordedRows(rows) {
  const normalized = rows.map(normalizeRow).filter(Boolean);
  if (!normalized.length) {
    return getRemoteStatus();
  }

  const scores = await getScores();
  const savedRows = [];
  const replacedIds = [];

  for (const row of normalized) {
    const existingIndex = scores.findIndex((existing) => normalizeRow(existing)?.id === row.id);
    if (existingIndex >= 0) {
      scores[existingIndex] = { ...scores[existingIndex], ...row };
      savedRows.push(row);
      continue;
    }

    if (row.captureMethod === "network") {
      const domIndex = scores.findIndex((existing) => {
        const normalizedExisting = normalizeRow(existing);
        return normalizedExisting?.captureMethod === "dom" && sameRecentScore(normalizedExisting, row);
      });

      if (domIndex >= 0) {
        const replaced = normalizeRow(scores[domIndex]);
        if (replaced?.id) {
          replacedIds.push(replaced.id);
        }
        scores[domIndex] = { ...scores[domIndex], ...row };
        savedRows.push(row);
        continue;
      }
    }

    if (row.captureMethod === "dom" && findRecentNetworkScore(scores, row)) {
      continue;
    }

    scores.push(row);
    savedRows.push(row);
  }

  if (!savedRows.length) {
    return getRemoteStatus();
  }

  await setScores(scores);
  await removeQueuedIds(replacedIds);
  await enqueueRows(savedRows);
  return getRemoteStatus();
}

async function recordIncomingRow(row) {
  const normalized = normalizeRow(row);
  if (!normalized) {
    return getRemoteStatus();
  }

  if (normalized.captureMethod === "dom") {
    await delay(DOM_FALLBACK_DELAY_MS);
    if (findRecentNetworkScore(await getScores(), normalized)) {
      return getRemoteStatus();
    }
  }

  await saveRecordedRows([normalized]);
  return flushQueue();
}

async function enqueueRows(rows) {
  const normalized = rows.map(normalizeRow).filter(Boolean);
  if (!normalized.length) {
    return getRemoteStatus();
  }

  const [queue, uploadedIds] = await Promise.all([getQueue(), getUploadedIds()]);
  const uploaded = new Set(uploadedIds);
  const queueById = new Map(queue.map((row) => [row.id, row]));

  for (const row of normalized) {
    if (uploaded.has(row.id) || queueById.has(row.id)) {
      continue;
    }
    queueById.set(row.id, row);
  }

  await setQueue(Array.from(queueById.values()));
  return getRemoteStatus();
}

async function postBatch(settings, rows) {
  const payload = {
    secret: settings.secret,
    source: "zetamac-tracker",
    deviceName: settings.deviceName,
    extensionVersion: browser.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    rows: rows.map((row) => {
      const payloadRow = {
        id: row.id,
        timestampMs: row.t,
        iso: new Date(row.t).toISOString(),
        score: row.s,
        deviceName: settings.deviceName,
      };

      for (const field of [...NUMBER_ROW_FIELDS, ...STRING_ROW_FIELDS]) {
        if (row[field] !== undefined) {
          payloadRow[field] = row[field];
        }
      }

      return payloadRow;
    }),
  };

  const body = JSON.stringify(payload);
  try {
    return await postBatchWithFetch(settings.webhookUrl, body);
  } catch (error) {
    const message = error?.message || String(error);
    const looksLikeNetworkError =
      /\bNetworkError\b/i.test(message) ||
      /\bFailed to fetch\b/i.test(message) ||
      /\bLoad failed\b/i.test(message);

    if (!looksLikeNetworkError) {
      throw error;
    }

    return postBatchWithXhr(settings.webhookUrl, body, message);
  }
}

async function postBatchWithFetch(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      // Use a simple content type so Firefox doesn't preflight the Apps Script URL.
      "Content-Type": "text/plain;charset=utf-8",
    },
    body,
    redirect: "follow",
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  if (data.ok === false) {
    throw new Error(data.error || "Remote upload rejected the batch.");
  }

  return data;
}

function postBatchWithXhr(url, body, priorErrorMessage) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.responseType = "text";
    xhr.timeout = 30000;
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");

    xhr.onload = () => {
      const text = xhr.responseText || "";
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = { raw: text };
        }
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error || `HTTP ${xhr.status} after fetch failed: ${priorErrorMessage}`));
        return;
      }

      if (data.ok === false) {
        reject(new Error(data.error || `Remote upload rejected the batch after fetch failed: ${priorErrorMessage}`));
        return;
      }

      resolve(data);
    };

    xhr.onerror = () => {
      reject(new Error(`NetworkError via XMLHttpRequest after fetch failed: ${priorErrorMessage}`));
    };

    xhr.ontimeout = () => {
      reject(new Error(`Upload timed out via XMLHttpRequest after fetch failed: ${priorErrorMessage}`));
    };

    xhr.send(body);
  });
}

async function markRowsUploaded(rows, response) {
  const uploadedIds = new Set(await getUploadedIds());
  const uploadedRowIds = new Set(rows.map((row) => row.id));
  rows.forEach((row) => uploadedIds.add(row.id));

  const queue = (await getQueue()).filter((row) => !uploadedRowIds.has(row.id));
  await Promise.all([
    setQueue(queue),
    setUploadedIds(Array.from(uploadedIds)),
    setRemoteStatus({
      uploading: false,
      lastError: "",
      lastSuccessAt: Date.now(),
      lastResponse: JSON.stringify({
        appended: Number.isFinite(response.appended) ? response.appended : rows.length,
        accepted: Array.isArray(response.acceptedIds) ? response.acceptedIds.length : rows.length,
      }),
    }),
  ]);
}

async function doFlushQueue() {
  const settings = await getRemoteSettings();
  if (!settings.webhookUrl) {
    await setRemoteStatus({ uploading: false });
    return getRemoteStatus();
  }

  await setRemoteStatus({
    uploading: true,
    lastAttemptAt: Date.now(),
    lastError: "",
  });

  let queue = await getQueue();
  if (!queue.length) {
    await setRemoteStatus({ uploading: false });
    return getRemoteStatus();
  }

  while (queue.length) {
    const batch = queue.slice(0, MAX_BATCH_SIZE);
    try {
      const response = await postBatch(settings, batch);
      await markRowsUploaded(batch, response);
    } catch (error) {
      await setRemoteStatus({
        uploading: false,
        lastError: error?.message || String(error),
        lastResponse: "",
      });
      return getRemoteStatus();
    }

    queue = await getQueue();
  }

  await setRemoteStatus({ uploading: false });
  return getRemoteStatus();
}

async function flushQueue() {
  if (!flushPromise) {
    flushPromise = doFlushQueue().finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

async function syncAllScores() {
  const scores = await getScores();
  await enqueueRows(scores);
  return flushQueue();
}

async function handleZetamacLogRequest(details) {
  const row = rowFromZetamacLog(details);
  if (!row) {
    return;
  }

  try {
    await saveRecordedRows([row]);
    await flushQueue();
  } catch (error) {
    console.error("Failed to save Zetamac network log", error);
  }
}

function registerZetamacLogListener() {
  if (!browser.webRequest?.onBeforeRequest) {
    console.warn("webRequest is unavailable; using DOM fallback only");
    return;
  }

  if (zetaLogListenerRegistered) {
    return;
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      handleZetamacLogRequest(details).catch(console.error);
    },
    { urls: ZETAMAC_LOG_URLS },
    ["requestBody"]
  );
  zetaLogListenerRegistered = true;
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  switch (message.type) {
    case "record-score":
      return recordIncomingRow(message.row);
    case "get-remote-status":
      return getRemoteStatus();
    case "get-remote-settings":
      return getRemoteSettings();
    case "save-remote-settings":
      return setRemoteSettings(message.settings).then(() => flushQueue());
    case "retry-remote-upload":
      return flushQueue();
    case "sync-all-remote":
      return syncAllScores();
    default:
      return undefined;
  }
});

browser.runtime.onStartup.addListener(() => {
  registerZetamacLogListener();
  ensureContentScriptRegistration().catch(console.error);
  injectIntoOpenTabs().catch(console.error);
  flushQueue().catch(console.error);
});

browser.runtime.onInstalled.addListener(() => {
  registerZetamacLogListener();
  ensureContentScriptRegistration().catch(console.error);
  injectIntoOpenTabs().catch(console.error);
  flushQueue().catch(console.error);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || "";
  if (changeInfo.status === "complete" || changeInfo.url) {
    handleTabNavigation(tabId, url);
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivation(activeInfo).catch(console.error);
});

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  handleTabNavigation(details.tabId, details.url);
});

browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  handleTabNavigation(details.tabId, details.url);
});

browser.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  handleTabNavigation(details.tabId, details.url);
});

registerZetamacLogListener();
ensureContentScriptRegistration().catch(console.error);
injectIntoOpenTabs().catch(console.error);
flushQueue().catch(console.error);
