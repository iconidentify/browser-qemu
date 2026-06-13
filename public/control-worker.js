const textEncoder = new TextEncoder();

let controlUrl = "";
let header = null;
let ring = null;
let ringSize = 0;
let pollMs = 750;
let lastControlId = 0;
let ignoreBeforeMs = 0;
let wasmHeap = null;
let waitAtomicIndex = 0;
let pollTimer = 0;
let pulseTimer = 0;
let pulseMode = "sample";
let keySequenceTimer = 0;
let keySequenceDelayMs = 45;
const pendingKeySequence = [];

function postLog(line) {
  self.postMessage({ type: "log", line });
}

function queuedBytes() {
  const read = Atomics.load(header, 0);
  const write = Atomics.load(header, 1);
  return write >= read ? write - read : ringSize - read + write;
}

function freeBytes() {
  return ringSize - queuedBytes() - 1;
}

function wakePty() {
  if (!wasmHeap || !waitAtomicIndex) return;
  Atomics.store(wasmHeap, waitAtomicIndex, 0);
  Atomics.notify(wasmHeap, waitAtomicIndex);
}

function writeBytes(bytes) {
  if (!header || !ring || !bytes.length) return;
  let dropped = 0;
  let write = Atomics.load(header, 1);
  let room = freeBytes();

  for (const byte of bytes) {
    if (room <= 0) {
      dropped += 1;
      continue;
    }
    ring[write] = byte;
    write = (write + 1) % ringSize;
    room -= 1;
  }

  if (dropped) {
    Atomics.add(header, 2, dropped);
    postLog(`control worker dropped ${dropped} PTY byte${dropped === 1 ? "" : "s"}`);
  }

  Atomics.store(header, 1, write);
  Atomics.add(header, 3, 1);
  wakePty();
}

function hmpShouldAppendCont(command, returnToGuest) {
  return returnToGuest && command.trim().toLowerCase() !== "cont";
}

function encodeHmp(command, returnToGuest = false) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  return `${trimmed}\r${hmpShouldAppendCont(trimmed, returnToGuest) ? "cont\r" : ""}`;
}

function queueHmp(command, returnToGuest = false, source = "control worker") {
  const appendCont = hmpShouldAppendCont(command, returnToGuest);
  writeBytes(textEncoder.encode(encodeHmp(command, returnToGuest)));
  if (!/^(mouse_move|mouse_button)\b/.test(command)) {
    postLog(`${source} queued hmp: ${command}${appendCont ? " + cont" : ""}`);
  }
}

function queueKey(key, source = "control worker", logKey = true) {
  writeBytes(textEncoder.encode(encodeHmp(`sendkey ${key}`, true)));
  if (logKey) postLog(`${source} queued key: ${key} + cont`);
}

function hmpKeyForChar(char) {
  if (/^[a-z]$/.test(char)) return char;
  if (/^[A-Z]$/.test(char)) return `shift-${char.toLowerCase()}`;
  if (/^[0-9]$/.test(char)) return char;

  const named = {
    "\n": "ret",
    "\r": "ret",
    "\t": "tab",
    " ": "spc",
    "-": "minus",
    "=": "equal",
    "[": "bracket_left",
    "]": "bracket_right",
    "\\": "backslash",
    ";": "semicolon",
    "'": "apostrophe",
    "`": "grave_accent",
    ",": "comma",
    ".": "dot",
    "/": "slash",
    "!": "shift-1",
    "@": "shift-2",
    "#": "shift-3",
    "$": "shift-4",
    "%": "shift-5",
    "^": "shift-6",
    "&": "shift-7",
    "*": "shift-8",
    "(": "shift-9",
    ")": "shift-0",
    "_": "shift-minus",
    "+": "shift-equal",
    "{": "shift-bracket_left",
    "}": "shift-bracket_right",
    "|": "shift-backslash",
    ":": "shift-semicolon",
    "\"": "shift-apostrophe",
    "~": "shift-grave_accent",
    "<": "shift-comma",
    ">": "shift-dot",
    "?": "shift-slash",
  };

  return named[char] || "";
}

function hmpKeysForText(text) {
  const keys = [];
  for (const char of String(text || "")) {
    const key = hmpKeyForChar(char);
    if (key) keys.push(key);
    else postLog(`control worker skipped unsupported guest text char U+${char.codePointAt(0).toString(16)}`);
  }
  return keys;
}

function pumpKeySequence() {
  if (!pendingKeySequence.length) {
    keySequenceTimer = 0;
    return;
  }

  const item = pendingKeySequence.shift();
  queueKey(item.key, item.source, false);
  keySequenceTimer = setTimeout(pumpKeySequence, keySequenceDelayMs);
}

function queueKeySequence(keys, source = "control worker", delayMs = 45) {
  const normalized = (Array.isArray(keys) ? keys : [])
    .map((key) => String(key || "").trim())
    .filter(Boolean);
  if (!normalized.length) return;

  keySequenceDelayMs = Math.max(15, Math.min(500, Number(delayMs) || 45));
  for (const key of normalized) pendingKeySequence.push({ key, source });
  postLog(`${source} queued ${normalized.length} guest key${normalized.length === 1 ? "" : "s"} (${keySequenceDelayMs}ms spacing)`);
  if (!keySequenceTimer) pumpKeySequence();
}

function queueText(text, source = "control worker", delayMs = 45) {
  queueKeySequence(hmpKeysForText(text), source, delayMs);
}

function queueRunFor(durationMs) {
  const boundedMs = Math.max(250, Math.min(120000, Number(durationMs) || 2000));
  queueHmp("cont", true, "control worker timed run");
  postLog(`control worker scheduled stop in ${(boundedMs / 1000).toFixed(1)}s`);
  setTimeout(() => {
    queueHmp("stop", false, "control worker timed run");
    queueHmp("info status", false, "control worker timed run");
    queueHmp("info registers", false, "control worker timed run");
  }, boundedMs);
}

function queuePulseSample(source = "control worker pulse") {
  queueHmp("stop", false, source);
  queueHmp("info status", false, source);
  queueHmp("info registers", false, source);
  queueHmp("info block", false, source);
  queueHmp("cont", true, source);
}

function queueYieldPulse() {
  writeBytes(textEncoder.encode(`${encodeHmp("stop", false)}${encodeHmp("cont", true)}`));
}

function queuePulseTick() {
  if (pulseMode === "yield") queueYieldPulse();
  else queuePulseSample();
}

function stopPulseRun(source = "control worker pulse") {
  if (!pulseTimer) return false;
  clearInterval(pulseTimer);
  pulseTimer = 0;
  postLog(`${source} stopped`);
  return true;
}

function startPulseRun(intervalMs, mode = "sample") {
  pulseMode = mode === "yield" ? "yield" : "sample";
  const minMs = pulseMode === "yield" ? 1000 : 5000;
  const fallbackMs = pulseMode === "yield" ? 2000 : 30000;
  const boundedMs = Math.max(minMs, Math.min(60000, Number(intervalMs) || fallbackMs));
  stopPulseRun();
  queueHmp("cont", true, "control worker pulse");
  pulseTimer = setInterval(queuePulseTick, boundedMs);
  postLog(`control worker ${pulseMode} pulse every ${(boundedMs / 1000).toFixed(1)}s`);
}

function queueCommand(item) {
  const issuedAtMs = Date.parse(item.issuedAt || "");
  if (Number.isFinite(issuedAtMs) && issuedAtMs < ignoreBeforeMs) {
    return;
  }

  if (item.type === "hmp" && item.command) {
    queueHmp(item.command, item.returnToGuest !== false);
    return;
  }

  if (item.type === "key" && item.key) {
    queueKey(item.key);
    return;
  }

  if (item.type === "keys" && Array.isArray(item.keys)) {
    queueKeySequence(item.keys, "control file", item.delayMs);
    return;
  }

  if (item.type === "text" && typeof item.text === "string") {
    queueText(item.text, "control file", item.delayMs);
    return;
  }

  if (item.type === "pulse") {
    if (item.action === "start") {
      startPulseRun(item.intervalMs, item.mode);
    } else if (item.action === "stop") {
      if (!stopPulseRun("control file pulse")) {
        postLog("control file pulse already stopped");
      }
    }
  }
}

let pollInFlight = false;
let pollCount = 0;
let pollOkCount = 0;
let pollLastError = "";

async function pollControlFile() {
  if (!controlUrl) return;
  if (pollInFlight) return;
  pollInFlight = true;

  pollCount += 1;
  if (pollCount % 8 === 0) {
    self.postMessage({
      type: "poll-heartbeat",
      count: pollCount,
      okCount: pollOkCount,
      lastError: pollLastError,
      at: Date.now(),
    });
  }

  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 5000);

  try {
    const response = await fetch(`${controlUrl}?ts=${Date.now()}`, {
      cache: "no-store",
      signal: abort.signal,
    });
    pollOkCount += 1;
    if (!response.ok) return;

    const payload = await response.json();
    const commands = Array.isArray(payload.commands)
      ? payload.commands
      : Array.isArray(payload)
        ? payload
        : [payload];

    const pending = commands
      .filter((item) => item && typeof item.id === "number" && item.id > lastControlId)
      .sort((a, b) => a.id - b.id);

    for (const item of pending) {
      lastControlId = item.id;
      queueCommand(item);
    }
  } catch (error) {
    // Missing control.local.json is the normal idle state; aborted slow
    // fetches are retried on the next poll tick.
    pollLastError = String((error && error.message) || error).slice(0, 120);
  } finally {
    clearTimeout(abortTimer);
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollControlFile, pollMs);
  pollControlFile();
}

self.onmessage = (event) => {
  const message = event.data || {};

  if (message.type === "init") {
    controlUrl = message.controlUrl;
    header = new Int32Array(message.headerBuffer);
    ring = new Uint8Array(message.ringBuffer);
    ringSize = ring.length;
    pollMs = message.pollMs || pollMs;
    ignoreBeforeMs = message.ignoreBeforeMs || Date.now();
    startPolling();
    postLog("control worker ready; ignoring pre-start commands");
    return;
  }

  if (message.type === "wait-index") {
    waitAtomicIndex = message.atomicIndex || 0;
    wasmHeap = message.wasmBuffer ? new Int32Array(message.wasmBuffer) : null;
    if (queuedBytes() > 0) wakePty();
    return;
  }

  if (message.type === "queue-hmp" && message.command) {
    queueHmp(message.command, message.returnToGuest !== false, "page");
    return;
  }

  if (message.type === "queue-key" && message.key) {
    queueKey(message.key, "page");
    return;
  }

  if (message.type === "queue-keys" && Array.isArray(message.keys)) {
    queueKeySequence(message.keys, "page", message.delayMs);
    return;
  }

  if (message.type === "queue-text" && typeof message.text === "string") {
    queueText(message.text, "page", message.delayMs);
    return;
  }

  if (message.type === "run-for") {
    queueRunFor(message.durationMs);
    return;
  }

  if (message.type === "start-pulse") {
    startPulseRun(message.intervalMs, message.mode);
    return;
  }

  if (message.type === "stop-pulse") {
    stopPulseRun("page pulse");
  }
};
