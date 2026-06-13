#!/usr/bin/env node
/*
 * Patch the Emscripten out.js so guest disk preads are served inside the
 * QEMU pthread from a SharedArrayBuffer filled by the dedicated disk worker
 * (public/disk-worker.js), instead of proxying every read to the page main
 * thread where it became a synchronous XHR (the Phase 0.5 boot-wedge class).
 *
 * Idempotent, in the same style as patch-qemu-out-js-lazyfile.mjs. Run it
 * after that script; it patches:
 *   1. a c89Disk helper block injected ahead of _fd_pread
 *   2. _fd_pread's pthread branch (serve from SAB, else fall through)
 *   3. ___syscall_openat's pthread branch (track the disk fd)
 *   4. _fd_close (untrack the disk fd)
 *   5. PThread's worker 'load' postMessage (hand the SABs to each realm)
 */
import fs from "node:fs";

const file = process.argv[2];

if (!file) {
  console.error("usage: patch-qemu-out-js-diskworker.mjs /path/to/out.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");
let patched = false;

const helperBlock = `/* c89 disk worker bridge (browser-qemu Phase 1): serve guest disk preads
   from a dedicated disk worker through SharedArrayBuffers so the page main
   thread is never on the disk path. Slot layout matches disk-worker.js. */
var C89D_LOCK = 0, C89D_STATE = 1, C89D_OFF_LO = 2, C89D_OFF_HI = 3,
    C89D_REQ_LEN = 4, C89D_RES_LEN = 5, C89D_ERR = 6, C89D_DISK_FD = 7,
    C89D_SIZE_LO = 8, C89D_SIZE_HI = 9, C89D_READY = 10;

function c89DiskCtrl() {
 var disk = Module["c89Disk"];
 if (!disk || !disk.control) return null;
 if (!disk.ctrlView) disk.ctrlView = new Int32Array(disk.control);
 return disk.ctrlView;
}

function c89DiskDataView() {
 var disk = Module["c89Disk"];
 if (!disk.dataView) disk.dataView = new Uint8Array(disk.data);
 return disk.dataView;
}

function c89DiskTrackOpen(fd, pathPtr) {
 try {
  var c = c89DiskCtrl();
  if (c && fd >= 0 && UTF8ToString(pathPtr) === Module["c89Disk"].guestPath) {
   Atomics.store(c, C89D_DISK_FD, fd);
   err("c89disk: tracking guest disk fd " + fd);
  }
 } catch (e) {}
 return fd;
}

function c89DiskTrackClose(fd) {
 var c = c89DiskCtrl();
 if (c && Atomics.load(c, C89D_DISK_FD) === fd) {
  Atomics.store(c, C89D_DISK_FD, -1);
  err("c89disk: guest disk fd " + fd + " closed");
 }
}

function c89DiskTryPread(fd, iov, iovcnt, offset, pnum) {
 var c = c89DiskCtrl();
 if (!c || Atomics.load(c, C89D_READY) !== 1) return null;
 if (Atomics.load(c, C89D_DISK_FD) !== fd) return null;
 var pos = bigintToI53Checked(offset);
 if (isNaN(pos)) return 61;
 var size = (Atomics.load(c, C89D_SIZE_HI) >>> 0) * 4294967296 + (Atomics.load(c, C89D_SIZE_LO) >>> 0);
 var dataBuf = c89DiskDataView();
 var total = 0;
 var hitEof = false;
 while (Atomics.compareExchange(c, C89D_LOCK, 0, 1) !== 0) Atomics.wait(c, C89D_LOCK, 1);
 try {
  for (var i = 0; i < iovcnt && !hitEof; i++) {
   var ptr = HEAPU32[(iov + i * 8) >> 2];
   var len = HEAPU32[(iov + i * 8 + 4) >> 2];
   var done = 0;
   while (done < len) {
    var at = pos + total + done;
    if (at >= size) { hitEof = true; break; }
    var want = Math.min(len - done, dataBuf.length, size - at);
    Atomics.store(c, C89D_OFF_LO, at % 4294967296 | 0);
    Atomics.store(c, C89D_OFF_HI, Math.floor(at / 4294967296));
    Atomics.store(c, C89D_REQ_LEN, want);
    Atomics.store(c, C89D_ERR, 0);
    Atomics.store(c, C89D_STATE, 1);
    Atomics.notify(c, C89D_STATE);
    var waits = 0;
    while (Atomics.load(c, C89D_STATE) === 1) {
     if (Atomics.wait(c, C89D_STATE, 1, 60000) === "timed-out" && Atomics.load(c, C89D_STATE) === 1) {
      waits++;
      err("c89disk: disk worker still busy after " + waits + " min (offset=" + at + " len=" + want + ")");
      if (waits >= 5) {
       Atomics.store(c, C89D_STATE, 0);
       throw new Error("disk worker unresponsive");
      }
     }
    }
    var state = Atomics.load(c, C89D_STATE);
    var got = Atomics.load(c, C89D_RES_LEN);
    Atomics.store(c, C89D_STATE, 0);
    if (state !== 2) throw new Error("disk worker error " + Atomics.load(c, C89D_ERR));
    if (got > 0) {
     HEAPU8.set(dataBuf.subarray(0, got), ptr + done);
     done += got;
    }
    if (got < want) { hitEof = true; break; }
   }
   total += done;
  }
 } catch (e) {
  err("c89disk: worker pread failed, falling back to proxied read: " + (e && e.message ? e.message : e));
  Atomics.store(c, C89D_LOCK, 0);
  Atomics.notify(c, C89D_LOCK, 1);
  return null;
 }
 Atomics.store(c, C89D_LOCK, 0);
 Atomics.notify(c, C89D_LOCK, 1);
 HEAPU32[pnum >> 2] = total;
 return 0;
}
`;

const preadPattern = /function _fd_pread\(fd, iov, iovcnt, offset, pnum\) \{\s*\n\s*if \(ENVIRONMENT_IS_PTHREAD\)\s*\n\s*return proxyToMainThread\((\d+), 1, fd, iov, iovcnt, offset, pnum\);/;

if (source.includes("function c89DiskTryPread(")) {
  // Helper block already present.
} else if (preadPattern.test(source)) {
  source = source.replace(preadPattern, (match, opcode) => `${helperBlock}
  function _fd_pread(fd, iov, iovcnt, offset, pnum) {
  if (ENVIRONMENT_IS_PTHREAD) {
    var c89r = c89DiskTryPread(fd, iov, iovcnt, offset, pnum);
    if (c89r !== null) return c89r;
    return proxyToMainThread(${opcode}, 1, fd, iov, iovcnt, offset, pnum);
  }`);
  patched = true;
} else {
  console.error(`${file}: _fd_pread pthread marker not found`);
  process.exit(1);
}

const openatPattern = /(function ___syscall_openat\(dirfd, path, flags, varargs\) \{\s*\n\s*if \(ENVIRONMENT_IS_PTHREAD\)\s*\n\s*return )proxyToMainThread\((\d+), 1, dirfd, path, flags, varargs\);/;

if (source.includes("c89DiskTrackOpen(proxyToMainThread(")) {
  // Already patched.
} else if (openatPattern.test(source)) {
  source = source.replace(openatPattern, (match, head, opcode) =>
    `${head}c89DiskTrackOpen(proxyToMainThread(${opcode}, 1, dirfd, path, flags, varargs), path);`);
  patched = true;
} else {
  console.error(`${file}: ___syscall_openat pthread marker not found`);
  process.exit(1);
}

const closePattern = /function _fd_close\(fd\) \{\s*\n\s*if \(ENVIRONMENT_IS_PTHREAD\)/;

if (source.includes("c89DiskTrackClose(fd);")) {
  // Already patched.
} else if (closePattern.test(source)) {
  source = source.replace(closePattern, `function _fd_close(fd) {
  c89DiskTrackClose(fd);
  if (ENVIRONMENT_IS_PTHREAD)`);
  patched = true;
} else {
  console.error(`${file}: _fd_close marker not found`);
  process.exit(1);
}

const loadMessageLines = `          'wasmMemory': wasmMemory,
          'wasmModule': wasmModule,
        });`;
const loadMessageReplacement = `          'wasmMemory': wasmMemory,
          'wasmModule': wasmModule,
          'c89Disk': Module['c89Disk'] ? {
            control: Module['c89Disk'].control,
            data: Module['c89Disk'].data,
            guestPath: Module['c89Disk'].guestPath
          } : null,
        });`;

if (source.includes("'c89Disk': Module['c89Disk']")) {
  // Already patched.
} else if (source.includes(loadMessageLines)) {
  source = source.replace(loadMessageLines, loadMessageReplacement);
  patched = true;
} else {
  console.error(`${file}: pthread load postMessage marker not found`);
  process.exit(1);
}

if (patched) {
  fs.writeFileSync(file, source);
  console.log(`patched disk-worker SAB pread bridge into ${file}`);
} else {
  console.log(`disk-worker patch already present in ${file}`);
}
