#!/usr/bin/env node
// Boot A/UX to the Classic Mac login dialog, type credentials through the real
// browser input path, then watch page responsiveness during the logged-in
// session. This targets the headed-only "Chrome gets hot after login" failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const opts = {
  chrome: process.env.CHROME || defaultChrome,
  server: "http://127.0.0.1:8088",
  url: "",
  outDir: path.join(root, "build", "login-watch"),
  readyTimeoutSec: 420,
  minLoginSec: 90,
  watchSecs: 360,
  snapshotIntervalSec: 30,
  stock: true,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--url") opts.url = argv[++i] || "";
  else if (arg === "--server") opts.server = String(argv[++i] || "").replace(/\/+$/, "");
  else if (arg === "--out-dir") opts.outDir = argv[++i] || opts.outDir;
  else if (arg === "--ready-timeout") opts.readyTimeoutSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--min-login-sec") opts.minLoginSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--watch-secs") opts.watchSecs = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--snapshot-interval") opts.snapshotIntervalSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--headless") opts.stock = false;
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!opts.url) {
  opts.url = `${opts.server}/?build=login-watch&ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(payload) {
  console.log(JSON.stringify(payload));
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.json();
      lastError = new Error(`${url} HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError || new Error(`timeout waiting for ${url}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP connect timeout")), 10000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP websocket error"));
    }, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(new Error(`${request.method}: ${message.error.message || JSON.stringify(message.error)}`));
    } else {
      request.resolve(message.result || {});
    }
  });

  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(requestId, { method, resolve, reject, timeout });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });

  return { ws, send };
}

async function evalQuick(cdp, expression, timeoutMs = 3000) {
  const started = Date.now();
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    }, timeoutMs);
    return {
      ok: true,
      ms: Date.now() - started,
      value: result.result ? result.result.value : null,
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: String(error && error.message ? error.message : error),
    };
  }
}

async function readProbe(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const node = document.getElementById("probeState");
    if (!node || !node.textContent) return null;
    try { return JSON.parse(node.textContent); } catch { return null; }
  })()`);
  return result.value || null;
}

async function screenshot(cdp, name) {
  try {
    const result = await cdp.send("Page.captureScreenshot", { format: "png" }, 10000);
    fs.writeFileSync(path.join(opts.outDir, name), Buffer.from(result.data, "base64"));
  } catch {
    // Keep the watcher alive; screenshots are supporting evidence.
  }
}

async function sampleCanvasState(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const w = canvas.width;
    const h = canvas.height;
    if (w < 64 || h < 64) return null;
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;
    let nonBlack = 0;
    let white = 0;
    let black = 0;
    let gray = 0;
    let menuWhite = 0;
    let menuSamples = 0;
    let centerInk = 0;
    let centerSamples = 0;
    let checksum = 2166136261 >>> 0;

    function pixelAt(x, y) {
      const i = (y * w + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    }

    const step = Math.max(1, Math.floor(Math.min(w, h) / 160));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const [r, g, b, a] = pixelAt(x, y);
        if (a > 16 && (r > 4 || g > 4 || b > 4)) nonBlack += 1;
        if (a > 16 && r > 235 && g > 235 && b > 235) white += 1;
        if (a > 16 && r < 24 && g < 24 && b < 24) black += 1;
        if (a > 16 && Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4 && r >= 90 && r <= 230) gray += 1;
        checksum ^= ((r << 16) ^ (g << 8) ^ b ^ (x * 131) ^ (y * 313)) >>> 0;
        checksum = Math.imul(checksum, 16777619) >>> 0;
      }
    }

    for (let y = 0; y < Math.min(24, h); y += 1) {
      for (let x = 0; x < w; x += 2) {
        const [r, g, b, a] = pixelAt(x, y);
        menuSamples += 1;
        if (a > 16 && r > 235 && g > 235 && b > 235) menuWhite += 1;
      }
    }

    const cx0 = Math.max(0, Math.floor(w / 2) - 32);
    const cx1 = Math.min(w, Math.floor(w / 2) + 32);
    const cy0 = Math.max(0, Math.floor(h / 2) - 32);
    const cy1 = Math.min(h, Math.floor(h / 2) + 32);
    for (let y = cy0; y < cy1; y += 1) {
      for (let x = cx0; x < cx1; x += 1) {
        const [r, g, b, a] = pixelAt(x, y);
        centerSamples += 1;
        if (a > 16 && ((r < 32 && g < 32 && b < 32) || (r > 235 && g > 235 && b > 235))) {
          centerInk += 1;
        }
      }
    }

    const samples = Math.max(1, Math.ceil(w / step) * Math.ceil(h / step));
    const menuWhitePct = menuWhite / Math.max(1, menuSamples);
    const centerInkPct = centerInk / Math.max(1, centerSamples);
    const classification = menuWhitePct > 0.55
      ? "classic-mac-surface"
      : gray / samples > 0.55
        ? "gray-transition"
        : nonBlack / samples > 0.25
          ? "active-framebuffer"
          : "dark-or-empty";
    return {
      width: w,
      height: h,
      checksum: "0x" + checksum.toString(16).padStart(8, "0"),
      nonBlackPct: Math.round(nonBlack * 1000 / samples) / 10,
      whitePct: Math.round(white * 1000 / samples) / 10,
      blackPct: Math.round(black * 1000 / samples) / 10,
      grayPct: Math.round(gray * 1000 / samples) / 10,
      menuWhitePct: Math.round(menuWhitePct * 1000) / 10,
      centerInkPct: Math.round(centerInkPct * 1000) / 10,
      classification,
    };
  })()`);
  return result.value || null;
}

async function canvasClientPoint(cdp, guestX, guestY) {
  const result = await evalQuick(cdp, `(() => {
    if (window.AuxQemuProbe && typeof window.AuxQemuProbe.clientPointForGuest === "function") {
      const mapped = window.AuxQemuProbe.clientPointForGuest(${Math.trunc(guestX)}, ${Math.trunc(guestY)});
      if (mapped) return { x: mapped.clientX, y: mapped.clientY, mapped };
    }
    const canvas = document.getElementById("canvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ${Math.trunc(guestX)} * rect.width / Math.max(1, canvas.width),
      y: rect.top + ${Math.trunc(guestY)} * rect.height / Math.max(1, canvas.height),
      fallback: true
    };
  })()`);
  if (!result.value) throw new Error("canvas rect unavailable");
  return {
    x: Math.round(result.value.x),
    y: Math.round(result.value.y),
  };
}

async function clickGuest(cdp, guestX, guestY) {
  const point = await canvasClientPoint(cdp, guestX, guestY);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
  }, 5000);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  }, 5000);
  await delay(80);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  }, 5000);
}

async function sampleLoginDialogState(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const w = canvas.width;
    const h = canvas.height;
    if (w < 320 || h < 240) return null;
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;
    function whiteAt(x, y) {
      const i = (y * w + x) * 4;
      return data[i + 3] > 128 && data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238;
    }

    const rows = [];
    for (let y = 55; y < h - 24; y += 1) {
      let bestStart = 0;
      let bestEnd = -1;
      let runStart = -1;
      for (let x = 0; x < w; x += 1) {
        if (whiteAt(x, y)) {
          if (runStart < 0) runStart = x;
        } else if (runStart >= 0) {
          if (x - runStart > bestEnd - bestStart + 1) {
            bestStart = runStart;
            bestEnd = x - 1;
          }
          runStart = -1;
        }
      }
      if (runStart >= 0 && w - runStart > bestEnd - bestStart + 1) {
        bestStart = runStart;
        bestEnd = w - 1;
      }
      const bestLen = bestEnd >= bestStart ? bestEnd - bestStart + 1 : 0;
      if (bestLen >= 240) rows.push({ y, x0: bestStart, x1: bestEnd, len: bestLen });
    }

    const groups = [];
    for (const row of rows) {
      const last = groups[groups.length - 1];
      if (!last || row.y - last.y1 > 14) {
        groups.push({
          y0: row.y,
          y1: row.y,
          x0: row.x0,
          x1: row.x1,
          rows: 1,
          totalLen: row.len,
        });
      } else {
        last.y1 = row.y;
        last.x0 = Math.min(last.x0, row.x0);
        last.x1 = Math.max(last.x1, row.x1);
        last.rows += 1;
        last.totalLen += row.len;
      }
    }

    const candidates = groups
      .map((group) => ({
        ...group,
        width: group.x1 - group.x0 + 1,
        height: group.y1 - group.y0 + 1,
        averageRun: group.rows ? group.totalLen / group.rows : 0,
      }))
      .filter((group) => (
        group.height >= 90 &&
        group.rows >= 45 &&
        group.averageRun >= 220 &&
        group.width >= 280 &&
        group.width <= 520 &&
        group.x0 >= 40 &&
        group.x1 <= w - 40
      ))
      .sort((a, b) => (b.height * b.averageRun) - (a.height * a.averageRun));

    const dialog = candidates[0] || null;
    return {
      present: Boolean(dialog),
      dialog,
      rows: rows.length,
      candidates: candidates.slice(0, 3),
    };
  })()`);
  if (!result.value) throw new Error("login dialog state unavailable");
  return result.value;
}

const keyInfo = new Map([
  ["\t", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["\r", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
]);

function infoForChar(char) {
  if (keyInfo.has(char)) return keyInfo.get(char);
  const lower = char.toLowerCase();
  if (/^[a-z]$/.test(lower)) {
    return {
      key: char,
      code: `Key${lower.toUpperCase()}`,
      windowsVirtualKeyCode: lower.toUpperCase().charCodeAt(0),
      text: char,
    };
  }
  if (/^[0-9]$/.test(char)) {
    return {
      key: char,
      code: `Digit${char}`,
      windowsVirtualKeyCode: char.charCodeAt(0),
      text: char,
    };
  }
  throw new Error(`unsupported login char ${JSON.stringify(char)}`);
}

async function sendKey(cdp, char) {
  const info = infoForChar(char);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text || "",
    unmodifiedText: info.text || "",
  }, 5000);
  await delay(35);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode,
    nativeVirtualKeyCode: info.windowsVirtualKeyCode,
  }, 5000);
  await delay(55);
}

async function typeText(cdp, text) {
  for (const char of text) {
    await sendKey(cdp, char);
  }
}

async function waitForSettledLogin(cdp) {
  const started = Date.now();
  const deadline = Date.now() + opts.readyTimeoutSec * 1000;
  const repeatedWindowMs = 45000;
  const repeatedChecksums = new Map();
  let previousChecksum = null;
  let stableSamples = 0;
  let nextSnapshotAt = opts.snapshotIntervalSec > 0 ? opts.snapshotIntervalSec : 0;
  while (Date.now() < deadline) {
    const probe = await readProbe(cdp);
    const dialog = await sampleLoginDialogState(cdp).catch((error) => ({
      present: false,
      error: String(error && error.message ? error.message : error),
    }));
    const framebuffer = probe && probe.framebuffer ? probe.framebuffer : null;
    if (framebuffer && framebuffer.nonBlack > 1000) {
      const now = Date.now();
      if (framebuffer.checksum === previousChecksum) stableSamples += 1;
      else stableSamples = 0;
      previousChecksum = framebuffer.checksum;
      const seenAt = repeatedChecksums.get(framebuffer.checksum) || [];
      seenAt.push(now);
      const recentSeenAt = seenAt.filter((sampleAt) => now - sampleAt <= repeatedWindowMs);
      repeatedChecksums.set(framebuffer.checksum, recentSeenAt);
      for (const [checksum, samples] of repeatedChecksums) {
        const recent = samples.filter((sampleAt) => now - sampleAt <= repeatedWindowMs);
        if (recent.length) repeatedChecksums.set(checksum, recent);
        else repeatedChecksums.delete(checksum);
      }
      const repeatedSamples = Math.max(0, ...Array.from(repeatedChecksums.values(), (samples) => samples.length));
      stamp({
        event: "login-wait",
        elapsed: Math.round((now - started) / 1000),
        stableSamples,
        repeatedSamples,
        checksum: framebuffer.checksum,
        nonBlack: framebuffer.nonBlack,
        loginDialog: dialog.present ? `${dialog.dialog.x0},${dialog.dialog.y0} ${dialog.dialog.width}x${dialog.dialog.height}` : "not-present",
        heartbeat: probe.heartbeat,
      });
      const elapsedSec = Math.round((now - started) / 1000);
      if (opts.snapshotIntervalSec > 0 && elapsedSec >= nextSnapshotAt) {
        await screenshot(cdp, `login-wait-${String(elapsedSec).padStart(4, "0")}s.png`);
        nextSnapshotAt = elapsedSec + opts.snapshotIntervalSec;
      }
      if (dialog.present &&
          (stableSamples >= 4 || repeatedSamples >= 4) &&
          now - started >= opts.minLoginSec * 1000) {
        probe.loginDialog = dialog;
        return probe;
      }
    }
    await delay(3000);
  }
  throw new Error("login framebuffer did not settle before timeout");
}

fs.mkdirSync(opts.outDir, { recursive: true });

const port = 9600 + Math.floor(Math.random() * 800);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-login-chrome-"));
const chromeArgs = opts.stock
  ? [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1600,1200",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ]
  : [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1600,1200",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];

const chrome = spawn(opts.chrome, chromeArgs, { stdio: ["ignore", "ignore", "ignore"] });
let cdp = null;
let cleaningUp = false;

function cleanupChrome() {
  if (cleaningUp) return;
  cleaningUp = true;
  try { cdp?.ws.close(); } catch {}
  try { chrome.kill("SIGTERM"); } catch {}
  // Stock Chrome can leave helper processes alive after the parent exits. Scope
  // cleanup to this run's temporary profile so normal user Chrome is untouched.
  try { spawnSync("pkill", ["-TERM", "-f", profileDir], { stdio: "ignore" }); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { spawnSync("pkill", ["-KILL", "-f", profileDir], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}

process.once("SIGINT", () => {
  cleanupChrome();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanupChrome();
  process.exit(143);
});

try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: opts.url });
  stamp({ event: "navigated", stock: opts.stock, url: opts.url });

  const loginProbe = await waitForSettledLogin(cdp);
  stamp({
    event: "login-settled",
    framebuffer: loginProbe.framebuffer,
    memory: loginProbe.memory,
    dialog: loginProbe.loginDialog,
  });
  await screenshot(cdp, "login.png");

  await clickGuest(cdp, 360, 252);
  await typeText(cdp, "root");
  await sendKey(cdp, "\t");
  await typeText(cdp, "31337leet");
  await sendKey(cdp, "\r");
  stamp({ event: "credentials-dispatched" });

  await delay(5000);
  await screenshot(cdp, "after-login-dispatch.png");

  const start = Date.now();
  const report = {
    startedAt: new Date().toISOString(),
    options: opts,
    samples: [],
    screenshots: ["login.png", "after-login-dispatch.png"],
  };
  let maxEvalMs = 0;
  let evalTimeouts = 0;
  let maxLagMs = 0;
  let maxStalls = 0;
  let maxWasmMb = 0;
  let maxDiskCacheMb = 0;
  let lastProbe = null;
  let lastSampleAt = 0;
  let nextSnapshotAt = 0;
  while (Date.now() - start < opts.watchSecs * 1000) {
    const latency = await evalQuick(cdp, "Date.now()", 4000);
    if (latency.ok) maxEvalMs = Math.max(maxEvalMs, latency.ms);
    else evalTimeouts += 1;
    const probe = await readProbe(cdp);
    if (probe) {
      lastProbe = probe;
      const responsiveness = probe.responsiveness || {};
      const memory = probe.memory || {};
      maxLagMs = Math.max(maxLagMs, Number(responsiveness.maxLagMs) || 0);
      maxStalls = Math.max(maxStalls, Number(responsiveness.longTasks) || 0);
      maxWasmMb = Math.max(maxWasmMb, Number(memory.wasmMb) || 0);
      maxDiskCacheMb = Math.max(maxDiskCacheMb, Number(memory.diskCacheMb) || 0);
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    const canvasState = await sampleCanvasState(cdp).catch((error) => ({
      error: String(error && error.message ? error.message : error),
    }));
    const snapshotDue = opts.snapshotIntervalSec > 0 && elapsed >= nextSnapshotAt;
    if (snapshotDue) {
      const name = `post-login-${String(elapsed).padStart(4, "0")}s.png`;
      await screenshot(cdp, name);
      report.screenshots.push(name);
      nextSnapshotAt = elapsed + opts.snapshotIntervalSec;
    }
    const shouldStamp = (Date.now() - lastSampleAt >= 14000) || snapshotDue || !latency.ok || latency.ms > 800;
    if (shouldStamp) {
      const sample = {
        event: "session-watch",
        elapsed,
        evalMs: latency.ms,
        evalOk: latency.ok,
        heartbeat: lastProbe ? lastProbe.heartbeat : null,
        qemuStatus: lastProbe ? lastProbe.qemuStatus : null,
        pulse: lastProbe ? lastProbe.pulseRun : null,
        lag: lastProbe ? lastProbe.responsiveness : null,
        memory: lastProbe ? lastProbe.memory : null,
        framebuffer: lastProbe ? lastProbe.framebuffer : null,
        renderer: lastProbe ? lastProbe.renderer : null,
        diskWorker: lastProbe ? lastProbe.diskWorker : null,
        diskIo: lastProbe ? lastProbe.diskIo : null,
        cpu: lastProbe ? lastProbe.cpu : null,
        canvasState,
      };
      report.samples.push(sample);
      lastSampleAt = Date.now();
      stamp({
        ...sample,
        diskWorker: sample.diskWorker ? {
          requests: sample.diskWorker.requests,
          servedMb: Math.round(sample.diskWorker.servedBytes / 104857.6) / 10,
          fetches: sample.diskWorker.fetches,
          wireMb: Math.round(sample.diskWorker.fetchedBytes / 104857.6) / 10,
          cacheMb: Math.round(sample.diskWorker.cacheBytes / 104857.6) / 10,
          writes: sample.diskWorker.writes,
          errors: sample.diskWorker.errors,
        } : null,
      });
    }
    await delay(3000);
  }

  await screenshot(cdp, "session-end.png");
  report.screenshots.push("session-end.png");
  report.verdict = {
    event: "session-verdict",
    responsive: evalTimeouts === 0 && maxEvalMs < 1500,
    maxEvalMs,
    evalTimeouts,
    maxLagMs,
    maxStalls,
    maxWasmMb,
    maxDiskCacheMb,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(opts.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  stamp(report.verdict);
} catch (error) {
  const fatal = { event: "fatal", message: String(error && error.stack ? error.stack : error) };
  try {
    if (cdp) {
      await screenshot(cdp, "fatal.png");
      fatal.probe = await readProbe(cdp).catch(() => null);
      fatal.canvasState = await sampleCanvasState(cdp).catch(() => null);
    }
    fs.writeFileSync(path.join(opts.outDir, "fatal.json"), `${JSON.stringify(fatal, null, 2)}\n`);
  } catch {}
  stamp(fatal);
} finally {
  cleanupChrome();
}
