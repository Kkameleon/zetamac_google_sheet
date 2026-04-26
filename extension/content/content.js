// Saves once per round after the end screen renders.

if (window.__zetamacTrackerInjected) {
  console.log("[ZetamacTracker] content script already active");
} else {
  window.__zetamacTrackerInjected = true;

const LOG = (...a) => console.log("[ZetamacTracker]", ...a);
const now = () => Date.now();

const MAX_ROWS = 10000;
const DEDUPE_MS = 60000;       // 60s: prevent multiple writes for same result
let armed = false;             // we're mid-round
let savedThisRound = false;    // we already saved the final score of this round
let sawUnfinishedSinceInjection = false;

function makeRowId(ts, score) {
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `score:${ts}:${score}:${Math.random().toString(36).slice(2, 10)}`;
}

async function getScores() {
  const { scores = [] } = await browser.storage.local.get("scores");
  return Array.isArray(scores) ? scores : [];
}
async function setScores(rows) {
  await browser.storage.local.set({ scores: rows.slice(-MAX_ROWS) });
}

function getScoreFromText(txt) {
  // Ignore "High Score" labels.
  const re = /\bScore\s*[:\-]?\s*(\d{1,3})\b/i;
  const m = re.exec(txt);
  if (!m) return null;
  const idx = m.index;
  const before = txt.slice(Math.max(0, idx - 12), idx); // look ~12 chars left
  if (/High\s*$/i.test(before)) return null; // it's "High Score"
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function snapshot() {
  const txt = (document.body && (document.body.innerText || "")) || "";

  const score = getScoreFromText(txt);

  const hasTryAgain = /\b(Try again|Retry|Play again)\b/i.test(txt);
  const hasStart    = /\b(Start|Begin)\b/i.test(txt);

  // Timer, if printed on page (not always)
  const tm = txt.match(/\bTime\s*[:\-]?\s*(\d{1,3})\b/i);
  const time = tm ? parseInt(tm[1], 10) : null;

  return { txt, score, hasTryAgain, hasStart, time };
}

async function maybeSave() {
  const s = snapshot();
  if (!armed && ((typeof s.time === "number" && s.time > 0) || s.hasStart)) {
    armed = true;
    savedThisRound = false;
    LOG("armed");
  }

  const finished = s.hasTryAgain || (typeof s.time === "number" && s.time === 0);
  if (!finished) {
    sawUnfinishedSinceInjection = true;
  }

  if ((armed || sawUnfinishedSinceInjection) && finished && !savedThisRound && typeof s.score === "number") {
    const rows = await getScores();
    const last = rows[rows.length - 1];
    const ts = now();

    if (last && last.s === s.score && (ts - last.t) < DEDUPE_MS) {
      LOG("skip duplicate", s.score);
    } else {
      const row = { id: makeRowId(ts, s.score), t: ts, s: s.score };
      rows.push(row);
      await setScores(rows);
      browser.runtime.sendMessage({ type: "record-score", row }).catch((error) => {
        LOG("remote upload queue failed", error);
      });
      LOG("SAVED", s.score, "total:", rows.length);
    }

    savedThisRound = true;
    armed = false;
  }

  if (!finished && typeof s.time === "number" && s.time > 0 && !armed) {
    armed = true;
    savedThisRound = false;
    LOG("re-armed (time>0)");
  }
}

const obs = new MutationObserver(() => { maybeSave().catch(console.error); });

function start() {
  if (!document.body) { setTimeout(start, 100); return; }
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  maybeSave().catch(console.error);
  setInterval(() => { maybeSave().catch(console.error); }, 500);
  LOG("content ready on", location.href);
}
start();
}
