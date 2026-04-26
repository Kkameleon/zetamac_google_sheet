// Popup chart + CSV export/clear helpers.

let popupCanvas = null;

async function loadScores() {
  const { scores = [] } = await browser.storage.local.get({ scores: [] });
  return Array.isArray(scores) ? scores : [];
}

function fmt(n) { return Number.isFinite(n) ? String(n) : "–"; }

function drawChart(canvas, rows) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!rows.length) {
    ctx.fillStyle = "#666"; ctx.font = "14px system-ui";
    ctx.fillText("No scores yet. Play a round on arithmetic.zetamac.com.", 12, H/2);
    return;
  }

  const padL = 40, padR = 12, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const ys = rows.map(r => r.s);
  const xs = rows.map(r => r.t);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const ySpan = Math.max(1, yMax - yMin);
  const xSpan = Math.max(1, xMax - xMin);

  ctx.strokeStyle = "#bbb";
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  ctx.fillStyle = "#666"; ctx.font = "12px system-ui";
  for (let i = 0; i <= 5; i++) {
    const yv = yMin + (ySpan * i / 5);
    const y = padT + plotH - (plotH * i / 5);
    ctx.fillText(Math.round(yv), 4, y + 4);
    ctx.strokeStyle = i === 0 ? "#bbb" : "#eee";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }

  ctx.strokeStyle = "#3a6cf0";
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((r, idx) => {
    const x = padL + ((r.t - xMin) / xSpan) * plotW;
    const y = padT + plotH - ((r.s - yMin) / ySpan) * plotH;
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const rlast = rows[rows.length - 1];
  const x = padL + ((rlast.t - xMin) / xSpan) * plotW;
  const y = padT + plotH - ((rlast.s - yMin) / ySpan) * plotH;
  ctx.fillStyle = "#3a6cf0"; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
}

function toCSV(rows) {
  return "timestamp,iso,score\n" + rows.map(r => `${r.t},${new Date(r.t).toISOString()},${r.s}`).join("\n");
}

function updateStats(rows) {
  const c = rows.length;
  const avg = c ? (rows.reduce((a, r) => a + r.s, 0) / c) : NaN;
  const best = c ? Math.max(...rows.map(r => r.s)) : NaN;
  const last = c ? rows[c - 1].s : NaN;
  document.getElementById("count").textContent = c;
  document.getElementById("avg").textContent   = fmt(Math.round(avg * 10) / 10);
  document.getElementById("best").textContent  = fmt(best);
  document.getElementById("last").textContent  = fmt(last);
}

function renderScores(rows) {
  if (!popupCanvas) return;
  updateStats(rows);
  drawChart(popupCanvas, rows.slice(-400));
}

function formatWhen(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

function renderRemoteStatus(status) {
  const el = document.getElementById("remote-status");
  if (!status.configured) {
    el.dataset.state = "warn";
    el.textContent = "Remote export is off. Open Options to add the Google Apps Script webhook URL.";
    return;
  }

  if (status.lastError) {
    el.dataset.state = "error";
    el.textContent = `Pending ${status.pendingCount}. Last error: ${status.lastError}`;
    return;
  }

  if (status.uploading) {
    el.dataset.state = "warn";
    el.textContent = `Uploading ${status.pendingCount} pending row(s) to Google Sheets...`;
    return;
  }

  el.dataset.state = "ok";
  el.textContent = `Pending ${status.pendingCount}. Last successful sync: ${formatWhen(status.lastSuccessAt)}${status.deviceName ? ` from ${status.deviceName}` : ""}.`;
}

async function refreshRemoteStatus() {
  const status = await browser.runtime.sendMessage({ type: "get-remote-status" });
  renderRemoteStatus(status);
  return status;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.scores) {
    const rows = Array.isArray(changes.scores.newValue) ? changes.scores.newValue : [];
    renderScores(rows);
  }
  if (!changes.remoteStatus && !changes.remoteQueue && !changes.remoteUploadedIds) return;
  refreshRemoteStatus().catch(console.error);
});

(async function main() {
  const canvas = document.getElementById("chart");
  popupCanvas = canvas;
  const rows = await loadScores();
  renderScores(rows);
  await refreshRemoteStatus();

  document.getElementById("export").onclick = async () => {
    const currentRows = await loadScores();
    const blob = new Blob([toCSV(currentRows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "zetamac_scores.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById("clear").onclick = async () => {
    if (!confirm("Clear all saved scores?")) return;
    const { remoteStatus = {} } = await browser.storage.local.get({ remoteStatus: {} });
    await browser.storage.local.set({
      scores: [],
      remoteQueue: [],
      remoteStatus: {
        ...remoteStatus,
        uploading: false,
        lastError: "",
      },
    });
    updateStats([]);
    drawChart(canvas, []);
  };

  document.getElementById("sync-remote").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const status = await browser.runtime.sendMessage({ type: "sync-all-remote" });
      renderRemoteStatus(status);
    } finally {
      button.disabled = false;
    }
  };

  document.getElementById("open-options").onclick = () => browser.runtime.openOptionsPage();
})();
