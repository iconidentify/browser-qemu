#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
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
  readyTimeout: 90000,
  probeDuration: 5,
  probeInterval: 0,
  probe: true,
  continuousLog: false,
  via: false,
  keepOpen: false,
};

function usage() {
  console.error(`Usage:
  node scripts/smoke-headless-browser.mjs [--url url] [--server url] [--probe-duration seconds] [--probe-interval seconds] [--ready-timeout ms] [--via] [--continuous-log] [--no-probe] [--keep-open]

Examples:
  node scripts/smoke-headless-browser.mjs --probe-duration 5
  node scripts/smoke-headless-browser.mjs --probe-duration 30 --probe-interval 5
  node scripts/smoke-headless-browser.mjs --probe-duration 300 --probe-interval 30 --continuous-log
  node scripts/smoke-headless-browser.mjs --no-probe --keep-open`);
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
  } else if (arg === "--probe-duration") {
    options.probeDuration = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--probe-interval") {
    options.probeInterval = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--via") {
    options.via = true;
  } else if (arg === "--continuous-log") {
    options.continuousLog = true;
  } else if (arg === "--no-probe") {
    options.probe = false;
  } else if (arg === "--keep-open") {
    options.keepOpen = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!options.url) {
  options.url = `${options.server}/?build=headless-t2-oneshot&ram=16&heap=1280&pace=0&autostart=lazy-paused`;
}
if (!Number.isFinite(options.readyTimeout) || options.readyTimeout < 1000) {
  console.error("--ready-timeout must be at least 1000 ms");
  process.exit(2);
}
if (!Number.isFinite(options.probeDuration) || options.probeDuration < 1 || options.probeDuration > 600) {
  console.error("--probe-duration must be an integer from 1 to 600");
  process.exit(2);
}
if (!Number.isFinite(options.probeInterval) || options.probeInterval < 0 || options.probeInterval > 60) {
  console.error("--probe-interval must be an integer from 0 to 60");
  process.exit(2);
}
if (options.continuousLog && options.via) {
  console.error("--continuous-log does not support --via; VIA snapshots require HMP stop/info via");
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
  const pieces = [];
  if (error && error.message) {
    pieces.push(String(error.message));
  } else if (error) {
    pieces.push(String(error));
  }

  const cause = error && error.cause;
  if (cause) {
    const causePieces = [];
    if (cause.code) causePieces.push(cause.code);
    if (cause.errno) causePieces.push(cause.errno);
    if (cause.address) causePieces.push(cause.address);
    if (cause.port) causePieces.push(`port=${cause.port}`);
    if (cause.message) causePieces.push(cause.message);
    if (causePieces.length) pieces.push(`cause: ${causePieces.join(" ")}`);
  }

  return pieces.join(" | ") || "unknown error";
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function removeDirWithRetries(dirname) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(dirname, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 7 || !["ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) {
        throw error;
      }
      await delay(250);
    }
  }
}

async function readJson(pathname) {
  const url = `${options.server}${pathname}${pathname.includes("?") ? "&" : "?"}ts=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`);
  return response.json();
}

async function resetServerState() {
  fs.rmSync(controlPath, { force: true });
  fs.rmSync(sequencePath, { force: true });
  await readJson("/__browser-log.json?reset=1");
  await readJson("/__range-stats.json?reset=1");
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
      lastError = new Error(`${url}: ${formatError(error)}`);
    }
    await delay(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function connectCdp(wsUrl, eventLog) {
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

    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        request.resolve(message.result || {});
      }
      return;
    }

    const scope = message.sessionId ? "worker" : "page";
    if (message.method === "Target.attachedToTarget") {
      const info = message.params.targetInfo || {};
      eventLog.push(`[attached:${info.type || "?"}] ${String(info.url || "").slice(-80)}`);
      // Do not Runtime.enable worker sessions here: enabling the Runtime
      // domain on the hot QEMU pthread workers reliably starved the page's
      // control worker ~70-90s into continuous runs (June 12 2026).
    } else if (message.method === "Runtime.consoleAPICalled") {
      const args = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" ");
      eventLog.push(`[${scope}-console:${message.params.type}] ${args}`);
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails || {};
      const stack = (details.stackTrace?.callFrames || [])
        .slice(0, 4)
        .map((frame) => frame.functionName || frame.url)
        .join(" < ");
      eventLog.push(`[${scope}-exception] ${details.text || ""} ${details.exception?.description || ""} ${stack}`.trim());
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params.entry || {};
      const location = entry.url ? `${entry.url}${entry.lineNumber ? `:${entry.lineNumber}` : ""} ` : "";
      eventLog.push(`[log:${entry.level || "info"}] ${location}${entry.text || ""}`);
    }
    if (eventLog.length > 400) eventLog.splice(0, eventLog.length - 400);
  });

  function send(method, params = {}, timeoutMs = 10000, sessionId = undefined) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(requestId, { method, resolve, reject, timeout });
      const envelope = { id: requestId, method, params };
      if (sessionId) envelope.sessionId = sessionId;
      ws.send(JSON.stringify(envelope));
    });
  }

  return { ws, send };
}

async function readProbeStateFromPage(cdp) {
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const probe = document.getElementById("probeState");
        if (!probe || !probe.textContent) return null;
        try {
          return JSON.parse(probe.textContent);
        } catch (error) {
          return { error: String(error && error.message || error), raw: probe.textContent.slice(0, 1000) };
        }
      })()`,
      returnByValue: true,
    }, 10000);
    return result.result?.value ?? null;
  } catch (error) {
    return { error: error && error.message ? String(error.message) : String(error) };
  }
}

async function waitForRuntimeReady(timeoutMs) {
  const startedAt = Date.now();
  let lastLines = [];
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await readJson("/__browser-log.json");
    lastLines = Array.isArray(payload.lines) ? payload.lines : [];
    if (lastLines.some((line) => line.includes("qemu runtime initialized with guest CPU paused"))) {
      return { ready: true, lines: lastLines };
    }
    if (lastLines.some((line) => line.includes("window error:") || line.includes("unhandled rejection:"))) {
      return { ready: false, lines: lastLines };
    }
    await delay(1000);
  }
  return { ready: false, lines: lastLines };
}

await resetServerState();

const port = 9400 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-headless-chrome-"));
const chromeArgs = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
];

const chrome = spawn(options.chrome, chromeArgs, {
  detached: options.keepOpen,
  stdio: ["ignore", "ignore", "pipe"],
});
const chromeErrors = [];
chrome.stderr.on("data", (chunk) => {
  chromeErrors.push(String(chunk).trim());
  if (chromeErrors.length > 80) chromeErrors.splice(0, chromeErrors.length - 80);
});

let cdp = null;
const eventLog = [];
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error("No debuggable page target found");
  cdp = await connectCdp(page.webSocketDebuggerUrl, eventLog);
  // Runtime.enable/Log.enable are intentionally not sent: Runtime.evaluate
  // works without them, and the event streams are suspected of stalling the
  // renderer's HTTP fetches during long hot QEMU runs (June 12 2026).
  await cdp.send("Page.enable");
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  }).catch(() => {});
  await cdp.send("Page.navigate", { url: options.url }, 10000);

  const readyResult = await waitForRuntimeReady(options.readyTimeout);
  let probe = null;
  if (options.probe && readyResult.ready) {
    const probeArgs = [
      "./scripts/probe-browser-rom-progress.mjs",
      "--duration",
      String(options.probeDuration),
      "--timeout",
      "120000",
    ];
    if (options.probeInterval > 0) {
      probeArgs.push("--interval", String(options.probeInterval));
    }
    if (options.via) {
      probeArgs.push("--via");
    }
    if (options.continuousLog) {
      probeArgs.push("--continuous-log");
    }
    const sampleCount = options.probeInterval > 0
      ? Math.ceil(options.probeDuration / options.probeInterval)
      : 1;
    // Run the probe asynchronously so this process keeps draining the CDP
    // websocket; a blocked event loop lets DevTools backpressure build up
    // against the renderer during long runs.
    const output = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        probeArgs,
        {
          cwd: root,
          encoding: "utf8",
          timeout: (options.probeDuration + 45 + sampleCount * 5 + 120) * 1000,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error && !stdout) reject(error);
          else resolve(stdout);
        },
      );
    });
    probe = JSON.parse(output);
  }

  const probeState = cdp ? await readProbeStateFromPage(cdp) : null;
  const rangeStats = await readJson("/__range-stats.json");
  console.log(JSON.stringify({
    ok: readyResult.ready,
    url: options.url,
    chromePid: chrome.pid,
    chromeExitCode: chrome.exitCode,
    chromeSignalCode: chrome.signalCode,
    remoteDebuggingPort: port,
    profileDir: options.keepOpen ? profileDir : undefined,
    probe,
    probeState,
    browserLogTail: readyResult.lines.slice(-40),
    cdpTail: eventLog.slice(-40),
    rangeStats,
    chromeStderrTail: chromeErrors.slice(-20),
  }, null, 2));
} catch (error) {
  let lines = [];
  try {
    const payload = await readJson("/__browser-log.json");
    lines = Array.isArray(payload.lines) ? payload.lines : [];
  } catch {
    lines = [];
  }
  console.log(JSON.stringify({
    ok: false,
    error: error && error.stack ? String(error.stack) : formatError(error),
    url: options.url,
    chromePid: chrome.pid,
    chromeExitCode: chrome.exitCode,
    chromeSignalCode: chrome.signalCode,
    remoteDebuggingPort: port,
    profileDir: options.keepOpen ? profileDir : undefined,
    browserLogTail: lines.slice(-60),
    cdpTail: eventLog.slice(-60),
    chromeStderrTail: chromeErrors.slice(-40),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.ws.close();
  chrome.stderr.removeAllListeners("data");
  chrome.stderr.destroy();
  if (!options.keepOpen) {
    chrome.kill("SIGTERM");
    await delay(500);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await waitForProcessExit(chrome, 3000);
    await removeDirWithRetries(profileDir);
  } else {
    chrome.unref();
    console.error(`Chrome left open: pid=${chrome.pid} port=${port} profile=${profileDir}`);
  }
}

process.exit(process.exitCode || 0);
