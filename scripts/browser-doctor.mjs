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
  if (args.includes("mediaanalysisd") || args.includes("photoanalysisd")) return "media-analysis";
  if (args.includes("mdworker") || args.includes("mds_stores") || args.includes(" mds ") || args.includes("mdbulkimport")) return "spotlight";
  if (args.includes("syspolicyd")) return "system-policy";
  if (args.includes("com.apple.Virtualization.VirtualMachine")) return "apple-virtualization";
  if (args.includes("Docker.app") || args.includes("com.docker.") || args.includes("docker exec")) return "docker";
  if (args.includes("claude ")) return "claude";
  if (args.includes("WindowServer")) return "window-server";
  if (args.includes("DesktopServicesHelper")) return "desktop-services";
  if (args.includes("Finder.app")) return "finder";
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

async function readBrowserLogHistory() {
  const tail = Math.max(opts.tail, 1000);
  const path = `/__browser-log-history.json?tail=${encodeURIComponent(tail)}&ts=${Date.now()}`;
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

function latestMatchingLine(lines = [], pattern) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (pattern.test(lines[i])) return lines[i];
  }
  return "";
}

function parseLineTime(line, now = new Date()) {
  const match = String(line || "").match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (!match) return null;
  const date = new Date(now);
  // Browser log lines use new Date().toISOString().slice(11, 19), so the
  // bracketed wall clock is UTC even when this doctor runs in local time.
  date.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
  if (date.getTime() - now.getTime() > 3600_000) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date;
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${(ms / 3600_000).toFixed(1)}h ago`;
}

const processes = await readProcesses();
const watched = processes.filter((proc) => classify(proc));
const high = processes.filter((proc) => proc.pcpu >= 75).slice(0, 12);
const diskUsage = await readDiskUsage();
const browserLog = await readBrowserLog();
const browserHistory = await readBrowserLogHistory();
const sessionInfo = await readSessionInfo();
const browserLines = browserLog.lines || [];
const historyLines = browserHistory.lines || [];
const forensicLines = historyLines.length ? historyLines : browserLines;
const health = latestHealthLine(forensicLines);
const latestLine = forensicLines[forensicLines.length - 1] || "";
const latestLineTime = parseLineTime(latestLine);
const latestLineAgeMs = latestLineTime ? Date.now() - latestLineTime.getTime() : NaN;
const latestPagehide = latestMatchingLine(forensicLines, /breadcrumb (?:pagehide|hidden|visibility-hidden)/);
const latestPressure = latestMatchingLine(forensicLines, /(?:ui pressure|pressure-relief|health worker: mainAge=\d{4,})/);
const latestBreadcrumb = latestMatchingLine(forensicLines, /breadcrumb /);

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
console.log(`  mirrored memory log lines=${browserLog.count ?? browserLines.length}`);
if (browserHistory.error) {
  console.log(`  persistent log unavailable: ${browserHistory.error}`);
} else {
  console.log(
    `  persistent log ${browserHistory.path || "n/a"} lines=${browserHistory.count || 0}` +
      `${browserHistory.truncated ? " (tail truncated)" : ""}`
  );
}
if (!health) {
  console.log("  no health-worker samples in mirrored log yet");
} else {
  console.log(`  mainAge=${health.mainAgeMs}ms beat=${health.beat} flags=${health.flags}`);
}
if (latestLine) {
  console.log(`  latest log: ${formatAge(latestLineAgeMs)} ${latestLine.slice(0, 140)}`);
}
if (latestPagehide) {
  console.log(`  latest close/hide marker: ${latestPagehide.slice(0, 160)}`);
}
if (latestPressure) {
  console.log(`  latest pressure marker: ${latestPressure.slice(0, 160)}`);
}
if (latestBreadcrumb && latestBreadcrumb !== latestPressure && latestBreadcrumb !== latestPagehide) {
  console.log(`  latest breadcrumb: ${latestBreadcrumb.slice(0, 160)}`);
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
if (watched.some((proc) => classify(proc) === "apple-virtualization" && proc.pcpu >= 75)) {
  console.log("NOTE: an Apple Virtualization VM is consuming about one CPU core; headed browser-QEMU testing will feel worse until that load drops.");
}
if (watched.some((proc) => classify(proc) === "desktop-services" && proc.pcpu >= 75)) {
  console.log("NOTE: macOS DesktopServicesHelper is hot; Finder/file-provider work can starve headed Chrome even when browser-QEMU itself is healthy.");
}
if (watched.some((proc) => classify(proc) === "window-server" && proc.pcpu >= 50)) {
  console.log("NOTE: WindowServer is hot; compositor pressure can make pointer/canvas interaction feel worse than the page heartbeat suggests.");
}
const spotlightCpu = watched
  .filter((proc) => classify(proc) === "spotlight")
  .reduce((sum, proc) => sum + proc.pcpu, 0);
if (spotlightCpu >= 50) {
  console.log(`NOTE: Spotlight workers are consuming about ${spotlightCpu.toFixed(0)}% CPU combined; wait for indexing to settle before judging headed feel.`);
}
if (!diskUsage.error && (diskUsage.availableKb < 20 * 1048576 || /^(9[5-9]|100)%$/.test(diskUsage.capacity))) {
  console.log("NOTE: disk headroom is low; Chrome temp profiles, caches, and wasm artifacts get less forgiving here.");
}
if (health && health.mainAgeMs >= 2500) {
  console.log("NOTE: the browser-qemu UI main thread was stalled in the last health sample.");
}
if (!sessionInfo.error && (sessionInfo.runningCount || 0) === 0 && health && /qemu/.test(health.flags)) {
  console.log("NOTE: the latest health sample is from a closed/stale tab; use it as postmortem evidence, not a live page status.");
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

if (!browserHistory.error && browserHistory.lines?.length) {
  console.log("\npersistent browser log history");
  for (const line of browserHistory.lines.slice(-Math.min(opts.tail, 80))) {
    console.log(`  ${line}`);
  }
}
