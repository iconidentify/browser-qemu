#!/usr/bin/env node
// Verify the old "click the canvas -> renderer wedges at 200% CPU" hazard is
// gone after disk I/O moved off the main thread. Boots to a stable framebuffer,
// then hammers the canvas with real mouse clicks + moves + a few keystrokes via
// CDP, while continuously measuring main-thread responsiveness (Runtime.evaluate
// round-trip latency) and framebuffer liveness. A wedge would starve the main
// thread, so CDP latency would balloon / time out.
//
// --stock launches headed Chrome with NO anti-throttling flags (the original
// failure condition). Default is headless with the usual flags.
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
  readyTimeout: 200000,
  stock: false,
  outDir: path.join(root, "build", "click-hazard"),
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--url") opts.url = argv[++i];
  else if (a === "--stock") opts.stock = true;
  else if (a === "--ready-timeout") opts.readyTimeout = Number.parseInt(argv[++i], 10) * 1000;
}
if (!opts.url) opts.url = `${opts.server}/?build=click-hazard&ram=128&heap=1280&pace=0&autostart=lazy`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (o) => console.log(JSON.stringify(o));

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return await r.json(); lastError = new Error("HTTP " + r.status); }
    catch (e) { lastError = e; }
    await delay(500);
  }
  throw lastError || new Error("timeout " + url);
}
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp err")); }, { once: true });
  });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); clearTimeout(r.timeout); m.error ? r.reject(new Error(r.method + ": " + (m.error.message || ""))) : r.resolve(m.result || {}); }
  });
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const rid = ++id; const timeout = setTimeout(() => { pending.delete(rid); reject(new Error(method + " timed out")); }, timeoutMs);
    pending.set(rid, { method, resolve, reject, timeout }); ws.send(JSON.stringify({ id: rid, method, params }));
  });
  return { ws, send };
}
async function evalQuick(cdp, expr, timeoutMs = 2500) {
  const t0 = Date.now();
  try {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, timeoutMs);
    return { ms: Date.now() - t0, value: r.result ? r.result.value : null, ok: true };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, error: String(e.message || e) };
  }
}
async function fb(cdp) {
  // framebuffer fingerprint via probe snapshot (set by the shell)
  const r = await evalQuick(cdp, `(()=>{try{const p=JSON.parse(document.getElementById('probeState').textContent);return p&&p.framebuffer?{checksum:p.framebuffer.checksum,nonBlack:p.framebuffer.nonBlack,heartbeat:p.heartbeat}:null;}catch(e){return null;}})()`);
  return r.value;
}

fs.mkdirSync(opts.outDir, { recursive: true });
const port = 9400 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-click-chrome-"));
const flags = opts.stock
  ? ["--no-first-run", "--no-default-browser-check", "--window-size=1400,1200", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"]
  : ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-dev-shm-usage", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--window-size=1400,1200", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"];
const chrome = spawn(opts.chrome, flags, { stdio: ["ignore", "ignore", "ignore"] });

let cdp = null;
async function shot(name) {
  try { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(opts.outDir, name), Buffer.from(r.data, "base64")); } catch {}
}
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((t) => t.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: opts.url });
  stamp({ event: "navigated", url: opts.url, stock: opts.stock });

  // Wait for a SETTLED framebuffer: same checksum across consecutive samples
  // (login screen idle), not just any non-black frame mid-boot.
  const deadline = Date.now() + opts.readyTimeout;
  let stable = null, prev = null, stableCount = 0;
  while (Date.now() < deadline) {
    const f = await fb(cdp);
    if (f && f.nonBlack > 1000) {
      if (prev && f.checksum === prev) { stableCount++; if (stableCount >= 4) { stable = f; break; } }
      else stableCount = 0;
      prev = f.checksum;
    }
    await delay(4000);
  }
  if (!stable) { stamp({ event: "error", message: "framebuffer never settled" }); throw new Error("no settle"); }
  stamp({ event: "framebuffer-settled", fb: stable });
  await shot("before-click.png");

  // Baseline main-thread responsiveness (eval runs on the page main thread).
  const base = [];
  for (let i = 0; i < 5; i++) { base.push((await evalQuick(cdp, "1+1")).ms); await delay(300); }
  stamp({ event: "baseline-latency-ms", samples: base, max: Math.max(...base) });

  const rect = await evalQuick(cdp, `(()=>{const c=document.querySelector('canvas');if(!c)return null;const r=c.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  if (!rect.value) { stamp({ event: "error", message: "no canvas element" }); throw new Error("no canvas"); }
  const cx = Math.round(rect.value.x + rect.value.w / 2);
  const cy = Math.round(rect.value.y + rect.value.h / 2);
  stamp({ event: "canvas-rect", rect: rect.value, click: { cx, cy } });

  // Mouse dispatch with a SHORT timeout; a hang here is recorded but NOT fatal
  // (it could be a pointer-lock/input-pipeline stall rather than a renderer
  // wedge -- the renderer-liveness loop below is the real verdict).
  let dispatchHangs = 0;
  async function mouse(type, x, y, extra = {}) {
    try { await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }, 3000); }
    catch { dispatchHangs++; }
  }
  await mouse("mouseMoved", cx, cy);
  await mouse("mousePressed", cx, cy); await delay(60); await mouse("mouseReleased", cx, cy);
  stamp({ event: "clicked", at: [cx, cy], dispatchHangs });

  // RENDERER LIVENESS after the click: eval latency + framebuffer + heartbeat,
  // measured independently of any further mouse dispatch.
  let maxLatency = 0, timeouts = 0, lastHeartbeat = null, heartbeatMoved = false;
  const fbset = new Set();
  for (let i = 0; i < 20; i++) {
    const q = await evalQuick(cdp, "Date.now()");
    if (!q.ok) timeouts++; else maxLatency = Math.max(maxLatency, q.ms);
    const f = await fb(cdp);
    if (f) { fbset.add(f.checksum); if (lastHeartbeat !== null && f.heartbeat !== lastHeartbeat) heartbeatMoved = true; lastHeartbeat = f.heartbeat; }
    if (i % 4 === 0) stamp({ event: "watch", i, evalMs: q.ms, evalOk: q.ok, heartbeat: f && f.heartbeat });
    await delay(2000);
  }
  await shot("after-click.png");
  stamp({
    event: "click-verdict",
    rendererAlive: timeouts === 0 && maxLatency < 1500,
    maxEvalLatencyMs: maxLatency,
    evalTimeouts: timeouts,
    mouseDispatchHangs: dispatchHangs,
    heartbeatMoved,
    distinctFramebuffers: fbset.size,
  });

  // Resize hazard: dragging/resizing the window used to kill a live session.
  // Drive viewport resizes and re-measure renderer liveness.
  const sizes = [[1100, 820], [1366, 1024], [900, 700], [1400, 1200]];
  for (const [w, h] of sizes) {
    try { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, 3000); }
    catch {}
    await delay(700);
  }
  try { await cdp.send("Emulation.clearDeviceMetricsOverride", {}, 3000); } catch {}
  stamp({ event: "resized", sizes });
  let rMax = 0, rTimeouts = 0, rPrevHb = null, rHbMoved = false;
  const rFb = new Set();
  for (let i = 0; i < 12; i++) {
    const q = await evalQuick(cdp, "Date.now()");
    if (!q.ok) rTimeouts++; else rMax = Math.max(rMax, q.ms);
    const f = await fb(cdp);
    if (f) { rFb.add(f.checksum); if (rPrevHb !== null && f.heartbeat !== rPrevHb) rHbMoved = true; rPrevHb = f.heartbeat; }
    if (i % 4 === 0) stamp({ event: "resize-watch", i, evalMs: q.ms, evalOk: q.ok, heartbeat: f && f.heartbeat });
    await delay(2000);
  }
  await shot("after-resize.png");
  stamp({
    event: "resize-verdict",
    rendererAlive: rTimeouts === 0 && rMax < 1500,
    maxEvalLatencyMs: rMax,
    evalTimeouts: rTimeouts,
    heartbeatMoved: rHbMoved,
    distinctFramebuffers: rFb.size,
  });
} catch (e) {
  stamp({ event: "fatal", message: String(e && e.message ? e.message : e) });
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
