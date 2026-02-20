/* Hotel Voice Agent Frontend (static) */

console.log("[app.js] loaded");

/* ---------- DOM ---------- */
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("statusEl");
const statusPill = document.getElementById("statusPill");
const statusText = document.getElementById("statusText");
const liveTranscript = document.getElementById("liveTranscript");
const transcriptBox = document.getElementById("transcriptBox");

const backendUrlEl = document.getElementById("backendUrl");
const topKEl = document.getElementById("topK");
const minScoreEl = document.getElementById("minScore");

const faqPathEl = document.getElementById("faqPath");
const useMicEl = document.getElementById("useMic");
const useTtsEl = document.getElementById("useTts");

const voiceSelectEl = document.getElementById("voiceSelect");

// Debug panel (older UI)
const debugInputEl = document.getElementById("debugInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");

// Main UI (newer UI) - support multiple possible IDs without breaking anything
const askBtn =
  document.getElementById("askBtn") ||
  document.getElementById("askButton") ||
  document.getElementById("ask") ||
  document.getElementById("btnAsk");

const mainQueryInputEl =
  document.getElementById("queryInput") ||
  document.getElementById("query") ||
  document.getElementById("questionInput") ||
  document.getElementById("userInput") ||
  document.getElementById("promptInput") ||
  document.getElementById("textInput");

/* ---------- Defaults ---------- */
const DEFAULT_BACKEND = "https://hotel-voice-agent-backend-575069296077.asia-southeast1.run.app";
const DEFAULT_FAQ_PATH = "/faq/answer";
const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.35;

/* ---------- State ---------- */
let sessionActive = false;
let ended = false;

let recognition = null;

// Browser TTS state
let ttsPlaying = false;
let currentUtterance = null;

// Hard lock to prevent STT auto-start while TTS is speaking
let sttPausedForTTS = false;

// Track real STT running state + safe-restart backoff
let sttRunning = false;
let sttStartBackoffMs = 600;
let sttStartTimer = null;
let sttWatchdogTimer = null;

let lastAiText = "";
let lastUserText = "";

// Greeting protection
let greetingLock = false;           // short protection window
let greetingInProgress = false;     // strong protection until greeting speech ends

/* ---------- Helpers ---------- */
function nowStamp() {
  return new Date().toLocaleTimeString();
}

function logLine(msg) {
  const line = `[${nowStamp()}] ${msg}`;
  transcriptBox.textContent += (transcriptBox.textContent ? "\n" : "") + line;
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
  console.log(line);
}

/**
 * Voice states (Listening / Thinking / Speaking / Idle)
 */
function setVoiceState(mode, text) {
  if (statusEl) statusEl.textContent = mode;
  if (statusText) statusText.textContent = text || "";

  if (statusPill) {
    statusPill.classList.remove("pill-idle", "pill-listening", "pill-thinking", "pill-speaking");

    if (mode === "Listening") {
      statusPill.classList.add("pill-listening");
      statusPill.textContent = "listening";
    } else if (mode === "Thinking") {
      statusPill.classList.add("pill-thinking");
      statusPill.textContent = "thinking";
    } else if (mode === "Speaking") {
      statusPill.classList.add("pill-speaking");
      statusPill.textContent = "speaking";
    } else {
      statusPill.classList.add("pill-idle");
      statusPill.textContent = "idle";
    }
  }
}

function setLiveTranscript(text) {
  if (!liveTranscript) return;
  liveTranscript.textContent = text ? `You said: ${text}` : "";
}

function getBackendBase() {
  const v = (backendUrlEl?.value || "").trim();
  return v || DEFAULT_BACKEND;
}

function getFaqPath() {
  const v = (faqPathEl?.value || "").trim();
  return v || DEFAULT_FAQ_PATH;
}

function getTopK() {
  const v = parseInt((topKEl?.value || "").trim(), 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 10) : DEFAULT_TOP_K;
}

function getMinScore() {
  const v = parseFloat((minScoreEl?.value || "").trim());
  return Number.isFinite(v) ? v : DEFAULT_MIN_SCORE;
}

/* ---------- Browser TTS voices ---------- */
function loadVoices() {
  if (!voiceSelectEl) return;

  while (voiceSelectEl.options.length > 1) voiceSelectEl.remove(1);

  const voices = window.speechSynthesis?.getVoices?.() || [];
  voices.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = v.name;
    voiceSelectEl.appendChild(opt);
  });

  if (voices.length) logLine(`TTS voices loaded: ${voices.length}`);
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

/* ---------- Input quality controls ---------- */
function isFiller(text) {
  const t = (text || "").toLowerCase().trim();
  return t === "ok" || t === "okay" || t === "okay okay" || t.length <= 2;
}

function isTooIncomplete(text) {
  const t = (text || "").toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean);
  const starters = new Set(["when", "what", "can", "is", "are", "do", "does", "tell"]);
  return (words.length <= 2 && starters.has(words[0])) || t.length < 4;
}

function isTooGeneric(q) {
  const t = (q || "").toLowerCase().trim();
  return (
    t === "what types are available" ||
    t === "what types are available at the hotel" ||
    t === "what types are available in the hotel" ||
    t === "what types are available there"
  );
}

/* ---------- Corrections ---------- */
function stripCorrectionPrefix(raw) {
  return (raw || "").trim().replace(/^i\s*mean\s+/i, "");
}

/* ---------- STT normalization ---------- */
function normalizeSpokenQuery(q) {
  let t = (q || "").toLowerCase().trim();

  t = t.replace(/\bchecking time\b/g, "check in time");
  t = t.replace(/\bchecking in time\b/g, "check in time");
  t = t.replace(/\bchecking out time\b/g, "check out time");
  t = t.replace(/\bchicken time\b/g, "check in time");

  t = t.replace(/\bcheckin\b/g, "check in");
  t = t.replace(/\bcheckout\b/g, "check out");
  t = t.replace(/\bcheck-in\b/g, "check in");
  t = t.replace(/\bcheck-out\b/g, "check out");

  t = t.replace(/\bwhen is (the )?check in time\b/g, "check in time");
  t = t.replace(/\bwhen is (the )?check out time\b/g, "check out time");
  t = t.replace(/\bwhat time is (the )?check in\b/g, "check in time");
  t = t.replace(/\bwhat time is (the )?check out\b/g, "check out time");

  t = t.replace(/\bmoney changer\b/g, "currency exchange");
  t = t.replace(/\bforex\b/g, "currency exchange");

  t = t.replace(/\bmini bar\b/g, "minibar");
  t = t.replace(/\bminiva\b/g, "minibar");
  t = t.replace(/\bminiba\b/g, "minibar");
  t = t.replace(/\bbeneva\b/g, "minibar");

  return t;
}

/**
 * FIX: Robust stop intent detection (covers "okay bye", punctuation, etc.)
 */
function isStopIntent(text) {
  const t = (text || "")
    .toLowerCase()
    .replace(/[.,!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  // Direct
  if (t === "stop" || t === "bye" || t === "goodbye") return true;

  // Any "ok/okay ... bye" variant
  if (/\b(ok|okay)\b.*\bbye\b/.test(t)) return true;

  // Any "thanks/thank you ... bye/goodbye" variant
  if (/\b(thanks|thank you)\b.*\b(bye|goodbye)\b/.test(t)) return true;

  // Other endings
  if (t.includes("see you")) return true;
  if (t.includes("end conversation")) return true;
  if (t.includes("stop conversation")) return true;

  // Catch-all: contains goodbye as a word
  if (/\bgoodbye\b/.test(t)) return true;

  return false;
}

/* ---------- STT safe start / watchdog ---------- */
function canStartSTT() {
  return (
    sessionActive &&
    (useMicEl?.checked ?? true) &&
    !ttsPlaying &&
    !sttPausedForTTS &&
    !greetingInProgress
  );
}

function clearSttStartTimer() {
  if (sttStartTimer) {
    clearTimeout(sttStartTimer);
    sttStartTimer = null;
  }
}

function safeStartSTT(reason = "unknown") {
  if (!recognition) return;
  if (!canStartSTT()) return;
  if (sttRunning) return;

  try {
    recognition.start();
    logLine(`STT start requested (${reason})`);
    setVoiceState("Listening", "🎤 Listening…");
    sttStartBackoffMs = 600;
    clearSttStartTimer();
  } catch (e) {
    const msg = String(e?.message || e);
    logLine(`STT start failed (${reason}): ${msg}`);

    clearSttStartTimer();
    sttStartTimer = setTimeout(() => {
      sttStartBackoffMs = Math.min(sttStartBackoffMs * 1.6, 8000);
      safeStartSTT("retry");
    }, sttStartBackoffMs);
  }
}

function startSTTWatchdog() {
  if (sttWatchdogTimer) return;
  sttWatchdogTimer = setInterval(() => {
    if (!document.hidden && canStartSTT() && !sttRunning) {
      safeStartSTT("watchdog");
    }
  }, 2500);
}

function stopSTTWatchdog() {
  if (sttWatchdogTimer) clearInterval(sttWatchdogTimer);
  sttWatchdogTimer = null;
}

/* ---------- Half-duplex helpers ---------- */
function pauseSTTForTTS() {
  sttPausedForTTS = true;
  try { recognition && recognition.stop(); } catch { }
}

function resumeSTTAfterTTS(delayMs = 350) {
  if (!sessionActive) return;
  if (!(useMicEl?.checked ?? true)) return;

  setTimeout(() => {
    if (!sessionActive) return;
    if (ttsPlaying || sttPausedForTTS || greetingInProgress) return;
    safeStartSTT("resumeAfterTTS");
  }, delayMs);
}

/* ---------- Stop/cancel TTS (browser) ---------- */
function stopAudio(reason = "stop") {
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { }

  if (ttsPlaying) logLine(`TTS cancelled (${reason})`);
  ttsPlaying = false;
  currentUtterance = null;

  sttPausedForTTS = false;

  if (sessionActive && !greetingInProgress) {
    resumeSTTAfterTTS(250);
  }
}

/* ---------- Speak (Browser TTS) ---------- */
async function speak(text, opts = { force: false, isGreeting: false }) {
  if (!text) return;
  if (!sessionActive && !opts.force) return;

  if (!(useTtsEl?.checked ?? true)) {
    lastAiText = text;
    logLine(`AI (no-tts): ${text}`);
    setVoiceState("Idle", "🎤 Tap Start to speak");
    return;
  }

  stopAudio("new utterance");

  lastAiText = text;
  logLine(`AI: ${text}`);

  const isGreeting = !!opts?.isGreeting;
  if (isGreeting) greetingInProgress = true;

  pauseSTTForTTS();
  setVoiceState("Speaking", "🔊 Speaking…");

  try {
    const utter = new SpeechSynthesisUtterance(text);
    currentUtterance = utter;

    utter.lang = "en-US";
    utter.rate = 1.0;
    utter.pitch = 1.0;

    const selectedName = (voiceSelectEl?.value || "").trim();
    if (selectedName) {
      const voices = window.speechSynthesis?.getVoices?.() || [];
      const v = voices.find(v => v.name === selectedName);
      if (v) utter.voice = v;
    }

    utter.onend = () => {
      ttsPlaying = false;
      currentUtterance = null;
      if (isGreeting) greetingInProgress = false;

      logLine("TTS end");
      setVoiceState("Idle", "🎤 Tap Start to speak");

      sttPausedForTTS = false;
      if (!greetingInProgress) resumeSTTAfterTTS(350);
    };

    utter.onerror = () => {
      ttsPlaying = false;
      currentUtterance = null;
      if (isGreeting) greetingInProgress = false;

      logLine("TTS error (browser)");
      setVoiceState("Idle", "🎤 Tap Start to speak");

      sttPausedForTTS = false;
      if (!greetingInProgress) resumeSTTAfterTTS(450);
    };

    ttsPlaying = true;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    ttsPlaying = false;
    currentUtterance = null;
    if (isGreeting) greetingInProgress = false;

    logLine(`TTS exception: ${String(e?.message || e)}`);
    setVoiceState("Idle", "🎤 Tap Start to speak");

    sttPausedForTTS = false;
    if (!greetingInProgress) resumeSTTAfterTTS(450);
  }
}

/* ---------- VAD barge-in ---------- */
let audioCtx = null;
let analyser = null;
let micStream = null;
let vadTimer = null;

async function startVAD() {
  try {
    if (audioCtx) return;

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);

    vadTimer = setInterval(() => {
      if (!sessionActive) return;
      if (greetingLock) return;
      if (greetingInProgress) return;
      if (!ttsPlaying) return;

      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128);
        if (v > peak) peak = v;
      }

      if (peak > 14) stopAudio("barge-in (VAD)");
    }, 80);
  } catch (e) {
    logLine("VAD disabled (mic permission or device issue).");
  }
}

function stopVAD() {
  try { if (vadTimer) clearInterval(vadTimer); } catch { }
  vadTimer = null;

  try { if (micStream) micStream.getTracks().forEach(t => t.stop()); } catch { }
  micStream = null;

  try { if (audioCtx) audioCtx.close(); } catch { }
  audioCtx = null;
  analyser = null;
}

/* ---------- STT (Web Speech API) ---------- */
function initSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("SpeechRecognition not supported. Use Chrome/Edge on Windows.");
    return null;
  }

  const rec = new SR();
  rec.lang = "en-SG";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = true;

  rec.onstart = () => {
    sttRunning = true;
    logLine("STT started");
    setVoiceState("Listening", "🎤 Listening…");
  };

  rec.onaudiostart = () => logLine("STT audio start");
  rec.onsoundstart = () => logLine("STT sound start");
  rec.onspeechstart = () => logLine("STT speech start");
  rec.onspeechend = () => logLine("STT speech end");
  rec.onaudioend = () => logLine("STT audio end");

  rec.onerror = (ev) => {
    const err = ev.error || "unknown";
    logLine(`STT error: ${err}`);

    if (err === "not-allowed" || err === "service-not-allowed") {
      sttRunning = false;
      setVoiceState("Idle", "🎤 Mic blocked — click Start again / allow mic");
      return;
    }

    sttRunning = false;
  };

  rec.onend = () => {
    sttRunning = false;

    if (!sessionActive) return;
    if (!(useMicEl?.checked ?? true)) return;

    if (ttsPlaying || sttPausedForTTS || greetingInProgress) return;

    safeStartSTT("onend");
  };

  rec.onresult = async (ev) => {
    if (!sessionActive) return;

    const last = ev.results[ev.results.length - 1];
    const rawText = (last && last[0] && last[0].transcript ? last[0].transcript : "").trim();
    if (!rawText) return;

    lastUserText = rawText;
    logLine(`YOU: ${rawText}`);
    setLiveTranscript(rawText);

    if (isStopIntent(rawText)) {
      await endSession("user said stop/bye", { speakGoodbye: true });
      return;
    }

    if (isFiller(rawText)) {
      logLine("Ignoring filler utterance.");
      return;
    }

    if (isTooIncomplete(rawText)) {
      logLine("Ignoring incomplete utterance (please continue speaking).");
      return;
    }

    const corrected = stripCorrectionPrefix(rawText);
    const normalized = normalizeSpokenQuery(corrected);

    if (normalized !== corrected.toLowerCase().trim()) {
      logLine(`NORMALIZED: ${normalized}`);
    }

    await askBackend(normalized);
  };

  return rec;
}

/* ---------- Backend ---------- */
async function askBackend(query) {
  if (isTooGeneric(query)) {
    logLine("Skipping too-generic query.");
    await speak("Could you please ask a more specific question?");
    return;
  }

  const backend = getBackendBase();
  const faqPath = getFaqPath();
  const url = `${backend}${faqPath}`;

  const payload = {
    query,
    top_k: getTopK(),
    min_score: getMinScore(),
  };

  setVoiceState("Thinking", "🤔 Thinking…");

  const t0 = performance.now();
  logLine(`NET start -> ${url} (timeout=12000ms)`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${detail}`);
    }

    const data = await res.json();
    const bs = Number(data.best_score ?? 0);
    const backendLatency = data.latency_ms ?? data.backend_total_ms ?? "?";

    logLine(
      `NET ok (${ms}ms). matched=${data.matched} best_score=${Number.isFinite(bs) ? bs.toFixed(3) : data.best_score
      } backend_latency=${backendLatency}`
    );

    const answer = (data.answer || "").trim();
    if (answer) await speak(answer);
    else await speak("Sorry — I had a backend error.");
  } catch (e) {
    const msg = (e?.name === "AbortError") ? "timeout" : String(e?.message || e);
    logLine(`NET error: ${msg}`);
    await speak("Sorry — I had a network/backend error.");
    setVoiceState("Idle", "🎤 Tap Start to speak");
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- Typed ASK (main UI) ---------- */
askBtn?.addEventListener("click", async () => {
  const q = (mainQueryInputEl?.value || "").trim();
  if (!q) return;

  // Ensure session is active so goodbye TTS can play
  if (!sessionActive) {
    sessionActive = true;
    stopBtn.disabled = false;
    startBtn.disabled = true;

    if (!recognition) recognition = initSTT();
    startSTTWatchdog();
  }

  setLiveTranscript(q);
  logLine(`YOU (typed): ${q}`);

  // FIX: typed stop intent should end session, not call FAQ backend
  if (isStopIntent(q)) {
    await endSession("typed stop intent", { speakGoodbye: true });
    return;
  }

  await askBackend(q);
});

/* ---------- Debug buttons ---------- */
sendBtn?.addEventListener("click", async () => {
  const q = (debugInputEl?.value || "").trim();
  if (!q) return;

  // Allow typed test even if user didn't start session
  if (!sessionActive) {
    sessionActive = true;
    stopBtn.disabled = false;
    startBtn.disabled = true;

    if (!recognition) recognition = initSTT();
    startSTTWatchdog();
  }

  setLiveTranscript(q);
  logLine(`YOU (typed): ${q}`);

  // FIX: stop intent should end session, not call FAQ backend
  if (isStopIntent(q)) {
    await endSession("typed stop intent (debug)", { speakGoodbye: true });
    return;
  }

  await askBackend(q);
});

clearBtn?.addEventListener("click", () => {
  transcriptBox.textContent = "";
  setLiveTranscript("");
  logLine("Cleared transcript.");
});

/* ---------- Session control ---------- */
async function startSession() {
  if (sessionActive) return;

  ended = false;
  sessionActive = true;

  if (backendUrlEl && !backendUrlEl.value) backendUrlEl.value = DEFAULT_BACKEND;
  if (faqPathEl && !faqPathEl.value) faqPathEl.value = DEFAULT_FAQ_PATH;
  if (topKEl && !topKEl.value) topKEl.value = String(DEFAULT_TOP_K);
  if (minScoreEl && !minScoreEl.value) minScoreEl.value = String(DEFAULT_MIN_SCORE);

  stopBtn.disabled = false;
  startBtn.disabled = true;

  logLine("Session started.");
  setVoiceState("Idle", "🔊 Greeting…");

  greetingLock = true;
  greetingInProgress = true;

  if (!recognition) recognition = initSTT();
  startSTTWatchdog();

  await startVAD();
  await speak("Hello — how may I assist you today?", { isGreeting: true });

  setTimeout(() => { greetingLock = false; }, 900);

  if (useMicEl?.checked ?? true) {
    setTimeout(() => {
      if (!sessionActive) return;
      if (greetingInProgress) return;
      if (ttsPlaying || sttPausedForTTS) return;
      safeStartSTT("initial");
    }, 650);
  } else {
    setVoiceState("Idle", "⌨️ Type a question (debug) or enable microphone");
  }
}

async function endSession(reason = "stop", opts = { speakGoodbye: true }) {
  if (!sessionActive) return;

  try { recognition && recognition.stop(); } catch { }
  sttRunning = false;
  clearSttStartTimer();
  stopSTTWatchdog();

  stopAudio("session stop");

  ended = true;

  if (opts.speakGoodbye) {
    await speak("Thank you. Goodbye!", { force: true });
  }

  stopVAD();

  sessionActive = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;

  setVoiceState("Idle", "🎤 Tap Start to speak");
  logLine("Session stopped.");
}

startBtn?.addEventListener("click", () => startSession());
stopBtn?.addEventListener("click", () => endSession("stop button", { speakGoodbye: false }));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && canStartSTT() && !sttRunning) {
    safeStartSTT("visibilitychange");
  }
});

window.addEventListener("beforeunload", () => {
  try { recognition && recognition.stop(); } catch { }
  sttRunning = false;
  clearSttStartTimer();
  stopSTTWatchdog();
  stopAudio("unload");
  stopVAD();
});
