#!/usr/bin/env node
// Boot A/UX to the Classic Mac login dialog, type credentials through the real
// browser input path, then watch page responsiveness during the logged-in
// session. This targets the headed-only "Chrome gets hot after login" failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const opts = {
  chrome: process.env.CHROME || defaultChrome,
  server: "http://127.0.0.1:8088",
  url: "",
  outDir: path.join(root, "build", "login-watch"),
  readyTimeoutSec: 260,
  minLoginSec: 90,
  watchSecs: 360,
  stock: true,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--url") opts.url = argv[++i] || "";
  else if (arg === "--server") opts.server = String(argv[++i] || "").replace(/\/+$/, "");
  else if (arg === "--out-dir") opts.outDir = argv[++i] || opts.outDir;
  else if (arg === "--ready-timeout") opts.readyTimeoutSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--min-login-sec") opts.minLoginSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--watch-secs") opts.watchSecs = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--headless") opts.stock = false;
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!opts.url) {
  opts.url = `${opts.server}/?build=login-watch&ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(payload) {
  console.log(JSON.stringify(payload));
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.json();
      lastError = new Error(`${url} HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError || new Error(`timeout waiting for ${url}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
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

  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(requestId, { method, resolve, reject, timeout });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });

  return { ws, send };
}

async function evalQuick(cdp, expression, timeoutMs = 3000) {
  const started = Date.now();
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    }, timeoutMs);
    return {
      ok: true,
      ms: Date.now() - started,
      value: result.result ? result.result.value : null,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function readProbe(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const node = document.getElementById("probeState");
    if (!node || !node.textContent) return null;
    try { return JSON.parse(node.textContent); } catch { return null; }
  })()`);
  return result.value || null;
}

async function screenshot(cdp, name) {
  try {
    const result = await cdp.send("Page.captureScreenshot", { format: "png" }, 10000);
    fs.writeFileSync(path.join(opts.outDir, name), Buffer.from(result.data, "base64"));
  } catch {
    // Keep the watcher alive; screenshots are supporting evidence.
  }
}

async function canvasClientPoint(cdp, guestX, guestY) {
  const result = await evalQuick(cdp, `(() => {
    if (window.AuxQemuProbe && typeof window.AuxQemuProbe.clientPointForGuest === "function") {
      const mapped = window.AuxQemuProbe.clientPointForGuest(${Math.trunc(guestX)}, ${Math.trunc(guestY)});
      if (mapped) return { x: mapped.clientX, y: mapped.clientY, mapped };
    }
    const canvas = document.getElementById("canvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ${Math.trunc(guestX)} * rect.width / Math.max(1, canvas.width),
      y: rect.top + ${Math.trunc(guestY)} * rect.height / Math.max(1, canvas.height),
      fallback: true
    };
  })()`);
  if (!result.value) throw new Error("canvas rect unavailable");
  return {
    x: Math.round(result.value.x),
    y: Math.round(result.value.y),
  };
}

async function clickGuest(cdp, guestX, guestY) {
  const point = await canvasClientPoint(cdp, guestX, guestY);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
  }, 5000);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  }, 5000);
  await delay(80);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  }, 5000);
}

const keyInfo = new Map([
  ["\t", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["\r", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
]);

function infoForChar(char) {
  if (keyInfo.has(char)) return keyInfo.get(char);
  const lower = char.toLowerCase();
  if (/^[a-z]$/.test(lower)) {
    return {
      key: char,
      code: `Key${lower.toUpperCase()}`,
      windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0),
      text: char,
    };
  }
  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: char.charCodeAt(0),
      text: char,
    };
  }
  throw new Error(`unsupported login char ${JSON.stringify(char)}`);
}

async function sendKey(cdp, char) {
  const info = infoForChar(char);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text || "",
    unmodifiedText: info.text || "",
  }, 5000);
  await delay(35);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
  }, 5000);
  await delay(55);
}

async function typeText(cdp, text) {
  for (const char of text) {
    await sendKey(cdp, char);
  }
}

async function waitForSettledLogin(cdp) {
  const started = Date.now();
  const deadline = Date.now() + opts.readyTimeoutSec * 1000;
  const repeatedWindowMs = 45000;
  const repeatedChecksums = new Map();
  let previousChecksum = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const probe = await readProbe(cdp);
    const framebuffer = probe && probe.framebuffer ? probe.framebuffer : null;
    if (framebuffer && framebuffer.nonBlack > 1000) {
      const now = Date.now();
      if (framebuffer.checksum === previousChecksum) stableSamples += 1;
      else stableSamples = 0;
      previousChecksum = framebuffer.checksum;
      const seenAt = repeatedChecksums.get(framebuffer.checksum) || [];
      seenAt.push(now);
      const recentSeenAt = seenAt.filter((sampleAt) => now - sampleAt <= repeatedWindowMs);
      repeatedChecksums.set(framebuffer.checksum, recentSeenAt);
      for (const [checksum, samples] of repeatedChecksums) {
        const recent = samples.filter((sampleAt) => now - sampleAt <= repeatedWindowMs);
        if (recent.length) repeatedChecksums.set(checksum, recent);
        else repeatedChecksums.delete(checksum);
      }
      const repeatedSamples = Math.max(0, ...Array.from(repeatedChecksums.values(), (samples) => samples.length));
      stamp({
        event: "login-wait",
        elapsed: Math.round((now - started) / 1000),
        stableSamples,
        repeatedSamples,
        checksum: framebuffer.checksum,
        nonBlack: framebuffer.nonBlack,
        heartbeat: probe.heartbeat,
      });
      if ((stableSamples >= 4 || repeatedSamples >= 4) && now - started >= opts.minLoginSec * 1000) {
        return probe;
      }
    }
    await delay(3000);
  }
  throw new Error("login framebuffer did not settle before timeout");
}

fs.mkdirSync(opts.outDir, { recursive: true });

const port = 9600 + Math.floor(Math.random() * 800);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-login-chrome-"));
const chromeArgs = opts.stock
  ? [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1600,1200",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ]
  : [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1600,1200",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];

const chrome = spawn(opts.chrome, chromeArgs, { stdio: ["ignore", "ignore", "ignore"] });
let cdp = null;

try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: opts.url });
  stamp({ event: "navigated", stock: opts.stock, url: opts.url });

  const loginProbe = await waitForSettledLogin(cdp);
  stamp({ event: "login-settled", framebuffer: loginProbe.framebuffer, memory: loginProbe.memory });
  await screenshot(cdp, "login.png");

  await clickGuest(cdp, 360, 252);
  await typeText(cdp, "root");
  await sendKey(cdp, "\t");
  await typeText(cdp, "31337leet");
  await sendKey(cdp, "\r");
  stamp({ event: "credentials-dispatched" });

  await delay(5000);
  await screenshot(cdp, "after-login-dispatch.png");

  const start = Date.now();
  let maxEvalMs = 0;
  let evalTimeouts = 0;
  let maxLagMs = 0;
  let maxStalls = 0;
  let maxWasmMb = 0;
  let maxDiskCacheMb = 0;
  let lastProbe = null;
  while (Date.now() - start < opts.watchSecs * 1000) {
    const latency = await evalQuick(cdp, "Date.now()", 4000);
    if (latency.ok) maxEvalMs = Math.max(maxEvalMs, latency.ms);
    else evalTimeouts += 1;
    const probe = await readProbe(cdp);
    if (probe) {
      lastProbe = probe;
      const responsiveness = probe.responsiveness || {};
      const memory = probe.memory || {};
      maxLagMs = Math.max(maxLagMs, Number(responsiveness.maxLagMs) || 0);
      maxStalls = Math.max(maxStalls, Number(responsiveness.longTasks) || 0);
      maxWasmMb = Math.max(maxWasmMb, Number(memory.wasmMb) || 0);
      maxDiskCacheMb = Math.max(maxDiskCacheMb, Number(memory.diskCacheMb) || 0);
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 15 === 0 || !latency.ok || latency.ms > 800) {
      stamp({
        event: "session-watch",
        elapsed,
        evalMs: latency.ms,
        evalOk: latency.ok,
        heartbeat: lastProbe ? lastProbe.heartbeat : null,
        lag: lastProbe ? lastProbe.responsiveness : null,
        memory: lastProbe ? lastProbe.memory : null,
        framebuffer: lastProbe ? lastProbe.framebuffer : null,
      });
    }
    await delay(3000);
  }

  await screenshot(cdp, "session-end.png");
  stamp({
    event: "session-verdict",
    responsive: evalTimeouts === 0 && maxEvalMs < 1500,
    maxEvalMs,
    evalTimeouts,
    maxLagMs,
    maxStalls,
    maxWasmMb,
    maxDiskCacheMb,
  });
} catch (error) {
  stamp({ event: "fatal", message: String(error && error.stack ? error.stack : error) });
} finally {
  try { cdp?.ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
