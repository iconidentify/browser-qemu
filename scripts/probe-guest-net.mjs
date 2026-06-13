#!/usr/bin/env node
// Relay-side prober for the A/UX guest's TCP/IP stack. Connects to the relay
// /ethernet endpoint as a peer in the guest's zone, waits for the guest's
// gratuitous ARP (interface-up at 10.1.1.20), then probes the guest with ARP
// and ICMP echo and reports any replies. This exercises the full
// relay -> bridge -> RX ring -> dp8393x -> A/UX stack -> dp8393x -> TX ring ->
// bridge -> relay path using real A/UX networking code, with no guest shell.
//
// Run a guest boot separately, e.g.:
//   node scripts/smoke-net-bridge.mjs --duration 240 --zone lan
// then this against the same zone:
//   node scripts/probe-guest-net.mjs --zone lan --guest-ip 10.1.1.20
import process from "node:process";

const opts = {
  relayWs: "ws://127.0.0.1:8080/ethernet",
  zone: "lan",
  guestIp: "10.1.1.20",
  myIp: "10.1.1.1",
  myMac: "02:00:00:00:00:01",
  waitMs: 240000,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--relay-ws") opts.relayWs = argv[++i];
  else if (a === "--zone") opts.zone = argv[++i];
  else if (a === "--guest-ip") opts.guestIp = argv[++i];
  else if (a === "--my-ip") opts.myIp = argv[++i];
  else if (a === "--wait") opts.waitMs = Number.parseInt(argv[++i], 10) * 1000;
  else if (a === "--tcp-ports") opts.tcpPorts = argv[++i].split(",").map((p) => parseInt(p, 10));
}
opts.tcpPorts = opts.tcpPorts || [23, 21, 79, 7, 13, 512, 514, 540];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (o) => console.log(JSON.stringify(o));
const ipBytes = (s) => s.split(".").map((n) => parseInt(n, 10));
const macBytes = (s) => s.split(":").map((h) => parseInt(h, 16));
const ipStr = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const macStr = (b, o) => [...Array(6)].map((_, i) => (b[o + i] | 0x100).toString(16).slice(1)).join(":");

function checksum16(bytes, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 2) {
    sum += (bytes[i] << 8) | (i + 1 < end ? bytes[i + 1] : 0);
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function ethHeader(dstMac, srcMac, etherType) {
  const h = new Uint8Array(14);
  h.set(macBytes(dstMac), 0);
  h.set(macBytes(srcMac), 6);
  h[12] = (etherType >> 8) & 0xff;
  h[13] = etherType & 0xff;
  return h;
}

function craftArp(op, senderMac, senderIp, targetMac, targetIp, ethDst) {
  const f = new Uint8Array(60); // min ethernet frame
  f.set(ethHeader(ethDst, senderMac, 0x0806), 0);
  const a = f.subarray(14);
  a[0] = 0x00; a[1] = 0x01;       // HW ethernet
  a[2] = 0x08; a[3] = 0x00;       // proto IPv4
  a[4] = 6; a[5] = 4;             // hlen plen
  a[6] = 0x00; a[7] = op;         // op
  a.set(macBytes(senderMac), 8);
  a.set(ipBytes(senderIp), 14);
  a.set(macBytes(targetMac), 18);
  a.set(ipBytes(targetIp), 24);
  return f;
}

function craftIcmpEcho(srcMac, dstMac, srcIp, dstIp, id, seq) {
  const icmp = new Uint8Array(16); // 8 header + 8 payload
  icmp[0] = 8; icmp[1] = 0;        // echo request
  icmp[4] = (id >> 8) & 0xff; icmp[5] = id & 0xff;
  icmp[6] = (seq >> 8) & 0xff; icmp[7] = seq & 0xff;
  for (let i = 8; i < 16; i++) icmp[i] = 0x40 + i; // payload
  const ck = checksum16(icmp, 0, icmp.length);
  icmp[2] = (ck >> 8) & 0xff; icmp[3] = ck & 0xff;

  const ip = new Uint8Array(20 + icmp.length);
  ip[0] = 0x45; ip[1] = 0;
  const total = ip.length;
  ip[2] = (total >> 8) & 0xff; ip[3] = total & 0xff;
  ip[4] = 0x12; ip[5] = 0x34;      // id
  ip[6] = 0; ip[7] = 0;            // flags/frag
  ip[8] = 64;                      // ttl
  ip[9] = 1;                       // proto ICMP
  ip.set(ipBytes(srcIp), 12);
  ip.set(ipBytes(dstIp), 16);
  const ick = checksum16(ip, 0, 20);
  ip[10] = (ick >> 8) & 0xff; ip[11] = ick & 0xff;
  ip.set(icmp, 20);

  const f = new Uint8Array(14 + ip.length);
  f.set(ethHeader(dstMac, srcMac, 0x0800), 0);
  f.set(ip, 14);
  return f;
}

// TCP SYN to a guest port. Checksum covers the IPv4 pseudo-header + segment.
function craftTcpSyn(srcMac, dstMac, srcIp, dstIp, srcPort, dstPort) {
  const tcp = new Uint8Array(20);
  tcp[0] = (srcPort >> 8) & 0xff; tcp[1] = srcPort & 0xff;
  tcp[2] = (dstPort >> 8) & 0xff; tcp[3] = dstPort & 0xff;
  tcp[4] = 0x00; tcp[5] = 0x00; tcp[6] = 0x10; tcp[7] = 0x00; // seq 0x1000
  tcp[12] = 0x50;            // data offset 5 words
  tcp[13] = 0x02;            // SYN
  tcp[14] = 0x20; tcp[15] = 0x00; // window 8192
  // pseudo-header checksum
  const pseudo = new Uint8Array(12 + tcp.length);
  pseudo.set(ipBytes(srcIp), 0);
  pseudo.set(ipBytes(dstIp), 4);
  pseudo[9] = 6;             // proto TCP
  pseudo[10] = (tcp.length >> 8) & 0xff; pseudo[11] = tcp.length & 0xff;
  pseudo.set(tcp, 12);
  const ck = checksum16(pseudo, 0, pseudo.length);
  tcp[16] = (ck >> 8) & 0xff; tcp[17] = ck & 0xff;

  const ip = new Uint8Array(20 + tcp.length);
  ip[0] = 0x45; ip[2] = (ip.length >> 8) & 0xff; ip[3] = ip.length & 0xff;
  ip[4] = 0x12; ip[5] = 0x35; ip[8] = 64; ip[9] = 6;
  ip.set(ipBytes(srcIp), 12); ip.set(ipBytes(dstIp), 16);
  const ick = checksum16(ip, 0, 20);
  ip[10] = (ick >> 8) & 0xff; ip[11] = ick & 0xff;
  ip.set(tcp, 20);

  const f = new Uint8Array(14 + ip.length);
  f.set(ethHeader(dstMac, srcMac, 0x0800), 0);
  f.set(ip, 14);
  return f;
}

let ws;
let guestMac = null;
let sawGratuitous = false;
const seen = { arpReply: 0, icmpReply: 0, other: 0 };
const tcpOpen = [];

function send(frame, destination) {
  ws.send(JSON.stringify({
    type: "send",
    destination,
    packetArray: Buffer.from(frame).toString("base64"),
  }));
}

function onFrame(f) {
  if (f.length < 14) return;
  const et = (f[12] << 8) | f[13];
  const src = macStr(f, 6);
  if (et === 0x0806) {
    const a = f.subarray(14);
    const op = (a[6] << 8) | a[7];
    const senderIp = ipStr(a, 14), targetIp = ipStr(a, 24);
    if (op === 1 && senderIp === opts.guestIp && targetIp === opts.guestIp) {
      if (!sawGratuitous) { sawGratuitous = true; guestMac = macStr(a, 8); stamp({ event: "guest-up", guestIp: opts.guestIp, guestMac }); }
      return;
    }
    if (op === 2) {
      seen.arpReply++;
      stamp({ event: "guest-arp-reply", senderIp, senderMac: macStr(a, 8), targetIp });
      if (!guestMac) guestMac = macStr(a, 8);
      return;
    }
    stamp({ event: "guest-arp", op, senderIp, targetIp, src });
  } else if (et === 0x0800) {
    const proto = f[23];
    const sip = ipStr(f, 26), dip = ipStr(f, 30);
    if (proto === 1) {
      const ihl = (f[14] & 0x0f) * 4;
      const icmpType = f[14 + ihl];
      seen.icmpReply++;
      stamp({ event: "guest-ip", proto: "icmp", type: icmpType, src: sip, dst: dip, note: icmpType === 0 ? "ECHO REPLY" : "type " + icmpType });
    } else if (proto === 6) {
      const ihl = (f[14] & 0x0f) * 4;
      const t = 14 + ihl;
      const sport = (f[t] << 8) | f[t + 1];
      const flags = f[t + 13];
      const synack = (flags & 0x12) === 0x12;
      const rst = (flags & 0x04) === 0x04;
      const state = synack ? "SYN-ACK (open)" : rst ? "RST (closed)" : "flags 0x" + flags.toString(16);
      if (synack && !tcpOpen.includes(sport)) tcpOpen.push(sport);
      stamp({ event: "guest-tcp", port: sport, state, src: sip, dst: dip });
    } else {
      stamp({ event: "guest-ip", proto: { 17: "udp" }[proto] || proto, src: sip, dst: dip });
    }
  } else {
    seen.other++;
  }
}

async function main() {
  ws = new WebSocket(opts.relayWs);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); }, { once: true });
  });
  ws.send(JSON.stringify({ type: "init", macAddress: opts.myMac, zone: opts.zone }));
  ws.addEventListener("message", (event) => {
    let m;
    try { m = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (m && m.type === "receive" && typeof m.packetArray === "string") {
      onFrame(new Uint8Array(Buffer.from(m.packetArray, "base64")));
    }
  });
  stamp({ event: "prober-ready", zone: opts.zone, relay: opts.relayWs });

  // Wait for the guest interface to come up (gratuitous ARP).
  const deadline = Date.now() + opts.waitMs;
  while (!sawGratuitous && Date.now() < deadline) await delay(2000);
  if (!sawGratuitous) {
    stamp({ event: "timeout", message: "never saw guest gratuitous ARP; is the guest booted with net=1&netZone=" + opts.zone + "?" });
    guestMac = "08:00:07:0a:0b:0c"; // fall back to the known configured MAC
    stamp({ event: "probe-anyway", guestMac });
  }
  await delay(1500);

  // 1) ARP request: who-has <guestIp> tell myIp (broadcast). Expect a reply.
  stamp({ event: "send-arp-request", who: opts.guestIp, tell: opts.myIp });
  for (let n = 0; n < 3; n++) {
    send(craftArp(1, opts.myMac, opts.myIp, "00:00:00:00:00:00", opts.guestIp, "*"), "*");
    await delay(600);
  }
  await delay(1500);

  // 2) Teach the guest my MAC (gratuitous ARP for myIp), then ICMP echo.
  stamp({ event: "announce-self", ip: opts.myIp, mac: opts.myMac });
  send(craftArp(2, opts.myMac, opts.myIp, guestMac, opts.guestIp, guestMac), guestMac);
  await delay(800);
  stamp({ event: "send-icmp-echo", from: opts.myIp, to: opts.guestIp });
  for (let n = 0; n < 4; n++) {
    send(craftIcmpEcho(opts.myMac, guestMac, opts.myIp, opts.guestIp, 0xc89e, n + 1), guestMac);
    await delay(800);
  }

  await delay(2000);

  // 3) TCP SYN scan: which services does A/UX listen on? SYN-ACK => open.
  stamp({ event: "tcp-scan", ports: opts.tcpPorts });
  let sport = 40000;
  for (const port of opts.tcpPorts) {
    send(craftTcpSyn(opts.myMac, guestMac, opts.myIp, opts.guestIp, sport++, port), guestMac);
    await delay(700);
  }
  await delay(3000);

  stamp({ event: "summary", sawGratuitous, guestMac, arpReplies: seen.arpReply,
    icmpReplies: seen.icmpReply, tcpOpenPorts: tcpOpen });
  try { ws.close(); } catch {}
}

main().catch((e) => { stamp({ event: "fatal", message: String(e && e.message ? e.message : e) }); process.exit(1); });
