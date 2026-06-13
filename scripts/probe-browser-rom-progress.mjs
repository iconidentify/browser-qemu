#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlPath = path.join(root, "public", "control.local.json");
const sequencePath = path.join(root, "public", "control.local.seq");

const args = process.argv.slice(2);
const options = {
  duration: 5,
  interval: 0,
  server: "http://127.0.0.1:8088",
  timeout: 15000,
  via: false,
  run: true,
  continuousLog: false,
};

function usage() {
  console.error(`Usage:
  node scripts/probe-browser-rom-progress.mjs [--duration seconds] [--interval seconds] [--server url] [--timeout ms] [--via] [--continuous-log] [--no-run]

Examples:
  node scripts/probe-browser-rom-progress.mjs --duration 5
  node scripts/probe-browser-rom-progress.mjs --duration 30 --interval 5
  node scripts/probe-browser-rom-progress.mjs --duration 300 --interval 30 --continuous-log
  node scripts/probe-browser-rom-progress.mjs --duration 1 --via
  node scripts/probe-browser-rom-progress.mjs --no-run`);
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--duration") {
    options.duration = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--interval") {
    options.interval = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--server") {
    options.server = String(args[++index] || "").replace(/\/+$/, "");
  } else if (arg === "--timeout") {
    options.timeout = Number.parseInt(args[++index] || "", 10);
  } else if (arg === "--via") {
    options.via = true;
  } else if (arg === "--continuous-log") {
    options.continuousLog = true;
  } else if (arg === "--no-run") {
    options.run = false;
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
if (!Number.isFinite(options.interval) || options.interval < 0 || options.interval > 60) {
  console.error("--interval must be an integer from 0 to 60");
  process.exit(2);
}
if (!Number.isFinite(options.timeout) || options.timeout < 1000) {
  console.error("--timeout must be at least 1000 ms");
  process.exit(2);
}
if (options.continuousLog && options.via) {
  console.error("--continuous-log does not support --via; VIA snapshots require HMP stop/info via");
  process.exit(2);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(pathname) {
  const url = `${options.server}${pathname}${pathname.includes("?") ? "&" : "?"}ts=${Date.now()}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}`);
  return response.json();
}

async function readLogLines() {
  const payload = await readJson("/__browser-log.json");
  return Array.isArray(payload.lines) ? payload.lines : [];
}

async function readRangeStats() {
  const payload = await readJson("/__range-stats.json");
  return Array.isArray(payload.entries) ? payload.entries : [];
}

function readLastId() {
  try {
    const sequence = Number.parseInt(fs.readFileSync(sequencePath, "utf8"), 10);
    if (Number.isFinite(sequence)) return sequence;
  } catch {
    // Fall through to the queue file.
  }

  try {
    const previous = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    const commands = Array.isArray(previous.commands)
      ? previous.commands
      : Array.isArray(previous)
        ? previous
        : previous && Number.isFinite(previous.id)
          ? [previous]
          : [];
    return commands.reduce((max, command) => Math.max(max, Number.isFinite(command.id) ? command.id : 0), 0);
  } catch {
    return 0;
  }
}

function queueHmp(command, returnToGuest = false) {
  let commands = [];
  try {
    const previous = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    if (Array.isArray(previous.commands)) {
      commands = previous.commands;
    } else if (Array.isArray(previous)) {
      commands = previous;
    } else if (previous && Number.isFinite(previous.id)) {
      commands = [previous];
    }
  } catch {
    commands = [];
  }

  const payload = {
    id: Math.max(readLastId() + 1, Date.now()),
    issuedAt: new Date().toISOString(),
    type: "hmp",
    command,
    returnToGuest,
  };
  commands.push(payload);
  fs.writeFileSync(controlPath, `${JSON.stringify({ ...payload, commands }, null, 2)}\n`);
  fs.writeFileSync(sequencePath, `${payload.id}\n`);
  return payload.id;
}

function parseLastRegisters(lines) {
  const text = lines.join("\n");
  const pcMatches = Array.from(text.matchAll(/\bPC = ([0-9a-f]{8})\s+SR = ([0-9a-f]{4})/gi));
  const pcMatch = pcMatches.at(-1);
  const result = pcMatch
    ? { pc: `0x${pcMatch[1].toLowerCase()}`, sr: `0x${pcMatch[2].toLowerCase()}` }
    : { pc: "", sr: "" };

  for (const reg of ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"]) {
    const matches = Array.from(text.matchAll(new RegExp(`\\b${reg}\\s*=\\s*([0-9a-f]{8})`, "gi")));
    if (matches.length) result[reg.toLowerCase()] = `0x${matches.at(-1)[1].toLowerCase()}`;
  }
  return result;
}

function classifyPc(pc) {
  const value = Number.parseInt(String(pc).replace(/^0x/, ""), 16);
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 0x40847a60 && value <= 0x40847a90) return "Quadra ROM checksum loop";
  if (value >= 0x408008bc && value <= 0x408008d2) return "Quadra ROM VIA delay helper";
  if (value >= 0x40847fe0 && value <= 0x40848060) return "VIA interrupt wait loop";
  if (value >= 0x40848120 && value <= 0x40848258) return "VIA timing self-test";
  if (value >= 0x40848258 && value <= 0x40848298) return "VIA timing interrupt handler";
  if (value >= 0x408bd300 && value <= 0x408bd420) return "ASC/EASC startup loop";
  if (value >= 0x408ce800 && value <= 0x408ce8d0) return "ROM allocator/callback utility";
  if (value >= 0x408477c0 && value <= 0x408478c0) return "Quadra ROM RAM test";
  if (value >= 0x40809b40 && value <= 0x40809c00) return "VIA/autovector handler";
  if (value >= 0x408099b0 && value <= 0x40809a30) return "ROM trap/dispatch helper";
  if (value >= 0x408ba080 && value <= 0x408ba180) return "ROM SCSI manager path";
  if (value >= 0x40899700 && value <= 0x40899770) return "ROM ESP/SCSI status poll";
  if (value >= 0x408d1e80 && value <= 0x408d2048) return "ROM SCSI DMA/transfer path";
  if (value < 0x01000000) return "low-memory ROM/boot code";
  return "unclassified ROM path";
}

function parseLastStatus(lines) {
  const statuses = lines
    .map((line) => line.match(/VM status:\s*(.+)$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
  return statuses.at(-1) || "";
}

function parseViaTrace(lines) {
  return lines.filter((line) => line.includes("[c89-via1")).slice(-8);
}

function cleanQemuLine(line) {
  return String(line)
    .replace(/^\[[^\]]+\]\s+qemu stdio:\s?/, "")
    .trimEnd();
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
  const names = viaName === "via1" ? via1Names : via2Names;
  return names
    .filter(([mask]) => (active & mask) !== 0)
    .map(([, name]) => name);
}

function finalizeViaInfo(result) {
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

function parseViaInfo(lines) {
  const result = {};
  let current = null;
  let currentTimer = null;

  for (const rawLine of lines) {
    const line = cleanQemuLine(rawLine).trim();
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

  return finalizeViaInfo(result);
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

function parseScsiTrace(lines) {
  return lines
    .filter((line) => /\b(esp_|scsi_)/.test(line))
    .filter((line) => !line.includes("qemu trace enabled:") && !line.includes("qemu args:"))
    .slice(-12);
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

function parseTraceFields(line) {
  return Object.fromEntries(
    Array.from(String(line).matchAll(/\b([a-z][a-z0-9_-]*)=([^ ]+)/gi))
      .map((match) => [match[1], match[2]]),
  );
}

function compactEspTraceLine(line) {
  const fields = parseTraceFields(line);
  return {
    t: (String(line).match(/^\[([^\]]+)/) || [])[1],
    event: fields.event,
    reg: fields.reg,
    val: fields.val,
    busid: fields.busid,
    sel: fields.sel,
    dev: fields.dev,
    lun: fields.lun,
    req: fields.req,
    req_lun: fields.req_lun,
    stat: fields.stat,
    intr: fields.intr,
    seq: fields.seq,
    tc: fields.tc,
    stc: fields.stc,
    ti_size: fields.ti_size,
    async: fields.async,
    dma: fields.dma,
    dma_en: fields.dma_en,
    ti_cmd: fields.ti_cmd,
    ready: fields.ready,
    pdma: fields.pdma,
    dma_cb: fields.dma_cb,
    fifo: fields.fifo,
    cmdfifo: fields.cmdfifo,
    cur: fields.cur,
    repeat: fields.repeat,
  };
}

function parseEspTrace(lines) {
  const espLines = lines.filter((line) => line.includes("[c89-esp]"));
  if (!espLines.length) return { count: 0, eventCounts: {}, tail: [] };

  const eventCounts = new Map();
  const lastByEvent = {};
  for (const line of espLines) {
    const fields = parseTraceFields(line);
    const event = fields.event || "unknown";
    eventCounts.set(event, (eventCounts.get(event) || 0) + 1);
    lastByEvent[event] = compactEspTraceLine(line);
  }

  const keepEvents = new Set([
    "transfer-data-enter",
    "transfer-data-ready",
    "transfer-data-defer-ti",
    "select-enter",
    "select-hit",
    "select-miss",
    "get-cmd",
    "message-identify",
    "command-phase-enter",
    "command-phase-empty",
    "command-phase-cdb",
    "command-phase-req",
    "command-phase-enqueue",
    "handle-ti-enter",
    "handle-ti-after-dma",
    "pdma-read",
    "pdma-write",
    "pdma-cb-enter",
    "pdma-cb-exit",
    "dma-done",
    "read",
    "write-before",
    "write-after",
    "raise-irq",
    "lower-irq",
    "raise-drq",
    "lower-drq",
  ]);

  const repeatedStatus = espLines
    .filter((line) => line.includes("event=read reg=RSTAT"))
    .slice(-8)
    .map(compactEspTraceLine);

  return {
    count: espLines.length,
    eventCounts: Object.fromEntries([...eventCounts.entries()].sort((a, b) => b[1] - a[1])),
    first: compactEspTraceLine(espLines[0]),
    last: compactEspTraceLine(espLines.at(-1)),
    lastByEvent: Object.fromEntries(
      Object.entries(lastByEvent).filter(([event]) => keepEvents.has(event)),
    ),
    repeatedStatus,
    tail: espLines.slice(-16).map(compactEspTraceLine),
  };
}

function parseM68kPcTrace(lines) {
  return lines
    .filter((line) => line.includes("[c89-m68k-pc]"))
    .slice(-24)
    .map((line) => {
      const fields = Object.fromEntries(
        Array.from(line.matchAll(/\b([a-z][a-z0-9]*)=(0x[0-9a-f]+|[0-9]+|[a-z-]+)/gi))
          .map((match) => [match[1], match[2]]),
      );
      return {
        tb: fields.tb ? Number.parseInt(fields.tb, 10) : undefined,
        pc: fields.pc,
        phase: fields.phase,
        sr: fields.sr,
        d0: fields.d0,
        d1: fields.d1,
        d6: fields.d6,
        d7: fields.d7,
        a4: fields.a4,
        a6: fields.a6,
        a7: fields.a7,
        repeat: fields.repeat ? Number.parseInt(fields.repeat, 10) : undefined,
        line,
      };
    });
}

function summarizeRangeEntry(entry) {
  const name = String(entry.path || "").split("/").pop() || entry.path || "unknown";
  const starts = Array.isArray(entry.lastRanges)
    ? [...new Set(entry.lastRanges.map((range) => range && range.start).filter((start) => Number.isFinite(start)))]
    : [];
  const nonZeroStarts = starts.filter((start) => start !== 0);
  return {
    name,
    rangeGet: entry.rangeGet || 0,
    rangeBytes: entry.rangeBytes || 0,
    uniqueStarts: starts.slice(-6),
    nonZeroStarts: nonZeroStarts.slice(-6),
  };
}

function hasNonZeroDiskRead(disks) {
  return disks.some((disk) => Array.isArray(disk.nonZeroStarts) && disk.nonZeroStarts.length > 0);
}

async function waitForProbeResult(startLineCount) {
  const startedAt = Date.now();
  let lastLines = [];
  while (Date.now() - startedAt < options.timeout) {
    lastLines = await readLogLines();
    const newLines = lastLines.slice(startLineCount);
    const viaInfo = options.via ? parseViaInfo(newLines) : {};
    if (
      newLines.some((line) => line.includes("VM status: paused")) &&
      newLines.some((line) => /\bPC = [0-9a-f]{8}\s+SR = [0-9a-f]{4}/i.test(line)) &&
      (!options.via || (viaInfo.via1?.activeIrq && viaInfo.via2?.registers?.ifr))
    ) {
      return lastLines;
    }
    await delay(500);
  }
  return lastLines;
}

const initialLines = await readLogLines();
let startLineCount = initialLines.length;
const samples = [];

async function queuePauseInspection(includeInitial = false) {
  if (includeInitial) {
    queueHmp("info status", false);
    queueHmp("info block", false);
  }
  queueHmp("stop", false);
  await delay(1000);
  queueHmp("info status", false);
  queueHmp("info registers", false);
  queueHmp("info block", false);
  if (options.via) queueHmp("info via", false);
}

async function collectSample(elapsedSeconds, includeInitial = false) {
  await queuePauseInspection(includeInitial);
  const lines = await waitForProbeResult(startLineCount);
  const stats = await readRangeStats();
  const registers = parseLastRegisters(lines);
  const newLines = lines.slice(startLineCount);
  const sampleLines = newLines.length ? newLines : lines;
  const disks = stats.map(summarizeRangeEntry);
  const viaInfo = parseViaInfo(sampleLines);
  const sample = {
    elapsedSeconds,
    status: parseLastStatus(lines),
    pc: registers.pc,
    sr: registers.sr,
    phase: classifyPc(registers.pc),
    registers: {
      d0: registers.d0,
      d1: registers.d1,
      d3: registers.d3,
      d4: registers.d4,
      d5: registers.d5,
      d6: registers.d6,
      d7: registers.d7,
      a0: registers.a0,
      a1: registers.a1,
      a2: registers.a2,
      a3: registers.a3,
      a4: registers.a4,
      a5: registers.a5,
      a7: registers.a7,
    },
    disks,
    viaTrace: parseViaTrace(sampleLines),
    viaInfo,
    viaSummary: summarizeViaInfo(viaInfo),
    traceTail: parseScsiTrace(sampleLines),
    scsiSummary: parseScsiSummary(sampleLines),
    espTrace: parseEspTrace(sampleLines),
    m68kPcTrace: parseM68kPcTrace(sampleLines),
    sawScsiTrace: parseScsiTrace(lines).length > 0,
    nonZeroDiskRead: hasNonZeroDiskRead(disks),
  };
  samples.push(sample);
  startLineCount = lines.length;
  return { lines, sample };
}

async function collectContinuousLogSample(elapsedSeconds) {
  const currentLines = await readLogLines();
  const stats = await readRangeStats();
  const registers = parseLastRegisters(currentLines);
  const newLines = currentLines.slice(startLineCount);
  const sampleLines = newLines.length ? newLines : currentLines;
  const disks = stats.map(summarizeRangeEntry);
  const viaInfo = {};
  const sample = {
    elapsedSeconds,
    mode: "continuous-log",
    status: parseLastStatus(currentLines) || "running/uninspected",
    pc: registers.pc,
    sr: registers.sr,
    phase: classifyPc(registers.pc),
    registers: {
      d0: registers.d0,
      d1: registers.d1,
      d3: registers.d3,
      d4: registers.d4,
      d5: registers.d5,
      d6: registers.d6,
      d7: registers.d7,
      a0: registers.a0,
      a1: registers.a1,
      a2: registers.a2,
      a3: registers.a3,
      a4: registers.a4,
      a5: registers.a5,
      a7: registers.a7,
    },
    disks,
    viaTrace: [],
    viaInfo,
    viaSummary: summarizeViaInfo(viaInfo),
    traceTail: parseScsiTrace(sampleLines),
    scsiSummary: parseScsiSummary(sampleLines),
    espTrace: parseEspTrace(sampleLines),
    m68kPcTrace: parseM68kPcTrace(sampleLines),
    sawScsiTrace: parseScsiTrace(currentLines).length > 0,
    nonZeroDiskRead: hasNonZeroDiskRead(disks),
    logLineCount: currentLines.length,
  };
  samples.push(sample);
  startLineCount = currentLines.length;
  return { lines: currentLines, sample };
}

let lines = initialLines;

if (options.run) {
  const useSeries = options.interval > 0 && options.interval < options.duration;
  const startedAt = Date.now();

  queueHmp("info status", false);
  queueHmp("info block", false);
  queueHmp("cont", true);

  if (options.continuousLog) {
    while (Date.now() - startedAt < options.duration * 1000) {
      const elapsedBeforeDelay = Date.now() - startedAt;
      const remainingMs = Math.max(0, options.duration * 1000 - elapsedBeforeDelay);
      const delayMs = useSeries ? Math.min(options.interval * 1000, remainingMs) : remainingMs;
      await delay(delayMs);
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const result = await collectContinuousLogSample(elapsedSeconds);
      lines = result.lines;
      if (!useSeries || elapsedSeconds >= options.duration) {
        break;
      }
    }
    const result = await collectSample(options.duration);
    result.sample.mode = "continuous-final-stop-inspection";
    lines = result.lines;
  } else if (useSeries) {
    while (Date.now() - startedAt < options.duration * 1000) {
      const elapsedBeforeDelay = Date.now() - startedAt;
      const remainingMs = Math.max(0, options.duration * 1000 - elapsedBeforeDelay);
      await delay(Math.min(options.interval * 1000, remainingMs));
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const result = await collectSample(elapsedSeconds);
      lines = result.lines;
      if (elapsedSeconds >= options.duration) {
        break;
      }
      queueHmp("cont", true);
    }
  } else {
    await delay(options.duration * 1000);
    const result = await collectSample(options.duration);
    lines = result.lines;
  }
}

const stats = await readRangeStats();
const registers = parseLastRegisters(lines);
const newLines = lines.slice(startLineCount);
const disks = stats.map(summarizeRangeEntry);
const traceTail = parseScsiTrace(lines);
const finalSample = samples.at(-1);
const scsiSummary = parseScsiSummary(lines);
const viaTrace = finalSample?.viaTrace || parseViaTrace(newLines.length ? newLines : lines);
const viaInfo = finalSample?.viaInfo || parseViaInfo(newLines.length ? newLines : lines);
const viaSummary = finalSample?.viaSummary || summarizeViaInfo(viaInfo);
const espTrace = finalSample?.espTrace || parseEspTrace(newLines.length ? newLines : lines);
const m68kPcTrace = finalSample?.m68kPcTrace || parseM68kPcTrace(newLines.length ? newLines : lines);

const summary = {
  durationSeconds: options.run ? options.duration : 0,
  intervalSeconds: options.interval,
  status: finalSample?.status || parseLastStatus(lines),
  pc: finalSample?.pc || registers.pc,
  sr: finalSample?.sr || registers.sr,
  phase: finalSample?.phase || classifyPc(registers.pc),
  registers: {
    d0: registers.d0,
    d1: registers.d1,
    d3: registers.d3,
    d4: registers.d4,
    d5: registers.d5,
    d6: registers.d6,
    d7: registers.d7,
    a0: registers.a0,
    a1: registers.a1,
    a2: registers.a2,
    a3: registers.a3,
    a4: registers.a4,
    a5: registers.a5,
    a7: registers.a7,
  },
  disks,
  viaTrace,
  viaInfo,
  viaSummary,
  traceTail,
  scsiSummary,
  espTrace,
  m68kPcTrace,
  sawScsiTrace: traceTail.length > 0,
  nonZeroDiskRead: hasNonZeroDiskRead(disks),
  samples,
};

console.log(JSON.stringify(summary, null, 2));
