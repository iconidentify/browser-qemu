#!/usr/bin/env node
/*
 * Expose wasminput's shared-block accessor to page-side JS.
 *
 * ui/wasminput.c exports c89_input_shared_ptr(). Capture the raw wasm export
 * right after Emscripten receives instance.exports, mirroring the net bridge.
 */
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: patch-qemu-out-js-input.mjs /path/to/out.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");

const anchor = `    wasmExports = instance.exports;`;
const injection = `    wasmExports = instance.exports;
    /* c89 input: expose the wasminput shared-block accessor to page JS.
       Emscripten may name the export with or without a leading underscore. */
    Module['c89InputSharedPtr'] = instance.exports['_c89_input_shared_ptr'] || instance.exports['c89_input_shared_ptr'] || Module['c89InputSharedPtr'];`;
const anchorPattern = /(\s*)wasmExports = instance\.exports;/;

if (source.includes("Module['c89InputSharedPtr']")) {
  console.log(`input export already exposed in ${file}`);
  process.exit(0);
}
if (source.includes(anchor)) {
  source = source.replace(anchor, injection);
} else if (anchorPattern.test(source)) {
  source = source.replace(anchorPattern, (match, indent) =>
    `${indent}wasmExports = instance.exports;
${indent}/* c89 input: expose the wasminput shared-block accessor to page JS.
${indent}   Emscripten may name the export with or without a leading underscore. */
${indent}Module['c89InputSharedPtr'] = instance.exports['_c89_input_shared_ptr'] || instance.exports['c89_input_shared_ptr'] || Module['c89InputSharedPtr'];`
  );
} else {
  console.error(`${file}: receiveInstance wasmExports anchor not found`);
  process.exit(1);
}

fs.writeFileSync(file, source);
console.log(`exposed wasminput accessor in ${file}`);
