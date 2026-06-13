#!/usr/bin/env node
// Diagnostic: reproduce the continuous-run wedge, then capture call stacks of
// every QEMU pthread worker via CDP Debugger.pause. Prints JSON with one stack
// per worker session so the blocked main-loop thread can be identified.
//
// Usage:
//   node scripts/diag-worker-stacks.mjs [--run-seconds 150] [--url <page url>]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const options = {
  runSeconds: 150,
  url: "http://127.0.0.1:8088/?build=diag-worker-stacks&ram=16&heap=1280&pace=0&autostart=lazy-paused",
  chrome: process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  controlPath: new URL("../public/control.local.json", import.meta.url).pathname,
};

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--run-seconds") options.runSeconds = Number.parseInt(args[++index] || "150", 10);
  else if (arg === "--url") options.url = String(args[++index] || options.url);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function queueHmp(command, returnToGuest = false) {
  let commands = [];
  try {
    const previous = JSON.parse(fs.readFileSync(options.controlPath, "utf8"));
    if (Array.isArray(previous.commands)) commands = previous.commands;
  } catch {
    commands = [];
  }
  const payload = {
    id: Date.now() + commands.length,
    issuedAt: new Date().toISOString(),
    type: "hmp",
    command,
    returnToGuest,
  };
  commands.push(payload);
  fs.writeFileSync(options.controlPath, `${JSON.stringify({ ...payload, commands }, null, 2)}\n`);
}

async function waitForJson(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.json();
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const port = 9400 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-diag-chrome-"));
const chrome = spawn(options.chrome, [
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
], { stdio: ["ignore", "ignore", "ignore"] });

const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const sessions = new Map(); // sessionId -> { url, type }
const pausedStacks = new Map(); // sessionId -> frames
let pausedResolvers = new Map();

const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
const page = targets.find((target) => target.type === "page") || targets[0];
const ws = new (globalThis.WebSocket)(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
});

let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result || {});
    return;
  }

  if (message.method === "Target.attachedToTarget") {
    const info = message.params.targetInfo || {};
    if (message.params.sessionId && info.type === "worker") {
      sessions.set(message.params.sessionId, { url: info.url, type: info.type });
    }
    return;
  }

  if (message.method === "Debugger.paused" && message.sessionId) {
    const frames = (message.params.callFrames || []).map((frame) => ({
      fn: frame.functionName || "?",
      url: String(frame.url || "").slice(-48),
      line: frame.location ? frame.location.lineNumber : -1,
    }));
    pausedStacks.set(message.sessionId, frames);
    const resolver = pausedResolvers.get(message.sessionId);
    if (resolver) resolver();
  }
});

function send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    ws.send(JSON.stringify(envelope));
  });
}

await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Page.enable");
await send("Page.navigate", { url: options.url });

// Wait for QEMU to initialize paused (workers spawn during init).
const contDelayMs = process.argv.includes("--early-commands") ? 6000 : 20000;
await delay(contDelayMs);
console.error(`workers attached: ${sessions.size}`);

if (process.argv.includes("--early-commands")) {
  queueHmp("info status", false);
  queueHmp("info block", false);
}
queueHmp("cont", true);
console.error(`cont queued; letting the guest run ${options.runSeconds}s to reach the wedge window`);
await delay(options.runSeconds * 1000);

async function captureStacks(label) {
  const results = [];
  for (const [sessionId, info] of sessions) {
    if (!info.url.includes("qemu-system-m68k.worker.js")) continue;
    let frames = null;
    try {
      await send("Debugger.enable", {}, sessionId);
      const paused = new Promise((resolve) => pausedResolvers.set(sessionId, resolve));
      await send("Debugger.pause", {}, sessionId);
      await Promise.race([paused, delay(8000)]);
      frames = pausedStacks.get(sessionId) || null;
      pausedStacks.delete(sessionId);
      await send("Debugger.resume", {}, sessionId).catch(() => {});
      await send("Debugger.disable", {}, sessionId).catch(() => {});
    } catch (error) {
      frames = [{ fn: `error: ${error.message}`, url: "", line: -1 }];
    }
    results.push({ label, sessionId: sessionId.slice(0, 8), url: info.url.slice(-40), frames });
  }
  return results;
}

const beforeStop = await captureStacks("before-stop");

queueHmp("stop", false);
queueHmp("info status", false);
console.error("stop queued; waiting 45s for the monitor to react");
await delay(45000);

const afterStop = await captureStacks("after-stop");

let serialTail = null;
try {
  const evalResult = await send("Runtime.evaluate", {
    expression: `(() => { const probe = document.getElementById("probeState"); try { const o = JSON.parse(probe.textContent); return { qemuStatus: o.qemuStatus, ptyQueuedBytes: o.ptyQueuedBytes, serialTail: String(o.serialTail || "").slice(-600) }; } catch (e) { return { error: String(e) }; } })()`,
    returnByValue: true,
  }, undefined, 10000);
  serialTail = evalResult.result?.value ?? null;
} catch (error) {
  serialTail = { error: error.message };
}

console.log(JSON.stringify({ runSeconds: options.runSeconds, beforeStop, afterStop, page: serialTail }, null, 2));
cleanup();
process.exit(0);
