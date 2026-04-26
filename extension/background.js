const REMOTE_SETTINGS_KEY = "remoteExport";
const REMOTE_QUEUE_KEY = "remoteQueue";
const REMOTE_UPLOADED_KEY = "remoteUploadedIds";
const REMOTE_STATUS_KEY = "remoteStatus";
const SCORES_KEY = "scores";

const MAX_QUEUE = 10000;
const MAX_UPLOADED_IDS = 20000;
const MAX_BATCH_SIZE = 50;
const GOOGLE_WEB_APP_RE = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/(?:exec|dev)(?:[?#].*)?$/i;
const ZETAMAC_MATCHES = ["*://zetamac.com/*", "*://*.zetamac.com/*"];

let flushPromise = null;
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

function normalizeRow(row) {
  const t = Number(row && row.t);
  const s = Number(row && row.s);
  if (!Number.isFinite(t) || !Number.isFinite(s)) {
    return null;
  }

  return {
    id: String(row.id || `legacy:${t}:${s}`),
    t,
    s,
  };
}

function normalizeSettings(settings) {
  return {
    webhookUrl: typeof settings?.webhookUrl === "string" ? settings.webhookUrl.trim() : "",
    secret: typeof settings?.secret === "string" ? settings.secret : "",
    deviceName: typeof settings?.deviceName === "string" ? settings.deviceName.trim() : "",
  };
}

async function getRemoteSettings() {
  const result = await browser.storage.local.get({ [REMOTE_SETTINGS_KEY]: {} });
  return normalizeSettings(result[REMOTE_SETTINGS_KEY]);
}

async function setRemoteSettings(settings) {
  const next = normalizeSettings(settings);
  if (next.webhookUrl && !GOOGLE_WEB_APP_RE.test(next.webhookUrl)) {
    throw new Error("Webhook URL must be a deployed Google Apps Script /exec URL.");
  }

  await browser.storage.local.set({ [REMOTE_SETTINGS_KEY]: next });
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
    source: "zetamac-google-sheet",
    deviceName: settings.deviceName,
    extensionVersion: browser.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    rows: rows.map((row) => ({
      id: row.id,
      timestampMs: row.t,
      iso: new Date(row.t).toISOString(),
      score: row.s,
      deviceName: settings.deviceName,
    })),
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
  const result = await browser.storage.local.get({ [SCORES_KEY]: [] });
  const scores = Array.isArray(result[SCORES_KEY]) ? result[SCORES_KEY] : [];
  await enqueueRows(scores);
  return flushQueue();
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  switch (message.type) {
    case "record-score":
      return enqueueRows([message.row]).then(() => flushQueue());
    case "get-remote-status":
      return getRemoteStatus();
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
  ensureContentScriptRegistration().catch(console.error);
  injectIntoOpenTabs().catch(console.error);
  flushQueue().catch(console.error);
});

browser.runtime.onInstalled.addListener(() => {
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

ensureContentScriptRegistration().catch(console.error);
injectIntoOpenTabs().catch(console.error);
flushQueue().catch(console.error);
