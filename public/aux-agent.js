/*
 * In-page A/UX agent client (browser-qemu).
 *
 * Speaks AAP (the A/UX Agent Protocol -- HTTP/1.0 over TCP; source
 * ~/se30/auxagent) to the auxagent server running INSIDE the guest, so the web
 * app itself can run commands and move files in A/UX. There is no real IP route
 * to the guest -- the wasmbridge ethernet bridge + relay zone is an L2 overlay
 * -- so this opens its OWN relay /ethernet WebSocket as a zone peer (a second
 * client alongside the guest's NIC bridge) and runs a minimal userspace TCP
 * client over raw L2 frames. Mirrors scripts/auxctl-zone.mjs.
 *
 * Requires the guest booted with ?net=1 (wasmbridge NIC) and the agent peer in
 * the SAME relay zone as the guest's bridge (app.js shares one zone id).
 */
(function (root) {
  "use strict";

  const ipBytes = (s) => s.split(".").map((n) => parseInt(n, 10));
  const macBytes = (s) => s.split(":").map((h) => parseInt(h, 16));
  const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

  function checksum16(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 2) {
      sum += (bytes[i] << 8) | (i + 1 < bytes.length ? bytes[i + 1] : 0);
    }
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return (~sum) & 0xffff;
  }

  // CRC-32 (IEEE 802.3) to verify /file transfers, matching the agent.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32hex(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }

  function bytesToB64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function strToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

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
  function craftTcp(o, srcPort, dstPort, seq, ack, flags, payload) {
    payload = payload || new Uint8Array(0);
    const tcp = new Uint8Array(20 + payload.length);
    tcp.set(be16(srcPort), 0);
    tcp.set(be16(dstPort), 2);
    tcp.set(be32(seq >>> 0), 4);
    tcp.set(be32(ack >>> 0), 8);
    tcp[12] = 0x50;
    tcp[13] = flags;
    tcp.set(be16(0x2000), 14);
    tcp.set(payload, 20);
    const pseudo = new Uint8Array(12 + tcp.length);
    pseudo.set(ipBytes(o.myIp), 0);
    pseudo.set(ipBytes(o.guestIp), 4);
    pseudo[9] = 6;
    pseudo.set(be16(tcp.length), 10);
    pseudo.set(tcp, 12);
    tcp.set(be16(checksum16(pseudo)), 16);

    const ip = new Uint8Array(20 + tcp.length);
    ip[0] = 0x45;
    ip.set(be16(ip.length), 2);
    ip.set(be16(0x1200 + (seq & 0xff)), 4);
    ip[8] = 64; ip[9] = 6;
    ip.set(ipBytes(o.myIp), 12);
    ip.set(ipBytes(o.guestIp), 16);
    ip.set(be16(checksum16(ip.subarray(0, 20))), 10);
    ip.set(tcp, 20);

    const f = new Uint8Array(14 + ip.length);
    f.set(ethHeader(o.guestMac, o.myMac, 0x0800), 0);
    f.set(ip, 14);
    return f;
  }
  function parseTcp(f, o) {
    if (f.length < 14 || ((f[12] << 8) | f[13]) !== 0x0800 || f[23] !== 6) return null;
    const ihl = (f[14] & 0x0f) * 4;
    const t = 14 + ihl;
    if (f.length < t + 20) return null;
    const dataOff = (f[t + 12] >> 4) * 4;
    const ipTotal = (f[16] << 8) | f[17];
    return {
      srcPort: (f[t] << 8) | f[t + 1],
      dstPort: (f[t + 2] << 8) | f[t + 3],
      seq: ((f[t + 4] << 24) | (f[t + 5] << 16) | (f[t + 6] << 8) | f[t + 7]) >>> 0,
      flags: f[t + 13],
      payload: f.subarray(t + dataOff, Math.min(14 + ipTotal, f.length)),
    };
  }

  function findHeaderEnd(buf) {
    for (let i = 3; i < buf.length; i++) {
      if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) return i + 1;
    }
    return -1;
  }
  function decodeLatin1(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return s;
  }
  function parseHttp(buf) {
    const he = findHeaderEnd(buf);
    if (he < 0) return null;
    const headerText = decodeLatin1(buf.subarray(0, he));
    const m = /content-length:\s*(\d+)/i.exec(headerText);
    if (!m) return { complete: false, headerEnd: he, length: null };
    return { complete: buf.length >= he + parseInt(m[1], 10), headerEnd: he, length: parseInt(m[1], 10) };
  }
  function buildResponse(buf) {
    const he = findHeaderEnd(buf);
    const headerText = decodeLatin1(he < 0 ? buf : buf.subarray(0, he));
    const lines = headerText.split("\r\n").filter(Boolean);
    const status = parseInt((lines[0] || "").split(" ")[1] || "0", 10);
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
    }
    return { status, headers, body: he < 0 ? new Uint8Array(0) : buf.subarray(he) };
  }

  root.createAuxAgent = function (options) {
    const o = {
      wsUrl: options.wsUrl,
      zone: options.zone || "aux",
      guestIp: options.guestIp || "10.1.1.20",
      guestMac: options.guestMac || "08:00:07:0a:0b:0c",
      myIp: options.myIp || "10.1.1.9",
      myMac: options.myMac || "02:00:00:00:00:09",
      port: options.port || 8377,
      token: options.token || "",
    };
    const log = options.log || function () {};

    let ws = null;
    let ready = false;
    let active = null;     // current in-flight request's segment handler
    let queue = Promise.resolve();

    function ensureConnected() {
      if (ready && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        ws = new WebSocket(o.wsUrl);
        const t = setTimeout(() => reject(new Error("agent relay ws timeout")), 8000);
        ws.onopen = () => {
          clearTimeout(t);
          ws.send(JSON.stringify({ type: "init", macAddress: o.myMac, zone: o.zone }));
          ready = true;
          log(`aux agent peer connected (zone=${o.zone}, ${o.myIp} -> ${o.guestIp}:${o.port})`);
          resolve();
        };
        ws.onerror = () => { clearTimeout(t); reject(new Error("agent relay ws error")); };
        ws.onclose = () => { ready = false; };
        ws.onmessage = (event) => {
          let m;
          try { m = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
          if (m && m.type === "receive" && typeof m.packetArray === "string" && active) {
            const seg = parseTcp(b64ToBytes(m.packetArray), o);
            if (seg) active(seg);
          }
        };
      });
    }

    function send(frame, destination) {
      ws.send(JSON.stringify({ type: "send", destination, packetArray: bytesToB64(frame) }));
    }

    // One AAP request over a fresh userspace TCP connection through the zone.
    function request(method, path, headers, body) {
      body = body || new Uint8Array(0);
      const run = () => new Promise((resolve, reject) => {
        const sport = 40000 + (Date.now() % 20000);
        const iss = 0x30000000;
        let snd = iss, rcv = 0, gotSynAck = false, established = false, finSeen = false, settled = false;
        const rx = [];

        const hdrLines = [`${method} ${path} HTTP/1.0`, `Host: ${o.guestIp}`];
        if (o.token) hdrLines.push(`X-Aap-Token: ${o.token}`);
        for (const [k, v] of Object.entries(headers || {})) hdrLines.push(`${k}: ${v}`);
        hdrLines.push(`Content-Length: ${body.length}`, "", "");
        const reqBytes = concat([strToBytes(hdrLines.join("\r\n")), body]);

        const tcp = (flags, payload) => craftTcp(o, sport, o.port, snd, rcv, flags, payload);
        let synTimer = 0, doneTimer = 0;
        const finish = (err, val) => {
          if (settled) return;
          settled = true;
          clearInterval(synTimer); clearTimeout(doneTimer);
          active = null;
          err ? reject(err) : resolve(val);
        };

        active = (seg) => {
          if (seg.srcPort !== o.port || seg.dstPort !== sport) return;
          if (seg.flags & 0x04) return finish(new Error("connection reset by guest (RST)"));
          if ((seg.flags & 0x12) === 0x12 && !gotSynAck) {
            gotSynAck = true;
            rcv = (seg.seq + 1) >>> 0;
            snd = (iss + 1) >>> 0;
            established = true;
            send(tcp(0x10), o.guestMac);               // ACK handshake
            send(tcp(0x18, reqBytes), o.guestMac);      // PSH request
            snd = (snd + reqBytes.length) >>> 0;
            return;
          }
          if (!established) return;
          if (seg.payload && seg.payload.length && seg.seq === rcv) {
            rx.push(seg.payload.slice());
            rcv = (rcv + seg.payload.length) >>> 0;
          }
          if (seg.flags & 0x01) { finSeen = true; rcv = (rcv + 1) >>> 0; }
          if ((seg.payload && seg.payload.length) || (seg.flags & 0x01)) send(tcp(0x10), o.guestMac);
          const buf = concat(rx);
          const p = parseHttp(buf);
          if ((p && p.complete) || finSeen) {
            if (!finSeen) { send(tcp(0x11), o.guestMac); snd = (snd + 1) >>> 0; }
            finish(null, buildResponse(buf));
          }
        };

        // Teach the guest our MAC, then SYN with light retransmit.
        send(craftArpReply(o.myMac, o.myIp, o.guestMac, o.guestIp), o.guestMac);
        let tries = 0;
        synTimer = setInterval(() => {
          if (gotSynAck || tries >= 12) { clearInterval(synTimer); return; }
          tries++;
          send(craftTcp(o, sport, o.port, iss, 0, 0x02, null), o.guestMac);
        }, 450);
        send(craftTcp(o, sport, o.port, iss, 0, 0x02, null), o.guestMac);
        doneTimer = setTimeout(() => finish(new Error("AAP request timed out")), 25000);
      });
      // Serialize requests over the single ws/peer.
      const result = queue.then(ensureConnected).then(run);
      queue = result.catch(() => {});
      return result;
    }

    return {
      isConnected: () => ready,
      connect: ensureConnected,
      close() { try { if (ws) ws.close(); } catch (e) {} ws = null; ready = false; },
      async ping() {
        const r = await request("GET", "/ping");
        return { ok: r.status === 200, text: decodeLatin1(r.body).trim(), status: r.status };
      },
      async exec(cmd) {
        const r = await request("POST", "/exec", {}, strToBytes(cmd));
        return { output: decodeLatin1(r.body), exitCode: parseInt(r.headers["x-exit-code"] || "0", 10), status: r.status };
      },
      async getFile(path) {
        const r = await request("GET", "/file" + path);
        if (r.status !== 200) throw new Error(`get ${path} -> ${r.status}`);
        const sum = r.headers["x-aap-sum"];
        if (sum && crc32hex(r.body) !== sum.toLowerCase()) throw new Error("CRC-32 mismatch on " + path);
        return r.body;
      },
      async putFile(path, bytes) {
        const r = await request("PUT", "/file" + path, {}, bytes);
        return { ok: (parseInt(r.headers["x-exit-code"] || "1", 10) === 0), status: r.status };
      },
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
