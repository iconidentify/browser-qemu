/*
 * Page-side ethernet bridge for browser-qemu (Phase 1).
 *
 * The wasmbridge net backend (net/wasmbridge.c) exposes two SPSC ring buffers
 * in wasm linear memory (a SharedArrayBuffer). This module, running on the page
 * main thread, drains the guest's TX ring and forwards each L2 frame to the
 * dialtone relay over its /ethernet WebSocket (JSON text, base64 packetArray),
 * and writes frames the relay delivers into the RX ring for the QEMU thread's
 * timer to inject into the guest.
 *
 * All work here is non-blocking: Atomics.waitAsync for TX wakeups (the C side
 * calls emscripten_futex_wake), async WebSocket I/O, and small memcpys. No
 * synchronous blocking on the main thread.
 *
 * Shared-block layout (must match net/wasmbridge.c):
 *   [ ctrl: 16 x int32 ][ tx ring: SLOTS x STRIDE ][ rx ring: SLOTS x STRIDE ]
 *   each ring slot: [ u32 len LE ][ payload ]
 */
(function (root) {
  "use strict";

  var WN_MAGIC = 0xc89e7001;
  var WN_NCTRL = 16;
  // ctrl int32 slot indices
  var C_MAGIC = 0, C_TX_WRITE = 1, C_TX_READ = 2, C_RX_WRITE = 3,
      C_RX_READ = 4, C_READY = 5, C_TX_DROP = 6, C_RX_DROP = 7,
      C_SLOTS = 8, C_STRIDE = 9, C_MAXFRAME = 10;

  function bytesToBase64(bytes) {
    var s = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(s);
  }

  function base64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function macStr(b, o) {
    var p = [];
    for (var i = 0; i < 6; i++) p.push((b[o + i] | 0x100).toString(16).slice(1));
    return p.join(":");
  }

  // module: the resolved QEMU Module (window.AuxQemu). Must expose
  // c89NetSharedPtr() and HEAP32/HEAPU8 over the wasm memory.
  root.createAuxNetBridge = function (options) {
    var module = options.module;
    var wsUrl = options.wsUrl;
    var mac = options.mac;
    var zone = options.zone || "";
    var log = options.log || function () {};

    var ws = null;
    var running = false;
    var inited = false;
    var base = 0, ctrlBase = 0, txRingOff = 0, rxRingOff = 0;
    var slots = 0, stride = 0, maxFrame = 0;
    var heap = null, ctrl = null;
    var txReadLocal = 0;
    var backstopTimer = 0;
    var stats = { tx: 0, txBytes: 0, rx: 0, rxBytes: 0, txDrops: 0, rxDrops: 0 };

    function locate() {
      if (typeof module.c89NetSharedPtr !== "function") {
        throw new Error("wasmbridge export missing (rebuild with the net backend, launch with net=1)");
      }
      base = module.c89NetSharedPtr() >>> 0;
      if (!base) throw new Error("wasmbridge shared block address is 0");
      heap = module.HEAPU8;
      ctrl = module.HEAP32;
      ctrlBase = base >> 2;
      var magic = ctrl[ctrlBase + C_MAGIC] >>> 0;
      if (magic !== WN_MAGIC) {
        throw new Error("wasmbridge magic mismatch 0x" + magic.toString(16) + " (backend not ready)");
      }
      slots = ctrl[ctrlBase + C_SLOTS];
      stride = ctrl[ctrlBase + C_STRIDE];
      maxFrame = ctrl[ctrlBase + C_MAXFRAME];
      txRingOff = base + WN_NCTRL * 4;
      rxRingOff = txRingOff + slots * stride;
      // Start draining from the backend's current TX write index so we do not
      // replay frames the guest sent before we connected.
      txReadLocal = Atomics.load(ctrl, ctrlBase + C_TX_WRITE);
      Atomics.store(ctrl, ctrlBase + C_TX_READ, txReadLocal);
    }

    function readFrame(ringOff, slot) {
      var off = ringOff + slot * stride;
      var len = heap[off] | (heap[off + 1] << 8) | (heap[off + 2] << 16) | (heap[off + 3] << 24);
      if (len <= 0 || len > maxFrame) return null;
      return heap.slice(off + 4, off + 4 + len);
    }

    function pumpTx() {
      if (!running) return;
      var wIdx = ctrlBase + C_TX_WRITE;
      var w = Atomics.load(ctrl, wIdx);
      while (txReadLocal !== w) {
        var frame = readFrame(txRingOff, (txReadLocal >>> 0) % slots);
        if (frame) sendFrame(frame);
        txReadLocal = (txReadLocal + 1) | 0;
        Atomics.store(ctrl, ctrlBase + C_TX_READ, txReadLocal);
      }
      var res = Atomics.waitAsync(ctrl, wIdx, w);
      if (res.async) {
        res.value.then(pumpTx);
      } else {
        // value changed between load and wait; re-drain on next microtask.
        Promise.resolve().then(pumpTx);
      }
    }

    function sendFrame(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        stats.txDrops++;
        return;
      }
      var dst = macStr(frame, 0);
      var destination = dst === "ff:ff:ff:ff:ff:ff" ? "*" : dst;
      ws.send(JSON.stringify({
        type: "send",
        destination: destination,
        packetArray: bytesToBase64(frame),
      }));
      stats.tx++;
      stats.txBytes += frame.length;
    }

    function injectToGuest(bytes) {
      if (!bytes || bytes.length === 0 || bytes.length > maxFrame) {
        stats.rxDrops++;
        return;
      }
      var wIdx = ctrlBase + C_RX_WRITE;
      var rIdx = ctrlBase + C_RX_READ;
      var w = Atomics.load(ctrl, wIdx);
      var r = Atomics.load(ctrl, rIdx);
      if (((w - r) >>> 0) >= slots) {
        stats.rxDrops++; // ring full; guest not draining
        return;
      }
      var off = rxRingOff + ((w >>> 0) % slots) * stride;
      heap[off] = bytes.length & 0xff;
      heap[off + 1] = (bytes.length >> 8) & 0xff;
      heap[off + 2] = (bytes.length >> 16) & 0xff;
      heap[off + 3] = (bytes.length >> 24) & 0xff;
      heap.set(bytes, off + 4);
      Atomics.store(ctrl, wIdx, (w + 1) | 0); // publish (C timer polls this)
      stats.rx++;
      stats.rxBytes += bytes.length;
    }

    function onMessage(event) {
      var msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch (e) {
        return;
      }
      if (msg && msg.type === "receive" && typeof msg.packetArray === "string") {
        injectToGuest(base64ToBytes(msg.packetArray));
      }
    }

    return {
      start: function () {
        if (running) return;
        locate();
        inited = true;
        ws = new WebSocket(wsUrl);
        ws.onopen = function () {
          var init = { type: "init", macAddress: mac };
          if (zone) init.zone = zone;
          ws.send(JSON.stringify(init));
          running = true;
          log("net bridge connected: " + wsUrl + " mac=" + mac + (zone ? " zone=" + zone : ""));
          pumpTx();
          backstopTimer = root.setInterval(pumpTx, 250); // missed-wake backstop
          if (options.onOpen) options.onOpen();
        };
        ws.onmessage = onMessage;
        ws.onerror = function () {
          log("net bridge websocket error");
          if (options.onError) options.onError();
        };
        ws.onclose = function () {
          running = false;
          if (backstopTimer) { root.clearInterval(backstopTimer); backstopTimer = 0; }
          log("net bridge websocket closed");
          if (options.onClose) options.onClose();
        };
      },
      stop: function () {
        running = false;
        if (backstopTimer) { root.clearInterval(backstopTimer); backstopTimer = 0; }
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      },
      isRunning: function () { return running; },
      stats: function () {
        if (inited && ctrl) {
          stats.txDropsBackend = Atomics.load(ctrl, ctrlBase + C_TX_DROP);
          stats.rxDropsBackend = Atomics.load(ctrl, ctrlBase + C_RX_DROP);
        }
        return stats;
      },
    };
  };
})(typeof window !== "undefined" ? window : globalThis);
