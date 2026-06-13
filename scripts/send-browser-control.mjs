#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const controlPath = path.join(root, "public", "control.local.json");
const sequencePath = path.join(root, "public", "control.local.seq");
const args = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  node scripts/send-browser-control.mjs hmp <command...> [--stay-monitor]
  node scripts/send-browser-control.mjs key <qemu-key>
  node scripts/send-browser-control.mjs pulse start [--interval-ms 30000]
  node scripts/send-browser-control.mjs pulse stop

Examples:
  node scripts/send-browser-control.mjs hmp help --stay-monitor
  node scripts/send-browser-control.mjs key a
  node scripts/send-browser-control.mjs key ret
  node scripts/send-browser-control.mjs pulse start --interval-ms 30000
  node scripts/send-browser-control.mjs pulse stop`);
}

function readLastId() {
  try {
    const sequence = Number.parseInt(fs.readFileSync(sequencePath, "utf8"), 10);
    if (Number.isFinite(sequence)) return sequence;
  } catch {
    // Fall through to the queue file for older checkouts.
  }

  try {
    const previous = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    if (Array.isArray(previous.commands)) {
      return previous.commands.reduce((max, command) => {
        return Math.max(max, Number.isFinite(command.id) ? command.id : 0);
      }, 0);
    }
    if (Array.isArray(previous)) {
      return previous.reduce((max, command) => {
        return Math.max(max, Number.isFinite(command.id) ? command.id : 0);
      }, 0);
    }
    return Number.isFinite(previous.id) ? previous.id : 0;
  } catch {
    return 0;
  }
}

function writeCommand(command) {
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

  const lastId = readLastId();
  const payload = {
    id: Math.max(lastId + 1, Date.now()),
    issuedAt: new Date().toISOString(),
    ...command,
  };
  commands.push(payload);
  fs.writeFileSync(controlPath, `${JSON.stringify({ ...payload, commands }, null, 2)}\n`);
  fs.writeFileSync(sequencePath, `${payload.id}\n`);
  console.log(`queued browser control command ${payload.id} in ${controlPath}`);
  console.log(JSON.stringify(payload));
  console.log("QEMU output appears in the browser Serial panel after the running page polls this file.");
}

const mode = args.shift();
if (mode === "hmp") {
  const stayMonitorIndex = args.indexOf("--stay-monitor");
  const returnToGuest = stayMonitorIndex === -1;
  if (stayMonitorIndex !== -1) args.splice(stayMonitorIndex, 1);
  const command = args.join(" ").trim();
  if (!command) {
    usage();
    process.exit(2);
  }
  writeCommand({ type: "hmp", command, returnToGuest });
} else if (mode === "key") {
  const key = args[0];
  if (!key) {
    usage();
    process.exit(2);
  }
  writeCommand({ type: "key", key });
} else if (mode === "pulse") {
  const action = args.shift();
  if (action === "start") {
    let intervalMs = 30000;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--interval-ms" || arg === "--interval") {
        const value = Number.parseInt(args[index + 1] || "", 10);
        if (!Number.isFinite(value) || value <= 0) {
          console.error(`${arg} must be a positive integer`);
          process.exit(2);
        }
        intervalMs = value;
        index += 1;
      } else {
        usage();
        process.exit(2);
      }
    }
    writeCommand({ type: "pulse", action: "start", intervalMs });
  } else if (action === "stop") {
    if (args.length) {
      usage();
      process.exit(2);
    }
    writeCommand({ type: "pulse", action: "stop" });
  } else {
    usage();
    process.exit(2);
  }
} else {
  usage();
  process.exit(2);
}
