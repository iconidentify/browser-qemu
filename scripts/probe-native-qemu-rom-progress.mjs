#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const options = {
  assetDir: process.env.AUX_QEMU_LOCAL || "/Users/chrisk/aux_qemu_local",
  qemu: "",
  duration: 30,
  interval: 5,
  ram: 16,
  keep: false,
  trace: true,
  via: false,
  continueAfterScsi: false,
};

function usage() {
  console.error(`Usage:
  node scripts/probe-native-qemu-rom-progress.mjs [--asset-dir path] [--qemu path] [--duration seconds] [--interval seconds] [--ram mb] [--via] [--no-trace] [--continue-after-scsi] [--keep]

Examples:
  node scripts/probe-native-qemu-rom-progress.mjs --duration 30 --ram 16
  node scripts/probe-native-qemu-rom-progress.mjs --qemu ./build/qemu-wasm-native/qemu-system-m68k --duration 30 --ram 16 --via
  node scripts/probe-native-qemu-rom-progress.mjs --duration 60 --interval 5 --continue-after-scsi
  node scripts/probe-native-qemu-rom-progress.mjs --duration 60 --ram 128`);
}

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--asset-dir") {
    options.assetDir = args[++index] || "";
  } else if (arg === "--qemu") {
    options.qemu = args[++index] || "";
  } else if (arg === "--duration") {
    options.duration = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--interval") {
    options.interval = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--ram") {
    options.ram = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--via") {
    options.via = true;
  } else if (arg === "--no-trace") {
    options.trace = false;
  } else if (arg === "--continue-after-scsi") {
    options.continueAfterScsi = true;
  } else if (arg === "--keep") {
    options.keep = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!Number.isFinite(options.duration) || options.duration < 1 || options.duration > 600) {
  console.error("--duration must be an integer from 1 to 600");
  process.exit(2);
}
if (!Number.isFinite(options.interval) || options.interval < 1 || options.interval > 60) {
  console.error("--interval must be an integer from 1 to 60");
  process.exit(2);
}
if (!Number.isFinite(options.ram) || options.ram < 4 || options.ram > 1024) {
  console.error("--ram must be an integer from 4 to 1024");
  process.exit(2);
}

function mustExist(label, pathname) {
  if (!fs.existsSync(pathname)) {
    console.error(`${label} not found: ${pathname}`);
    process.exit(2);
  }
  return pathname;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function tailLines(text, limit = 80) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-limit);
}

function viaTraceLines(text, limit = 40) {
  return tailLines(text, 1000).filter((line) => line.includes("[c89-via1")).slice(-limit);
}

function parseScsiSummary(lines) {
  const traceLines = lines
    .filter((line) => /\b(esp_|scsi_)/.test(line))
    .filter((line) => !line.includes("qemu trace enabled:") && !line.includes("qemu args:"));
  const readSectors = [];
  const lbas = [];
  const targetReads = new Map();
  const targetLbas = new Map();
  const eventCounts = new Map();
  let lastTarget = "?";

  for (const line of traceLines) {
    const event = (String(line).match(/\b((?:esp|scsi)_[a-z0-9_]+)/i) || [])[1];
    if (event) eventCounts.set(event, (eventCounts.get(event) || 0) + 1);
    const targetMatch = String(line).match(/\btarget\s+(\d+)\b/i);
    if (targetMatch) lastTarget = targetMatch[1];

    for (const match of String(line).matchAll(/\bsector\s+(\d+)\b/gi)) {
      const sector = Number.parseInt(match[1], 10);
      if (Number.isFinite(sector)) {
        readSectors.push(sector);
        if (!targetReads.has(lastTarget)) targetReads.set(lastTarget, []);
        targetReads.get(lastTarget).push(sector);
      }
    }

    for (const match of String(line).matchAll(/\blba\s+(\d+)\b/gi)) {
      const lba = Number.parseInt(match[1], 10);
      if (Number.isFinite(lba)) {
        lbas.push(lba);
        if (!targetLbas.has(lastTarget)) targetLbas.set(lastTarget, []);
        targetLbas.get(lastTarget).push(lba);
      }
    }
  }

  const uniqueReadSectors = [...new Set(readSectors)];
  const uniqueLbas = [...new Set(lbas)];
  const targets = {};
  for (const target of [...new Set([...targetReads.keys(), ...targetLbas.keys()])].sort()) {
    const sectors = [...new Set(targetReads.get(target) || [])];
    const targetLbaList = [...new Set(targetLbas.get(target) || [])];
    targets[target] = {
      readSectors: sectors.slice(-24),
      maxReadSector: sectors.length ? Math.max(...sectors) : null,
      lbas: targetLbaList.slice(-24),
      maxLba: targetLbaList.length ? Math.max(...targetLbaList) : null,
    };
  }
  return {
    count: traceLines.length,
    eventCounts: Object.fromEntries([...eventCounts.entries()].sort((a, b) => b[1] - a[1])),
    readCommandCount: readSectors.length,
    readSectors: uniqueReadSectors.slice(-24),
    maxReadSector: uniqueReadSectors.length ? Math.max(...uniqueReadSectors) : null,
    lbas: uniqueLbas.slice(-24),
    maxLba: uniqueLbas.length ? Math.max(...uniqueLbas) : null,
    targets,
    transferCount: traceLines.filter((line) => /\besp_transfer_data\b/.test(line)).length,
    tail: traceLines.slice(-16),
  };
}

function parseHexByte(value) {
  const parsed = Number.parseInt(String(value).replace(/^0x/i, ""), 16);
  return Number.isFinite(parsed) ? parsed & 0xff : null;
}

function hexByte(value) {
  return `0x${(value & 0xff).toString(16).padStart(2, "0")}`;
}

function activeIrqNames(viaName, active) {
  const via1Names = [
    [0x01, "one_second"],
    [0x02, "sixty_hz"],
    [0x04, "adb_ready"],
    [0x08, "adb_data"],
    [0x10, "adb_clock"],
    [0x20, "t2"],
    [0x40, "t1"],
  ];
  const via2Names = [
    [0x01, "scsi_data"],
    [0x02, "nubus"],
    [0x04, "shift_register"],
    [0x08, "scsi"],
    [0x10, "asc"],
    [0x20, "t2"],
    [0x40, "t1"],
  ];
  return (viaName === "via1" ? via1Names : via2Names)
    .filter(([mask]) => (active & mask) !== 0)
    .map(([, name]) => name);
}

function parseViaInfo(text) {
  const result = {};
  let current = null;
  let currentTimer = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const deviceMatch = line.match(/^mos6522-q800-(via[12]):$/);
    if (deviceMatch) {
      current = {
        registers: {},
        timers: {},
        raw: [line],
      };
      result[deviceMatch[1]] = current;
      currentTimer = null;
      continue;
    }
    if (!current) continue;
    current.raw.push(line);

    const registerMatch = line.match(/^([A-Z0-9]+)\s*:\s*(0x[0-9a-f]+|\d+)$/i);
    if (registerMatch) {
      current.registers[registerMatch[1].toLowerCase()] = registerMatch[2].toLowerCase();
      continue;
    }

    const nowMatch = line.match(/^Using current time now\(ns\)=(\d+)$/);
    if (nowMatch) {
      current.nowNs = Number.parseInt(nowMatch[1], 10);
      continue;
    }

    const timerMatch = line.match(/^(T[12]) freq\(hz\)=(\d+) mode=([a-z-]+) counter=(0x[0-9a-f]+) latch=(0x[0-9a-f]+)$/i);
    if (timerMatch) {
      currentTimer = timerMatch[1].toLowerCase();
      current.timers[currentTimer] = {
        frequencyHz: Number.parseInt(timerMatch[2], 10),
        mode: timerMatch[3],
        counter: timerMatch[4].toLowerCase(),
        latch: timerMatch[5].toLowerCase(),
      };
      continue;
    }

    const timerDetailMatch = line.match(/^load_time\(ns\)=(\d+) next_irq_time\(ns\)=(\d+)$/);
    if (timerDetailMatch && currentTimer && current.timers[currentTimer]) {
      current.timers[currentTimer].loadTimeNs = Number.parseInt(timerDetailMatch[1], 10);
      current.timers[currentTimer].nextIrqTimeNs = Number.parseInt(timerDetailMatch[2], 10);
    }
  }

  for (const [viaName, via] of Object.entries(result)) {
    const ifr = parseHexByte(via.registers.ifr);
    const ier = parseHexByte(via.registers.ier);
    if (ifr !== null) via.ifr = hexByte(ifr);
    if (ier !== null) via.ier = hexByte(ier);
    if (ifr !== null && ier !== null) {
      const active = ifr & ier & 0x7f;
      via.activeIrq = hexByte(active);
      via.activeIrqNames = activeIrqNames(viaName, active);
    }
    via.rawTail = via.raw.slice(-32);
  }

  return result;
}

function summarizeViaTimer(timer, nowNs) {
  if (!timer) return undefined;
  const summary = {
    mode: timer.mode,
    counter: timer.counter,
    latch: timer.latch,
  };
  if (Number.isFinite(timer.nextIrqTimeNs) && Number.isFinite(timer.loadTimeNs)) {
    summary.nextMinusLoadMs = Math.round((timer.nextIrqTimeNs - timer.loadTimeNs) / 1_000_000);
  }
  if (Number.isFinite(nowNs) && Number.isFinite(timer.loadTimeNs)) {
    summary.loadAgeMs = Math.round((nowNs - timer.loadTimeNs) / 1_000_000);
  }
  if (Number.isFinite(nowNs) && Number.isFinite(timer.nextIrqTimeNs)) {
    summary.nextFromNowMs = Math.round((timer.nextIrqTimeNs - nowNs) / 1_000_000);
  }
  return summary;
}

function summarizeViaInfo(viaInfo) {
  const summary = {};
  for (const [viaName, via] of Object.entries(viaInfo || {})) {
    summary[viaName] = {
      ifr: via.ifr,
      ier: via.ier,
      activeIrq: via.activeIrq,
      activeIrqNames: via.activeIrqNames || [],
      nowMs: Number.isFinite(via.nowNs) ? Math.round(via.nowNs / 1_000_000) : undefined,
      t1: summarizeViaTimer(via.timers?.t1, via.nowNs),
      t2: summarizeViaTimer(via.timers?.t2, via.nowNs),
    };
  }
  return summary;
}

function cleanHmp(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.match(/^(?:[a-z]+ ?){1,4}$/i))
    .join("\n");
}

function parseRegisters(text) {
  const registers = {};
  const patterns = [
    /\bPC\s*=\s*([0-9a-fA-F]+)/,
    /\bSR\s*=\s*([0-9a-fA-F]+)/,
    /\bD([0-7])\s*=\s*([0-9a-fA-F]+)/g,
    /\bA([0-7])\s*=\s*([0-9a-fA-F]+)/g,
  ];

  const pc = text.match(patterns[0]);
  if (pc) registers.pc = `0x${pc[1].toLowerCase().padStart(8, "0")}`;
  const sr = text.match(patterns[1]);
  if (sr) registers.sr = `0x${sr[1].toLowerCase().padStart(4, "0")}`;

  for (const regex of [patterns[2], patterns[3]]) {
    for (const match of text.matchAll(regex)) {
      const prefix = regex === patterns[2] ? "d" : "a";
      registers[`${prefix}${match[1]}`] = `0x${match[2].toLowerCase().padStart(8, "0")}`;
    }
  }

  return registers;
}

function classifyPc(pc) {
  if (!pc) return "unknown";
  const value = Number.parseInt(pc, 16);
  if (value >= 0x408008bc && value <= 0x408008d2) return "Quadra ROM VIA delay helper";
  if (value >= 0x408099b0 && value <= 0x40809a30) return "ROM trap/dispatch helper";
  if (value >= 0x408ba080 && value <= 0x408ba180) return "ROM SCSI manager path";
  if (value >= 0x40899700 && value <= 0x40899770) return "ROM ESP/SCSI status poll";
  if (value >= 0x408d1e80 && value <= 0x408d2048) return "ROM SCSI DMA/transfer path";
  if (value >= 0x40800000 && value < 0x40900000) return "Quadra ROM";
  if (value >= 0 && value < 0x100000) return "low-memory ROM/boot code";
  if (value >= 0xf9000000) return "framebuffer/NuBus";
  return "unknown";
}

function hmpClient(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const waiters = [];

  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(buffer)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(buffer);
      }
    }
  });
  socket.on("error", (error) => {
    while (waiters.length) {
      const waiter = waiters.pop();
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  });

  function waitUntil(predicate, timeoutMs) {
    if (predicate(buffer)) return Promise.resolve(buffer);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((item) => item.resolve === resolve);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for HMP response"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  async function ready() {
    await waitUntil((text) => text.includes("(qemu)"), 10000);
    buffer = "";
  }

  async function command(cmd, timeoutMs = 10000) {
    buffer = "";
    socket.write(`${cmd}\n`);
    const text = await waitUntil((payload) => payload.includes("(qemu)"), timeoutMs);
    buffer = "";
    return cleanHmp(text.replace(/\n?\(qemu\)\s*$/, ""));
  }

  function close() {
    socket.destroy();
  }

  return { command, close, ready };
}

const qemu = mustExist(
  "qemu-system-m68k",
  options.qemu ? path.resolve(options.qemu) : path.join(options.assetDir, "qemu-system-m68k"),
);
const rom = mustExist("Quadra800.ROM", path.join(options.assetDir, "Quadra800.ROM"));
const aux = mustExist("AUX3.img", path.join(options.assetDir, "AUX3.img"));
const jag = mustExist("JAG.img", path.join(options.assetDir, "JAG.img"));
const pramSource = mustExist("pram-aux.img", path.join(options.assetDir, "pram-aux.img"));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-native-qemu-"));
const monitorSocket = path.join(tmpDir, "hmp.sock");
const pram = path.join(tmpDir, "pram.img");
const traceFile = path.join(tmpDir, "trace.log");
fs.copyFileSync(pramSource, pram);

const tracePatterns = [
  "esp_get_cmd",
  "esp_do_command_phase",
  "esp_transfer_data",
  "esp_command_complete*",
  "scsi_req_parsed*",
  "scsi_req_parse_bad",
  "scsi_disk_new_request",
  "scsi_disk_dma_command_*",
];

const qemuArgs = [
  "-M", "q800",
  "-m", String(options.ram),
  "-bios", rom,
  "-display", "none",
  "-g", "1152x870x8",
  "-audio", "none",
  "-snapshot",
  "-drive", `file=${pram},format=raw,if=mtd,file.locking=off,snapshot=on`,
  "-drive", `file=${aux},media=disk,format=raw,if=none,id=hd2,file.locking=off,snapshot=on`,
  "-device", "scsi-hd,scsi-id=1,drive=hd2",
  "-drive", `file=${jag},media=disk,format=raw,if=none,id=hd3,file.locking=off,snapshot=on`,
  "-device", "scsi-hd,scsi-id=0,drive=hd3",
  "-nic", "none",
  "-S",
  "-monitor", `unix:${monitorSocket},server=on,wait=off`,
  "-serial", "none",
];

if (options.trace) {
  qemuArgs.push("-trace", `enable=${tracePatterns[0]},file=${traceFile}`);
  for (const pattern of tracePatterns.slice(1)) {
    qemuArgs.push("-trace", `enable=${pattern}`);
  }
}

const stderrChunks = [];
const child = spawn(qemu, qemuArgs, {
  cwd: options.assetDir,
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
  if (stderrChunks.length > 200) stderrChunks.splice(0, stderrChunks.length - 200);
});

let hmp = null;
const samples = [];
let errorMessage = "";
try {
  await waitFor(() => fs.existsSync(monitorSocket), 10000, "native QEMU HMP socket");
  hmp = hmpClient(monitorSocket);
  await hmp.ready();

  const initialStatus = await hmp.command("info status");
  const initialBlock = await hmp.command("info block");
  await hmp.command("cont");

  const startedAt = Date.now();
  while (Date.now() - startedAt < options.duration * 1000) {
    await delay(options.interval * 1000);
    await hmp.command("stop", 10000);
    const status = await hmp.command("info status");
    const registerText = await hmp.command("info registers", 10000);
    const viaText = options.via ? await hmp.command("info via", 10000) : "";
    const registers = parseRegisters(registerText);
    const viaInfo = options.via ? parseViaInfo(viaText) : undefined;
    const traceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
    const stderrText = stderrChunks.join("");
    const traceLines = tailLines(`${traceText}\n${stderrText}`, 40).filter((line) => /\b(esp_|scsi_)/.test(line));
    const viaLines = viaTraceLines(stderrText, 12);
    const scsiSummary = parseScsiSummary(traceLines);
    samples.push({
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      status: status.includes("running") ? "running" : "paused",
      pc: registers.pc || "",
      sr: registers.sr || "",
      phase: classifyPc(registers.pc),
      registers,
      traceTail: traceLines.slice(-20),
      scsiSummary,
      viaTrace: viaLines,
      viaInfo,
      viaSummary: options.via ? summarizeViaInfo(viaInfo) : undefined,
    });
    if (traceLines.length && !options.continueAfterScsi) {
      break;
    }
    await hmp.command("cont");
  }

  const finalTraceText = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
  const finalStderrText = stderrChunks.join("");
  const traceTail = tailLines(`${finalTraceText}\n${finalStderrText}`, 120).filter((line) => /\b(esp_|scsi_)/.test(line));
  const scsiSummary = parseScsiSummary(String(`${finalTraceText}\n${finalStderrText}`).split(/\r?\n/));
  const viaTail = viaTraceLines(finalStderrText, 80);
  const firstScsiSample = samples.find((sample) => sample.traceTail.length);
  const finalSample = samples.at(-1) || null;

  console.log(JSON.stringify({
    ok: true,
    qemu,
    ramMb: options.ram,
    durationSeconds: options.duration,
    intervalSeconds: options.interval,
    tmpDir: options.keep ? tmpDir : undefined,
    initialStatus,
    initialBlockTail: tailLines(initialBlock, 30),
    finalSample,
    finalViaSummary: finalSample?.viaSummary,
    samples,
    sawScsiTrace: traceTail.length > 0,
    firstScsiElapsedSeconds: firstScsiSample ? firstScsiSample.elapsedSeconds : null,
    scsiSummary,
    traceTail: traceTail.slice(-80),
    viaTail,
    stderrTail: tailLines(finalStderrText, 40),
    qemuArgs,
  }, null, 2));
} catch (error) {
  errorMessage = error && error.stack ? String(error.stack) : String(error);
  console.log(JSON.stringify({
    ok: false,
    error: errorMessage,
    qemu,
    ramMb: options.ram,
    tmpDir: options.keep ? tmpDir : undefined,
    samples,
    stderrTail: tailLines(stderrChunks.join(""), 80),
    qemuArgs,
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (hmp) {
    try {
      if (options.keep) {
        await hmp.command("stop", 3000).catch(() => "");
      } else {
        await hmp.command("quit", 3000).catch(() => "");
      }
    } finally {
      hmp.close();
    }
  }
  if (!options.keep) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await delay(500);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
