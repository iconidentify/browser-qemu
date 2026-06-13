#!/usr/bin/env node
/*
 * Decouple QEMU's SDL framebuffer blit from the page main thread.
 *
 * Stock behavior: SDL's software-renderer "copyData" callback runs a full
 * putImageData to the page canvas on every display refresh. Under
 * PROXY_TO_PTHREAD that whole call is proxied synchronously to the browser main
 * thread, so the QEMU worker blocks on a heavy main-thread DOM op every frame.
 * Combined with the worker pegging the CPU, a real (throttled/compositing)
 * browser tab wedges -- the core reliability bug.
 *
 * This patch makes that callback CHEAP: instead of touching the canvas, it just
 * records {w, h, framebuffer-ptr, generation} into a small shared control block
 * (Module.c89Screen, an Int32 SharedArrayBuffer) and returns. The framebuffer
 * stays in wasm linear memory (already shared). The page main thread then draws
 * it on its own requestAnimationFrame loop (public/app.js), reading the pixels
 * directly from the shared wasm heap -- exactly the BasiliskII-style decoupling
 * (worker writes, main thread renders, no synchronous coupling).
 *
 * Idempotent. Run after the other out.js patches. Slot layout (mirror in app.js):
 *   ctrl[0]=MAGIC ctrl[1]=W ctrl[2]=H ctrl[3]=PTR ctrl[4]=GENERATION
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: patch-qemu-out-js-display.mjs /path/to/out.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");

if (source.includes("/* c89 display decouple */")) {
  console.log(`display decouple already present in ${file}`);
  process.exit(0);
}

// The SDL2 software-renderer copyData callback begins with this exact prefix.
// Keep SDL2's canvas/context initialization, then take the fast framebuffer
// publication path. Returning before ctxCanvas was set made SDL/browser input
// harder to reason about in headed Chrome.
const anchor =
  "var w = $0; var h = $1; var pixels = $2; if (!Module['SDL2']) Module['SDL2'] = {}; var SDL2 = Module['SDL2']; if (SDL2.ctxCanvas !== Module['canvas']) { SDL2.ctx = Module['createContext'](Module['canvas'], false, true); SDL2.ctxCanvas = Module['canvas']; } if (SDL2.w !==";
const fastPath =
  "var w = $0; var h = $1; var pixels = $2; " +
  "if (!Module['SDL2']) Module['SDL2'] = {}; var SDL2 = Module['SDL2']; " +
  "if (SDL2.ctxCanvas !== Module['canvas']) { SDL2.ctx = Module['createContext'](Module['canvas'], false, true); SDL2.ctxCanvas = Module['canvas']; } " +
  "/* c89 display decouple */ { var c89s = Module['c89Screen']; if (c89s) { " +
  "var c89c = Module['_c89ScreenCtl']; if (!c89c) { c89c = Module['_c89ScreenCtl'] = new Int32Array(c89s); } " +
  "Atomics.store(c89c, 1, w); Atomics.store(c89c, 2, h); Atomics.store(c89c, 3, pixels); Atomics.add(c89c, 4, 1); return; } } " +
  "if (SDL2.w !==";
const expandedAnchorPattern =
  /(var w = \$0;\s*\n\s*var h = \$1;\s*\n\s*var pixels = \$2;\s*\n\s*if \(!Module\[(["'])SDL2\2\]\) Module\[\2SDL2\2\] = \{};\s*\n\s*var SDL2 = Module\[\2SDL2\2\];\s*\n\s*if \(SDL2\.ctxCanvas !== Module\[\2canvas\2\]\) \{\s*\n\s*SDL2\.ctx = Module\[\2createContext\2\]\(Module\[\2canvas\2\], false, true\);\s*\n\s*SDL2\.ctxCanvas = Module\[\2canvas\2\];\s*\n\s*\}\s*\n\s*)if \(SDL2\.w !==/;

if (source.includes(anchor)) {
  source = source.replace(anchor, fastPath);
} else if (expandedAnchorPattern.test(source)) {
  source = source.replace(
    expandedAnchorPattern,
    (match, prefix, quote) =>
      `${prefix}/* c89 display decouple */ { var c89s = Module[${quote}c89Screen${quote}]; if (c89s) { var c89c = Module[${quote}_c89ScreenCtl${quote}]; if (!c89c) { c89c = Module[${quote}_c89ScreenCtl${quote}] = new Int32Array(c89s); } Atomics.store(c89c, 1, w); Atomics.store(c89c, 2, h); Atomics.store(c89c, 3, pixels); Atomics.add(c89c, 4, 1); return; } }
  if (SDL2.w !==`
  );
} else {
  console.error(`${file}: SDL2 copyData blit anchor not found`);
  process.exit(1);
}
fs.writeFileSync(file, source);
console.log(`patched display decouple into ${file}`);
