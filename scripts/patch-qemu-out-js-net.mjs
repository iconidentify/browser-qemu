#!/usr/bin/env node
/*
 * Expose the wasmbridge net backend's shared-block accessor to page-side JS.
 *
 * net/wasmbridge.c exports c89_net_shared_ptr() (wasm export name
 * "_c89_net_shared_ptr"), which returns the wasm address of the ring-buffer
 * control block. This patch captures the RAW (un-Asyncify-instrumented)
 * export right after `wasmExports = instance.exports;` and stashes it on the
 * Module as c89NetSharedPtr, so public/net-bridge.js (window.AuxQemu) can call
 * it. Idempotent, matching the other out.js patch scripts.
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: patch-qemu-out-js-net.mjs /path/to/out.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");

const anchor = `    wasmExports = instance.exports;`;
const injection = `    wasmExports = instance.exports;
    /* c89 ethernet: expose the wasmbridge shared-ring accessor to page JS.
       Emscripten may name the export with or without a leading underscore. */
    Module['c89NetSharedPtr'] = instance.exports['_c89_net_shared_ptr'] || instance.exports['c89_net_shared_ptr'] || Module['c89NetSharedPtr'];`;
const anchorPattern = /(\s*)wasmExports = instance\.exports;/;

if (source.includes("Module['c89NetSharedPtr']")) {
  console.log(`net export already exposed in ${file}`);
  process.exit(0);
}
if (source.includes(anchor)) {
  source = source.replace(anchor, injection);
} else if (anchorPattern.test(source)) {
  source = source.replace(anchorPattern, (match, indent) =>
    `${indent}wasmExports = instance.exports;
${indent}/* c89 ethernet: expose the wasmbridge shared-ring accessor to page JS.
${indent}   Emscripten may name the export with or without a leading underscore. */
${indent}Module['c89NetSharedPtr'] = instance.exports['_c89_net_shared_ptr'] || instance.exports['c89_net_shared_ptr'] || Module['c89NetSharedPtr'];`
  );
} else {
  console.error(`${file}: receiveInstance wasmExports anchor not found`);
  process.exit(1);
}
fs.writeFileSync(file, source);
console.log(`exposed wasmbridge net accessor in ${file}`);
