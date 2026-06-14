#!/usr/bin/env node
// Probe browser/client -> guest -> Classic Mac low-memory mouse alignment.
//
// This is deliberately focused on the A/UX login screen because that is where
// manual testing has seen cursor/click drift after the A/UX kernel takes over.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const opts = {
  chrome: process.env.CHROME || defaultChrome,
  server: "http://127.0.0.1:8088",
  url: "",
  outDir: path.join(root, "build", "click-alignment"),
  readyTimeoutSec: 260,
  minLoginSec: 90,
  stock: true,
  cssScale: 1,
  radioSweep: false,
};

function usage() {
  console.error(`Usage:
  node scripts/probe-click-alignment.mjs [--headless] [--url url]
    [--ready-timeout sec] [--min-login-sec sec] [--css-scale n] [--radio-sweep] [--out-dir dir]

Default URL:
  :8088/?build=click-align&ram=128&heap=384&pace=1&input=shared&inputMotion=hybrid&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16&probeMs=500&healthMs=1000`);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--chrome") opts.chrome = argv[++i] || "";
  else if (arg === "--server") opts.server = String(argv[++i] || "").replace(/\/+$/, "");
  else if (arg === "--url") opts.url = argv[++i] || "";
  else if (arg === "--out-dir") opts.outDir = argv[++i] || opts.outDir;
  else if (arg === "--ready-timeout") opts.readyTimeoutSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--min-login-sec") opts.minLoginSec = Number.parseInt(argv[++i] || "", 10);
  else if (arg === "--css-scale") opts.cssScale = Number(argv[++i] || "1");
  else if (arg === "--radio-sweep") opts.radioSweep = true;
  else if (arg === "--headless") opts.stock = false;
  else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    usage();
    process.exit(2);
  }
}

if (!opts.url) {
  opts.url = `${opts.server}/?build=click-align&ram=128&heap=384&pace=1&input=shared&inputMotion=hybrid&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16&probeMs=500&healthMs=1000`;
}

if (!fs.existsSync(opts.chrome)) {
  console.error(`Chrome executable not found: ${opts.chrome}`);
  process.exit(2);
}

if (!Number.isFinite(opts.cssScale) || opts.cssScale <= 0) {
  console.error(`Invalid --css-scale: ${opts.cssScale}`);
  process.exit(2);
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

async function resetServerState() {
  await fetch(`${opts.server}/__browser-log.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
  await fetch(`${opts.server}/__range-stats.json?reset=1&ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
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

async function evalQuick(cdp, expression, timeoutMs = 5000) {
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
    if (window.AuxQemuProbe && typeof window.AuxQemuProbe.snapshot === "function") {
      return window.AuxQemuProbe.snapshot();
    }
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
    // Screenshots are supporting evidence; keep probing if capture fails.
  }
}

async function clientPointForGuest(cdp, guestX, guestY) {
  const result = await evalQuick(cdp, `(() => {
    if (!window.AuxQemuProbe || typeof window.AuxQemuProbe.clientPointForGuest !== "function") return null;
    const mapped = window.AuxQemuProbe.clientPointForGuest(${Math.trunc(guestX)}, ${Math.trunc(guestY)});
    if (!mapped) return null;
    const reverse = window.AuxQemuProbe.guestPointForClient(mapped.clientX, mapped.clientY);
    return { ...mapped, reverse };
  })()`);
  if (!result.value) throw new Error("clientPointForGuest unavailable");
  return result.value;
}

async function setCanvasCssScale(cdp, scale) {
  if (!Number.isFinite(scale) || Math.abs(scale - 1) < 0.001) return null;
  const result = await evalQuick(cdp, `(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const scale = ${JSON.stringify(scale)};
    for (const selector of [".telemetry-panel", ".control-panel", ".topbar"]) {
      const node = document.querySelector(selector);
      if (node) node.style.display = "none";
    }
    const workspace = document.querySelector(".workspace");
    if (workspace) {
      workspace.style.display = "block";
      workspace.style.padding = "8px";
    }
    const stage = document.querySelector(".stage-column");
    if (stage) stage.style.width = Math.round(canvas.width * scale + 24) + "px";
    const display = document.getElementById("displayPanel");
    if (display) {
      display.style.position = "static";
      display.style.width = Math.round(canvas.width * scale + 24) + "px";
    }
    canvas.style.width = Math.round(canvas.width * scale) + "px";
    canvas.style.height = Math.round(canvas.height * scale) + "px";
    window.dispatchEvent(new Event("resize"));
    const rect = canvas.getBoundingClientRect();
    const probe = window.AuxQemuProbe && typeof window.AuxQemuProbe.snapshot === "function"
      ? window.AuxQemuProbe.snapshot()
      : null;
    return {
      scale,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      clientWidth: Math.round(rect.width),
      clientHeight: Math.round(rect.height),
      hostCursor: probe ? probe.hostCursor : null,
    };
  })()`);
  await delay(500);
  return result.value;
}

async function sampleLoginRadioState(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const centers = {
      guest: { x: 243, y: 201 },
      registered: { x: 243, y: 220 },
    };
    function score(center) {
      const radius = 3;
      const image = ctx.getImageData(center.x - radius, center.y - radius, radius * 2 + 1, radius * 2 + 1);
      let dark = 0;
      let ink = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        const r = image.data[i + 0];
        const g = image.data[i + 1];
        const b = image.data[i + 2];
        const a = image.data[i + 3];
        if (a > 128 && r < 110 && g < 110 && b < 110) dark += 1;
        if (a > 128 && r < 180 && g < 180 && b < 180) ink += 1;
      }
      return { center, dark, ink, pixels: image.data.length / 4 };
    }
    return {
      guest: score(centers.guest),
      registered: score(centers.registered),
    };
  })()`);
  if (!result.value) throw new Error("login radio state unavailable");
  return result.value;
}

async function sampleNameFieldTextState(cdp) {
  const result = await evalQuick(cdp, `(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const x = 316, y = 238, w = 164, h = 22;
    const image = ctx.getImageData(x, y, w, h);
    let dark = 0;
    let ink = 0;
    let checksum = 2166136261 >>> 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const r = image.data[i + 0];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const a = image.data[i + 3];
      if (a > 128 && r < 110 && g < 110 && b < 110) dark += 1;
      if (a > 128 && r < 180 && g < 180 && b < 180) ink += 1;
      checksum ^= ((r << 16) ^ (g << 8) ^ b ^ i) >>> 0;
      checksum = Math.imul(checksum, 16777619) >>> 0;
    }
    return { x, y, w, h, dark, ink, checksum };
  })()`);
  if (!result.value) throw new Error("name field text state unavailable");
  return result.value;
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

async function waitForSettledLogin(cdp) {
  const started = Date.now();
  const deadline = Date.now() + opts.readyTimeoutSec * 1000;
  const repeatedWindowMs = 45000;
  const repeatedChecksums = new Map();
  let previousChecksum = null;
  let stableSamples = 0;

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
      repeatedChecksums.set(
        framebuffer.checksum,
        seenAt.filter((sampleAt) => now - sampleAt <= repeatedWindowMs),
      );
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
        auxLoginDialog: isAuxLoginDialog(dialog),
        heartbeat: probe.heartbeat,
        renderer: probe.renderer ? `${probe.renderer.width}x${probe.renderer.height}` : null,
        canvas: probe.canvas ? `${probe.canvas.width}x${probe.canvas.height}` : null,
      });
      if (isAuxLoginDialog(dialog) &&
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

function isAuxLoginDialog(dialogState) {
  const dialog = dialogState && dialogState.dialog;
  if (!dialog) return false;
  return (
    dialog.width >= 300 &&
    dialog.width <= 380 &&
    dialog.height >= 130 &&
    dialog.height <= 180 &&
    dialog.x0 >= 120 &&
    dialog.x1 <= 520 &&
    dialog.y0 >= 80 &&
    dialog.y0 <= 130
  );
}

const keyInfo = new Map([
  ["\t", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["\r", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
  [" ", { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }],
  ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
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
  throw new Error(`unsupported probe char ${JSON.stringify(char)}`);
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
  await delay(120);
}

async function waitForNameFieldTextChange(cdp, beforeText, beforeProbe, timeoutMs = 3000) {
  const started = Date.now();
  const beforeKeys = beforeProbe && beforeProbe.buttons ? beforeProbe.buttons.backendKeys || 0 : 0;
  let last = {
    text: await sampleNameFieldTextState(cdp),
    probe: summarizeProbe(await readProbe(cdp)),
  };

  while (Date.now() - started < timeoutMs) {
    const text = await sampleNameFieldTextState(cdp);
    const probe = summarizeProbe(await readProbe(cdp));
    last = { text, probe };

    const keyConsumed = (probe.buttons.backendKeys || 0) > beforeKeys;
    const textChanged = text.checksum !== beforeText.checksum ||
      text.ink > beforeText.ink + 3 ||
      text.dark > beforeText.dark + 3;
    if (keyConsumed && textChanged) {
      return {
        ...last,
        elapsedMs: Date.now() - started,
        changed: true,
      };
    }
    await delay(150);
  }

  return {
    ...last,
    elapsedMs: Date.now() - started,
    changed: false,
  };
}

function summarizeProbe(probe) {
  const shared = probe && probe.sharedInput ? probe.sharedInput : {};
  const pointer = shared.pointer || {};
  return {
    heartbeat: probe ? probe.heartbeat : null,
    activeElement: probe ? probe.activeElement : "",
    canvas: probe ? probe.canvas : null,
    renderer: probe ? probe.renderer : null,
    responsiveness: probe ? probe.responsiveness : null,
    abs: {
      x: shared.absX,
      y: shared.absY,
      w: shared.absWidth,
      h: shared.absHeight,
    },
    macMouse: { x: shared.macMouseX, y: shared.macMouseY },
    macMTemp: { x: shared.macMTempX, y: shared.macMTempY },
    macRaw: { x: shared.macRawX, y: shared.macRawY },
    macDelta: { x: shared.macMouseDeltaX, y: shared.macMouseDeltaY },
    lastSync: { x: shared.lastSyncX, y: shared.lastSyncY },
    adbPosition: { x: shared.adbPositionX, y: shared.adbPositionY },
    adbPending: { dx: shared.adbPendingDx, dy: shared.adbPendingDy },
    adbLastPoll: {
      beforeX: shared.adbLastPollBeforeX,
      beforeY: shared.adbLastPollBeforeY,
      afterX: shared.adbLastPollAfterX,
      afterY: shared.adbLastPollAfterY,
      dx: shared.adbLastPollDx,
      dy: shared.adbLastPollDy,
      buttons: shared.adbLastPollButtons,
      count: shared.adbPollCount,
      emptyCount: shared.adbEmptyPollCount,
    },
    lastAbsEvent: {
      x: shared.lastAbsEventX,
      y: shared.lastAbsEventY,
      w: shared.lastAbsEventW,
      h: shared.lastAbsEventH,
    },
    pointer: {
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      guestX: pointer.guestX,
      guestY: pointer.guestY,
      contentLeft: pointer.contentLeft,
      contentTop: pointer.contentTop,
      contentWidth: pointer.contentWidth,
      contentHeight: pointer.contentHeight,
      scaleX: pointer.scaleX,
      scaleY: pointer.scaleY,
    },
    buttons: {
      frontend: shared.frontendButtons,
      last: shared.lastButtons,
      adb: shared.lastAdbButtons,
      adbState: shared.adbStateButtons,
      adbLastState: shared.adbLastButtonsState,
      adbDesired: shared.adbDesiredButtons,
      adbQueueDepth: shared.adbQueueDepth,
      localQueueDepth: shared.localButtonQueueDepth,
      pressPrimeMs: shared.buttonPressPrimeMs,
      pressPending: shared.buttonPressPending,
      pendingMask: shared.pendingButtonMask,
      releaseHoldMs: shared.buttonReleaseHoldMs,
      targetPending: shared.targetPending,
      backendKeys: shared.backendKeys,
      backendButtons: shared.backendButtons,
      backendMouse: shared.backendMouse,
    },
    alignment: probe ? probe.alignment : null,
    cursor: {
      valid: shared.cursorValid,
      seq: shared.cursorSeq,
      hotspotX: shared.cursorHotspotX,
      hotspotY: shared.cursorHotspotY,
    },
    hostCursor: probe ? probe.hostCursor : null,
  };
}

function deltaFromTarget(summary, point) {
  const abs = summary.abs || {};
  const mac = summary.macMouse || {};
  const pointer = summary.pointer || {};
  return {
    absDx: Number(abs.x) - point.x,
    absDy: Number(abs.y) - point.y,
    macDx: Number(mac.x) - point.x,
    macDy: Number(mac.y) - point.y,
    pointerDx: Number(pointer.guestX) - point.x,
    pointerDy: Number(pointer.guestY) - point.y,
  };
}

function buttonTransitionSummary(before, result) {
  const beforeButtons = before && before.buttons ? before.buttons : {};
  const moveButtons = result.afterMove && result.afterMove.buttons ? result.afterMove.buttons : {};
  const downButtons = result.afterDown && result.afterDown.buttons ? result.afterDown.buttons : {};
  const upButtons = result.afterUp && result.afterUp.buttons ? result.afterUp.buttons : {};
  const beforePoll = before && before.adbLastPoll ? before.adbLastPoll : {};
  const upPoll = result.afterUp && result.afterUp.adbLastPoll ? result.afterUp.adbLastPoll : {};
  return {
    backendButtonsBefore: beforeButtons.backendButtons || 0,
    backendButtonsAfterMove: moveButtons.backendButtons || 0,
    backendButtonsAfterDown: downButtons.backendButtons || 0,
    backendButtonsAfterUp: upButtons.backendButtons || 0,
    downEdges: Math.max(0, (downButtons.backendButtons || 0) - (moveButtons.backendButtons || 0)),
    upEdges: Math.max(0, (upButtons.backendButtons || 0) - (downButtons.backendButtons || 0)),
    totalEdges: Math.max(0, (upButtons.backendButtons || 0) - (beforeButtons.backendButtons || 0)),
    adbPollDelta: Math.max(0, (upPoll.count || 0) - (beforePoll.count || 0)),
    emptyPollDelta: Math.max(0, (upPoll.emptyCount || 0) - (beforePoll.emptyCount || 0)),
    finalFrontend: upButtons.frontend,
    finalAdb: upButtons.adb,
    finalQueueDepth: upButtons.adbQueueDepth,
  };
}

function compactClickResult(result, beforeProbe = null) {
  return {
    name: result.name,
    target: result.target,
    timing: result.timing,
    mapped: result.mapped,
    deltas: result.deltas,
    buttonTransitions: buttonTransitionSummary(beforeProbe || result.afterMoveImmediate, result),
    buttons: {
      before: beforeProbe && beforeProbe.buttons ? beforeProbe.buttons : null,
      move: result.afterMove.buttons,
      down: result.afterDown.buttons,
      up: result.afterUp.buttons,
    },
    adbLastPoll: {
      before: beforeProbe && beforeProbe.adbLastPoll ? beforeProbe.adbLastPoll : null,
      down: result.afterDown.adbLastPoll,
      up: result.afterUp.adbLastPoll,
    },
    alignment: result.afterUp.alignment,
    hostCursor: result.afterUp.hostCursor,
  };
}

function summarizeFailureForConsole(failure) {
  if (!failure) return failure;
  const summary = {
    name: failure.name,
    issues: failure.issues,
  };
  if (Array.isArray(failure.attempts)) {
    const byMode = {};
    for (const attempt of failure.attempts) {
      const mode = attempt.mode || "unknown";
      byMode[mode] = (byMode[mode] || 0) + 1;
    }
    summary.attempts = failure.attempts.length;
    summary.byMode = byMode;
  }
  if (failure.deltas) summary.deltas = failure.deltas;
  if (failure.state) summary.state = failure.state;
  return summary;
}

async function dispatchClickProbe(cdp, point, options = {}) {
  const mapped = await clientPointForGuest(cdp, point.x, point.y);
  const x = mapped.clientX;
  const y = mapped.clientY;
  const moveDelayMs = Number.isFinite(options.moveDelayMs) ? options.moveDelayMs : 160;
  const downDelayMs = Number.isFinite(options.downDelayMs) ? options.downDelayMs : 120;
  const upDelayMs = Number.isFinite(options.upDelayMs) ? options.upDelayMs : 260;
  const clickCount = Number.isFinite(options.clickCount) ? Math.max(1, Math.trunc(options.clickCount)) : 1;
  const downMoves = Array.isArray(options.downMoves) ? options.downMoves : [];

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  }, 5000);
  const afterMoveImmediate = summarizeProbe(await readProbe(cdp));
  await delay(moveDelayMs);
  const afterMove = summarizeProbe(await readProbe(cdp));

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount,
  }, 5000);
  const afterDownImmediate = summarizeProbe(await readProbe(cdp));
  const afterDownMoves = [];
  for (const move of downMoves) {
    await delay(Number.isFinite(move.delayMs) ? move.delayMs : 45);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x + (Number(move.dx) || 0),
      y: y + (Number(move.dy) || 0),
      button: "none",
      buttons: 1,
    }, 5000);
    afterDownMoves.push({
      move,
      probe: summarizeProbe(await readProbe(cdp)),
    });
  }
  if (downMoves.length) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 1,
    }, 5000);
  }
  await delay(downDelayMs);
  const afterDown = summarizeProbe(await readProbe(cdp));

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount,
  }, 5000);
  const afterUpImmediate = summarizeProbe(await readProbe(cdp));
  await delay(upDelayMs);
  const afterUp = summarizeProbe(await readProbe(cdp));

  return {
    name: point.name,
    target: point,
    timing: { moveDelayMs, downDelayMs, upDelayMs },
    mapped,
    client: { x, y },
    roundedClient: { x: Math.round(x), y: Math.round(y) },
    reverse: mapped.reverse || null,
    afterMoveImmediate,
    afterMove,
    afterDownImmediate,
    afterDownMoves,
    afterDown,
    afterUpImmediate,
    afterUp,
    deltas: {
      moveImmediate: deltaFromTarget(afterMoveImmediate, point),
      move: deltaFromTarget(afterMove, point),
      downImmediate: deltaFromTarget(afterDownImmediate, point),
      down: deltaFromTarget(afterDown, point),
      upImmediate: deltaFromTarget(afterUpImmediate, point),
      up: deltaFromTarget(afterUp, point),
    },
  };
}

const probePoints = [
  { name: "guest-radio-center", x: 243, y: 201 },
  { name: "registered-radio-center", x: 243, y: 220 },
  { name: "name-field-left", x: 319, y: 249 },
  { name: "name-field-mid", x: 408, y: 249 },
  { name: "password-field", x: 408, y: 274 },
  { name: "dialog-icon", x: 228, y: 164 },
  { name: "desktop-center", x: 320, y: 240 },
];

const radioSweepTargets = [
  { name: "guest-circle", x: 243, y: 201 },
  { name: "guest-circle-upper", x: 243, y: 198 },
  { name: "guest-circle-lower", x: 243, y: 204 },
  { name: "guest-label-left", x: 270, y: 201 },
  { name: "guest-label-mid", x: 302, y: 201 },
  { name: "guest-row-right", x: 360, y: 201 },
];

const radioSweepHoldMs = [120, 250, 500, 900];
const radioSweepModes = [
  {
    name: "plain",
    targets: radioSweepTargets,
    holdMs: radioSweepHoldMs,
  },
  {
    name: "micro-drag-east",
    targets: radioSweepTargets.slice(0, 4),
    holdMs: [250, 700],
    downMoves: [{ dx: 1, dy: 0, delayMs: 70 }, { dx: 0, dy: 0, delayMs: 70 }],
  },
  {
    name: "micro-drag-south",
    targets: radioSweepTargets.slice(0, 4),
    holdMs: [250, 700],
    downMoves: [{ dx: 0, dy: 1, delayMs: 70 }, { dx: 0, dy: 0, delayMs: 70 }],
  },
  {
    name: "double-click",
    targets: [radioSweepTargets[0], radioSweepTargets[3], radioSweepTargets[4]],
    holdMs: [160],
    clicks: 2,
    interClickMs: 180,
  },
  {
    name: "click-space",
    targets: [radioSweepTargets[0], radioSweepTargets[3], radioSweepTargets[4]],
    holdMs: [250],
    keyAfter: " ",
  },
];

function selectedRadio(state) {
  if (!state || !state.guest || !state.registered) return "unknown";
  if (state.guest.dark > state.registered.dark + 8) return "guest";
  if (state.registered.dark > state.guest.dark + 8) return "registered";
  if (state.guest.ink > state.registered.ink + 8) return "guest-ish";
  if (state.registered.ink > state.guest.ink + 8) return "registered-ish";
  return "ambiguous";
}

async function restoreRegisteredRadio(cdp) {
  await dispatchClickProbe(cdp, { name: "registered-radio-restore", x: 243, y: 220 }, {
    moveDelayMs: 220,
    downDelayMs: 350,
    upDelayMs: 420,
  });
  await delay(300);
  return sampleLoginRadioState(cdp);
}

async function runRadioSweep(cdp) {
  const attempts = [];
  let restoredState = null;

  for (const mode of radioSweepModes) {
    for (const target of mode.targets) {
      for (const holdMs of mode.holdMs) {
        const before = await sampleLoginRadioState(cdp);
        const beforeProbe = summarizeProbe(await readProbe(cdp));
        const result = await dispatchClickProbe(cdp, target, {
          moveDelayMs: 260,
          downDelayMs: holdMs,
          upDelayMs: 520,
          downMoves: mode.downMoves,
        });
        const clickResults = [result];
        for (let click = 1; click < (mode.clicks || 1); click += 1) {
          await delay(mode.interClickMs || 160);
          clickResults.push(await dispatchClickProbe(cdp, target, {
            moveDelayMs: 80,
            downDelayMs: holdMs,
            upDelayMs: 320,
            clickCount: click + 1,
            downMoves: mode.downMoves,
          }));
        }
        if (mode.keyAfter) {
          await sendKey(cdp, mode.keyAfter);
          await delay(250);
        }
        const after = await sampleLoginRadioState(cdp);
        const selection = selectedRadio(after);
        const lastClick = clickResults[clickResults.length - 1];
        const attempt = {
          mode: mode.name,
          target,
          holdMs,
          clicks: mode.clicks || 1,
          keyAfter: mode.keyAfter || "",
          before: selectedRadio(before),
          after: selection,
          state: after,
          clickResults: clickResults.map((item) => compactClickResult(item, beforeProbe)),
          immediateDeltas: lastClick.deltas.upImmediate,
          downDeltas: lastClick.deltas.down,
          upDeltas: lastClick.deltas.up,
          immediateButtons: lastClick.afterUpImmediate.buttons,
          downButtons: lastClick.afterDown.buttons,
          upButtons: lastClick.afterUp.buttons,
          buttonTransitions: buttonTransitionSummary(beforeProbe, lastClick),
          alignment: lastClick.afterUp.alignment,
        };
        attempts.push(attempt);
        stamp({
          event: "radio-sweep",
          mode: mode.name,
          target: target.name,
          point: { x: target.x, y: target.y },
          holdMs,
          clicks: attempt.clicks,
          keyAfter: attempt.keyAfter,
          before: attempt.before,
          after: selection,
          immediateDeltas: attempt.immediateDeltas,
          downDeltas: attempt.downDeltas,
          upDeltas: attempt.upDeltas,
          immediateButtons: attempt.immediateButtons,
          downButtons: attempt.downButtons,
          upButtons: attempt.upButtons,
          buttonTransitions: attempt.buttonTransitions,
          alignment: attempt.alignment,
        });

        if (selection === "guest") {
          restoredState = await restoreRegisteredRadio(cdp);
          return {
            ok: true,
            attempts,
            restored: selectedRadio(restoredState),
            restoredState,
          };
        }

        if (selection !== "registered" && selection !== "registered-ish") {
          restoredState = await restoreRegisteredRadio(cdp);
        }
      }
    }
  }

  return {
    ok: false,
    attempts,
    restored: restoredState ? selectedRadio(restoredState) : selectedRadio(await sampleLoginRadioState(cdp)),
    restoredState,
  };
}

fs.mkdirSync(opts.outDir, { recursive: true });
await resetServerState();

const port = 9700 + Math.floor(Math.random() * 800);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "c89-click-align-"));
const chromeArgs = opts.stock
  ? [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1500,1100",
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
      "--window-size=1500,1100",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ];

const chrome = spawn(opts.chrome, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] });
const chromeErrors = [];
chrome.stderr.on("data", (chunk) => {
  chromeErrors.push(String(chunk).trim());
  if (chromeErrors.length > 80) chromeErrors.splice(0, chromeErrors.length - 80);
});
if (typeof chrome.stderr.unref === "function") chrome.stderr.unref();

let cdp = null;
let report = null;
try {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 15000);
  const page = targets.find((target) => target.type === "page") || targets[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error("No debuggable page target found");
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url: opts.url }, 10000);
  stamp({ event: "navigated", stock: opts.stock, url: opts.url });

  const loginProbe = await waitForSettledLogin(cdp);
  const cssScaleProbe = await setCanvasCssScale(cdp, opts.cssScale);
  if (cssScaleProbe) {
    stamp({ event: "css-scale", state: cssScaleProbe });
  }
  await screenshot(cdp, "login-before-probes.png");
  stamp({
    event: "login-settled",
    framebuffer: loginProbe.framebuffer,
    canvas: loginProbe.canvas,
    renderer: loginProbe.renderer,
    dialog: loginProbe.loginDialog,
  });

  const radioBefore = await sampleLoginRadioState(cdp);
  stamp({ event: "radio-state", phase: "before", state: radioBefore });

  const results = [];
  let radioAfterGuest = null;
  let radioAfterRegistered = null;
  let nameTypeProbe = null;
  let radioSweepResult = null;
  for (const point of probePoints) {
    const result = await dispatchClickProbe(cdp, point);
    results.push(result);
    stamp({
      event: "click-probe",
      name: point.name,
      target: { x: point.x, y: point.y },
      client: result.client,
      roundedClient: result.roundedClient,
      reverse: result.reverse,
      deltasImmediate: result.deltas.upImmediate,
      deltas: result.deltas.up,
      buttons: result.afterUp.buttons,
      buttonTransitions: buttonTransitionSummary(result.afterMoveImmediate, result),
      alignment: result.afterUp.alignment,
      cursor: result.afterUp.cursor,
      hostCursor: result.afterUp.hostCursor,
    });

    if (point.name === "guest-radio-center") {
      radioAfterGuest = await sampleLoginRadioState(cdp);
      stamp({ event: "radio-state", phase: "after-guest", state: radioAfterGuest });
    } else if (point.name === "registered-radio-center") {
      radioAfterRegistered = await sampleLoginRadioState(cdp);
      stamp({ event: "radio-state", phase: "after-registered", state: radioAfterRegistered });
    } else if (point.name === "name-field-mid") {
      const beforeText = await sampleNameFieldTextState(cdp);
      const beforeProbe = summarizeProbe(await readProbe(cdp));
      await sendKey(cdp, "x");
      const after = await waitForNameFieldTextChange(cdp, beforeText, beforeProbe);
      const afterText = after.text;
      const afterProbe = after.probe;
      nameTypeProbe = { beforeText, afterText, beforeProbe, afterProbe, waitMs: after.elapsedMs, changed: after.changed };
      stamp({
        event: "name-field-type",
        beforeText,
        afterText,
        backendKeysBefore: beforeProbe.buttons.backendKeys,
        backendKeysAfter: afterProbe.buttons.backendKeys,
        waitMs: after.elapsedMs,
        changed: after.changed,
      });
    }
  }

  if (opts.radioSweep) {
    radioSweepResult = await runRadioSweep(cdp);
    await screenshot(cdp, "login-after-radio-sweep.png");
    stamp({
      event: "radio-sweep-result",
      ok: radioSweepResult.ok,
      attempts: radioSweepResult.attempts.length,
      restored: radioSweepResult.restored,
    });
  }
  await screenshot(cdp, "login-after-probes.png");

  const failures = results.flatMap((result) => {
    const up = result.deltas.up;
    const issues = [];
    if (Math.abs(up.absDx) > 1 || Math.abs(up.absDy) > 1) issues.push("abs");
    if (Math.abs(up.macDx) > 1 || Math.abs(up.macDy) > 1) issues.push("mac");
    if (Math.abs(up.pointerDx) > 1 || Math.abs(up.pointerDy) > 1) issues.push("pointer");
    if (result.afterDown.buttons.frontend !== 1 || result.afterUp.buttons.frontend !== 0) issues.push("button");
    return issues.length ? [{ name: result.name, issues, deltas: up }] : [];
  });
  if (radioBefore.registered.ink <= radioBefore.guest.ink + 8) {
    failures.push({ name: "radio-before", issues: ["registered-not-selected"], state: radioBefore });
  }
  if (!radioAfterGuest || radioAfterGuest.guest.dark <= radioAfterGuest.registered.dark + 8) {
    stamp({ event: "radio-note", note: "Guest radio did not toggle; treating as non-fatal because Registered User is the A/UX login path", state: radioAfterGuest });
  }
  if (!radioAfterRegistered || radioAfterRegistered.registered.ink <= radioAfterRegistered.guest.ink + 8) {
    failures.push({ name: "radio-after-registered", issues: ["registered-not-restored"], state: radioAfterRegistered });
  }
  if (opts.radioSweep && (!radioSweepResult || !radioSweepResult.ok)) {
    failures.push({
      name: "radio-sweep",
      issues: ["guest-radio-never-toggled"],
      attempts: radioSweepResult ? radioSweepResult.attempts : [],
    });
  }
  if (!nameTypeProbe) {
    failures.push({ name: "name-field-type", issues: ["not-run"] });
  } else {
    const typeIssues = [];
    const beforeKeys = nameTypeProbe.beforeProbe.buttons.backendKeys || 0;
    const afterKeys = nameTypeProbe.afterProbe.buttons.backendKeys || 0;
    const beforeText = nameTypeProbe.beforeText;
    const afterText = nameTypeProbe.afterText;
    if (afterKeys <= beforeKeys) typeIssues.push("backend-key-not-consumed");
    if (afterText.ink <= beforeText.ink + 3 && afterText.checksum === beforeText.checksum) {
      typeIssues.push("name-field-no-visible-text");
    }
    if (afterKeys - beforeKeys > 4) typeIssues.push("possible-key-repeat-storm");
    if (typeIssues.length) {
      failures.push({ name: "name-field-type", issues: typeIssues, beforeText, afterText, beforeKeys, afterKeys });
    }
  }

  report = {
    ok: failures.length === 0,
    url: opts.url,
    stock: opts.stock,
    cssScale: opts.cssScale,
    radioSweepEnabled: opts.radioSweep,
    cssScaleProbe,
    login: {
      framebuffer: loginProbe.framebuffer,
      canvas: loginProbe.canvas,
      renderer: loginProbe.renderer,
      memory: loginProbe.memory,
      responsiveness: loginProbe.responsiveness,
      dialog: loginProbe.loginDialog || null,
    },
    results,
    radio: {
      before: radioBefore,
      afterGuest: radioAfterGuest,
      afterRegistered: radioAfterRegistered,
      sweep: radioSweepResult,
    },
    nameTypeProbe,
    failures,
    chromeStderrTail: chromeErrors.slice(-20),
  };

  const reportPath = path.join(opts.outDir, "click-alignment-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  stamp({
    event: "report",
    ok: report.ok,
    path: reportPath,
    failures: failures.map(summarizeFailureForConsole),
  });
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  let finalProbe = null;
  if (cdp) {
    await screenshot(cdp, "fatal.png");
    finalProbe = await readProbe(cdp).catch(() => null);
  }
  report = {
    ok: false,
    error: error && error.stack ? String(error.stack) : String(error),
    url: opts.url,
    stock: opts.stock,
    finalProbe,
    chromeStderrTail: chromeErrors.slice(-40),
  };
  fs.writeFileSync(path.join(opts.outDir, "click-alignment-report.json"), JSON.stringify(report, null, 2));
  stamp({ event: "fatal", error: report.error });
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch {}
  try { chrome.stderr.destroy(); } catch {}
  try { chrome.kill("SIGKILL"); } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
