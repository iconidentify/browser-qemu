#!/usr/bin/env node
// Boot the lazy A/UX runtime in headless Chrome and record periodic
// screenshots plus browser-log/range-stats samples so a human (or agent)
// can watch boot progress toward the A/UX login screen.
//
// Hazards inherited from smoke-headless-browser.mjs (June 12, 2026):
// - never Runtime.enable the QEMU pthread worker sessions
// - keep this process's event loop unblocked so CDP stays drained
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
  outDir: path.join(root, "build", "boot-watch"),
  readyTimeout: 120000,
  duration: 1800,
  interval: 60,
};

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--url") options.url = args[++index] || "";
  else if (arg === "--server") options.server = String(args[++index] || "").replace(/\/+$/, "");
  else if (arg === "--out-dir") options.outDir = args[++index] || options.outDir;
  else if (arg === "--duration") options.duration = Number.parseInt(args[++index] || "", 10);
  else if (arg === "--interval") options.interval = Number.parseInt(args[++index] || "", 10);
  else if (arg === "--ready-timeout") options.readyTimeout = Number.parseInt(args[++index] || "", 10);
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!options.url) {
  options.url = `${options.server}/?build=aux-login-watch&ram=128&heap=2048&pace=0&autostart=lazy-pulse&pulseMs=30000`;
}
if (!Number.isFinite(options.duration) || options.duration < 30) {
  console.error("--duration must be at least 30 seconds");
  process.exit(2);
}
if (!Number.isFinite(options.interval) || options.interval < 5) {
  console.error("--interval must be at least 5 seconds");
  process.exit(2);
}
if (!fs.existsSync(options.chrome)) {
  console.error(`Chrome executable not found: ${options.chrome}`);
  process.exit(2);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
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
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        request.resolve(message.result || {});
      }
    }
  });

  function send(method, params = {}, timeoutMs = 20000) {
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

async function readProbeStateFromPage(cdp) {
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const probe = document.getElementById("probeState");
        if (!probe || !probe.textContent) return null;
        try { return JSON.parse(probe.textContent); } catch { return null; }
      })()`,
      returnByValue: true,
    });
    return result.result?.value ?? null;
  } catch {
    return null;
  }
}

fs.mkdirSync(options.outDir, { recursive: true });
const logStream = fs.createWriteStream(path.join(options.outDir, "browser-log.txt"), { flags: "w" });
let consumedLogLines = 0;

async function drainBrowserLog() {
  try {
    const payload = await readJson("/__browser-log.json");
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const fresh = lines.slice(consumedLogLines);
    consumedLogLines = lines.length;
    for (const line of fresh) logStream.write(`${line}\n`);
    return fresh;
  } catch {
    return [];
  }
}

await resetServerState();

const port = 9400 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-boot-watch-chrome-"));
const chrome = spawn(options.chrome, [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--window-size=1400,1200",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let cdp = null;
let shotCount = 0;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error("No debuggable page target found");
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: options.url });
  console.log(JSON.stringify({ event: "navigated", url: options.url, port }));

  const readyDeadline = Date.now() + options.readyTimeout;
  let ready = false;
  while (Date.now() < readyDeadline && !ready) {
    const fresh = await drainBrowserLog();
    for (const line of fresh) {
      if (line.includes("qemu runtime initialized")) ready = true;
      if (line.includes("window error:") || line.includes("unhandled rejection:")) {
        throw new Error(`page error before runtime ready: ${line}`);
      }
    }
    if (!ready) await delay(1000);
  }
  console.log(JSON.stringify({ event: "runtime-ready", ready }));
  if (!ready) throw new Error("runtime did not become ready in time");

  const startedAt = Date.now();
  async function sample(label) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const fresh = await drainBrowserLog();
    let shotFile = null;
    try {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      }, 30000);
      shotCount += 1;
      shotFile = path.join(options.outDir, `shot-${String(elapsed).padStart(5, "0")}s.png`);
      fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
    } catch (error) {
      console.log(JSON.stringify({ event: "screenshot-failed", elapsed, error: String(error.message || error) }));
    }
    let rangeStats = null;
    try {
      rangeStats = await readJson("/__range-stats.json");
    } catch {
      rangeStats = null;
    }
    const probeState = await readProbeStateFromPage(cdp);
    console.log(JSON.stringify({
      event: label,
      elapsed,
      shot: shotFile ? path.basename(shotFile) : null,
      newLogLines: fresh.length,
      lastLogLine: fresh.length ? fresh[fresh.length - 1] : null,
      framebuffer: probeState && probeState.framebuffer ? probeState.framebuffer : null,
      ranges: rangeStats && rangeStats.files ? rangeStats.files : rangeStats,
    }));
  }

  await sample("sample");
  while ((Date.now() - startedAt) / 1000 < options.duration) {
    await delay(options.interval * 1000);
    await sample("sample");
  }
  await sample("final");
} catch (error) {
  console.log(JSON.stringify({ event: "error", error: error && error.stack ? String(error.stack) : String(error) }));
  process.exitCode = 1;
} finally {
  logStream.end();
  if (cdp) cdp.ws.close();
  chrome.kill("SIGTERM");
  await delay(500);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log(JSON.stringify({ event: "done", screenshots: shotCount, outDir: options.outDir }));
}
