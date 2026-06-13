#!/usr/bin/env node
// Headless boot benchmark for browser-qemu. Boots a given URL, detects when the
// guest reaches a steady screen (login), and prints a compact metric summary so
// optimization changes can be A/B-compared objectively rather than by feel:
//   - timeToLoginSec   : wall-clock until the framebuffer stops changing (CPU-speed proxy)
//   - genPerSec        : steady-state framebuffer generation rate (renderer/refresh proxy)
//   - fetchesToLogin   : disk range fetches issued to reach login (disk-paging proxy)
//   - wireMBToLogin    : disk bytes pulled over the wire to reach login
//   - peakWasmMB / peakCacheMB : memory footprint
//
// Reuses the same CDP-over-WebSocket approach as the other harnesses. Reads the
// page's #probeState snapshot (the vanilla app publishes it). Main page target
// only -- never Runtime.enable a QEMU pthread worker (it stalls the renderer).
//
// Usage: node scripts/bench-boot.mjs --url "http://127.0.0.1:8088/?...&autostart=lazy" [--label name] [--max 180]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const opts = { chrome: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  url: "", label: "bench", max: 180, settleSamples: 4, sampleMs: 3000 };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--url") opts.url = a[++i];
  else if (a[i] === "--label") opts.label = a[++i];
  else if (a[i] === "--max") opts.max = Number(a[++i]);
}
if (!opts.url) { console.error("need --url"); process.exit(2); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp ws error")); }, { once: true });
  });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id); pending.delete(m.id); clearTimeout(r.timeout);
      m.error ? r.reject(new Error(`${r.method}: ${m.error.message}`)) : r.resolve(m.result || {});
    }
  });
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const rid = ++id; const timeout = setTimeout(() => { pending.delete(rid); reject(new Error(`${method} timeout`)); }, timeoutMs);
    pending.set(rid, { method, resolve, reject, timeout }); ws.send(JSON.stringify({ id: rid, method, params }));
  });
  return { ws, send };
}
async function waitForJson(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return r.json(); } catch {}
    await delay(500);
  }
  throw new Error("waitForJson timeout");
}
async function readProbe(cdp) {
  try {
    const r = await cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('probeState') && document.getElementById('probeState').textContent",
      returnByValue: true,
    });
    return r.result && r.result.value ? JSON.parse(r.result.value) : null;
  } catch { return null; }
}

const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c89-bench-"));
const chrome = spawn(opts.chrome, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-dev-shm-usage",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1200,1000", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let cdp = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((t) => t.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: opts.url });

  const start = Date.now();
  let lastChanges = -1, stable = 0, loginAt = 0;
  let loginFetches = 0, loginWireMB = 0, peakWasm = 0, peakCache = 0;
  let genAtLogin = 0, genLast = 0, tLast = 0;
  while ((Date.now() - start) / 1000 < opts.max) {
    await delay(opts.sampleMs);
    const p = await readProbe(cdp);
    if (!p) continue;
    const fb = p.framebuffer || {};
    const mem = p.memory || {};
    const rend = p.renderer || {};
    const ranges = (p.diskIo && p.diskIo.length) ? p.diskIo : null;
    peakWasm = Math.max(peakWasm, mem.wasmMb || 0);
    peakCache = Math.max(peakCache, mem.diskCacheMb || 0);
    genLast = rend.generation || genLast;
    tLast = (Date.now() - start) / 1000;
    if (!loginAt) {
      // Login reached: framebuffer lit and 'changes' stable across settleSamples.
      const lit = (fb.nonBlack || 0) > 2000;
      if (lit && fb.changes === lastChanges && fb.changes > 0) {
        stable += 1;
        if (stable >= opts.settleSamples) {
          loginAt = tLast;
          genAtLogin = rend.generation || 0;
          // fetches/wire come from /__range-stats below
        }
      } else {
        stable = 0;
      }
      lastChanges = fb.changes;
    }
  }
  // Pull disk wire stats from the server.
  let rangeStats = null;
  try {
    const origin = new URL(opts.url).origin;
    rangeStats = await waitForJson(`${origin}/__range-stats.json?ts=${start}`, 3000);
  } catch {}
  if (rangeStats && rangeStats.entries) {
    for (const e of rangeStats.entries) {
      if (e.path && e.path.endsWith(".img")) {
        loginFetches = e.rangeGet || 0;
        loginWireMB = Math.round(((e.rangeBytes || 0) / 1048576) * 10) / 10;
      }
    }
  }
  // Steady-state gen/sec measured over a short trailing window.
  const winStart = Date.now();
  const g0 = genLast;
  await delay(6000);
  const p2 = await readProbe(cdp);
  const g1 = (p2 && p2.renderer && p2.renderer.generation) || g0;
  const genPerSec = Math.round(((g1 - g0) / ((Date.now() - winStart) / 1000)) * 10) / 10;

  console.log(JSON.stringify({
    label: opts.label,
    timeToLoginSec: loginAt || null,
    reachedLogin: Boolean(loginAt),
    genPerSec,
    fetchesToLogin: loginFetches,
    wireMBToLogin: loginWireMB,
    peakWasmMB: peakWasm,
    peakCacheMB: peakCache,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ event: "error", error: String(e.stack || e) }));
} finally {
  try { cdp?.ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  fs.rmSync(profile, { recursive: true, force: true });
}
