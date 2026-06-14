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

const processes = await readProcesses();
const watched = processes.filter((proc) => classify(proc));
const high = processes.filter((proc) => proc.pcpu >= 75).slice(0, 12);

console.log("browser-qemu doctor");
console.log(`port=${opts.port} tail=${opts.tail}`);
printTable("hot processes", high.length ? high : processes.slice(0, 10));
printTable("watched browser-qemu-related processes", watched);

const nativeQemuHot = watched.some((proc) => classify(proc) === "native-qemu" && proc.pcpu >= 75);
const rendererHot = watched.filter((proc) => /chrome|renderer/.test(classify(proc)) && proc.pcpu >= 75);
if (nativeQemuHot) {
  console.log("\nNOTE: native desktop qemu-system-m68k is consuming about one CPU core.");
}
if (rendererHot.length >= 2) {
  console.log("NOTE: multiple browser/Codex renderers are hot at the same time; manual Chrome can feel frozen even if the page heartbeat is healthy.");
}
if (!high.length) {
  console.log("\nNOTE: no process is currently above 75% CPU.");
}

const browserLog = await readBrowserLog();
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
