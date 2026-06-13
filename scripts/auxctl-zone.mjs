#!/usr/bin/env node
// auxctl-zone: speak AAP (the A/UX Agent Protocol, HTTP/1.0 over TCP) to the
// auxagent server running INSIDE the browser-qemu A/UX guest, reached through
// the wasmbridge ethernet bridge + dialtone relay zone -- there is no real IP
// route to the guest, so this implements a minimal userspace TCP client that
// rides on raw L2 frames over the relay /ethernet WebSocket.
//
// This is the reliable in-VM control channel for our system (auxagent source:
// ~/se30/auxagent). Subcommands mirror auxctl:
//   ping
//   exec  "shell command"        -> prints merged stdout+stderr; exit=remote
//   get   REMOTE_PATH LOCAL_FILE  -> download (CRC-32 verified)
//   put   LOCAL_FILE REMOTE_PATH  -> upload   (CRC-32 verified)
//
// Requires a guest booted with ?net=1&netZone=<zone> (bridge connected) and a
// relay running. Env AAP_TOKEN sets X-Aap-Token.
import fs from "node:fs";
import zlib from "node:zlib";
import process from "node:process";

const opts = {
  relayWs: process.env.AUX_RELAY_WS || "ws://127.0.0.1:8080/ethernet",
  zone: process.env.AUX_ZONE || "lan",
  guestIp: process.env.AUX_GUEST_IP || "10.1.1.20",
  guestMac: process.env.AUX_GUEST_MAC || "08:00:07:0a:0b:0c",
  myIp: process.env.AUX_MY_IP || "10.1.1.1",
  myMac: process.env.AUX_MY_MAC || "02:00:00:00:00:01",
  port: Number(process.env.AUX_PORT || 8377),
  token: process.env.AAP_TOKEN || "",
  verbose: false,
};

const rawArgs = process.argv.slice(2);
const cmdArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--zone") opts.zone = rawArgs[++i];
  else if (a === "--relay-ws") opts.relayWs = rawArgs[++i];
  else if (a === "--guest-ip") opts.guestIp = rawArgs[++i];
  else if (a === "--guest-mac") opts.guestMac = rawArgs[++i];
  else if (a === "--port") opts.port = Number(rawArgs[++i]);
  else if (a === "-v" || a === "--verbose") opts.verbose = true;
  else cmdArgs.push(a);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const vlog = (...a) => { if (opts.verbose) process.stderr.write("[auxctl-zone] " + a.join(" ") + "\n"); };
const ipBytes = (s) => s.split(".").map((n) => parseInt(n, 10));
const macBytes = (s) => s.split(":").map((h) => parseInt(h, 16));

function checksum16(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i] << 8) | (i + 1 < bytes.length ? bytes[i + 1] : 0);
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}
function be16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
function be32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }

function ethHeader(dstMac, srcMac, etherType) {
  const h = new Uint8Array(14);
  h.set(macBytes(dstMac), 0);
  h.set(macBytes(srcMac), 6);
  h[12] = (etherType >> 8) & 0xff; h[13] = etherType & 0xff;
  return h;
}

function craftArpReply(senderMac, senderIp, targetMac, targetIp) {
  const f = new Uint8Array(60);
  f.set(ethHeader(targetMac, senderMac, 0x0806), 0);
  const a = f.subarray(14);
  a.set([0, 1, 8, 0, 6, 4, 0, 2], 0);
  a.set(macBytes(senderMac), 8); a.set(ipBytes(senderIp), 14);
  a.set(macBytes(targetMac), 18); a.set(ipBytes(targetIp), 24);
  return f;
}

// Build an Ethernet+IPv4+TCP frame. flags e.g. 0x02 SYN, 0x10 ACK, 0x18 PSH+ACK, 0x11 FIN+ACK.
function craftTcp(srcMac, dstMac, srcIp, dstIp, srcPort, dstPort, seq, ack, flags, payload) {
  payload = payload || new Uint8Array(0);
  const tcp = new Uint8Array(20 + payload.length);
  tcp.set(be16(srcPort), 0);
  tcp.set(be16(dstPort), 2);
  tcp.set(be32(seq >>> 0), 4);
  tcp.set(be32(ack >>> 0), 8);
  tcp[12] = 0x50;            // data offset 5
  tcp[13] = flags;
  tcp.set(be16(0x2000), 14); // window 8192
  tcp.set(payload, 20);
  // pseudo-header checksum
  const pseudo = new Uint8Array(12 + tcp.length);
  pseudo.set(ipBytes(srcIp), 0);
  pseudo.set(ipBytes(dstIp), 4);
  pseudo[9] = 6;
  pseudo.set(be16(tcp.length), 10);
  pseudo.set(tcp, 12);
  const ck = checksum16(pseudo);
  tcp.set(be16(ck), 16);

  const ip = new Uint8Array(20 + tcp.length);
  ip[0] = 0x45;
  ip.set(be16(ip.length), 2);
  ip.set(be16(0x1200 + (seq & 0xff)), 4); // id (varied)
  ip[8] = 64; ip[9] = 6;
  ip.set(ipBytes(srcIp), 12);
  ip.set(ipBytes(dstIp), 16);
  ip.set(be16(checksum16(ip.subarray(0, 20))), 10);
  ip.set(tcp, 20);

  const f = new Uint8Array(14 + ip.length);
  f.set(ethHeader(dstMac, srcMac, 0x0800), 0);
  f.set(ip, 14);
  return f;
}

// Parse an incoming Ethernet frame; return TCP info if it's TCP from guest->me.
function parseTcp(f) {
  if (f.length < 14) return null;
  if (((f[12] << 8) | f[13]) !== 0x0800) return null;
  if (f[23] !== 6) return null;
  const ihl = (f[14] & 0x0f) * 4;
  const t = 14 + ihl;
  if (f.length < t + 20) return null;
  const srcPort = (f[t] << 8) | f[t + 1];
  const dstPort = (f[t + 2] << 8) | f[t + 3];
  const seq = ((f[t + 4] << 24) | (f[t + 5] << 16) | (f[t + 6] << 8) | f[t + 7]) >>> 0;
  const ack = ((f[t + 8] << 24) | (f[t + 9] << 16) | (f[t + 10] << 8) | f[t + 11]) >>> 0;
  const dataOff = (f[t + 12] >> 4) * 4;
  const flags = f[t + 13];
  const ipTotal = (f[16] << 8) | f[17];
  const payloadStart = t + dataOff;
  const payloadEnd = 14 + ipTotal;
  const payload = f.subarray(payloadStart, Math.min(payloadEnd, f.length));
  return { srcPort, dstPort, seq, ack, flags, payload };
}

class Relay {
  constructor() { this.ws = null; this.onTcp = null; }
  async connect() {
    this.ws = new WebSocket(opts.relayWs);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("relay ws timeout")), 8000);
      this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("relay ws error")); }, { once: true });
    });
    this.ws.send(JSON.stringify({ type: "init", macAddress: opts.myMac, zone: opts.zone }));
    this.ws.addEventListener("message", (event) => {
      let m;
      try { m = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
      if (m && m.type === "receive" && typeof m.packetArray === "string") {
        const f = new Uint8Array(Buffer.from(m.packetArray, "base64"));
        const tcp = parseTcp(f);
        if (tcp && this.onTcp) this.onTcp(tcp);
      }
    });
  }
  send(frame, destination) {
    this.ws.send(JSON.stringify({ type: "send", destination, packetArray: Buffer.from(frame).toString("base64") }));
  }
  close() { try { this.ws.close(); } catch {} }
}

// One AAP request over a fresh userspace TCP connection through the zone.
async function aapRequest(relay, { method, path, headers = {}, body = new Uint8Array(0) }) {
  const sport = 40000 + Math.floor((Date.now() % 20000));
  let iss = 0x20000000;          // my initial send seq
  let snd = iss;                 // my next seq to send
  let rcv = 0;                   // next expected seq from guest
  let established = false, finSeen = false, gotSynAck = false;
  const rxChunks = [];
  const tcp = (flags, payload) =>
    craftTcp(opts.myMac, opts.guestMac, opts.myIp, opts.guestIp, sport, opts.port, snd, rcv, flags, payload);

  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

  relay.onTcp = (seg) => {
    if (seg.srcPort !== opts.port || seg.dstPort !== sport) return;
    if (seg.flags & 0x04) { rejectDone(new Error("connection reset by guest (RST)")); return; }
    if ((seg.flags & 0x12) === 0x12 && !gotSynAck) {     // SYN-ACK
      gotSynAck = true;
      rcv = (seg.seq + 1) >>> 0;
      snd = (iss + 1) >>> 0;
      established = true;
      relay.send(tcp(0x10), opts.guestMac);              // ACK the handshake
      // send the request body immediately (PSH+ACK)
      const reqHead = tcp(0x18, requestBytes);
      snd = (snd + requestBytes.length) >>> 0;
      relay.send(reqHead, opts.guestMac);
      return;
    }
    if (!established) return;
    // In-order data only.
    if (seg.payload && seg.payload.length && seg.seq === rcv) {
      rxChunks.push(Buffer.from(seg.payload));
      rcv = (rcv + seg.payload.length) >>> 0;
    }
    if (seg.flags & 0x01) { // FIN
      finSeen = true;
      rcv = (rcv + 1) >>> 0;
    }
    // ACK whatever we've received (data and/or FIN).
    if ((seg.payload && seg.payload.length) || (seg.flags & 0x01)) {
      relay.send(tcp(0x10), opts.guestMac);
    }
    // Completion check: full body by Content-Length, or FIN.
    const buf = Buffer.concat(rxChunks);
    const parsed = tryParseHttp(buf);
    if ((parsed && parsed.complete) || finSeen) {
      if (!finSeen) { relay.send(tcp(0x11), opts.guestMac); snd = (snd + 1) >>> 0; } // our FIN
      resolveDone(buf);
    }
  };

  // Build the HTTP/1.0 request now (need its length for seq math).
  const hdrLines = [`${method} ${path} HTTP/1.0`, `Host: ${opts.guestIp}`];
  if (opts.token) hdrLines.push(`X-Aap-Token: ${opts.token}`);
  for (const [k, v] of Object.entries(headers)) hdrLines.push(`${k}: ${v}`);
  hdrLines.push(`Content-Length: ${body.length}`);
  hdrLines.push("", "");
  const head = Buffer.from(hdrLines.join("\r\n"), "binary");
  const requestBytes = Buffer.concat([head, Buffer.from(body)]);

  // Make sure the guest can address us, then SYN (with light retransmit).
  relay.send(craftArpReply(opts.myMac, opts.myIp, opts.guestMac, opts.guestIp), opts.guestMac);
  await delay(150);
  let tries = 0;
  const synTimer = setInterval(() => {
    if (gotSynAck || tries >= 10) { clearInterval(synTimer); return; }
    tries++;
    relay.send(craftTcp(opts.myMac, opts.guestMac, opts.myIp, opts.guestIp, sport, opts.port, iss, 0, 0x02, null), opts.guestMac);
  }, 500);

  const timeout = setTimeout(() => rejectDone(new Error("AAP request timed out")), 25000);
  try {
    const raw = await done;
    return parseHttpResponse(raw);
  } finally {
    clearInterval(synTimer);
    clearTimeout(timeout);
    relay.onTcp = null;
  }
}

function findHeaderEnd(buf) {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) return i + 1;
  }
  return -1;
}
function tryParseHttp(buf) {
  const he = findHeaderEnd(buf);
  if (he < 0) return null;
  const headerText = buf.slice(0, he).toString("binary");
  const m = /content-length:\s*(\d+)/i.exec(headerText);
  if (!m) return { complete: false }; // no length yet; wait for FIN
  const need = he + parseInt(m[1], 10);
  return { complete: buf.length >= need, headerEnd: he, bodyLen: parseInt(m[1], 10) };
}
function parseHttpResponse(buf) {
  const he = findHeaderEnd(buf);
  const headerText = (he < 0 ? buf : buf.slice(0, he)).toString("binary");
  const lines = headerText.split("\r\n").filter(Boolean);
  const statusLine = lines[0] || "";
  const status = parseInt((statusLine.split(" ")[1] || "0"), 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
  }
  const body = he < 0 ? Buffer.alloc(0) : buf.slice(he);
  return { status, statusLine, headers, body };
}

function crc32hex(buf) {
  // zlib.crc32 (Node >=20) gives IEEE 802.3 CRC-32, matching the agent.
  const c = (zlib.crc32 ? zlib.crc32(buf) : null);
  if (c === null) throw new Error("zlib.crc32 unavailable (need Node >= 20)");
  return (c >>> 0).toString(16).padStart(8, "0");
}

async function main() {
  const sub = cmdArgs[0];
  if (!sub) { process.stderr.write("usage: auxctl-zone [--zone z] {ping|exec|get|put} ...\n"); process.exit(2); }
  const relay = new Relay();
  await relay.connect();
  vlog(`zone=${opts.zone} guest=${opts.guestIp}:${opts.port} me=${opts.myIp}`);
  try {
    if (sub === "ping") {
      const r = await aapRequest(relay, { method: "GET", path: "/ping" });
      process.stdout.write(r.body.toString("binary") + "\n");
      process.exit(r.status === 200 ? 0 : 1);
    } else if (sub === "exec") {
      const cmd = cmdArgs.slice(1).join(" ");
      if (!cmd) { process.stderr.write("usage: ... exec \"shell command\"\n"); process.exit(2); }
      const r = await aapRequest(relay, { method: "POST", path: "/exec", body: Buffer.from(cmd, "binary") });
      process.stdout.write(r.body.toString("binary"));
      const code = parseInt(r.headers["x-exit-code"] || "0", 10);
      process.exit(code);
    } else if (sub === "get") {
      const [rpath, lpath] = [cmdArgs[1], cmdArgs[2]];
      const r = await aapRequest(relay, { method: "GET", path: "/file" + rpath });
      if (r.status !== 200) { process.stderr.write(r.body.toString("binary")); process.exit(1); }
      const sum = r.headers["x-aap-sum"];
      if (sum && crc32hex(r.body) !== sum.toLowerCase()) { process.stderr.write("CRC mismatch\n"); process.exit(1); }
      if (lpath && lpath !== "-") fs.writeFileSync(lpath, r.body); else process.stdout.write(r.body);
      process.exit(0);
    } else if (sub === "put") {
      const [lpath, rpath] = [cmdArgs[1], cmdArgs[2]];
      const data = fs.readFileSync(lpath);
      const r = await aapRequest(relay, { method: "PUT", path: "/file" + rpath, body: data });
      process.stdout.write(r.body.toString("binary"));
      process.exit(parseInt(r.headers["x-exit-code"] || "1", 10));
    } else {
      process.stderr.write(`unknown subcommand: ${sub}\n`); process.exit(2);
    }
  } catch (e) {
    process.stderr.write("auxctl-zone error: " + (e && e.message ? e.message : e) + "\n");
    process.exit(1);
  } finally {
    relay.close();
  }
}

main();
