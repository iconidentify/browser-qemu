#!/usr/bin/env node
// Smoke-test the ethernet bridge: boot the lazy A/UX runtime in headless
// Chrome with ?net=1 (so -nic wasmbridge is active), wait for the wasmbridge
// backend to come up, call window.AuxQemuNet.connect() to attach the page-side
// bridge to the relay /ethernet endpoint, then sample the bridge stats and
// browser log so we can confirm frames flow.
//
// The relay must already be running (make disk-relay, or a plain relay with
// -allow-ips PUBLIC for outbound TCP). Inherits the CDP hazards from
// watch-browser-boot.mjs: never Runtime.enable the QEMU pthread workers; keep
// this event loop unblocked so CDP stays drained.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const options = {
  chrome: process.env.CHROME || defaultChrome,
  server: "http://127.0.0.1:8088",
  duration: 360,
  readyTimeout: 200000,
  url: "",
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--duration") options.duration = Number.parseInt(args[++i], 10);
  else if (a === "--url") options.url = args[++i];
  else if (a === "--server") options.server = String(args[++i]).replace(/\/+$/, "");
  else if (a === "--ready-timeout") options.readyTimeout = Number.parseInt(args[++i], 10);
  else if (a === "--zone") options.zone = args[++i];
  else if (a === "--inject") options.inject = true;
  else if (a === "--sniff") options.sniff = true;
  else if (a === "--agent") options.agent = true;
  else if (a === "--relay-ws") options.relayWs = args[++i];
}
options.zone = options.zone || "";
options.relayWs = options.relayWs || "ws://127.0.0.1:8080/ethernet";
if (!options.url) {
  options.url = `${options.server}/?build=net-smoke&ram=128&heap=384&pace=0&autostart=lazy&net=1` +
    (options.zone ? `&netZone=${encodeURIComponent(options.zone)}` : "");
}

// Inject a broadcast ARP frame into the guest's zone from a second relay
// client, to prove the relay -> browser -> RX-ring -> guest path. Frame:
// ethernet broadcast, EtherType ARP, request "who has 10.1.1.20".
function craftBroadcastArp(srcMac) {
  const f = new Uint8Array(60);
  for (let i = 0; i < 6; i++) f[i] = 0xff;             // dst broadcast
  f.set(srcMac, 6);                                     // src
  f[12] = 0x08; f[13] = 0x06;                           // EtherType ARP
  f[14] = 0x00; f[15] = 0x01;                           // HW type ethernet
  f[16] = 0x08; f[17] = 0x00;                           // proto IPv4
  f[18] = 6; f[19] = 4; f[20] = 0x00; f[21] = 0x01;     // hlen plen op=request
  f.set(srcMac, 22);                                    // sender MAC
  f.set([10, 1, 1, 99], 28);                            // sender IP
  // target MAC zero, target IP 10.1.1.20
  f.set([10, 1, 1, 20], 38);
  return f;
}

function ipStr(b, o) { return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`; }
function macStr2(b, o) {
  const p = [];
  for (let i = 0; i < 6; i++) p.push((b[o + i] | 0x100).toString(16).slice(1));
  return p.join(":");
}

// Decode a captured ethernet frame enough to learn the guest's config.
function decodeFrame(f) {
  if (f.length < 14) return { kind: "short", len: f.length };
  const dst = macStr2(f, 0), src = macStr2(f, 6);
  const et = (f[12] << 8) | f[13];
  if (et === 0x0806 && f.length >= 28) {
    const a = f.subarray(14);
    const op = (a[6] << 8) | a[7];
    return { kind: "arp", op: op === 1 ? "request" : op === 2 ? "reply" : op,
      senderMac: macStr2(a, 8), senderIp: ipStr(a, 14), targetMac: macStr2(a, 18), targetIp: ipStr(a, 24), src };
  }
  if (et === 0x0800 && f.length >= 34) {
    const ihl = (f[14] & 0x0f) * 4;
    const proto = f[23];
    const sip = ipStr(f, 26), dip = ipStr(f, 30);
    const protoName = { 1: "icmp", 6: "tcp", 17: "udp" }[proto] || proto;
    let ports = "";
    if ((proto === 6 || proto === 17) && f.length >= 14 + ihl + 4) {
      const sp = (f[14 + ihl] << 8) | f[14 + ihl + 1];
      const dp = (f[14 + ihl + 2] << 8) | f[14 + ihl + 3];
      ports = `${sp}->${dp}`;
    }
    return { kind: "ipv4", proto: protoName, src: sip, dst: dip, ports };
  }
  if (et === 0x809b) return { kind: "appletalk-ddp", src };
  if (et === 0x80f3) return { kind: "appletalk-aarp", src };
  return { kind: "eth", etherType: "0x" + et.toString(16), src, dst };
}

// Passive sniffer: a relay client in the guest's zone that logs decoded
// frames the guest broadcasts (forwarded to all zone members).
async function runSniffer(zone) {
  const ws = new WebSocket(options.relayWs);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sniffer ws timeout")), 8000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("sniffer ws error")); }, { once: true });
  });
  ws.send(JSON.stringify({ type: "init", macAddress: "02:00:00:00:00:02", zone }));
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (msg && msg.type === "receive" && typeof msg.packetArray === "string") {
      const bytes = Buffer.from(msg.packetArray, "base64");
      stamp({ event: "sniff", frame: decodeFrame(new Uint8Array(bytes)), bytes: bytes.length });
    }
  });
  stamp({ event: "sniffer-ready", zone });
  return ws;
}

async function runInjector(zone) {
  const srcMac = [0x02, 0x00, 0x00, 0x00, 0x00, 0x01];
  const ws = new WebSocket(options.relayWs);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("injector ws timeout")), 8000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("injector ws error")); }, { once: true });
  });
  ws.send(JSON.stringify({ type: "init", macAddress: "02:00:00:00:00:01", zone }));
  await delay(500);
  const frame = craftBroadcastArp(srcMac);
  const b64 = Buffer.from(frame).toString("base64");
  for (let n = 0; n < 3; n++) {
    ws.send(JSON.stringify({ type: "send", destination: "*", packetArray: b64 }));
    await delay(300);
  }
  stamp({ event: "injected", frames: 3, bytes: frame.length, zone });
  return ws;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (o) => console.log(JSON.stringify(o));

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
      lastError = new Error(`${url} HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await delay(500);
  }
  throw lastError || new Error(`timed out: ${url}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP ws error")); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let m;
    try { m = JSON.parse(event.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const req = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(req.timeout);
      if (m.error) req.reject(new Error(`${req.method}: ${m.error.message || JSON.stringify(m.error)}`));
      else req.resolve(m.result || {});
    }
  });
  function send(method, params = {}, timeoutMs = 20000) {
    const rid = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(rid); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(rid, { method, resolve, reject, timeout });
      ws.send(JSON.stringify({ id: rid, method, params }));
    });
  }
  return { ws, send };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result ? r.result.value : null;
}

async function evaluateAsync(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 40000);
  return r.result ? r.result.value : null;
}

// Drive the in-page auxagent client (window.AuxAgent) to prove the web app
// itself can run commands inside A/UX. Net mode auto-shares one zone between
// the NIC bridge and the agent peer.
async function runAgentTest(cdp) {
  await evaluate(cdp, `(window.AuxQemuNet && window.AuxQemuNet.connect(), "net-connect")`);
  stamp({ event: "agent-net-connect" });
  let up = false;
  for (let i = 0; i < 24; i++) {
    const r = await evaluateAsync(cdp, `window.AuxAgent.ping().then(x=>JSON.stringify(x)).catch(e=>"ERR:"+(e&&e.message||e))`);
    stamp({ event: "agent-ping", i, r });
    if (r && r.includes("auxagent")) { up = true; break; }
    await delay(10000);
  }
  if (!up) { stamp({ event: "agent-timeout" }); return; }
  const ex = await evaluateAsync(cdp, `window.AuxAgent.exec("uname -a; id").then(x=>JSON.stringify(x)).catch(e=>"ERR:"+(e&&e.message||e))`);
  stamp({ event: "agent-exec", result: ex });
}

const port = 9400 + Math.floor(Math.random() * 1000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-net-smoke-chrome-"));
const chrome = spawn(options.chrome, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-dev-shm-usage",
  "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--window-size=1400,1200",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let cdp = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((t) => t.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: options.url });
  stamp({ event: "navigated", url: options.url, port });

  // Wait for the wasmbridge backend export to appear.
  const readyDeadline = Date.now() + options.readyTimeout;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const state = await evaluate(cdp, `(() => ({
      hasQemu: !!window.AuxQemu,
      hasNetExport: !!(window.AuxQemu && typeof window.AuxQemu.c89NetSharedPtr === 'function'),
    }))()`);
    if (state && state.hasNetExport) { ready = true; break; }
    await delay(3000);
  }
  if (!ready) {
    stamp({ event: "error", message: "wasmbridge backend export never appeared (backend missing or boot stalled)" });
  } else {
    stamp({ event: "backend-ready" });
    const connectRes = await evaluate(cdp, `(() => {
      try { window.AuxQemuNet.connect(); return 'connect-called'; }
      catch (e) { return 'connect-error: ' + (e && e.message ? e.message : e); }
    })()`);
    stamp({ event: "connect", result: connectRes });
    if (options.agent) {
      try { await runAgentTest(cdp); }
      catch (e) { stamp({ event: "agent-error", message: String(e && e.message ? e.message : e) }); }
    }
    if (options.sniff) {
      try { await runSniffer(options.zone); }
      catch (e) { stamp({ event: "sniff-error", message: String(e && e.message ? e.message : e) }); }
    }
    if (options.inject) {
      await delay(2000);
      try { await runInjector(options.zone); }
      catch (e) { stamp({ event: "inject-error", message: String(e && e.message ? e.message : e) }); }
    }
  }

  const end = Date.now() + options.duration * 1000;
  while (Date.now() < end) {
    await delay(15000);
    const stats = await evaluate(cdp, `(window.AuxQemuNet && window.AuxQemuNet.stats) ? window.AuxQemuNet.stats() : null`);
    let logTail = [];
    try {
      const payload = await waitForJson(`${options.server}/__browser-log.json`, 4000);
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      logTail = lines.filter((l) => /net|wasmbridge|ethernet|nic/i.test(String(l))).slice(-4);
    } catch {}
    stamp({ event: "sample", elapsedMs: Date.now() - (end - options.duration * 1000), stats, logTail });
  }
  stamp({ event: "done" });
} catch (e) {
  stamp({ event: "fatal", message: String(e && e.message ? e.message : e) });
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
