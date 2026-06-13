#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];

if (!file) {
  console.error("usage: patch-qemu-out-js-lazyfile.mjs /path/to/out.js");
  process.exit(2);
}

let source = fs.readFileSync(file, "utf8");

const dynamicTbStartAbi = process.env.QEMU_WASM_DYNAMIC_TB_START_ABI || "fpcast";
if (!["fpcast", "ii"].includes(dynamicTbStartAbi)) {
  console.error("QEMU_WASM_DYNAMIC_TB_START_ABI must be fpcast or ii");
  process.exit(2);
}

const guard = `if (!ENVIRONMENT_IS_WORKER) throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
   var lazyArray = new LazyUint8Array;`;
const guardReplacement = `/* C89 A/UX prototype: allow range-backed lazy disk files on the main browser thread. */
   var lazyArray = new LazyUint8Array();`;
const guardPattern = /if \(!ENVIRONMENT_IS_WORKER\) throw (["'])Cannot do synchronous binary XHRs outside webworkers in modern browsers\. Use --embed-file or --preload-file in emcc\1;\s*var lazyArray = new LazyUint8Array(?:\(\))?;/;

const xhrBlock = `    xhr.responseType = "arraybuffer";
    if (xhr.overrideMimeType) {
     xhr.overrideMimeType("text/plain; charset=x-user-defined");
    }
    xhr.send(null);
    if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    if (xhr.response !== undefined) {
     return new Uint8Array(/** @type{Array<number>} */ (xhr.response || []));
    }
    return intArrayFromString(xhr.responseText || "", true);`;
const xhrPattern = /(\s*)xhr\.responseType = ['"]arraybuffer['"];\n\s*if \(xhr\.overrideMimeType\) \{\n\s*xhr\.overrideMimeType\(['"]text\/plain; charset=x-user-defined['"]\);\n\s*\}\n\s*xhr\.send\(null\);\n\s*if \(!\(xhr\.status >= 200 && xhr\.status < 300 \|\| xhr\.status === 304\)\) throw new Error\(["']Couldn't load ["'] \+ url \+ ["']\. Status: ["'] \+ xhr\.status\);\n\s*if \(xhr\.response !== undefined\) \{\n\s*return new Uint8Array\(\/\*\* @type\{Array<number>\} \*\/\s*\(xhr\.response \|\| \[\]\)\);\n\s*\}\n\s*return intArrayFromString\(xhr\.responseText \|\| (?:''|""), true\);/;
const damagedXhrPattern = /(\/\/ Some hints to the browser that we want binary data\.)[ \t]*if \(ENVIRONMENT_IS_WORKER\) \{\s*xhr\.responseType = "arraybuffer";\s*\}\s*if \(xhr\.overrideMimeType\) \{\s*xhr\.overrideMimeType\("text\/plain; charset=x-user-defined"\);\s*\}\s*xhr\.send\(null\);\s*if \(!\(xhr\.status >= 200 && xhr\.status < 300 \|\| xhr\.status === 304\)\) throw new Error\("Couldn't load " \+ url \+ "\. Status: " \+ xhr\.status\);\s*if \(ENVIRONMENT_IS_WORKER && xhr\.response !== undefined\) \{\s*return new Uint8Array\(\/\*\* @type\{Array<number>\} \*\/ \(xhr\.response \|\| \[\]\)\);\s*\}\s*return intArrayFromString\(xhr\.responseText \|\| "", true\);/;
function formatXhrReplacement(indent = "    ") {
  // The responseText fallback must NOT go through intArrayFromString: that
  // UTF-8 encodes the string, so with the x-user-defined charset every disk
  // byte >= 0x80 becomes the 3-byte sequence ef 9e/9f xx, silently shifting
  // and corrupting sector data (jag-disk DDM corruption, June 12 2026).
  // Recover the raw bytes with charCodeAt & 0xff instead.
  return `${indent}if (ENVIRONMENT_IS_WORKER) {
${indent} xhr.responseType = "arraybuffer";
${indent}}
${indent}if (xhr.overrideMimeType) {
${indent} xhr.overrideMimeType("text/plain; charset=x-user-defined");
${indent}}
${indent}xhr.send(null);
${indent}if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
${indent}if (ENVIRONMENT_IS_WORKER && xhr.response !== undefined) {
${indent} return new Uint8Array(/** @type{Array<number>} */ (xhr.response || []));
${indent}}
${indent}/* c89 raw byte recovery */
${indent}var c89Text = xhr.responseText || "";
${indent}var c89Bytes = new Uint8Array(c89Text.length);
${indent}for (var c89I = 0; c89I < c89Text.length; c89I++) {
${indent} c89Bytes[c89I] = c89Text.charCodeAt(c89I) & 0xff;
${indent}}
${indent}return c89Bytes;`;
}
const xhrReplacement = formatXhrReplacement();

const ptyLine = `var PTY = Module["pty"];`;
const ptyPattern = /var PTY = Module\[(["'])pty\1\];/;
const ptyReplacement = `var PTY = Module["pty"] || {
 readable: false,
 writable: true,
 read() {
  return [];
 },
 write(bytes) {
  if (!bytes || !bytes.length) return;
  var text = "";
  try {
   if (typeof TextDecoder != "undefined") {
    text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
   } else {
    text = String.fromCharCode.apply(null, bytes);
   }
  } catch (e) {}
  if (text && Module["print"]) Module["print"](text.replace(/\\\\s+$/, ""));
 },
 ioctl(request) {
  if (request === "TCGETS") {
   return {
    iflag: 0,
    oflag: 0,
    cflag: 0,
    lflag: 0,
    cc: new Uint8Array(32)
   };
  }
  if (request === "TIOCGWINSZ") return [ 0, 0, 80, 24 ];
  return 0;
 },
 onReadable() {
  return {
   dispose() {}
  };
 },
 onSignal() {
  return {
   dispose() {}
  };
 }
};`;

const invokeEntryPointPattern = /var invokeEntryPoint = \(ptr, arg\) => \{[\s\S]*?\n\s*\};\n\s*Module\[(["'])invokeEntryPoint\1\] = invokeEntryPoint;/;
const invokeEntryPointReplacement = `var invokeEntryPoint = (ptr, arg) => {
 var result = dynCall("ii", ptr, [arg]);
 if (typeof result === "bigint") result = Number(result);
 if (result == null) result = 0;
 function finish(result) {
  if (keepRuntimeAlive()) {
   PThread.setExitStatus(result);
  } else {
   __emscripten_thread_exit(result);
  }
 }
 finish(result);
};

Module["invokeEntryPoint"] = invokeEntryPoint;`;

const ffiCallLine = ` var result = (0, getWasmTableEntry(fn).apply(null, args));`;
const ffiRetryPattern = / var callArgs = args\.slice\(\);\n var result;[\s\S]*?\n \}\n stackRestore\(orig_stack_ptr\);/;
const ffiCallReplacement = ` var ffiArgSig = ret_by_arg ? "i" : "";
 for (var sigi = 0; sigi < nfixedargs; sigi++) {
  var sig_unboxed = unbox_small_structs(HEAPU32[(arg_types_ptr >> 2) + sigi >>> 0]);
  switch (sig_unboxed[1]) {
  case 2:
   ffiArgSig += "f";
   break;
  case 3:
   ffiArgSig += "d";
   break;
  case 4:
   ffiArgSig += "jj";
   break;
  case 11:
  case 12:
   ffiArgSig += "j";
   break;
  default:
   ffiArgSig += "i";
   break;
  }
 }
 if (nfixedargs != nargs) {
  ffiArgSig += "i";
 }
 var ffiRetSig;
 switch (rtype_id) {
 case 0:
 case 4:
 case 13:
  ffiRetSig = "v";
  break;
 case 2:
  ffiRetSig = "f";
  break;
 case 3:
  ffiRetSig = "d";
  break;
 case 11:
 case 12:
  ffiRetSig = "j";
  break;
 default:
  ffiRetSig = "i";
  break;
 }
 var result = dynCall(ffiRetSig + ffiArgSig, fn, args);`;

const instantiateWasmPattern = /function instantiate_wasm\(\) \{ const memory_v = new DataView\(HEAP8\.buffer\); const tb_ptr = memory_v\.getInt32\(Module\.__wasm32_tb\.tb_ptr_ptr, true\); const export_vec_size = memory_v\.getInt32\(tb_ptr \+ 4, true\); const export_vec_begin = tb_ptr \+ 4 \+ 4; const counter_vec_size = memory_v\.getInt32\(export_vec_begin \+ export_vec_size, true\); const counter_vec_begin = export_vec_begin \+ export_vec_size \+ 4; const tmp_body_size = memory_v\.getInt32\(counter_vec_begin \+ counter_vec_size, true\); const tmp_body_begin = counter_vec_begin \+ counter_vec_size \+ 4; const wasm_size = memory_v\.getInt32\(tmp_body_begin \+ tmp_body_size, true\); const wasm_begin = tmp_body_begin \+ tmp_body_size \+ 4; const import_vec_size = memory_v\.getInt32\(wasm_begin \+ wasm_size, true\); const import_vec_begin = wasm_begin \+ wasm_size \+ 4; const wasmBytes = new Uint8Array\(HEAP8\.slice\(wasm_begin, wasm_begin \+ wasm_size\)\); var helper = \{\}; for \(var i = 0; i < import_vec_size \/ 4; i\+\+\) \{ helper\[i\] = wasmTable\.get\(memory_v\.getInt32\(import_vec_begin \+ i \* 4, true\)\); \} const mod = new WebAssembly\.Module\(wasmBytes\); const inst = new WebAssembly\.Instance\(mod, \{ "env": \{ "buffer": wasmMemory, \}, "helper": helper, \}\); Module\.__wasm32_tb\.inst_gc_registry\.register\(inst, "instance"\); const fidx = addFunction\(inst\.exports\.start, 'ii'\); return fidx; \}/;
const qemuWasmStartGlue = `function c89QemuWasmStartUsesFpcast() {
 return "${dynamicTbStartAbi}" === "fpcast";
}

function c89QemuWasmFpcastSig() {
 return "j" + "j".repeat(16);
}

function c89QemuWasmStartSig() {
 return c89QemuWasmStartUsesFpcast() ? c89QemuWasmFpcastSig() : "ii";
}

function c89WrapQemuWasmStart(start) {
 return function() {
  var useFpcast = c89QemuWasmStartUsesFpcast();
  var ctx = useFpcast ? Module.__wasm32_tb.tb_ptr_ptr - 8 : Number(arguments[0]);
  try {
   var result = start(ctx);
   if (useFpcast) {
    if (typeof result === "bigint") return result;
    return BigInt(result >>> 0);
   }
   if (typeof result === "bigint") return Number(result);
   if (result == null) return 0;
   return result;
  } catch (e) {
   if (typeof e === "number") throw e;
   throw new Error("qemu-wasm dynamic TB start failed abi=" + c89QemuWasmStartSig() + " ctx=" + ctx + ": " + (e && e.stack ? e.stack : e));
  }
 };
}`;
const instantiateWasmReplacement = `function c89ReadWasmU32(bytes, offset) {
 var value = 0;
 var shift = 0;
 while (true) {
  var byte = bytes[offset++];
  value |= (byte & 0x7f) << shift;
  if ((byte & 0x80) === 0) break;
  shift += 7;
 }
 return [value >>> 0, offset];
}

function c89ReadWasmString(bytes, offset) {
 var lengthResult = c89ReadWasmU32(bytes, offset);
 var length = lengthResult[0];
 offset = lengthResult[1];
 var text = "";
 for (var i = 0; i < length; i++) {
  text += String.fromCharCode(bytes[offset + i]);
 }
 return [text, offset + length];
}

function c89WasmValueTypeSig(type) {
 switch (type) {
 case 0x7f:
  return "i";
 case 0x7e:
  return "j";
 case 0x7d:
  return "f";
 case 0x7c:
  return "d";
 default:
  throw new Error("unsupported qemu-wasm helper value type 0x" + type.toString(16));
 }
}

function c89DecodeQemuWasmHelperSigs(bytes) {
 var offset = 8;
 var types = [];
 var helpers = [];
 while (offset < bytes.length) {
  var sectionId = bytes[offset++];
  var sizeResult = c89ReadWasmU32(bytes, offset);
  var sectionSize = sizeResult[0];
  offset = sizeResult[1];
  var sectionEnd = offset + sectionSize;

  if (sectionId === 1) {
   var countResult = c89ReadWasmU32(bytes, offset);
   var count = countResult[0];
   offset = countResult[1];
   for (var typeIndex = 0; typeIndex < count; typeIndex++) {
    if (bytes[offset++] !== 0x60) throw new Error("unexpected qemu-wasm helper type form");
    var paramCountResult = c89ReadWasmU32(bytes, offset);
    var paramCount = paramCountResult[0];
    offset = paramCountResult[1];
    var params = [];
    for (var paramIndex = 0; paramIndex < paramCount; paramIndex++) {
     params.push(c89WasmValueTypeSig(bytes[offset++]));
    }
    var returnCountResult = c89ReadWasmU32(bytes, offset);
    var returnCount = returnCountResult[0];
    offset = returnCountResult[1];
    var returns = [];
    for (var returnIndex = 0; returnIndex < returnCount; returnIndex++) {
     returns.push(c89WasmValueTypeSig(bytes[offset++]));
    }
    types.push((returns[0] || "v") + params.join(""));
   }
  } else if (sectionId === 2) {
   var importCountResult = c89ReadWasmU32(bytes, offset);
   var importCount = importCountResult[0];
   offset = importCountResult[1];
   for (var importIndex = 0; importIndex < importCount; importIndex++) {
    var moduleResult = c89ReadWasmString(bytes, offset);
    var moduleName = moduleResult[0];
    offset = moduleResult[1];
    var fieldResult = c89ReadWasmString(bytes, offset);
    var fieldName = fieldResult[0];
    offset = fieldResult[1];
    var kind = bytes[offset++];
    if (kind === 0) {
     var typeIndexResult = c89ReadWasmU32(bytes, offset);
     var importedTypeIndex = typeIndexResult[0];
     offset = typeIndexResult[1];
     if (moduleName === "helper") {
      helpers[Number(fieldName)] = types[importedTypeIndex];
     }
    } else if (kind === 2) {
     var limitsFlags = bytes[offset++];
     var minResult = c89ReadWasmU32(bytes, offset);
     offset = minResult[1];
     if (limitsFlags & 1) {
      var maxResult = c89ReadWasmU32(bytes, offset);
      offset = maxResult[1];
     }
    } else {
     throw new Error("unsupported qemu-wasm import kind " + kind);
    }
   }
  }
  offset = sectionEnd;
 }
 return helpers;
}

function c89WrapQemuWasmHelper(ptr, sig) {
 if (!sig) throw new Error("missing qemu-wasm helper signature for function pointer " + ptr);
 return function() {
  var args = Array.prototype.slice.call(arguments);
  try {
   return dynCall(sig, ptr, args);
  } catch (e) {
   if (typeof e === "number") throw e;
   throw new Error("qemu-wasm helper dynCall failed sig=" + sig + " ptr=" + ptr + " argc=" + args.length + " argTypes=" + args.map(function(arg) { return typeof arg; }).join(",") + ": " + (e && e.stack ? e.stack : e));
  }
 };
}

${qemuWasmStartGlue}

function instantiate_wasm() {
 const memory_v = new DataView(HEAP8.buffer);
 const tb_ptr = memory_v.getInt32(Module.__wasm32_tb.tb_ptr_ptr, true);
 const export_vec_size = memory_v.getInt32(tb_ptr + 4, true);
 const export_vec_begin = tb_ptr + 4 + 4;
 const counter_vec_size = memory_v.getInt32(export_vec_begin + export_vec_size, true);
 const counter_vec_begin = export_vec_begin + export_vec_size + 4;
 const tmp_body_size = memory_v.getInt32(counter_vec_begin + counter_vec_size, true);
 const tmp_body_begin = counter_vec_begin + counter_vec_size + 4;
 const wasm_size = memory_v.getInt32(tmp_body_begin + tmp_body_size, true);
 const wasm_begin = tmp_body_begin + tmp_body_size + 4;
 const import_vec_size = memory_v.getInt32(wasm_begin + wasm_size, true);
 const import_vec_begin = wasm_begin + wasm_size + 4;
 const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));
 const helperSigs = c89DecodeQemuWasmHelperSigs(wasmBytes);
 var helper = {};
 for (var i = 0; i < import_vec_size / 4; i++) {
  var helperPtr = memory_v.getInt32(import_vec_begin + i * 4, true);
  helper[i] = c89WrapQemuWasmHelper(helperPtr, helperSigs[i]);
 }
 const mod = new WebAssembly.Module(wasmBytes);
 const inst = new WebAssembly.Instance(mod, { "env": { "buffer": wasmMemory, }, "helper": helper, });
 Module.__wasm32_tb.inst_gc_registry.register(inst, "instance");
 const fidx = addFunction(c89WrapQemuWasmStart(inst.exports.start), c89QemuWasmStartSig());
 return fidx;
}`;

let patched = false;

if (source.includes(guard)) {
  source = source.replace(guard, guardReplacement);
  patched = true;
} else if (guardPattern.test(source)) {
  source = source.replace(guardPattern, guardReplacement);
  patched = true;
} else if (!source.includes(guardReplacement)) {
  console.error(`${file}: lazy-file worker guard marker not found`);
  process.exit(1);
}

if (source.includes(xhrBlock)) {
  source = source.replace(xhrBlock, xhrReplacement);
  patched = true;
} else if (damagedXhrPattern.test(source)) {
  source = source.replace(damagedXhrPattern, (match, comment) => `${comment}${formatXhrReplacement("\n            ")}`);
  patched = true;
} else if (xhrPattern.test(source)) {
  source = source.replace(xhrPattern, (match, indent) => formatXhrReplacement(indent));
  patched = true;
} else if (!source.includes("ENVIRONMENT_IS_WORKER && xhr.response !== undefined")) {
  console.error(`${file}: lazy-file XHR marker not found`);
  process.exit(1);
}

if (source.includes(ptyLine)) {
  source = source.replace(ptyLine, ptyReplacement);
  patched = true;
} else if (ptyPattern.test(source)) {
  source = source.replace(ptyPattern, ptyReplacement);
  patched = true;
} else if (!source.includes(ptyReplacement)) {
  console.error(`${file}: PTY marker not found`);
  process.exit(1);
}

if (source.includes(invokeEntryPointReplacement)) {
  // Already patched.
} else if (invokeEntryPointPattern.test(source)) {
  source = source.replace(invokeEntryPointPattern, invokeEntryPointReplacement);
  patched = true;
} else {
  console.error(`${file}: invokeEntryPoint marker not found`);
  process.exit(1);
}

if (source.includes(ffiCallLine)) {
  source = source.replace(ffiCallLine, ffiCallReplacement);
  patched = true;
} else if (ffiRetryPattern.test(source)) {
  source = source.replace(ffiRetryPattern, `${ffiCallReplacement}
 stackRestore(orig_stack_ptr);`);
  patched = true;
} else if (!source.includes(ffiCallReplacement)) {
  console.error(`${file}: ffi_call_js marker not found`);
  process.exit(1);
}

if (source.includes("function c89DecodeQemuWasmHelperSigs(bytes)")) {
  const staleMemoryLimitParser = `    } else if (kind === 2) {
     offset += 1;
     var minResult = c89ReadWasmU32(bytes, offset);
     offset = minResult[1];
     if (kind & 1) {`;
  const fixedMemoryLimitParser = `    } else if (kind === 2) {
     var limitsFlags = bytes[offset++];
     var minResult = c89ReadWasmU32(bytes, offset);
     offset = minResult[1];
     if (limitsFlags & 1) {`;
  if (source.includes(staleMemoryLimitParser)) {
    source = source.replace(staleMemoryLimitParser, fixedMemoryLimitParser);
    patched = true;
  }
  const staleHelperWrapper = `function c89WrapQemuWasmHelper(ptr, sig) {
 if (!sig) throw new Error("missing qemu-wasm helper signature for function pointer " + ptr);
 return function() {
  return dynCall(sig, ptr, Array.prototype.slice.call(arguments));
 };
}`;
  const diagnosticHelperWrapper = `function c89WrapQemuWasmHelper(ptr, sig) {
 if (!sig) throw new Error("missing qemu-wasm helper signature for function pointer " + ptr);
 return function() {
  var args = Array.prototype.slice.call(arguments);
  try {
   return dynCall(sig, ptr, args);
  } catch (e) {
   if (typeof e === "number") throw e;
   throw new Error("qemu-wasm helper dynCall failed sig=" + sig + " ptr=" + ptr + " argc=" + args.length + " argTypes=" + args.map(function(arg) { return typeof arg; }).join(",") + ": " + (e && e.stack ? e.stack : e));
  }
 };
}`;
  if (source.includes(staleHelperWrapper)) {
    source = source.replace(staleHelperWrapper, diagnosticHelperWrapper);
    patched = true;
  }
  const helperCatchWithoutNumericRethrow = `  } catch (e) {
   throw new Error("qemu-wasm helper dynCall failed sig=" + sig + " ptr=" + ptr + " argc=" + args.length + " argTypes=" + args.map(function(arg) { return typeof arg; }).join(",") + ": " + (e && e.stack ? e.stack : e));
  }`;
  const helperCatchWithNumericRethrow = `  } catch (e) {
   if (typeof e === "number") throw e;
   throw new Error("qemu-wasm helper dynCall failed sig=" + sig + " ptr=" + ptr + " argc=" + args.length + " argTypes=" + args.map(function(arg) { return typeof arg; }).join(",") + ": " + (e && e.stack ? e.stack : e));
  }`;
  if (source.includes(helperCatchWithoutNumericRethrow)) {
    source = source.replaceAll(helperCatchWithoutNumericRethrow, helperCatchWithNumericRethrow);
    patched = true;
  }
  const startGluePattern = /function c89WrapQemuWasmStart\(start\) \{[\s\S]*?\n\}\n\nfunction c89QemuWasmFpcastSig\(\) \{[\s\S]*?\n\}/;
  const startGluePatternNewOrder = /function c89QemuWasmStartUsesFpcast\(\) \{[\s\S]*?\n\}\n\nfunction c89QemuWasmFpcastSig\(\) \{[\s\S]*?\n\}\n\nfunction c89QemuWasmStartSig\(\) \{[\s\S]*?\n\}\n\nfunction c89WrapQemuWasmStart\(start\) \{[\s\S]*?\n\}/;
  if (startGluePatternNewOrder.test(source)) {
    source = source.replace(startGluePatternNewOrder, qemuWasmStartGlue);
    patched = true;
  } else if (startGluePattern.test(source)) {
    source = source.replace(startGluePattern, qemuWasmStartGlue);
    patched = true;
  }
  const directStartRegistration = ` const fidx = addFunction(inst.exports.start, 'ii');
 return fidx;`;
  const wrappedStartRegistration = ` const fidx = addFunction(c89WrapQemuWasmStart(inst.exports.start), 'ii');
 return fidx;`;
  const fpcastStartRegistration = ` const fidx = addFunction(c89WrapQemuWasmStart(inst.exports.start), c89QemuWasmFpcastSig());
 return fidx;`;
  const selectedStartRegistration = ` const fidx = addFunction(c89WrapQemuWasmStart(inst.exports.start), c89QemuWasmStartSig());
 return fidx;`;
  if (source.includes(directStartRegistration)) {
    if (!source.includes("function c89WrapQemuWasmStart(start)")) {
      source = source.replace(`${diagnosticHelperWrapper}

function instantiate_wasm() {`, `${diagnosticHelperWrapper}

${qemuWasmStartGlue}

function instantiate_wasm() {`);
    }
    source = source.replace(directStartRegistration, selectedStartRegistration);
    patched = true;
  } else if (source.includes(wrappedStartRegistration)) {
    source = source.replace(wrappedStartRegistration, selectedStartRegistration);
    patched = true;
  } else if (source.includes(fpcastStartRegistration)) {
    source = source.replace(fpcastStartRegistration, selectedStartRegistration);
    patched = true;
  }
} else if (instantiateWasmPattern.test(source)) {
  source = source.replace(instantiateWasmPattern, instantiateWasmReplacement);
  patched = true;
} else {
  console.error(`${file}: instantiate_wasm marker not found`);
  process.exit(1);
}

const ptyWaitLine = ` if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(25, 0, atomicIndex);
 PTY_waitForReadableWithCallback(type => {`;
const ptyWaitReplacement = ` if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(25, 0, atomicIndex);
 if (Module["ptyWaitIndex"]) Module["ptyWaitIndex"](atomicIndex, wasmMemory);
 PTY_waitForReadableWithCallback(type => {`;
const ptyWaitPattern = /(if \(ENVIRONMENT_IS_PTHREAD\)\s*return proxyToMainThread\(25, 0, atomicIndex\);\s*)(PTY_waitForReadableWithCallback\(type => \{)/;

if (source.includes(ptyWaitLine)) {
  source = source.replace(ptyWaitLine, ptyWaitReplacement);
  patched = true;
} else if (ptyWaitPattern.test(source)) {
  source = source.replace(ptyWaitPattern, `$1if (Module["ptyWaitIndex"]) Module["ptyWaitIndex"](atomicIndex, wasmMemory);
  $2`);
  patched = true;
} else if (!source.includes('Module["ptyWaitIndex"]')) {
  console.error(`${file}: PTY wait marker not found`);
  process.exit(1);
}

// Bound the QEMU-main-thread PTY poll wait by the poll timeout. The stock
// xterm-pty atomic wait is Atomics.wait(..., -1) with no timeout; its wakeup
// depends entirely on a callback chain proxied to the browser main thread.
// When that page-side wake is lost, the QEMU main loop sleeps through every
// timer deadline forever: continuous browser runs stopped answering HMP after
// 60-120s with the main loop parked in PTY_waitForReadableWithAtomic (worker
// stack capture, June 12 2026). PTY_pollTimeout is set in this worker realm
// by PTY_askToWaitAgain just before the wait, so use it to bound the sleep
// and synthesize the regular timeout result when it expires.
const ptyBoundedWaitPattern =
  /(HEAP32\[PTY_atomicIndex\] = -1;\s*\n\s*PTY_waitForReadableWithAtomicImpl\(PTY_atomicIndex\);\s*\n)(\s*)Atomics\.wait\(HEAP32, PTY_atomicIndex, -1\);/;

if (!source.includes("c89 pty bounded wait")) {
  if (ptyBoundedWaitPattern.test(source)) {
    source = source.replace(
      ptyBoundedWaitPattern,
      `$1$2/* c89 pty bounded wait; min 8ms so page-side proxy churn stays low */
$2Atomics.wait(HEAP32, PTY_atomicIndex, -1,
$2             PTY_pollTimeout >= 0 ? Math.max(PTY_pollTimeout, 8) : Infinity);
$2/* If the page-side wake never arrived, report a plain poll timeout. */
$2Atomics.compareExchange(HEAP32, PTY_atomicIndex, -1, 2);`
    );
    patched = true;
  } else {
    console.error(`${file}: PTY bounded-wait marker not found`);
    process.exit(1);
  }
}

if (patched) {
  fs.writeFileSync(file, source);
  console.log(`patched lazy-file main-thread range reads in ${file}`);
} else {
  console.log(`lazy-file patch already present in ${file}`);
}
