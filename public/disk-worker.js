/*
 * Dedicated disk-I/O worker for the lazy A/UX disk (browser-qemu Phase 1).
 *
 * The QEMU pthread writes a read request into a shared control buffer and
 * blocks on Atomics.wait; this worker fetches the bytes (128 KB aligned
 * chunks, LRU-cached) and hands them back through a shared data buffer.
 * The page main thread is never on the disk path, which removes the
 * sync-XHR boot-wedge class documented in ROADMAP Phase 0.5.
 *
 * Transports:
 *   http      range GETs against the static disk image (default)
 *   dialtone  the 68k_web Go relay binary block protocol over WebSocket
 *             (6-byte big-endian header: type u8, requestId u16, len u24)
 */
"use strict";

const CTRL = {
  LOCK: 0,
  STATE: 1, // 0 idle, 1 requested, 2 done, 3 error
  OFF_LO: 2,
  OFF_HI: 3,
  REQ_LEN: 4,
  RES_LEN: 5,
  ERR: 6,
  DISK_FD: 7,
  SIZE_LO: 8,
  SIZE_HI: 9,
  READY: 10,
};

const DIALTONE = {
  MsgReadRequest: 0x01,
  MsgReadResponse: 0x02,
  MsgWriteRequest: 0x03,
  MsgWriteAck: 0x04,
  MsgPrefetchPush: 0x05,
  MsgPrefetchHint: 0x06,
  MsgInit: 0x07,
  MsgInitAck: 0x08,
};

let ctrl = null;
let data = null;
let transport = null;
let diskSize = 0;
let chunkSize = 128 * 1024;
let cacheCapBytes = 512 * 1024 * 1024;

const cache = new Map(); // chunkId -> Uint8Array, Map order doubles as LRU
let cacheBytes = 0;

const stats = {
  requests: 0,
  servedBytes: 0,
  cacheHitRequests: 0,
  fetches: 0,
  fetchedBytes: 0,
  prefetchPushes: 0,
  prefetchBytes: 0,
  evictedChunks: 0,
  errors: 0,
};

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "init") {
    init(msg).catch((error) => {
      stats.errors += 1;
      postMessage({ type: "init-error", error: String((error && error.message) || error) });
    });
  } else if (msg.type === "stats") {
    postMessage({ type: "stats", stats: snapshotStats() });
  }
};

function snapshotStats() {
  return Object.assign({ cacheBytes, cacheChunks: cache.size, diskSize }, stats);
}

async function init(msg) {
  ctrl = new Int32Array(msg.control);
  data = new Uint8Array(msg.data);
  chunkSize = msg.chunkBytes || chunkSize;
  cacheCapBytes = (msg.cacheMb || 512) * 1024 * 1024;

  transport = msg.transport === "dialtone" ? makeDialtoneTransport(msg) : makeHttpTransport(msg);
  diskSize = await transport.size();
  if (!Number.isFinite(diskSize) || diskSize <= 0) {
    throw new Error(`bad disk size ${diskSize}`);
  }

  Atomics.store(ctrl, CTRL.SIZE_LO, diskSize % 4294967296 | 0);
  Atomics.store(ctrl, CTRL.SIZE_HI, Math.floor(diskSize / 4294967296));
  Atomics.store(ctrl, CTRL.READY, 1);
  postMessage({ type: "ready", diskSize, transport: msg.transport || "http", chunkBytes: chunkSize });

  setInterval(() => postMessage({ type: "stats", stats: snapshotStats() }), msg.statsMs || 30000);
  pump();
}

async function pump() {
  for (;;) {
    const state = Atomics.load(ctrl, CTRL.STATE);
    if (state === 1) {
      await handleRequest();
      continue;
    }
    const wait = Atomics.waitAsync(ctrl, CTRL.STATE, state);
    if (wait.async) await wait.value;
  }
}

async function handleRequest() {
  const lo = Atomics.load(ctrl, CTRL.OFF_LO) >>> 0;
  const hi = Atomics.load(ctrl, CTRL.OFF_HI) >>> 0;
  const offset = hi * 4294967296 + lo;
  const requested = Atomics.load(ctrl, CTRL.REQ_LEN) >>> 0;
  const length = Math.min(requested, data.length, Math.max(0, diskSize - offset));
  let nextState = 2;

  try {
    const bytes = await read(offset, length);
    data.set(bytes, 0);
    Atomics.store(ctrl, CTRL.RES_LEN, bytes.length);
    stats.requests += 1;
    stats.servedBytes += bytes.length;
  } catch (error) {
    stats.errors += 1;
    console.error("disk-worker: read failed", offset, length, error);
    Atomics.store(ctrl, CTRL.ERR, 1);
    Atomics.store(ctrl, CTRL.RES_LEN, 0);
    nextState = 3;
  }

  Atomics.store(ctrl, CTRL.STATE, nextState);
  Atomics.notify(ctrl, CTRL.STATE);
}

async function read(offset, length) {
  if (length <= 0) return new Uint8Array(0);
  const firstChunk = Math.floor(offset / chunkSize);
  const lastChunk = Math.floor((offset + length - 1) / chunkSize);

  let missing = false;
  for (let id = firstChunk; id <= lastChunk; id += 1) {
    if (!cache.has(id)) {
      missing = true;
      break;
    }
  }
  if (missing) {
    await transport.fill(firstChunk, lastChunk);
  } else {
    stats.cacheHitRequests += 1;
  }

  const out = new Uint8Array(length);
  for (let id = firstChunk; id <= lastChunk; id += 1) {
    const chunk = touchChunk(id);
    if (!chunk) throw new Error(`chunk ${id} missing after fill`);
    const chunkStart = id * chunkSize;
    const copyFrom = Math.max(offset, chunkStart);
    const copyTo = Math.min(offset + length, chunkStart + chunk.length);
    if (copyTo <= copyFrom) {
      // Short chunk at EOF; nothing more to copy.
      return out.subarray(0, copyFrom - offset);
    }
    out.set(chunk.subarray(copyFrom - chunkStart, copyTo - chunkStart), copyFrom - offset);
  }
  return out;
}

function touchChunk(id) {
  const chunk = cache.get(id);
  if (chunk) {
    cache.delete(id);
    cache.set(id, chunk);
  }
  return chunk || null;
}

function insertChunk(id, bytes) {
  const existing = cache.get(id);
  if (existing) {
    cacheBytes -= existing.length;
    cache.delete(id);
  }
  cache.set(id, bytes);
  cacheBytes += bytes.length;
  while (cacheBytes > cacheCapBytes && cache.size > 1) {
    const oldest = cache.keys().next().value;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= evicted.length;
    stats.evictedChunks += 1;
  }
}

function insertSpan(firstChunk, bytes) {
  for (let i = 0; i * chunkSize < bytes.length; i += 1) {
    insertChunk(firstChunk + i, bytes.slice(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length)));
  }
}

function makeHttpTransport(msg) {
  return {
    async size() {
      if (msg.size) return msg.size;
      const response = await fetch(msg.url, { method: "HEAD" });
      if (!response.ok) throw new Error(`HEAD ${msg.url} -> ${response.status}`);
      return Number(response.headers.get("Content-Length"));
    },
    async fill(firstChunk, lastChunk) {
      const start = firstChunk * chunkSize;
      const end = Math.min((lastChunk + 1) * chunkSize, diskSize) - 1;
      const response = await fetch(msg.url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!(response.status === 206 || response.ok)) {
        throw new Error(`range ${start}-${end} -> ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status !== 206 && bytes.length !== end - start + 1) {
        throw new Error(`server ignored Range header (${bytes.length} bytes for ${end - start + 1})`);
      }
      insertSpan(firstChunk, bytes);
      stats.fetches += 1;
      stats.fetchedBytes += bytes.length;
    },
  };
}

function makeDialtoneTransport(msg) {
  let socket = null;
  let socketReady = null;
  let nextRequestId = 1;
  const pending = new Map(); // requestId -> { resolve, reject }

  function takeRequestId() {
    const id = nextRequestId;
    nextRequestId = (nextRequestId + 1) & 0xffff || 1;
    return id;
  }

  function frame(type, requestId, payload) {
    const out = new Uint8Array(6 + payload.length);
    out[0] = type;
    out[1] = (requestId >> 8) & 0xff;
    out[2] = requestId & 0xff;
    out[3] = (payload.length >> 16) & 0xff;
    out[4] = (payload.length >> 8) & 0xff;
    out[5] = payload.length & 0xff;
    out.set(payload, 6);
    return out;
  }

  function connect() {
    if (socketReady) return socketReady;
    socketReady = new Promise((resolve, reject) => {
      const ws = new WebSocket(msg.wsUrl);
      ws.binaryType = "arraybuffer";
      const initId = takeRequestId();

      ws.onopen = () => {
        const name = new TextEncoder().encode(msg.diskName);
        const payload = new Uint8Array(2 + name.length + 8);
        payload[0] = (name.length >> 8) & 0xff;
        payload[1] = name.length & 0xff;
        payload.set(name, 2);
        // Trailing u64 disk size is informational; zero is accepted.
        ws.send(frame(DIALTONE.MsgInit, initId, payload));
      };
      ws.onmessage = (event) => {
        const bytes = new Uint8Array(event.data);
        const type = bytes[0];
        const requestId = (bytes[1] << 8) | bytes[2];
        const payloadLength = (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
        const payload = bytes.subarray(6, 6 + payloadLength);

        if (type === DIALTONE.MsgInitAck) {
          socket = ws;
          resolve(ws);
        } else if (type === DIALTONE.MsgReadResponse) {
          const waiter = pending.get(requestId);
          if (waiter) {
            pending.delete(requestId);
            waiter.resolve(payload.slice());
          }
        } else if (type === DIALTONE.MsgPrefetchPush) {
          const chunkId = (payload[0] << 24 >>> 0) + (payload[1] << 16) + (payload[2] << 8) + payload[3];
          if (!cache.has(chunkId)) {
            insertChunk(chunkId, payload.slice(4));
            stats.prefetchPushes += 1;
            stats.prefetchBytes += payload.length - 4;
          }
        }
      };
      ws.onerror = () => reject(new Error(`dialtone websocket error (${msg.wsUrl})`));
      ws.onclose = () => {
        socket = null;
        socketReady = null;
        const waiters = Array.from(pending.values());
        pending.clear();
        for (const waiter of waiters) waiter.reject(new Error("dialtone websocket closed"));
      };
    });
    return socketReady;
  }

  async function readRange(offset, length) {
    const ws = socket || (await connect());
    const requestId = takeRequestId();
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setUint32(0, Math.floor(offset / 4294967296));
    view.setUint32(4, offset % 4294967296);
    view.setUint32(8, length);
    const result = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error(`dialtone read timeout offset=${offset} len=${length}`));
        }
      }, msg.readTimeoutMs || 30000);
    });
    ws.send(frame(DIALTONE.MsgReadRequest, requestId, payload));
    return result;
  }

  return {
    async size() {
      if (msg.size) return msg.size;
      const infoUrl = msg.infoUrl || `${msg.httpBase}/disk/info?name=${encodeURIComponent(msg.diskName)}`;
      const response = await fetch(infoUrl);
      if (!response.ok) throw new Error(`disk info ${infoUrl} -> ${response.status}`);
      const info = await response.json();
      const size = info.size || info.diskSize || info.length;
      if (!size) throw new Error(`disk info has no size field: ${JSON.stringify(info)}`);
      return Number(size);
    },
    async fill(firstChunk, lastChunk) {
      const reads = [];
      for (let id = firstChunk; id <= lastChunk; id += 1) {
        if (cache.has(id)) continue;
        const start = id * chunkSize;
        const length = Math.min(chunkSize, diskSize - start);
        reads.push(
          readRange(start, length).then((bytes) => {
            insertChunk(id, bytes);
            stats.fetches += 1;
            stats.fetchedBytes += bytes.length;
          })
        );
      }
      await Promise.all(reads);
    },
  };
}
