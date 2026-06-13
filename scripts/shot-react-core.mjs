#!/usr/bin/env node
// Headless screenshot + console capture for the React common-layer frontend
// (web/dist) driving a chosen core. Unlike watch-browser-boot.mjs this does not
// wait for the vanilla app's browser-log line; it just navigates, captures the
// page console (main target only -- never the QEMU pthread worker), and writes
// periodic screenshots so we can confirm a core boots THROUGH the React shell.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const opts = { chrome: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  url: "", outDir: "build/qemu-react-watch", duration: 150, interval: 20 };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--url") opts.url = a[++i];
  else if (a[i] === "--out-dir") opts.outDir = a[++i];
  else if (a[i] === "--duration") opts.duration = Number(a[++i]);
  else if (a[i] === "--interval") opts.interval = Number(a[++i]);
}
if (!opts.url) { console.error("need --url"); process.exit(2); }
fs.mkdirSync(opts.outDir, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("cdp connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); rej(new Error("cdp ws error")); }, { once: true });
  });
  let id = 0; const pending = new Map(); const handlers = [];
  ws.addEventListener("message", (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id); pending.delete(m.id); clearTimeout(r.timeout);
      m.error ? r.reject(new Error(`${r.method}: ${m.error.message}`)) : r.resolve(m.result || {});
    } else if (m.method) { for (const h of handlers) h(m); }
  });
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const rid = ++id; const timeout = setTimeout(() => { pending.delete(rid); reject(new Error(`${method} timeout`)); }, timeoutMs);
    pending.set(rid, { method, resolve, reject, timeout }); ws.send(JSON.stringify({ id: rid, method, params }));
  });
  return { ws, send, on: (h) => handlers.push(h) };
}
async function waitForJson(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url, { cache: "no-store" }); if (r.ok) return r.json(); } catch {}
    await delay(500);
  }
  throw new Error("waitForJson timeout");
}

const port = 9500 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "c89-react-shot-"));
const chrome = spawn(opts.chrome, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-dev-shm-usage",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required",
  "--window-size=1400,1200", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

const consoleLog = [];
let cdp = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((t) => t.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  cdp.on((m) => {
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map((x) => x.value ?? x.description ?? x.unserializableValue ?? (x.preview ? JSON.stringify(x.preview) : "")).join(" ");
      consoleLog.push(`[${m.params.type}] ${text}`);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      const ex = d.exception || {};
      const detail = ex.description || ex.value || ex.className || (ex.preview ? JSON.stringify(ex.preview) : "");
      const where = d.url ? ` @${d.url}:${d.lineNumber}` : "";
      const props = ex.preview && ex.preview.properties ? " props=" + JSON.stringify(ex.preview.properties) : "";
      consoleLog.push(`[exception] text="${d.text || ""}" detail=${detail}${where}${props}`);
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable"); // main page target only
  await cdp.send("Page.navigate", { url: opts.url });
  console.log(JSON.stringify({ event: "navigated", url: opts.url, port }));

  const start = Date.now();
  async function sample(label) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    let shot = null;
    try {
      const s = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, 30000);
      shot = path.join(opts.outDir, `shot-${String(elapsed).padStart(5, "0")}s.png`);
      fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
    } catch (e) { console.log(JSON.stringify({ event: "shot-failed", elapsed, error: String(e.message || e) })); }
    const recent = consoleLog.slice(-6);
    console.log(JSON.stringify({ event: label, elapsed, shot: shot ? path.basename(shot) : null, consoleTail: recent }));
  }
  await sample("sample");
  while ((Date.now() - start) / 1000 < opts.duration) { await delay(opts.interval * 1000); await sample("sample"); }
  await sample("final");
  fs.writeFileSync(path.join(opts.outDir, "console.log"), consoleLog.join("\n"));
  console.log(JSON.stringify({ event: "done", consoleLines: consoleLog.length }));
} catch (e) {
  console.log(JSON.stringify({ event: "error", error: String(e.stack || e) }));
  fs.writeFileSync(path.join(opts.outDir, "console.log"), consoleLog.join("\n"));
} finally {
  try { cdp?.ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  fs.rmSync(profile, { recursive: true, force: true });
}
