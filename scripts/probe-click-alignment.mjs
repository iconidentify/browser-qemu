#!/usr/bin/env node
// Probe browser/client -> guest -> Classic Mac low-memory mouse alignment.
//
// This is deliberately focused on the A/UX login screen because that is where
// manual testing has seen cursor/click drift after the A/UX kernel takes over.
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
  outDir: path.join(root, "build", "click-alignment"),
  readyTimeoutSec: 260,
  minLoginSec: 90,
  stock: true,
};

function usage() {
  console.error(`Usage:
  node scripts/probe-click-alignment.mjs [--headless] [--url url]
    [--ready-timeout sec] [--min-login-sec sec] [--out-dir dir]

Default URL:
  :8088/?build=click-align&ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16&probeMs=500&healthMs=1000`);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--chrome") opts.chrome = argv[++i] || "";
  else if (arg === "--server") opts.server = String(argv[++i] || "").replace(/\/+$/, "");
  else if (arg === "--url") opts.url = argv[++i] || "";
  else if (arg === "--out-dir") opts.outDir = argv[++i] || opts.outDir;
  else if (arg === "--ready-timeout") opts.readyTimeoutSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--min-login-sec") opts.minLoginSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--headless") opts.stock = false;
  else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!opts.url) {
  opts.url = `${opts.server}/?build=click-align&ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16&probeMs=500&healthMs=1000`;
}

if (!fs.existsSync(opts.chrome)) {
  console.error(`Chrome executable not found: ${opts.chrome}`);
  process.exit(2);
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

async function resetServerState() {
  await fetch(`${opts.server}/__browser-log.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
  await fetch(`${opts.server}/__range-stats.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
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

async function evalQuick(cdp, expression, timeoutMs = 5000) {
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
    if (window.AuxQemuProbe && typeof window.AuxQemuProbe.snapshot === "function") {
      return window.AuxQemuProbe.snapshot();
    }
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
    // Screenshots are supporting evidence; keep probing if capture fails.
  }
}

async function clientPointForGuest(cdp, guestX, guestY) {
  const result = await evalQuick(cdp, `(() => {
    if (!window.AuxQemuProbe || typeof window.AuxQemuProbe.clientPointForGuest !== "function") return null;
    const mapped = window.AuxQemuProbe.clientPointForGuest(${Math.trunc(guestX)}, ${Math.trunc(guestY)});
    if (!mapped) return null;
    const reverse = window.AuxQemuProbe.guestPointForClient(mapped.clientX, mapped.clientY);
    return { ...mapped, reverse };
  })()`);
  if (!result.value) throw new Error("clientPointForGuest unavailable");
  return result.value;
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
      repeatedChecksums.set(
        framebuffer.checksum,
        seenAt.filter((sampleAt) => now - sampleAt <= repeatedWindowMs),
      );
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
        renderer: probe.renderer ? `${probe.renderer.width}x${probe.renderer.height}` : null,
        canvas: probe.canvas ? `${probe.canvas.width}x${probe.canvas.height}` : null,
      });
      if ((stableSamples >= 4 || repeatedSamples >= 4) && now - started >= opts.minLoginSec * 1000) {
        return probe;
      }
    }
    await delay(3000);
  }
  throw new Error("login framebuffer did not settle before timeout");
}

function summarizeProbe(probe) {
  const shared = probe && probe.sharedInput ? probe.sharedInput : {};
  const pointer = shared.pointer || {};
  return {
    heartbeat: probe ? probe.heartbeat : null,
    activeElement: probe ? probe.activeElement : "",
    canvas: probe ? probe.canvas : null,
    renderer: probe ? probe.renderer : null,
    responsiveness: probe ? probe.responsiveness : null,
    abs: {
      x: shared.absX,
      y: shared.absY,
      w: shared.absWidth,
      h: shared.absHeight,
    },
    macMouse: { x: shared.macMouseX, y: shared.macMouseY },
    macMTemp: { x: shared.macMTempX, y: shared.macMTempY },
    macRaw: { x: shared.macRawX, y: shared.macRawY },
    macDelta: { x: shared.macMouseDeltaX, y: shared.macMouseDeltaY },
    lastSync: { x: shared.lastSyncX, y: shared.lastSyncY },
    lastAbsEvent: {
      x: shared.lastAbsEventX,
      y: shared.lastAbsEventY,
      w: shared.lastAbsEventW,
      h: shared.lastAbsEventH,
    },
    pointer: {
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      guestX: pointer.guestX,
      guestY: pointer.guestY,
      contentLeft: pointer.contentLeft,
      contentTop: pointer.contentTop,
      contentWidth: pointer.contentWidth,
      contentHeight: pointer.contentHeight,
      scaleX: pointer.scaleX,
      scaleY: pointer.scaleY,
    },
    buttons: {
      frontend: shared.frontendButtons,
      last: shared.lastButtons,
      adb: shared.lastAdbButtons,
      backendButtons: shared.backendButtons,
      backendMouse: shared.backendMouse,
    },
    cursor: {
      valid: shared.cursorValid,
      seq: shared.cursorSeq,
      hotspotX: shared.cursorHotspotX,
      hotspotY: shared.cursorHotspotY,
    },
  };
}

function deltaFromTarget(summary, point) {
  const abs = summary.abs || {};
  const mac = summary.macMouse || {};
  const pointer = summary.pointer || {};
  return {
    absDx: Number(abs.x) - point.x,
    absDy: Number(abs.y) - point.y,
    macDx: Number(mac.x) - point.x,
    macDy: Number(mac.y) - point.y,
    pointerDx: Number(pointer.guestX) - point.x,
    pointerDy: Number(pointer.guestY) - point.y,
  };
}

async function dispatchClickProbe(cdp, point) {
  const mapped = await clientPointForGuest(cdp, point.x, point.y);
  const x = Math.round(mapped.clientX);
  const y = Math.round(mapped.clientY);

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  }, 5000);
  await delay(160);
  const afterMove = summarizeProbe(await readProbe(cdp));

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, 5000);
  await delay(120);
  const afterDown = summarizeProbe(await readProbe(cdp));

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, 5000);
  await delay(260);
  const afterUp = summarizeProbe(await readProbe(cdp));

  return {
    name: point.name,
    target: point,
    mapped,
    roundedClient: { x, y },
    afterMove,
    afterDown,
    afterUp,
    deltas: {
      move: deltaFromTarget(afterMove, point),
      down: deltaFromTarget(afterDown, point),
      up: deltaFromTarget(afterUp, point),
    },
  };
}

const probePoints = [
  { name: "registered-radio", x: 286, y: 244 },
  { name: "name-field-left", x: 344, y: 252 },
  { name: "name-field-mid", x: 430, y: 252 },
  { name: "password-field", x: 420, y: 280 },
  { name: "dialog-icon", x: 228, y: 164 },
  { name: "desktop-center", x: 320, y: 240 },
];

fs.mkdirSync(opts.outDir, { recursive: true });
await resetServerState();

const port = 9700 + Math.floor(Math.random() * 800);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-click-align-"));
const chromeArgs = opts.stock
  ? [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1500,1100",
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
      "--window-size=1500,1100",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];

const chrome = spawn(opts.chrome, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
const chromeErrors = [];
chrome.stderr.on("data", (chunk) => {
  chromeErrors.push(String(chunk).trim());
  if (chromeErrors.length > 80) chromeErrors.splice(0, chromeErrors.length - 80);
});
if (typeof chrome.stderr.unref === "function") chrome.stderr.unref();

let cdp = null;
let report = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error("No debuggable page target found");
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url: opts.url }, 10000);
  stamp({ event: "navigated", stock: opts.stock, url: opts.url });

  const loginProbe = await waitForSettledLogin(cdp);
  await screenshot(cdp, "login-before-probes.png");
  stamp({ event: "login-settled", framebuffer: loginProbe.framebuffer, canvas: loginProbe.canvas, renderer: loginProbe.renderer });

  const results = [];
  for (const point of probePoints) {
    const result = await dispatchClickProbe(cdp, point);
    results.push(result);
    stamp({
      event: "click-probe",
      name: point.name,
      target: { x: point.x, y: point.y },
      mapped: result.roundedClient,
      deltas: result.deltas.up,
      buttons: result.afterUp.buttons,
      cursor: result.afterUp.cursor,
    });
  }
  await screenshot(cdp, "login-after-probes.png");

  const failures = results.flatMap((result) => {
    const up = result.deltas.up;
    const issues = [];
    if (Math.abs(up.absDx) > 1 || Math.abs(up.absDy) > 1) issues.push("abs");
    if (Math.abs(up.macDx) > 1 || Math.abs(up.macDy) > 1) issues.push("mac");
    if (Math.abs(up.pointerDx) > 1 || Math.abs(up.pointerDy) > 1) issues.push("pointer");
    if (result.afterDown.buttons.frontend !== 1 || result.afterUp.buttons.frontend !== 0) issues.push("button");
    return issues.length ? [{ name: result.name, issues, deltas: up }] : [];
  });

  report = {
    ok: failures.length === 0,
    url: opts.url,
    stock: opts.stock,
    login: {
      framebuffer: loginProbe.framebuffer,
      canvas: loginProbe.canvas,
      renderer: loginProbe.renderer,
      memory: loginProbe.memory,
      responsiveness: loginProbe.responsiveness,
    },
    results,
    failures,
    chromeStderrTail: chromeErrors.slice(-20),
  };

  const reportPath = path.join(opts.outDir, "click-alignment-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  stamp({ event: "report", ok: report.ok, path: reportPath, failures });
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report = {
    ok: false,
    error: error && error.stack ? String(error.stack) : String(error),
    url: opts.url,
    stock: opts.stock,
    chromeStderrTail: chromeErrors.slice(-40),
  };
  fs.writeFileSync(path.join(opts.outDir, "click-alignment-report.json"), JSON.stringify(report, null, 2));
  stamp({ event: "fatal", error: report.error });
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch {}
  try { chrome.stderr.destroy(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
