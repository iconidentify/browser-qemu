#!/usr/bin/env node
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const opts = {
  port: Number(process.env.PORT || 8088),
  tail: 40,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--tail") {
    opts.tail = Number(process.argv[++i] || opts.tail);
  } else if (arg === "--port") {
    opts.port = Number(process.argv[++i] || opts.port);
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: node scripts/browser-doctor.mjs [--port 8088] [--tail 40]");
    process.exit(0);
  }
}

function mbFromKb(kb) {
  return `${Math.round(kb / 1024)}MB`;
}

function gbFromKb(kb) {
  return `${(kb / 1048576).toFixed(1)}GB`;
}

function compactArgs(args) {
  return args.replace(/\s+/g, " ").slice(0, 160);
}

async function readProcesses() {
  const { stdout } = await execFileAsync("ps", [
    "-axo",
    "pid=,pcpu=,pmem=,rss=,comm=,args=",
  ]);
  return stdout
    .trim()
    .split(/\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        pcpu: Number(match[2]),
        pmem: Number(match[3]),
        rssKb: Number(match[4]),
        comm: match[5],
        args: match[6],
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.pcpu - a.pcpu);
}

function classify(proc) {
  const args = proc.args;
  if (args.includes("qemu-system-m68k")) return "native-qemu";
  if (args.includes("serve_with_headers.py")) return "dev-server";
  if (args.includes("Google Chrome") && args.includes("c89-login-chrome")) return "login-watch-chrome";
  if (args.includes("Google Chrome") && args.includes("c89-aux-chrome")) return "browser-qemu-chrome";
  if (args.includes("Google Chrome") && args.includes("remote-debugging-port")) return "debug-chrome";
  if (args.includes("Google Chrome") && proc.pcpu >= 10) return "chrome";
  if (args.includes("Codex (Renderer)")) return "codex-renderer";
  if (args.includes("WindowServer")) return "window-server";
  return "";
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("  none");
    return;
  }
  for (const proc of rows) {
    const label = classify(proc) || "process";
    console.log(
      `  ${String(proc.pid).padStart(6)}  ${String(proc.pcpu.toFixed(1)).padStart(6)}% cpu  ${String(mbFromKb(proc.rssKb)).padStart(7)}  ${label.padEnd(19)} ${compactArgs(proc.args)}`,
    );
  }
}

async function readBrowserLog() {
  const path = `/__browser-log.json?tail=${encodeURIComponent(opts.tail)}&ts=${Date.now()}`;
  return readJsonEndpoint(path);
}

async function readSessionInfo() {
  return readJsonEndpoint(`/__session.json?ts=${Date.now()}`);
}

async function readJsonEndpoint(path) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port: opts.port, path, timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          resolve({ error: `could not parse browser log JSON: ${err.message}` });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "browser log request timed out" });
    });
    req.on("error", (err) => {
      resolve({ error: err.message });
    });
  });
}

async function readDiskUsage(target = process.cwd()) {
  try {
    const { stdout } = await execFileAsync("df", ["-k", target]);
    const lines = stdout.trim().split(/\n/);
    const line = lines[lines.length - 1] || "";
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) throw new Error(`unexpected df output: ${line}`);
    return {
      filesystem: fields[0],
      sizeKb: Number(fields[1]) || 0,
      usedKb: Number(fields[2]) || 0,
      availableKb: Number(fields[3]) || 0,
      capacity: fields[4] || "",
      mount: fields.slice(8).join(" ") || fields[5] || "",
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function latestHealthLine(lines = []) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const match = line.match(/health worker: mainAge=(\d+)ms beat=(\d+) beatChanged=(\d+) flags=([^\s]+)/);
    if (match) {
      return {
        line,
        mainAgeMs: Number(match[1]),
        beat: Number(match[2]),
        beatChanged: match[3] === "1",
        flags: match[4],
      };
    }
  }
  return null;
}

const processes = await readProcesses();
const watched = processes.filter((proc) => classify(proc));
const high = processes.filter((proc) => proc.pcpu >= 75).slice(0, 12);
const diskUsage = await readDiskUsage();
const browserLog = await readBrowserLog();
const sessionInfo = await readSessionInfo();
const health = latestHealthLine(browserLog.lines || []);

console.log("browser-qemu doctor");
console.log(`port=${opts.port} tail=${opts.tail}`);
printTable("hot processes", high.length ? high : processes.slice(0, 10));
printTable("watched browser-qemu-related processes", watched);

console.log("\ndisk pressure");
if (diskUsage.error) {
  console.log(`  unavailable: ${diskUsage.error}`);
} else {
  console.log(
    `  ${diskUsage.mount}: ${gbFromKb(diskUsage.availableKb)} free, ` +
      `${gbFromKb(diskUsage.usedKb)} used, ${diskUsage.capacity} full`
  );
}

console.log("\npage health");
if (!health) {
  console.log("  no health-worker samples in mirrored log yet");
} else {
  console.log(`  mainAge=${health.mainAgeMs}ms beat=${health.beat} flags=${health.flags}`);
}

console.log("\nsession guard");
if (sessionInfo.error) {
  console.log(`  unavailable: ${sessionInfo.error}`);
} else {
  console.log(`  running=${sessionInfo.runningCount || 0} leader=${sessionInfo.leaderId || "none"}`);
  for (const session of (sessionInfo.sessions || [])) {
    const leader = session.id === sessionInfo.leaderId ? " leader" : "";
    const paused = session.pausedByGuard ? " paused-by-guard" : "";
    const visible = session.visible ? " visible" : " hidden";
    console.log(
      `  ${String(session.id).slice(0, 8)}${leader}${visible}${paused} ` +
      `qemu=${session.qemuStarted ? "on" : "off"} pulse=${session.pulseRunActive ? "on" : "off"} ` +
      `hb=${session.heartbeat || 0} frames=${session.framesRendered || 0}`
    );
  }
}

const nativeQemuHot = watched.some((proc) => classify(proc) === "native-qemu" && proc.pcpu >= 75);
const rendererHot = watched.filter((proc) => /chrome|renderer/.test(classify(proc)) && proc.pcpu >= 75);
if (nativeQemuHot) {
  console.log("\nNOTE: native desktop qemu-system-m68k is consuming about one CPU core.");
}
if (rendererHot.length >= 2) {
  console.log("NOTE: multiple browser/Codex renderers are hot at the same time; manual Chrome can feel frozen even if the page heartbeat is healthy.");
}
if (!diskUsage.error && (diskUsage.availableKb < 20 * 1048576 || /^(9[5-9]|100)%$/.test(diskUsage.capacity))) {
  console.log("NOTE: disk headroom is low; Chrome temp profiles, caches, and wasm artifacts get less forgiving here.");
}
if (health && health.mainAgeMs >= 2500) {
  console.log("NOTE: the browser-qemu UI main thread was stalled in the last health sample.");
}
if (!sessionInfo.error && (sessionInfo.runningCount || 0) > 1) {
  console.log("NOTE: more than one browser-QEMU session is live; the session guard should pause non-leaders.");
}
if (!high.length) {
  console.log("\nNOTE: no process is currently above 75% CPU.");
}

console.log("\nmirrored browser log");
if (browserLog.error) {
  console.log(`  unavailable: ${browserLog.error}`);
} else if (!browserLog.lines?.length) {
  console.log("  empty");
} else {
  for (const line of browserLog.lines.slice(-opts.tail)) {
    console.log(`  ${line}`);
  }
}
