const REMOTE_SETTINGS_KEY = "remoteExport";

function formatWhen(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

function setRemoteStatusText(text, state = "ok") {
  const el = document.getElementById("remoteStatus");
  el.textContent = text;
  el.dataset.state = state;
  el.style.color = state === "error" ? "#9f2020" : state === "warn" ? "#835b00" : "#13643b";
}

async function loadRemoteSettings() {
  const { [REMOTE_SETTINGS_KEY]: settings = {} } = await browser.storage.local.get({ [REMOTE_SETTINGS_KEY]: {} });
  document.getElementById("webhookUrl").value = settings.webhookUrl || "";
  document.getElementById("secret").value = settings.secret || "";
  document.getElementById("deviceName").value = settings.deviceName || "";
}

function renderRemoteStatus(status) {
  if (!status.configured) {
    setRemoteStatusText("Remote export is disabled. Save a webhook URL to enable Google Sheets sync.", "warn");
    return;
  }

  if (status.lastError) {
    setRemoteStatusText(`Pending ${status.pendingCount}. Last error: ${status.lastError}`, "error");
    return;
  }

  if (status.uploading) {
    setRemoteStatusText(`Uploading ${status.pendingCount} pending row(s)...`, "warn");
    return;
  }

  setRemoteStatusText(
    `Pending ${status.pendingCount}. Last successful sync: ${formatWhen(status.lastSuccessAt)}. Uploaded IDs tracked locally: ${status.uploadedCount}.`,
    "ok"
  );
}

async function refreshRemoteStatus() {
  const status = await browser.runtime.sendMessage({ type: "get-remote-status" });
  renderRemoteStatus(status);
  return status;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes[REMOTE_SETTINGS_KEY]) {
    loadRemoteSettings().catch(console.error);
  }

  if (changes.remoteStatus || changes.remoteQueue || changes.remoteUploadedIds) {
    refreshRemoteStatus().catch(console.error);
  }
});

document.getElementById("saveRemote").onclick = async () => {
  try {
    const status = await browser.runtime.sendMessage({
      type: "save-remote-settings",
      settings: {
        webhookUrl: document.getElementById("webhookUrl").value,
        secret: document.getElementById("secret").value,
        deviceName: document.getElementById("deviceName").value,
      },
    });
    renderRemoteStatus(status);
  } catch (error) {
    setRemoteStatusText(error?.message || String(error), "error");
  }
};

document.getElementById("syncAll").onclick = async () => {
  try {
    const status = await browser.runtime.sendMessage({ type: "sync-all-remote" });
    renderRemoteStatus(status);
  } catch (error) {
    setRemoteStatusText(error?.message || String(error), "error");
  }
};

document.getElementById("retryPending").onclick = async () => {
  try {
    const status = await browser.runtime.sendMessage({ type: "retry-remote-upload" });
    renderRemoteStatus(status);
  } catch (error) {
    setRemoteStatusText(error?.message || String(error), "error");
  }
};

document.getElementById("import").onclick = async () => {
  const f = document.getElementById("file").files?.[0];
  if (!f) return;

  const text = await f.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    alert("No data rows.");
    return;
  }

  const rows = [];
  for (const line of lines.slice(1)) {
    const [t, , s] = line.split(",");
    const tt = Number(t);
    const ss = Number(s);
    if (!Number.isFinite(tt) || !Number.isFinite(ss)) {
      continue;
    }
    rows.push({ id: `legacy:${tt}:${ss}`, t: tt, s: ss });
  }

  await browser.storage.local.set({ scores: rows });
  alert(`Imported ${rows.length} rows.`);
  await refreshRemoteStatus();
};

(async function init() {
  await loadRemoteSettings();
  await refreshRemoteStatus();
})();
