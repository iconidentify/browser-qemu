#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];

if (!file) {
  console.error("usage: patch-qemu-worker-js.mjs /path/to/qemu-system-m68k.worker.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");
let patched = false;

const threadInitCall = `Module['__emscripten_thread_init'](e.data.pthread_ptr, /*is_main=*/0, /*is_runtime=*/0, /*can_block=*/1);`;
const threadInitReplacement = `Module['__emscripten_thread_init'](e.data.pthread_ptr, /*is_main=*/0, /*is_runtime=*/0, /*can_block=*/1, /*default_stacksize=*/65536, /*start_profiling=*/false);`;

const catchBlock = `    if (Module['__emscripten_thread_crashed']) {
      Module['__emscripten_thread_crashed']();
    }
    throw ex;`;
const catchReplacement = `    try {
      var detail = ex && (ex.stack || ex.message || String(ex));
      err('worker exception detail: ' + detail);
      postMessage({ cmd: 'callHandler', handler: 'printErr', args: [ 'worker exception detail: ' + detail ] });
    } catch (_) {}
    if (Module['__emscripten_thread_crashed']) {
      Module['__emscripten_thread_crashed']();
    }
    throw ex;`;

if (source.includes(threadInitCall)) {
  source = source.replace(threadInitCall, threadInitReplacement);
  patched = true;
} else if (!source.includes(threadInitReplacement)) {
  console.error(`${file}: thread-init marker not found`);
  process.exit(1);
}

if (source.includes(catchBlock)) {
  source = source.replace(catchBlock, catchReplacement);
  patched = true;
} else if (!source.includes(catchReplacement)) {
  console.error(`${file}: worker catch marker not found`);
  process.exit(1);
}

if (patched) {
  fs.writeFileSync(file, source);
  console.log(`patched pthread worker glue in ${file}`);
} else {
  console.log(`pthread worker patch already present in ${file}`);
}
