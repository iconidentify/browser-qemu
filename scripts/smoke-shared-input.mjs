#!/usr/bin/env node
// Fast shared-input smoke for the browser-qemu A/UX runtime.
//
// Starts a temporary headless Chrome, launches qemu-lazy paused with the
// built-in input self-test, then verifies the shared-memory path without
// waiting for A/UX to boot:
//   - the bridge writes exact 800x600 geometry into QEMU shared memory
//   - a center pointer press/release is either consumed by QEMU or safely
//     deferred behind hybrid ADB cursor catch-up while the VM is paused
//   - the configured absolute/hybrid mouse-motion mode is internally consistent
//   - a KeyX press/release reaches QEMU as Mac ADB keycode 0x07
//   - a normal browser keydown/keyup is held and released without repeat spam
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const controlPath = path.join(root, "public", "control.local.json");
const sequencePath = path.join(root, "public", "control.local.seq");

const options = {
  chrome: process.env.CHROME || defaultChrome,
  server: "http://127.0.0.1:8088",
  url: "",
  readyTimeout: 30000,
};

function usage() {
  console.error(`Usage:
  node scripts/smoke-shared-input.mjs [--url url] [--server url] [--ready-timeout ms]

Default URL:
  :8088/?build=shared-input-smoke&ram=128&heap=384&pace=1&input=shared&inputMotion=hybrid&cursor=host&fps=8&res=800x600&autostart=lazy-paused&inputSelfTest=1&ptyMin=2&ptyIdle=16`);
}

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--chrome") {
    options.chrome = args[++index] || "";
  } else if (arg === "--server") {
    options.server = String(args[++index] || "").replace(/\/+$/, "");
  } else if (arg === "--url") {
    options.url = args[++index] || "";
  } else if (arg === "--ready-timeout") {
    options.readyTimeout = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!options.url) {
  options.url = `${options.server}/?build=shared-input-smoke&ram=128&heap=384&pace=1&input=shared&inputMotion=hybrid&cursor=host&fps=8&res=800x600&autostart=lazy-paused&inputSelfTest=1&ptyMin=2&ptyIdle=16`;
}
if (!Number.isFinite(options.readyTimeout) || options.readyTimeout < 1000) {
  console.error("--ready-timeout must be at least 1000 ms");
  process.exit(2);
}
if (!fs.existsSync(options.chrome)) {
  console.error(`Chrome executable not found: ${options.chrome}`);
  process.exit(2);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error && error.message ? String(error.message) : String(error || "unknown error");
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.json();
      lastError = new Error(`${url} HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function resetServerState() {
  fs.rmSync(controlPath, { force: true });
  fs.rmSync(sequencePath, { force: true });
  await fetch(`${options.server}/__browser-log.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
  await fetch(`${options.server}/__range-stats.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
}

async function closeServerSession(sessionId) {
  if (!sessionId) return;
  await fetch(`${options.server}/__session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      id: sessionId,
      href: options.url,
      title: "shared-input-smoke",
      state: "closed",
      qemuStarted: false,
      visible: false,
      pulseRunActive: false,
      pausedByGuard: false,
      heartbeat: 0,
      framesRendered: 0,
      startedAtMs: 0,
      userAgent: "smoke-shared-input",
    }),
  }).catch(() => {});
}

async function readBrowserLog() {
  const url = `${options.server}/__browser-log.json?tail=160&ts=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function waitForInputSelfTestResult(timeoutMs) {
  const startedAt = Date.now();
  let log = null;
  while (Date.now() - startedAt < timeoutMs) {
    log = await readBrowserLog().catch((error) => ({ error: formatError(error), lines: [] }));
    const lines = Array.isArray(log.lines) ? log.lines : [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = /input self-test result: (\{.*\})/.exec(lines[index]);
      if (!match) continue;
      try {
        return {
          result: JSON.parse(match[1]),
          line: lines[index],
          logTail: lines.slice(-80),
        };
      } catch (error) {
        throw new Error(`Could not parse input self-test JSON: ${formatError(error)}: ${lines[index]}`);
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for input self-test result: ${JSON.stringify(log).slice(0, 1200)}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP websocket error"));
    }, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(new Error(`${request.method}: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      request.resolve(message.result || {});
    }
  });

  function send(method, params = {}, timeoutMs = 10000) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(requestId, { method, resolve, reject, timeout });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  }

  return { ws, send };
}

async function evaluate(cdp, expression, timeoutMs = 10000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, timeoutMs);
  return result.result ? result.result.value : null;
}

function addCheck(checks, name, pass, details = {}) {
  checks.push({ name, pass: Boolean(pass), ...details });
}

await resetServerState();

const port = 9900 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-input-smoke-"));
const chrome = spawn(options.chrome, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-domain-reliability",
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--metrics-recording-only",
  "--window-size=1400,1000",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const chromeErrors = [];
chrome.stderr.on("data", (chunk) => {
  chromeErrors.push(String(chunk).trim());
  if (chromeErrors.length > 60) chromeErrors.splice(0, chromeErrors.length - 60);
});
if (typeof chrome.stderr.unref === "function") chrome.stderr.unref();

let cdp = null;
let pageSessionId = "";
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error("No debuggable page target found");

  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url: options.url }, 10000);

  const selfTest = await waitForInputSelfTestResult(options.readyTimeout);
  pageSessionId = await evaluate(cdp, `(() => {
    try {
      return window.AuxQemuProbe && typeof window.AuxQemuProbe.snapshot === "function"
        ? (window.AuxQemuProbe.snapshot().session || {}).id || ""
        : "";
    } catch {
      return "";
    }
  })()`).catch(() => "");
  const result = selfTest.result || {};
  const checks = [];
  addCheck(checks, "self-test-ok", result.ok === true, { result });
  addCheck(checks, "shared-input-version-6", result.version >= 6, { result });
  addCheck(checks, "shared-dimensions-800x600", result.absWidth === 800 && result.absHeight === 600, { result });
  addCheck(checks, "mouse-abs-center", result.absX === 400 && result.absY === 300, { result });
  addCheck(checks, "mouse-pointer-event-off-center", result.pointerEventOk === true && result.pointerEventX === 123 && result.pointerEventY === 77, { result });
  addCheck(
    checks,
    "mouse-button-edges-consumed-or-deferred",
    result.buttonEdgesOk === true &&
      (
        result.buttonEdgesConsumed === true ||
        (
          result.motionMode === "hybrid" &&
          result.buttonEdgesDeferred === true &&
          result.targetPending === true &&
          result.localButtonQueueDepth >= 2
        )
      ),
    { result },
  );
  addCheck(
    checks,
    "mouse-motion-mode-consistent",
    result.motionMode === "absolute" ||
      (result.motionMode === "hybrid" && (result.lastMouseDx !== 0 || result.lastMouseDy !== 0)),
    { result },
  );
  addCheck(checks, "mouse-released", result.frontendButtons === 0 && result.lastButtons === 0, { result });
  addCheck(checks, "keyboard-backend-saw-keyx", result.backendKeys >= 2 && result.lastAdb === 0x07, { result });
  addCheck(checks, "keyboard-held-key-down-up", result.heldKeyDown === true && result.heldKeyUp === true, { result });
  addCheck(
    checks,
    "keyboard-held-repeat-suppressed",
    result.repeatSuppressionOk === true &&
      result.repeatKeyDownSuppressed === true &&
      result.tapNonModifierKeys === false &&
      result.keyTapRepeatSuppressions >= 1,
    { result },
  );
  addCheck(checks, "keyboard-missing-keyup-auto-release", result.autoReleaseOk === true && result.autoKeyReleases >= 1 && result.pressedKeys === 0, { result });

  const ok = checks.every((check) => check.pass);
  console.log(JSON.stringify({
    ok,
    url: options.url,
    selfTest: result,
    selfTestLine: selfTest.line,
    checks,
    logTail: selfTest.logTail,
    chromeStderrTail: chromeErrors.slice(-20),
  }, null, 2));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error && error.stack ? String(error.stack) : formatError(error),
    url: options.url,
    chromeStderrTail: chromeErrors.slice(-40),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await closeServerSession(pageSessionId);
  try { cdp?.ws.close(); } catch {}
  try { chrome.stderr.destroy(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
