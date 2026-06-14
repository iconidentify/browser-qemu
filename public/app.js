(function () {
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const displayPanel = document.getElementById("displayPanel");
  const serial = document.getElementById("serialLog");
  const isolationStatus = document.getElementById("isolationStatus");
  const qemuStatus = document.getElementById("qemuStatus");
  const netStatus = document.getElementById("netStatus");
  const agentStatus = document.getElementById("agentStatus");
  const agentCmd = document.getElementById("agentCmd");
  const agentOut = document.getElementById("agentOut");
  const lastKey = document.getElementById("lastKey");
  const mouseMetric = document.getElementById("mouseMetric");
  const captureMetric = document.getElementById("captureMetric");
  const heartbeatMetric = document.getElementById("heartbeatMetric");
  const eventMetric = document.getElementById("eventMetric");
  const diskMetric = document.getElementById("diskMetric");
  const diskIoMetric = document.getElementById("diskIoMetric");
  const frameMetric = document.getElementById("frameMetric");
  const cpuMetric = document.getElementById("cpuMetric");
  const wsUrl = document.getElementById("wsUrl");
  const paceCpuCheckbox = document.getElementById("paceCpu");
  const ramSizeSelect = document.getElementById("ramSize");
  const captureKeysButton = document.getElementById("captureKeys");
  const capturePointerButton = document.getElementById("capturePointer");
  const fullscreenButton = document.getElementById("fullscreenDisplay");
  const runRomProbeButton = document.getElementById("runRomProbe");
  const inputSelfTestButton = document.getElementById("inputSelfTest");
  const probeSnapshotButton = document.getElementById("probeSnapshot");
  const guestTextInput = document.getElementById("guestText");
  const probeLog = document.getElementById("probeLog");
  const framebufferProbeCanvas = document.createElement("canvas");
  const framebufferProbeCtx = framebufferProbeCanvas.getContext("2d", { willReadFrequently: true });
  const probeState = document.createElement("script");
  probeState.type = "application/json";
  probeState.id = "probeState";
  document.head.appendChild(probeState);

  const runtimes = {
    "qemu-smoke": {
      label: "smoke",
      startButton: "startSmoke",
      artifacts: [
        "out.js",
        "qemu-system-m68k.wasm",
        "qemu-system-m68k.worker.js",
        "qemu-system-m68k.data",
        "load.js",
        "module.js",
      ],
    },
    "qemu-lazy": {
      label: "lazy",
      startButton: "startLazy",
      artifacts: [
        "out.js",
        "qemu-system-m68k.wasm",
        "qemu-system-m68k.worker.js",
        "qemu-system-m68k.data",
        "load.js",
        "module.js",
        "aux-3.1.1-disk.img",
      ],
      lazyDisk: {
        file: "aux-3.1.1-disk.img",
        guestPath: "/pack/aux-3.1.1-disk.img",
      },
    },
    qemu: {
      label: "full preload",
      startButton: "startQemu",
      artifacts: [
        "out.js",
        "qemu-system-m68k.wasm",
        "qemu-system-m68k.worker.js",
        "qemu-system-m68k.data",
        "load.js",
        "module.js",
      ],
    },
  };

  const files = {
    rom: null,
    disk: null,
    disk2: null,
    pram: null,
  };

  let keyCapture = false;
  let mouseX = 0;
  let mouseY = 0;
  let qemuStarted = false;
  let qemuInstance = null;
  let qemuRuntimeDir = null;
  let qemuPty = null;
  let qemuStartPaused = false;
  let qemuHeapMb = null;
  let qemuPtyMinWaitMs = 8;
  let qemuPtyIdleWaitMs = 32;
  let qemuAutoPulseMs = 0;
  let qemuAutoPulseMode = "sample";
  let qemuControlWorker = null;
  let qemuSharedInput = null;
  let sharedInputBridge = null;
  let sharedInputRetryTimer = 0;
  let sharedInputRetryCount = 0;
  let qemuDiskWorker = null;
  let qemuDiskShared = null;
  // Decoupled renderer: QEMU's SDL blit (patched in out.js) writes the current
  // framebuffer {w,h,heap-ptr,generation} into this small shared control block
  // instead of doing a synchronous main-thread putImageData. The page draws on
  // its own paced timer (startScreenRenderer), reading pixels straight from the shared
  // wasm heap -- the BasiliskII-style worker-writes / main-renders decoupling
  // that keeps a throttled tab from wedging. Slots: [0]=MAGIC [1]=W [2]=H
  // [3]=PTR(bytes) [4]=GENERATION. Mirror of patch-qemu-out-js-display.mjs.
  const C89_SCREEN_MAGIC = 0x53435231; // "SCR1"
  const FRAMEBUFFER_RELOCK_DELTA = 16;
  let qemuScreenShared = null; // SharedArrayBuffer | null
  let qemuScreenCtl = null;    // Int32Array over qemuScreenShared
  let screenTimerId = 0;
  let screenLastGen = -1;
  let screenImage = null;      // ImageData (w x h), reused across frames
  let screenImage32 = null;    // Int32Array over screenImage.data
  let screenImage8 = null;     // Uint8Array over screenImage.data
  let screenW = 0, screenH = 0;
  let canvasDisplayW = canvas.width;
  let canvasDisplayH = canvas.height;
  let canvasDisplayLocked = false;
  let canvasNativeFrameSeen = false;
  let canvasDisplayMismatchLogged = false;
  let canvasBackingMismatchLogged = false;
  let hostCursorMode = "host";
  let hostCursorCss = "";
  const hostCursorCache = new Map();
  let framesRendered = 0; // page-side frames drawn (decoupled renderer health)
  let screenFpsLimit = 20;
  let screenNextFrameAt = 0;
  let qemuDiskWriteRequested = false;
  let qemuDiskWriteMode = false;
  let qemuDiskReady = null;
  let netBridge = null;
  let netModeRequested = false;
  let netZone = "";       // shared relay zone for the NIC bridge and the agent
  let auxAgent = null;
  // Guest NIC MAC. q800 forces the 08:00:07 (Apple) prefix; the low 3 bytes
  // come from this and must match the relay /ethernet init macAddress.
  const AUX_NET_MAC = "08:00:07:0a:0b:0c";
  let heartbeat = 0;
  let lastHeartbeatAt = performance.now();
  let lastControlId = 0;
  let hmpMonitorActive = false;
  let hmpInputMode = "shared";
  let mouseButtons = 0;
  let guestMouseX = 0;
  let guestMouseY = 0;
  let guestMouseKnown = false;
  let pendingMouseDx = 0;
  let pendingMouseDy = 0;
  let mouseFlushTimer = 0;
  let hmpKeyboardTextBuffer = "";
  let hmpKeyboardTextTimer = 0;
  let inputSelfTestStayPaused = false;
  let runInputSelfTestAfterQemuReady = false;
  let diagnosticRunId = 0;
  let diagnosticLive = false;
  let pulseRunTimer = 0;
  let controlWorkerPollCount = 0;
  let controlWorkerPollAt = 0;
  let controlWorkerPollOkCount = 0;
  let controlWorkerPollLastError = "";
  let pulseRunActive = false;
  let pulseRunMode = "sample";
  const serialLines = [];
  let serialFrozen = false; // pause serial re-render while the user selects text
  const maxSerialLines = 1500;
  const maxSerialChars = 220000;
  const serialRenderMinMs = 100;
  let serialRenderTimer = 0;
  let serialRenderDirty = false;
  let lastSerialRenderAt = 0;
  const probeStateMinMs = 250;
  let probeStateTimer = 0;
  let probeStateDirty = false;
  const uiMetricMinMs = 80;
  let eventMetricTimer = 0;
  let mouseMetricTimer = 0;
  let pendingMouseMetric = null;
  const browserLogMirror = {
    queue: [],
    scheduled: 0,
    posting: false,
    failedUntil: 0,
    maxQueue: 500,
    maxBatch: 100,
  };
  const eventCounters = {
    keydown: 0,
    keyup: 0,
    mousedown: 0,
    mouseup: 0,
    mousemove: 0,
    wheel: 0,
  };
  const controlRingSize = 64 * 1024;
  let framebufferChecksum = null;
  let framebufferChanges = 0;
  let framebufferProbe = {
    sampledAt: 0,
    width: canvas.width,
    height: canvas.height,
    samples: 0,
    nonBlack: 0,
    alpha: 0,
    checksum: 0,
    changes: 0,
    error: "",
  };
  let diskIoStats = {
    generatedAtMs: 0,
    entries: [],
    error: "",
  };
  let lastCpuRegister = {
    pc: "",
    sr: "",
    at: 0,
  };

  function startButtons() {
    return ["startSmoke", "startLazy", "startLazyPaused", "startQemu"].map((id) => document.getElementById(id));
  }

  function runtimeStartButtons(runtimeDir) {
    const runtime = runtimes[runtimeDir];
    const ids = [runtime.startButton];
    if (runtimeDir === "qemu-lazy") ids.push("startLazyPaused");
    return ids.map((id) => document.getElementById(id)).filter(Boolean);
  }

  function setStartButtonsDisabled(disabled) {
    for (const button of startButtons()) {
      button.disabled = disabled || button.dataset.available !== "true";
    }
  }

  function setStatus(node, text, kind) {
    node.textContent = text;
    node.className = "status" + (kind ? " " + kind : "");
  }

  function log(line) {
    const stamp = new Date().toISOString().slice(11, 19);
    const stampedLine = `[${stamp}] ${line}`;
    serialLines.push(stampedLine);
    enqueueBrowserLogMirror(stampedLine);
    let totalChars = 0;
    for (let index = serialLines.length - 1; index >= 0; index -= 1) {
      totalChars += serialLines[index].length + 1;
      if (serialLines.length - index > maxSerialLines || totalChars > maxSerialChars) {
        serialLines.splice(0, index + 1);
        break;
      }
    }
    scheduleSerialRender();
  }

  // Re-render the serial log. Skipped while the user is selecting text in it
  // (serialFrozen) so a fresh log line doesn't wipe the in-progress selection --
  // the long-standing "near impossible to copy" annoyance.
  function renderSerial() {
    if (serialRenderTimer) {
      window.clearTimeout(serialRenderTimer);
      serialRenderTimer = 0;
    }
    serialRenderDirty = false;
    lastSerialRenderAt = performance.now();
    serial.textContent = `${serialLines.join("\n")}\n`;
    serial.scrollTop = serial.scrollHeight;
  }

  function scheduleSerialRender() {
    serialRenderDirty = true;
    if (serialFrozen) return;
    if (serialRenderTimer) return;
    const elapsed = performance.now() - lastSerialRenderAt;
    const delayMs = Math.max(0, serialRenderMinMs - elapsed);
    serialRenderTimer = window.setTimeout(() => {
      serialRenderTimer = 0;
      if (serialRenderDirty && !serialFrozen) renderSerial();
    }, delayMs);
  }

  function formatError(error) {
    const message = error && error.message ? error.message : String(error);
    if (!error || !error.stack) return message;
    const stack = String(error.stack).split("\n").slice(0, 8).join(" | ");
    return stack.includes(message) ? stack : `${message} | ${stack}`;
  }

  window.addEventListener("error", (event) => {
    const location = event.filename ? ` at ${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "";
    log(`window error: ${event.message || "unknown"}${location}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    log(`unhandled rejection: ${formatError(event.reason)}`);
  });

  function enqueueBrowserLogMirror(line) {
    if (!line) return;
    browserLogMirror.queue.push(String(line).slice(0, 8000));
    if (browserLogMirror.queue.length > browserLogMirror.maxQueue) {
      browserLogMirror.queue.splice(0, browserLogMirror.queue.length - browserLogMirror.maxQueue);
    }
    scheduleBrowserLogMirrorFlush();
  }

  function scheduleBrowserLogMirrorFlush(delayMs = 250) {
    if (browserLogMirror.scheduled || browserLogMirror.posting) return;
    browserLogMirror.scheduled = window.setTimeout(flushBrowserLogMirror, delayMs);
  }

  async function flushBrowserLogMirror() {
    browserLogMirror.scheduled = 0;
    if (browserLogMirror.posting || !browserLogMirror.queue.length) return;

    const now = Date.now();
    if (now < browserLogMirror.failedUntil) {
      scheduleBrowserLogMirrorFlush(browserLogMirror.failedUntil - now);
      return;
    }

    const batch = browserLogMirror.queue.splice(0, browserLogMirror.maxBatch);
    const body = JSON.stringify({
      source: "browser-qemu",
      href: window.location.href,
      lines: batch,
    });

    browserLogMirror.posting = true;
    try {
      let sent = false;
      if (navigator.sendBeacon && body.length < 60000) {
        sent = navigator.sendBeacon(
          "./__browser-log",
          new Blob([body], { type: "application/json" }),
        );
      }
      if (!sent) {
        const abort = new AbortController();
        const abortTimer = window.setTimeout(() => abort.abort(), 5000);
        try {
          const response = await fetch("./__browser-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            cache: "no-store",
            keepalive: body.length < 60000,
            signal: abort.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } finally {
          window.clearTimeout(abortTimer);
        }
      }
    } catch {
      browserLogMirror.failedUntil = Date.now() + 2000;
    } finally {
      browserLogMirror.posting = false;
      if (browserLogMirror.queue.length) scheduleBrowserLogMirrorFlush();
    }
  }

  function humanSize(size) {
    if (!size) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function parseDisplayGeometry(value) {
    const spec = String(value || "").toLowerCase().trim();
    if (!spec) return null;
    const match = /^(\d{3,4})x(\d{3,4})(?:x(\d+))?$/.exec(spec);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const depth = Number(match[3] || 8);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
      return null;
    }
    return { width, height, depth };
  }

  function setCanvasDisplaySize(width, height, options = {}) {
    const w = Math.max(1, Math.trunc(width));
    const h = Math.max(1, Math.trunc(height));
    canvasDisplayW = w;
    canvasDisplayH = h;
    if (options.lock) {
      canvasDisplayLocked = true;
    }
    canvas.style.setProperty("--guest-width", `${w}px`);
    canvas.style.setProperty("--guest-height", `${h}px`);
    if (displayPanel) {
      displayPanel.style.setProperty("--guest-width", `${w}px`);
      displayPanel.style.setProperty("--guest-height", `${h}px`);
    }
    canvas.dataset.resolution = `${w}x${h}`;
    if (options.resizeBacking) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    if (options.reason) {
      log(`canvas display locked: ${w}x${h} (${options.reason})`);
    }
  }

  function syncDisplayToCanvasBacking(reason) {
    const w = canvas.width;
    const h = canvas.height;
    if (w <= 0 || h <= 0 || (w === canvasDisplayW && h === canvasDisplayH)) {
      return false;
    }
    if (canvasDisplayLocked) {
      if (!canvasBackingMismatchLogged) {
        canvasBackingMismatchLogged = true;
        log(`canvas backing ${w}x${h} differs from locked display ${canvasDisplayW}x${canvasDisplayH}; restoring locked native pixels (${reason})`);
      }
      canvas.width = canvasDisplayW;
      canvas.height = canvasDisplayH;
      screenLastGen = -1;
      return true;
    }
    if (!canvasBackingMismatchLogged) {
      canvasBackingMismatchLogged = true;
      log(`canvas backing ${w}x${h} differs from display ${canvasDisplayW}x${canvasDisplayH}; snapping display to native pixels (${reason})`);
    }
    setCanvasDisplaySize(w, h);
    return true;
  }

  function normalizeCursorMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "none" || mode === "hidden" || mode === "off") return "none";
    if (mode === "guest" || mode === "software" || mode === "framebuffer") return "guest";
    return "host";
  }

  function clampCursorHotspot(value) {
    const n = Math.trunc(Number(value) || 0);
    return Math.max(0, Math.min(15, n));
  }

  function macCursorCacheKey(cursor) {
    const bytes = cursor.bytes || [];
    let key = `${cursor.hotspotX},${cursor.hotspotY}`;
    for (let i = 0; i < bytes.length; i++) {
      key += `,${bytes[i]}`;
    }
    return key;
  }

  function macCursorToCss(cursor) {
    if (!cursor || !cursor.valid || !cursor.bytes || cursor.bytes.length !== 64) {
      return "";
    }
    const hotspotX = clampCursorHotspot(cursor.hotspotX);
    const hotspotY = clampCursorHotspot(cursor.hotspotY);
    const cacheKey = macCursorCacheKey({ ...cursor, hotspotX, hotspotY });
    const cached = hostCursorCache.get(cacheKey);
    if (cached) return cached;

    const cursorCanvas = document.createElement("canvas");
    cursorCanvas.width = 16;
    cursorCanvas.height = 16;
    const cursorCtx = cursorCanvas.getContext("2d");
    if (!cursorCtx) return "";

    const image = cursorCtx.createImageData(16, 16);
    let hasMask = false;
    for (let i = 32; i < 64; i++) {
      if (cursor.bytes[i]) {
        hasMask = true;
        break;
      }
    }

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const byteIndex = y * 2 + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        const dataBit = (cursor.bytes[byteIndex] >> bitIndex) & 1;
        const maskBit = (cursor.bytes[32 + byteIndex] >> bitIndex) & 1;
        const pixelIndex = (y * 16 + x) * 4;
        let alpha = 0;
        let color = 0;

        if (hasMask) {
          if (maskBit) {
            alpha = 255;
            color = dataBit ? 0 : 255;
          }
        } else if (dataBit) {
          alpha = 255;
          color = 0;
        }

        image.data[pixelIndex + 0] = color;
        image.data[pixelIndex + 1] = color;
        image.data[pixelIndex + 2] = color;
        image.data[pixelIndex + 3] = alpha;
      }
    }

    cursorCtx.putImageData(image, 0, 0);
    const result = `url("${cursorCanvas.toDataURL("image/png")}") ${hotspotX} ${hotspotY}, auto`;
    if (hostCursorCache.size >= 32) {
      const firstKey = hostCursorCache.keys().next().value;
      if (firstKey) hostCursorCache.delete(firstKey);
    }
    hostCursorCache.set(cacheKey, result);
    return result;
  }

  function pollSharedCursor() {
    if (hostCursorMode !== "host" ||
        !sharedInputBridge ||
        typeof sharedInputBridge.readCursor !== "function") {
      return;
    }
    const cursor = sharedInputBridge.readCursor();
    if (!cursor) return;
    hostCursorCss = macCursorToCss(cursor);
    applyHostCursorMode();
  }

  function applyHostCursorMode() {
    canvas.dataset.cursorMode = hostCursorMode;
    if (hostCursorMode === "host") {
      const cursor = hostCursorCss || getComputedStyle(document.documentElement)
        .getPropertyValue("--mac-arrow-cursor")
        .trim();
      canvas.style.cursor = cursor || "default";
    } else {
      canvas.style.cursor = "none";
    }
  }

  function drawPlaceholder() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, w, h);

    for (let y = 0; y < h; y += 12) {
      ctx.fillStyle = y % 24 === 0 ? "#101820" : "#0c1218";
      ctx.fillRect(0, y, w, 12);
    }

    ctx.strokeStyle = "#55c7a7";
    ctx.lineWidth = 2;
    ctx.strokeRect(28, 28, w - 56, h - 56);

    ctx.fillStyle = "#f1f3f4";
    ctx.font = "22px Menlo, Consolas, monospace";
    ctx.fillText("A/UX 3.1.1 browser-QEMU host", 54, 78);
    ctx.font = "15px Menlo, Consolas, monospace";
    ctx.fillStyle = "#aeb7c2";
    ctx.fillText("SDL canvas display/input bridge ready", 54, 110);
    ctx.fillText("Canvas: 1152 x 870 x 8", 54, 134);
  }

  // Allocate the shared screen control block. Requires cross-origin isolation
  // (SharedArrayBuffer). When unavailable we leave qemuScreenShared null and the
  // patched blit falls through to the stock (synchronous) putImageData path.
  function allocScreenShared() {
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      qemuScreenShared = null;
      qemuScreenCtl = null;
      log("decoupled renderer disabled: SharedArrayBuffer unavailable (stock blit)");
      return;
    }
    qemuScreenShared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    qemuScreenCtl = new Int32Array(qemuScreenShared);
    Atomics.store(qemuScreenCtl, 0, C89_SCREEN_MAGIC);
    screenLastGen = -1;
    log("decoupled renderer armed (worker writes framebuffer, page renders on paced timer)");
  }

  // Draw the latest published framebuffer to the canvas. Reads {w,h,ptr,gen}
  // from the shared control block and copies pixels directly out of the shared
  // wasm heap. Cheap and throttle-friendly: it runs on the page's own paced timer, so a
  // backgrounded/throttled tab simply renders less often instead of blocking the
  // QEMU worker (the stock synchronous-proxy blit was the core headed wedge).
  function renderScreenFrame() {
    if (!qemuScreenCtl || !qemuInstance) return false;
    const gen = Atomics.load(qemuScreenCtl, 4);
    if (gen === screenLastGen) return false;
    const w = Atomics.load(qemuScreenCtl, 1);
    const h = Atomics.load(qemuScreenCtl, 2);
    const ptr = Atomics.load(qemuScreenCtl, 3);
    if (w <= 0 || h <= 0 || !ptr) return false;

    let heap32;
    try {
      heap32 = qemuInstance.HEAP32;
    } catch (_e) {
      return false;
    }
    if (!heap32 || !heap32.length) return false;
    const src = ptr >>> 2;
    const n = w * h;
    if (src + n > heap32.length) return false; // stale ptr after a mode change

    if (w !== screenW || h !== screenH || !screenImage) {
      if (canvasDisplayLocked) {
        const deltaW = Math.abs(w - canvasDisplayW);
        const deltaH = Math.abs(h - canvasDisplayH);
        if ((deltaW > FRAMEBUFFER_RELOCK_DELTA || deltaH > FRAMEBUFFER_RELOCK_DELTA) &&
            (w !== canvasDisplayW || h !== canvasDisplayH)) {
          setCanvasDisplaySize(w, h, {
            lock: true,
            resizeBacking: true,
            reason: canvasNativeFrameSeen ? "framebuffer mode change" : "framebuffer native size",
          });
        }
        canvasNativeFrameSeen = true;
      }

      const targetW = canvasDisplayLocked ? canvasDisplayW : w;
      const targetH = canvasDisplayLocked ? canvasDisplayH : h;
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;
      if (!canvasDisplayLocked) {
        setCanvasDisplaySize(w, h);
      } else if (canvasNativeFrameSeen && (w !== canvasDisplayW || h !== canvasDisplayH)) {
        if (!canvasDisplayMismatchLogged) {
          canvasDisplayMismatchLogged = true;
          log(`framebuffer ${w}x${h} differs from locked canvas ${canvasDisplayW}x${canvasDisplayH}; drawing clipped to locked native size`);
        }
      }
      screenImage = ctx.createImageData(w, h);
      screenImage32 = new Int32Array(screenImage.data.buffer);
      screenImage8 = new Uint8Array(screenImage.data.buffer);
      screenW = w;
      screenH = h;
    }

    // Bulk-copy the 32-bit pixels, then force opaque alpha. QEMU's macfb blit
    // packs R,G,B in the low three bytes; the 4th byte is undefined, so the
    // stock path always overwrote alpha with 0xff -- we do the same.
    screenImage32.set(heap32.subarray(src, src + n));
    const d8 = screenImage8;
    const end = n * 4;
    for (let i = 3; i < end; i += 4) d8[i] = 0xff;
    if (canvasDisplayLocked && (w !== canvas.width || h !== canvas.height)) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    ctx.putImageData(screenImage, 0, 0);

    screenLastGen = gen;
    framesRendered++;
    return true;
  }

  function screenRenderLoop(now) {
    if (!screenTimerId) return;
    const minFrameMs = screenFpsLimit > 0 ? 1000 / screenFpsLimit : 16;
    const timestamp = Number.isFinite(now) ? now : performance.now();
    if (timestamp >= screenNextFrameAt) {
      window.requestAnimationFrame(() => {
        if (!screenTimerId) return;
        if (!renderScreenFrame()) {
          syncDisplayToCanvasBacking("render loop");
        }
        pollSharedCursor();
      });
      screenNextFrameAt = timestamp + minFrameMs;
    }
    screenTimerId = window.setTimeout(screenRenderLoop, Math.max(8, minFrameMs * 0.85));
  }

  function startScreenRenderer() {
    if (!qemuScreenCtl) return; // decoupled renderer not armed
    if (screenTimerId) return;
    screenLastGen = -1;
    screenNextFrameAt = 0;
    screenTimerId = window.setTimeout(screenRenderLoop, 0);
    log(`page renderer started${screenFpsLimit > 0 ? ` (${screenFpsLimit} fps cap)` : " (uncapped)"}`);
  }

  function stopScreenRenderer() {
    if (screenTimerId) {
      window.clearTimeout(screenTimerId);
      screenTimerId = 0;
    }
    screenImage = null;
    screenImage32 = null;
    screenImage8 = null;
    screenW = 0;
    screenH = 0;
    qemuScreenShared = null;
    qemuScreenCtl = null;
    screenLastGen = -1;
    screenNextFrameAt = 0;
  }

  function updateAssetMetrics() {
    const selected = [];
    if (files.disk) selected.push(`${files.disk.name} (${humanSize(files.disk.size)})`);
    if (files.disk2) selected.push(`${files.disk2.name} (${humanSize(files.disk2.size)})`);
    diskMetric.textContent = selected.length ? selected.join(" + ") : "none";
  }

  function onFile(kind, event) {
    files[kind] = event.target.files && event.target.files[0] ? event.target.files[0] : null;
    updateAssetMetrics();
    if (files[kind]) {
      log(`${kind} selected: ${files[kind].name} (${humanSize(files[kind].size)})`);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => {
        log(`loaded ${src}`);
        resolve(script);
      };
      script.onerror = () => {
        log(`failed to load ${src}`);
        reject(new Error(`failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
  }

  function qemuAsset(runtimeDir, path) {
    return new URL(`./${runtimeDir}/${path}`, window.location.href).href;
  }

  function qemuImportAsset(runtimeDir, path) {
    const url = new URL(qemuAsset(runtimeDir, path));
    const params = new URLSearchParams(window.location.search);
    url.searchParams.set("build", params.get("build") || String(Date.now()));
    return url.href;
  }

  function createSharedInputQueue() {
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      log("control worker disabled: SharedArrayBuffer unavailable");
      return null;
    }

    const headerBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const ringBuffer = new SharedArrayBuffer(controlRingSize);
    const header = new Int32Array(headerBuffer);
    const ring = new Uint8Array(ringBuffer);

    return {
      headerBuffer,
      ringBuffer,
      header,
      ring,
      queuedBytes() {
        const read = Atomics.load(header, 0);
        const write = Atomics.load(header, 1);
        return write >= read ? write - read : ring.length - read + write;
      },
      droppedBytes() {
        return Atomics.load(header, 2);
      },
      drain(maxBytes) {
        let read = Atomics.load(header, 0);
        const write = Atomics.load(header, 1);
        const bytes = [];

        while (bytes.length < maxBytes && read !== write) {
          bytes.push(ring[read]);
          read = (read + 1) % ring.length;
        }

        Atomics.store(header, 0, read);
        return bytes;
      },
    };
  }

  function startControlWorker(sharedInput) {
    if (!sharedInput) return null;

    const worker = new Worker("./control-worker.js", { type: "module" });
    const ignoreBeforeMs = Date.now();
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "log" && message.line) {
        log(message.line);
      } else if (message.type === "poll-heartbeat") {
        controlWorkerPollCount = message.count || 0;
        controlWorkerPollAt = message.at || Date.now();
        controlWorkerPollOkCount = message.okCount || 0;
        controlWorkerPollLastError = message.lastError || "";
      }
    };
    worker.onerror = (event) => {
      log(`control worker error: ${event.message || "unknown error"}`);
    };
    worker.postMessage({
      type: "init",
      controlUrl: new URL("./control.local.json", window.location.href).href,
      headerBuffer: sharedInput.headerBuffer,
      ringBuffer: sharedInput.ringBuffer,
      pollMs: 750,
      ignoreBeforeMs,
    });
    return worker;
  }

  function stopControlWorker() {
    clearPulseRunTimer();
    if (qemuControlWorker) {
      qemuControlWorker.terminate();
      qemuControlWorker = null;
    }
    qemuSharedInput = null;
  }

  // Dedicated disk-I/O worker (ROADMAP Phase 1): guest disk preads are served
  // in the QEMU pthread from SharedArrayBuffers this worker fills, so the
  // page main thread is never on the disk path. disk=legacy restores the old
  // main-thread sync-XHR lazy path.
  function startDiskWorker(runtime, runtimeDir) {
    if (!runtime.lazyDisk) return null;
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      log("disk worker disabled: SharedArrayBuffer unavailable");
      return null;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("disk") === "legacy") {
      log("disk worker disabled by disk=legacy; using main-thread lazy reads");
      return null;
    }

    qemuDiskWriteRequested = params.get("disk") === "rw";
    let transport = params.get("diskTransport") === "dialtone" ? "dialtone" : "http";
    if (qemuDiskWriteRequested && transport !== "dialtone") {
      log("disk=rw requires the dialtone transport; enabling it");
      transport = "dialtone";
    }
    const chunkKb = Number(params.get("diskChunkKb")) || 128;
    const cacheMb = Number(params.get("diskCacheMb")) || 384;
    const token = params.get("diskToken") || "";
    const tabId = `c89-${Math.random().toString(36).slice(2, 10)}`;
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 16);
    const data = new SharedArrayBuffer(8 * 1024 * 1024);
    const ctrlView = new Int32Array(control);
    ctrlView[7] = -1; // DISK_FD: nothing tracked yet

    let readyResolve;
    qemuDiskReady = new Promise((resolve) => {
      readyResolve = resolve;
    });

    const worker = new Worker("./disk-worker.js");
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "ready") {
        log(`disk worker ready: ${message.transport} transport, ${message.diskSize} bytes, ${message.chunkBytes >> 10} KB chunks, ${message.writable ? "writable" : "read-only"}`);
        if (readyResolve) readyResolve({ writable: Boolean(message.writable) });
      } else if (message.type === "init-error") {
        log(`disk worker init failed (falling back to main-thread lazy reads): ${message.error}`);
        if (readyResolve) readyResolve({ writable: false, error: message.error });
      } else if (message.type === "write-disabled") {
        log(`disk worker write mode unavailable: ${message.reason}`);
      } else if (message.type === "stats" && message.stats) {
        window.AuxDiskStats = message.stats;
        const s = message.stats;
        log(`disk worker stats: ${s.requests} reqs ${(s.servedBytes / 1048576).toFixed(1)}MB served, ` +
          `${s.fetches} fetches ${(s.fetchedBytes / 1048576).toFixed(1)}MB wire, ` +
          `${s.cacheHitRequests} cache-hit reqs, cache ${(s.cacheBytes / 1048576).toFixed(1)}MB/${s.cacheChunks} chunks, ` +
          `${s.writes} writes ${(s.writtenBytes / 1048576).toFixed(1)}MB, ` +
          `${s.errors} errors`);
      }
    };
    worker.onerror = (event) => {
      log(`disk worker error: ${event.message || "unknown error"}`);
    };

    const wsDefault = `ws://${window.location.hostname}:8080/disk`;
    let wsUrl = params.get("diskWs") || wsDefault;
    if (token) {
      // The relay authorizes WebSocket writes at upgrade time via ?token=.
      wsUrl += (wsUrl.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;
    }
    worker.postMessage({
      type: "init",
      control,
      data,
      transport,
      url: qemuAsset(runtimeDir, runtime.lazyDisk.file),
      wsUrl,
      httpBase: `http://${window.location.hostname}:8080`,
      diskName: params.get("diskName") || runtime.lazyDisk.file,
      chunkBytes: chunkKb * 1024,
      cacheMb,
      write: qemuDiskWriteRequested,
      token,
      tabId,
    });

    log(`disk worker started: transport=${transport} chunk=${chunkKb}KB cache=${cacheMb}MB${qemuDiskWriteRequested ? " write-mode-requested" : ""}`);
    qemuDiskShared = { control, data, guestPath: runtime.lazyDisk.guestPath };
    return worker;
  }

  // disk=rw drops -snapshot only after the worker confirms write auth and
  // the relay disk lock, so a failed setup degrades to the read-only
  // overlay behavior instead of a guest that cannot write at all.
  async function confirmDiskWriteMode() {
    qemuDiskWriteMode = false;
    window.AuxQemuDiskWritable = false;
    if (!qemuDiskWriteRequested || !qemuDiskWorker || !qemuDiskReady) return;
    const timeout = new Promise((resolve) =>
      window.setTimeout(() => resolve({ writable: false, error: "disk worker ready timeout" }), 20000));
    const ready = await Promise.race([qemuDiskReady, timeout]);
    qemuDiskWriteMode = Boolean(ready.writable);
    window.AuxQemuDiskWritable = qemuDiskWriteMode;
    if (qemuDiskWriteMode) {
      log("disk write mode ACTIVE: guest writes persist through the relay");
    } else {
      log(`disk write mode disabled (${ready.error || "see disk worker log"}); continuing read-only with -snapshot`);
    }
  }

  function applyDiskWriteMode(args) {
    if (!qemuDiskWriteMode) return args;
    return args
      .filter((arg) => arg !== "-snapshot")
      .map((arg) => (typeof arg === "string" ? arg.replace("snapshot=on", "snapshot=off") : arg));
  }

  function stopDiskWorker() {
    if (qemuDiskWorker) {
      qemuDiskWorker.terminate();
      qemuDiskWorker = null;
    }
    qemuDiskShared = null;
    qemuDiskWriteRequested = false;
    qemuDiskWriteMode = false;
    qemuDiskReady = null;
    window.AuxQemuDiskWritable = false;
  }

  function startSharedInputBridge() {
    if (hmpInputMode !== "shared" || !qemuInstance) return;
    if (sharedInputBridge && sharedInputBridge.isReady()) return;
    if (!window.createAuxSharedInputBridge) {
      setStatus(qemuStatus, "Shared input missing", "error");
      log("shared input bridge script missing; rebuild/runtime required");
      updateCaptureState();
      return;
    }

    try {
      sharedInputBridge = window.createAuxSharedInputBridge({
        module: qemuInstance,
        canvas,
        log,
      });
      sharedInputBridge.start();
      if (sharedInputRetryTimer) {
        window.clearTimeout(sharedInputRetryTimer);
        sharedInputRetryTimer = 0;
      }
      sharedInputRetryCount = 0;
      setStatus(qemuStatus, qemuStartPaused ? "QEMU paused" : "QEMU running", "ready");
      log("input mode active: shared memory (68k_web-style)");
    } catch (error) {
      const message = formatError(error);
      sharedInputBridge = null;
      if (
        qemuStarted &&
        sharedInputRetryCount < 80 &&
        (/backend not ready|magic mismatch/.test(message))
      ) {
        const attempt = sharedInputRetryCount;
        const delay = Math.min(1000, 120 + sharedInputRetryCount * 60);
        sharedInputRetryCount += 1;
        setStatus(qemuStatus, "Shared input waiting", "warn");
        if (attempt === 0) {
          log(`shared input backend not ready yet; retrying (${message})`);
        }
        window.clearTimeout(sharedInputRetryTimer);
        sharedInputRetryTimer = window.setTimeout(() => {
          sharedInputRetryTimer = 0;
          startSharedInputBridge();
        }, delay);
        updateCaptureState();
        return;
      }
      setStatus(qemuStatus, "Shared input unavailable", "error");
      log(`shared input unavailable: ${message} (no fallback)`);
    }
    updateCaptureState();
  }

  function stopSharedInputBridge() {
    if (sharedInputRetryTimer) {
      window.clearTimeout(sharedInputRetryTimer);
      sharedInputRetryTimer = 0;
    }
    sharedInputRetryCount = 0;
    if (sharedInputBridge) {
      try {
        sharedInputBridge.releaseAll();
        sharedInputBridge.stop();
      } catch {
        // Best-effort cleanup during runtime teardown.
      }
      sharedInputBridge = null;
    }
  }

  function createPtyShim(sharedInput) {
    const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
    const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    const input = [];
    const readableListeners = new Set();
    const signalListeners = new Set();
    let stdioBuffer = "";

    function notifyReadable() {
      for (const listener of readableListeners) {
        try {
          listener();
        } catch (error) {
          log(`pty readable listener failed: ${error && error.message ? error.message : error}`);
        }
      }
    }

    function encodeText(text) {
      if (encoder) return Array.from(encoder.encode(text));
      return Array.from(text).map((char) => char.charCodeAt(0) & 0xff);
    }

    function logQemuStdio(text) {
      const clean = normalizeQemuStdio(text);
      stdioBuffer += clean;

      const lines = stdioBuffer.split("\n");
      stdioBuffer = lines.pop() || "";

      for (const line of lines) {
        handleQemuStdio(line);
        if (shouldLogQemuStdioLine(line)) {
          log(`qemu stdio: ${line.replace(/\s+$/, "")}`);
        }
      }

      if (stdioBuffer.length > 8192) {
        const tail = stdioBuffer.slice(-4096);
        if (tail.trim() && shouldLogQemuStdioLine(tail)) {
          log(`qemu stdio tail: ${tail.replace(/\s+$/, "")}`);
        }
        stdioBuffer = "";
      }
    }

    return {
      get readable() {
        return input.length > 0 || (sharedInput ? sharedInput.queuedBytes() > 0 : false);
      },
      writable: true,
      read(length) {
        const count = Math.max(0, length || input.length + (sharedInput ? sharedInput.queuedBytes() : 0));
        const bytes = input.splice(0, count);
        if (sharedInput && bytes.length < count) {
          bytes.push(...sharedInput.drain(count - bytes.length));
        }
        return bytes;
      },
      write(bytes) {
        if (!bytes || !bytes.length) return;
        const text = decoder
          ? decoder.decode(new Uint8Array(bytes))
          : String.fromCharCode.apply(null, bytes);
        logQemuStdio(text);
      },
      ioctl(request) {
        if (request === "TCGETS") {
          return {
            iflag: 0,
            oflag: 0,
            cflag: 0,
            lflag: 0,
            cc: new Uint8Array(32),
          };
        }
        if (request === "TIOCGWINSZ") {
          return [0, 0, 80, 24];
        }
        return 0;
      },
      onReadable(listener) {
        if (typeof listener !== "function") return { dispose() {} };
        readableListeners.add(listener);
        return {
          dispose() {
            readableListeners.delete(listener);
          },
        };
      },
      onSignal(listener) {
        if (typeof listener !== "function") return { dispose() {} };
        signalListeners.add(listener);
        return {
          dispose() {
            signalListeners.delete(listener);
          },
        };
      },
      signal(name) {
        for (const listener of signalListeners) {
          try {
            listener(name);
          } catch (error) {
            log(`pty signal listener failed: ${error && error.message ? error.message : error}`);
          }
        }
      },
      pushText(text) {
        input.push(...encodeText(text));
        notifyReadable();
        updateProbeState();
      },
      queuedBytes() {
        return input.length + (sharedInput ? sharedInput.queuedBytes() : 0);
      },
      droppedBytes() {
        return sharedInput ? sharedInput.droppedBytes() : 0;
      },
    };
  }

  function createRuntimeDirs(Module) {
    Module.FS_createPath("/", "tmp", true, true);
    Module.FS_createPath("/", "var/tmp", true, true);
  }

  function focusCanvas() {
    try {
      canvas.focus({ preventScroll: true });
    } catch {
      canvas.focus();
    }
    updateCaptureState();
  }

  function updateCaptureState() {
    const pointerLocked = document.pointerLockElement === canvas;
    const fullscreen = document.fullscreenElement === displayPanel;
    const pieces = [];

    if (document.activeElement === canvas) pieces.push("focus");
    if (keyCapture) pieces.push("keys");
    if (hmpInputMode === "hmp") pieces.push("hmp");
    else if (hmpInputMode === "hybrid") pieces.push("hybrid");
    else if (hmpInputMode === "shared") pieces.push(sharedInputBridge && sharedInputBridge.isReady() ? "shared" : "shared?");
    if (pointerLocked) pieces.push("pointer");
    if (fullscreen) pieces.push("fullscreen");

    captureMetric.textContent = pieces.length ? pieces.join(" + ") : "off";
    captureKeysButton.classList.toggle("active", keyCapture);
    capturePointerButton.classList.toggle("active", pointerLocked);
    fullscreenButton.classList.toggle("active", fullscreen);
    captureKeysButton.textContent = keyCapture ? "Release keyboard" : "Capture keyboard";
    capturePointerButton.textContent = pointerLocked ? "Release pointer" : "Pointer lock";
    fullscreenButton.textContent = fullscreen ? "Exit fullscreen" : "Fullscreen";
    displayPanel.classList.toggle("capturing", keyCapture || pointerLocked);
  }

  function updateEventMetric() {
    eventMetric.textContent = `${eventCounters.keydown + eventCounters.keyup} key / ${eventCounters.mousemove + eventCounters.mousedown + eventCounters.mouseup + eventCounters.wheel} mouse`;
  }

  function scheduleEventMetricUpdate() {
    if (eventMetricTimer) return;
    eventMetricTimer = window.setTimeout(() => {
      eventMetricTimer = 0;
      updateEventMetric();
    }, uiMetricMinMs);
  }

  function setMouseMetric(x, y) {
    pendingMouseMetric = `${x}, ${y}`;
    if (mouseMetricTimer) return;
    mouseMetricTimer = window.setTimeout(() => {
      mouseMetricTimer = 0;
      if (pendingMouseMetric !== null) {
        mouseMetric.textContent = pendingMouseMetric;
        pendingMouseMetric = null;
      }
    }, uiMetricMinMs);
  }

  function summarizeDiskIo(stats) {
    if (stats.error) return `stats error: ${stats.error}`;
    if (!stats.entries.length) return "no lazy reads";

    return stats.entries.map((entry) => {
      const name = entry.path.split("/").pop();
      return `${name}: ${entry.rangeGet} ranges`;
    }).join(" / ");
  }

  async function pollDiskIoStats() {
    try {
      const response = await fetch("./__range-stats.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      diskIoStats = {
        generatedAtMs: payload.generatedAtMs || Date.now(),
        entries: Array.isArray(payload.entries) ? payload.entries : [],
        error: "",
      };
    } catch (error) {
      diskIoStats = {
        ...diskIoStats,
        error: error && error.message ? error.message : String(error),
      };
    }
    diskIoMetric.textContent = summarizeDiskIo(diskIoStats);
    updateProbeState();
  }

  function stripAnsi(text) {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  function normalizeQemuStdio(text) {
    return stripAnsi(text)
      .replace(/\r/g, "\n")
      .replace(/\x00/g, "")
      .replace(/\x08/g, "");
  }

  function isLikelyHmpEcho(line) {
    const trimmed = line.trim();
    const withoutPrompt = trimmed.replace(/^\(qemu\)\s*/, "").trim();
    if (!withoutPrompt) return true;

    return /^(cont|stop|help|info(?:\s+\S.*)?|x(?:p)?(?:\s|\/).*|sendkey\s+\S.*|mouse_(?:move|button)\s+\S.*)$/i.test(withoutPrompt);
  }

  function isLikelyHmpReadlineEcho(line) {
    const withoutPrompt = line.trim().replace(/^\(qemu\)\s*/, "").trim();
    const compact = withoutPrompt.toLowerCase().replace(/\s+/g, "");
    const knownCommands = [
      "help",
      "infostatus",
      "infoblock",
      "inforegisters",
      "infoqtree",
      "cont",
      "stop",
    ];

    return knownCommands.some((command) => (
      compact.length > command.length &&
      compact.endsWith(command) &&
      Array.from(compact).every((char) => command.includes(char))
    ));
  }

  function shouldLogQemuStdioLine(line) {
    const trimmed = line.trim();
    if (!trimmed || isLikelyHmpEcho(line) || isLikelyHmpReadlineEcho(line)) return false;
    if (/^\(qemu\)\s*\S/.test(trimmed) && trimmed.length > 120) return false;
    return true;
  }

  function handleQemuStdio(text) {
    const clean = normalizeQemuStdio(text);
    const pcMatch = clean.match(/\bPC = ([0-9a-f]{8})\s+SR = ([0-9a-f]{4})/i);
    if (pcMatch) {
      lastCpuRegister = {
        pc: `0x${pcMatch[1].toLowerCase()}`,
        sr: `0x${pcMatch[2].toLowerCase()}`,
        at: Date.now(),
      };
      cpuMetric.textContent = `${lastCpuRegister.pc} / ${lastCpuRegister.sr}`;
      updateProbeState();
      return;
    }

    const match = clean.match(/VM status:\s*([^\n]+)/);
    if (!match) return;

    const state = match[1].trim();
    setStatus(qemuStatus, `VM ${state}`, state.startsWith("running") ? "ready" : "warn");
    updateProbeState();
  }

  function sampleFramebuffer() {
    try {
      const sampleWidth = 144;
      const sampleHeight = 109;
      framebufferProbeCanvas.width = sampleWidth;
      framebufferProbeCanvas.height = sampleHeight;
      framebufferProbeCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
      const image = framebufferProbeCtx.getImageData(0, 0, sampleWidth, sampleHeight);
      const totalPixels = sampleWidth * sampleHeight;
      const stride = 1;
      let samples = 0;
      let nonBlack = 0;
      let alpha = 0;
      let checksum = 2166136261;

      for (let pixel = 0; pixel < totalPixels; pixel += stride) {
        const offset = pixel * 4;
        const r = image.data[offset];
        const g = image.data[offset + 1];
        const b = image.data[offset + 2];
        const a = image.data[offset + 3];
        if (r || g || b) nonBlack += 1;
        if (a) alpha += 1;
        checksum ^= r;
        checksum = Math.imul(checksum, 16777619);
        checksum ^= g;
        checksum = Math.imul(checksum, 16777619);
        checksum ^= b;
        checksum = Math.imul(checksum, 16777619);
        checksum ^= a;
        checksum = Math.imul(checksum, 16777619);
        samples += 1;
      }

      checksum >>>= 0;
      if (framebufferChecksum !== null && checksum !== framebufferChecksum) {
        framebufferChanges += 1;
      }
      framebufferChecksum = checksum;
      framebufferProbe = {
        sampledAt: Date.now(),
        width: canvas.width,
        height: canvas.height,
        samples,
        nonBlack,
        alpha,
        checksum,
        changes: framebufferChanges,
        error: "",
      };
      frameMetric.textContent = `${nonBlack}/${samples} lit, ${framebufferChanges} changes`;
    } catch (error) {
      framebufferProbe = {
        ...framebufferProbe,
        sampledAt: Date.now(),
        error: error && error.message ? error.message : String(error),
      };
      frameMetric.textContent = `probe error: ${framebufferProbe.error}`;
    }
  }

  function recordEvent(name) {
    eventCounters[name] += 1;
    scheduleEventMetricUpdate();
    updateProbeState();
  }

  function readProbeSnapshot() {
    return {
      heartbeat,
      heartbeatAgeMs: Math.round(performance.now() - lastHeartbeatAt),
      qemuStarted,
      qemuRuntimeDir,
      qemuStartPaused,
      qemuHeapMb,
      qemuPtyMinWaitMs,
      qemuPtyIdleWaitMs,
      qemuAutoPulseMs,
      qemuAutoPulseMode,
      lastControlId,
      hmpMonitorActive,
      hmpInputMode,
      sharedInput: sharedInputBridge ? sharedInputBridge.stats() : null,
      qemuStatus: qemuStatus.textContent,
      netStatus: netStatus.textContent,
      activeElement: document.activeElement ? document.activeElement.id || document.activeElement.tagName : "",
      capture: captureMetric.textContent,
      lastKey: lastKey.textContent,
      mouse: mouseMetric.textContent,
      net: {
        requested: netModeRequested,
        zone: netZone,
        status: netStatus.textContent,
        bridgeRunning: Boolean(netBridge && netBridge.isRunning()),
        bridgeStats: netBridge ? netBridge.stats() : null,
      },
      ptyQueuedBytes: qemuPty ? qemuPty.queuedBytes() : 0,
      controlWorkerPollCount,
      controlWorkerPollAgeMs: controlWorkerPollAt ? Date.now() - controlWorkerPollAt : -1,
      controlWorkerPollOkCount,
      controlWorkerPollLastError,
      pulseRun: {
        active: pulseRunActive,
        mode: pulseRunMode,
      },
      ptyDroppedBytes: qemuPty ? qemuPty.droppedBytes() : 0,
      events: { ...eventCounters },
      canvas: {
        width: canvas.width,
        height: canvas.height,
        displayWidth: canvasDisplayW,
        displayHeight: canvasDisplayH,
        displayLocked: canvasDisplayLocked,
        clientWidth: Math.round(canvas.getBoundingClientRect().width),
        clientHeight: Math.round(canvas.getBoundingClientRect().height),
      },
      framebuffer: framebufferProbe,
      renderer: {
        decoupled: Boolean(qemuScreenCtl),
        active: Boolean(screenTimerId),
        framesRendered,
        fpsLimit: screenFpsLimit,
        width: screenW,
        height: screenH,
        generation: qemuScreenCtl ? Atomics.load(qemuScreenCtl, 4) : -1,
      },
      memory: {
        // Committed wasm linear memory (the big one), the disk worker's LRU
        // cache, and the page JS heap -- summed, this is what can OOM a tab.
        wasmMb: (qemuInstance && qemuInstance.HEAPU8) ? Math.round(qemuInstance.HEAPU8.length / 1048576) : 0,
        diskCacheMb: (window.AuxDiskStats && window.AuxDiskStats.cacheBytes) ? Math.round(window.AuxDiskStats.cacheBytes / 1048576) : 0,
        jsHeapMb: (performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
      },
      cpu: lastCpuRegister,
      diskIo: diskIoStats,
      serialTail: serialLines.slice(-80).join("\n").slice(-4000),
    };
  }

  function compactProbeSnapshot(note = "") {
    const snapshot = readProbeSnapshot();
    const diskIo = snapshot.diskIo.entries.map((entry) => ({
      name: entry.path.split("/").pop(),
      rangeGet: entry.rangeGet,
      bytesServed: entry.bytesServed,
      lastRange: entry.lastRange || "",
    }));

    return {
      note,
      capturedAt: new Date().toISOString(),
      heartbeat: snapshot.heartbeat,
      heartbeatAgeMs: snapshot.heartbeatAgeMs,
      qemuStarted: snapshot.qemuStarted,
      qemuRuntimeDir: snapshot.qemuRuntimeDir,
      qemuStartPaused: snapshot.qemuStartPaused,
      qemuStatus: snapshot.qemuStatus,
      hmpMonitorActive: snapshot.hmpMonitorActive,
      ptyQueuedBytes: snapshot.ptyQueuedBytes,
      ptyDroppedBytes: snapshot.ptyDroppedBytes,
      events: snapshot.events,
      capture: snapshot.capture,
      canvas: snapshot.canvas,
      framebuffer: snapshot.framebuffer,
      renderer: snapshot.renderer,
      memory: snapshot.memory,
      cpu: snapshot.cpu,
      diskIo,
      serialTail: snapshot.serialTail.split("\n").slice(-18).join("\n"),
    };
  }

  function renderProbeLog(note = "") {
    if (!probeLog) return;
    probeLog.textContent = JSON.stringify(compactProbeSnapshot(note), null, 2);
    probeLog.scrollTop = probeLog.scrollHeight;
  }

  function updateProbeState() {
    probeStateDirty = true;
    if (probeStateTimer) return;
    probeStateTimer = window.setTimeout(() => {
      probeStateTimer = 0;
      if (!probeStateDirty) return;
      probeStateDirty = false;
      probeState.textContent = JSON.stringify(readProbeSnapshot());
      if (diagnosticLive) {
        renderProbeLog("diagnostic running");
      }
    }, probeStateMinMs);
  }

  function updateProbeStateNow() {
    if (probeStateTimer) {
      window.clearTimeout(probeStateTimer);
      probeStateTimer = 0;
    }
    probeStateDirty = false;
    probeState.textContent = JSON.stringify(readProbeSnapshot());
    if (diagnosticLive) {
      renderProbeLog("diagnostic running");
    }
  }

  function shouldCaptureEvent(event) {
    return keyCapture || document.activeElement === canvas || event.target === canvas;
  }

  function isEditableTarget(target) {
    if (!target || target === canvas) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function stopNativeInputPropagation(event) {
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function useSharedInputBridge() {
    return hmpInputMode === "shared" && sharedInputBridge && sharedInputBridge.isReady();
  }

  function shouldUseSharedKeyboardCapture(event) {
    if (hmpInputMode !== "shared" || isEditableTarget(event.target)) return false;
    return shouldCaptureEvent(event);
  }

  function handleSharedKeyboardCapture(event, down) {
    if (!shouldUseSharedKeyboardCapture(event)) return false;
    recordEvent(down ? "keydown" : "keyup");
    lastKey.textContent = event.code || "";
    event.preventDefault();
    if (useSharedInputBridge()) {
      sharedInputBridge.keyEvent(event, down);
    }
    stopNativeInputPropagation(event);
    return true;
  }

  function shouldUseSharedPointerCapture(event) {
    if (hmpInputMode !== "shared") return false;
    return event.target === canvas || document.pointerLockElement === canvas;
  }

  function updateSharedPointerMetric(point) {
    if (point) {
      setMouseMetric(point.x, point.y);
    }
  }

  function handleSharedPointerEvent(event) {
    if (!shouldUseSharedPointerCapture(event)) return false;
    const eventName = event.type === "pointermove"
      ? "mousemove"
      : event.type === "pointerup" || event.type === "pointercancel"
        ? "mouseup"
        : "mousedown";
    recordEvent(eventName);

    if (event.type === "pointerdown") {
      focusCanvas();
      if (canvas.setPointerCapture && event.pointerId != null) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch {
          // Some synthetic/browser-driven pointer events are not capturable.
        }
      }
    }

    event.preventDefault();
    if (event.type === "pointercancel") {
      if (sharedInputBridge && typeof sharedInputBridge.releaseMouse === "function") {
        sharedInputBridge.releaseMouse();
      }
    } else if (useSharedInputBridge()) {
      updateSharedPointerMetric(sharedInputBridge.mouseEvent(event));
    } else {
      updateSharedPointerMetric(canvasGuestPoint(event));
    }

    if ((event.type === "pointerup" || event.type === "pointercancel") &&
        canvas.releasePointerCapture && event.pointerId != null &&
        canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Best-effort cleanup for browser automation events.
      }
    }

    stopNativeInputPropagation(event);
    return true;
  }

  function trapSharedMouseCompatibilityEvent(event) {
    if (!shouldUseSharedPointerCapture(event)) return false;
    event.preventDefault();
    stopNativeInputPropagation(event);
    return true;
  }

  function useHmpKeyboardFallback() {
    if (hmpInputMode === "shared") return false;
    return inputSelfTestStayPaused || !qemuInstance || hmpInputMode === "hmp";
  }

  function useHmpMouseFallback() {
    if (hmpInputMode === "shared") return false;
    return inputSelfTestStayPaused || !qemuInstance || hmpInputMode === "hmp" || hmpInputMode === "hybrid";
  }

  function queueInputHmp(command) {
    if (!qemuPty || !command) return false;

    if (qemuControlWorker) {
      qemuControlWorker.postMessage({
        type: "queue-hmp",
        command,
        returnToGuest: false,
      });
    } else {
      qemuPty.pushText(`${command}\r`);
    }
    return true;
  }

  function hmpKeyForEvent(event) {
    const code = event.code || "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);

    const named = {
      Enter: "ret",
      NumpadEnter: "ret",
      Space: "spc",
      Tab: "tab",
      Escape: "esc",
      Backspace: "backspace",
      Delete: "delete",
      Insert: "insert",
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      Home: "home",
      End: "end",
      PageUp: "pgup",
      PageDown: "pgdn",
      Minus: "minus",
      Equal: "equal",
      BracketLeft: "bracket_left",
      BracketRight: "bracket_right",
      Backslash: "backslash",
      Semicolon: "semicolon",
      Quote: "apostrophe",
      Backquote: "grave_accent",
      Comma: "comma",
      Period: "dot",
      Slash: "slash",
    };

    if (named[code]) return named[code];
    if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
    return "";
  }

  function flushKeyboardTextBuffer() {
    const text = hmpKeyboardTextBuffer;
    hmpKeyboardTextBuffer = "";
    hmpKeyboardTextTimer = 0;
    if (!text) return;
    sendGuestText(text, 35, { quiet: true });
  }

  function queueKeyboardText(text) {
    hmpKeyboardTextBuffer += text;
    if (!hmpKeyboardTextTimer) {
      hmpKeyboardTextTimer = window.setTimeout(flushKeyboardTextBuffer, 25);
    }
  }

  function queueKeyboardEvent(event) {
    if (!shouldCaptureEvent(event) || event.repeat || event.type !== "keydown") return;

    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key && event.key.length === 1) {
      queueKeyboardText(event.key);
      return;
    }

    flushKeyboardTextBuffer();
    const key = hmpKeyForEvent(event);
    if (!key) return;
    if (inputSelfTestStayPaused && queueInputHmp(`sendkey ${key}`)) {
      log(`input bridge key: ${key} (stay paused)`);
      return;
    }
    sendHmpKey(key);
    log(`input bridge key: ${key}`);
  }

  function buttonMaskFromEvent(event) {
    let mask = 0;
    if (event.buttons & 1) mask |= 1;
    if (event.buttons & 4) mask |= 2;
    if (event.buttons & 2) mask |= 4;
    return mask;
  }

  function canvasGuestPoint(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height)));
    return { x, y };
  }

  function queueMouseMoveToEvent(event, immediate = false) {
    const point = canvasGuestPoint(event);
    if (!point) return null;
    if (!guestMouseKnown) {
      guestMouseX = 0;
      guestMouseY = 0;
      guestMouseKnown = true;
    }
    const dx = point.x - guestMouseX;
    const dy = point.y - guestMouseY;
    guestMouseX = point.x;
    guestMouseY = point.y;
    queueMouseMove(dx, dy);
    if (immediate) flushMouseMove();
    return point;
  }

  function flushMouseMove() {
    mouseFlushTimer = 0;
    const dx = pendingMouseDx;
    const dy = pendingMouseDy;
    pendingMouseDx = 0;
    pendingMouseDy = 0;
    if (!dx && !dy) return;
    queueInputHmp(`mouse_move ${dx} ${dy}`);
  }

  function queueMouseMove(dx, dy) {
    if (!qemuStarted || (!keyCapture && document.pointerLockElement !== canvas && document.activeElement !== canvas)) {
      return;
    }
    if (!useHmpMouseFallback()) return;
    pendingMouseDx += Math.max(-2048, Math.min(2048, Math.trunc(dx || 0)));
    pendingMouseDy += Math.max(-2048, Math.min(2048, Math.trunc(dy || 0)));
    if (!mouseFlushTimer) {
      mouseFlushTimer = window.setTimeout(flushMouseMove, 120);
    }
  }

  function queueMouseButtons(event) {
    if (!qemuStarted || (!keyCapture && document.pointerLockElement !== canvas && document.activeElement !== canvas)) {
      return;
    }
    if (!useHmpMouseFallback()) return;
    const nextButtons = buttonMaskFromEvent(event);
    if (nextButtons === mouseButtons) return;
    mouseButtons = nextButtons;
    queueInputHmp(`mouse_button ${mouseButtons}`);
  }

  function dispatchCanvasInputEvent(event) {
    canvas.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  function cloneEventCounters() {
    return { ...eventCounters };
  }

  function runInputSelfTest() {
    const before = cloneEventCounters();
    focusCanvas();

    const previousStayPaused = inputSelfTestStayPaused;
    inputSelfTestStayPaused = true;
    try {
      dispatchCanvasInputEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyA",
        key: "a",
      }));
      dispatchCanvasInputEvent(new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        code: "KeyA",
        key: "a",
      }));
      dispatchCanvasInputEvent(new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        buttons: 1,
        movementX: 6,
        movementY: -4,
      }));
      dispatchCanvasInputEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
      }));
      dispatchCanvasInputEvent(new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        buttons: 0,
        cancelable: true,
      }));
    } finally {
      inputSelfTestStayPaused = previousStayPaused;
    }

    const hmpPath = qemuPty ? (qemuControlWorker ? "worker" : "pty") : "none";
    const after = cloneEventCounters();
    const result = {
      before,
      after,
      capture: captureMetric.textContent,
      activeElement: document.activeElement ? document.activeElement.id || document.activeElement.tagName : "",
      hmpPath,
      qemuStarted,
      queuedBytes: qemuPty ? qemuPty.queuedBytes() : 0,
    };

    window.AuxQemuInputSelfTest = result;
    log(`input self-test: key ${before.keydown + before.keyup} -> ${after.keydown + after.keyup}, mouse ${before.mousemove + before.mousedown + before.mouseup + before.wheel} -> ${after.mousemove + after.mousedown + after.mouseup + after.wheel}, hmp ${hmpPath}`);
    renderProbeLog("input self-test");
    updateProbeState();
    return result;
  }

  function applyCpuPacing(args) {
    const next = [...args];
    if (!paceCpuCheckbox || !paceCpuCheckbox.checked || next.includes("-icount")) {
      return next;
    }

    const params = new URLSearchParams(window.location.search);
    const icount = normalizeIcount(params.get("icount")) || "shift=10,sleep=on";
    const accelIndex = next.indexOf("-accel");
    const insertAt = accelIndex === -1 ? 0 : Math.min(next.length, accelIndex + 2);
    next.splice(insertAt, 0, "-icount", icount);
    return next;
  }

  function normalizeIcount(value) {
    const trimmed = String(value || "").trim();
    const numericMatch = trimmed.match(/^shift=([0-9]|1[0-9]|20),sleep=(on|off)$/i);
    if (numericMatch) {
      return `shift=${numericMatch[1]},sleep=${numericMatch[2].toLowerCase()}`;
    }

    const autoMatch = trimmed.match(/^shift=auto(?:,sleep=(on|off))?$/i);
    if (autoMatch) {
      return `shift=auto${autoMatch[1] ? `,sleep=${autoMatch[1].toLowerCase()}` : ""}`;
    }

    return "";
  }

  function normalizeRamMb(value) {
    const ramMb = Number.parseInt(value, 10);
    return [16, 32, 64, 128].includes(ramMb) ? ramMb : 16;
  }

  function selectedRamMb() {
    return normalizeRamMb(ramSizeSelect ? ramSizeSelect.value : 16);
  }

  function normalizeHeapMb(value) {
    const heapMb = Number.parseInt(value, 10);
    if (!Number.isFinite(heapMb)) return null;
    return Math.max(256, Math.min(2300, heapMb));
  }

  function normalizePulseIntervalMs(value, minMs = 5000) {
    const intervalMs = Number.parseInt(value, 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
    return Math.max(minMs, Math.min(60000, intervalMs));
  }

  function normalizePtyWaitMs(value, fallback, minMs, maxMs) {
    if (value === null || value === undefined || value === "") return fallback;
    const waitMs = Number.parseInt(value, 10);
    if (!Number.isFinite(waitMs)) return fallback;
    return Math.max(minMs, Math.min(maxMs, waitMs));
  }

  function normalizeFpsLimit(value) {
    if (value === null || value === undefined || value === "") return 20;
    const fps = Number.parseInt(value, 10);
    if (!Number.isFinite(fps)) return 20;
    if (fps <= 0) return 0;
    return Math.max(5, Math.min(60, fps));
  }

  function selectedHeapMb() {
    const params = new URLSearchParams(window.location.search);
    return params.has("heap") ? normalizeHeapMb(params.get("heap")) : null;
  }

  function selectedPtyWaitOptions() {
    const params = new URLSearchParams(window.location.search);
    return {
      min: normalizePtyWaitMs(
        params.get("ptyMin") || params.get("ptyFloor") || params.get("pty_min"),
        8,
        0,
        64
      ),
      idle: normalizePtyWaitMs(
        params.get("ptyIdle") || params.get("ptyIdleWait") || params.get("pty_idle"),
        32,
        1,
        250
      ),
    };
  }

  function applyRamSize(args) {
    const next = [...args];
    const ramMb = String(selectedRamMb());
    const memoryIndex = next.indexOf("-m");

    if (memoryIndex !== -1 && memoryIndex + 1 < next.length) {
      next[memoryIndex + 1] = ramMb;
      return next;
    }

    const accelIndex = next.indexOf("-accel");
    const insertAt = accelIndex === -1 ? 0 : accelIndex;
    next.splice(insertAt, 0, "-m", ramMb);
    return next;
  }

  // ?net=1 swaps the default -nic none for the wasmbridge backend so guest
  // NIC frames flow to the relay /ethernet endpoint. Off by default so the
  // verified read-only boot path is unchanged for visitors with no relay.
  function applyNetMode(args) {
    const params = new URLSearchParams(window.location.search);
    netModeRequested = params.get("net") === "1" || params.get("net") === "relay";
    if (!netModeRequested) return args;
    // One shared relay zone for both the guest NIC bridge and the agent peer
    // so they can exchange frames. Unique per page unless ?netZone= pins it.
    netZone = params.get("netZone") || `aux-${Math.random().toString(36).slice(2, 8)}`;
    const next = [...args];
    const nicSpec = `wasmbridge,model=dp83932,mac=${AUX_NET_MAC}`;
    const nicIndex = next.indexOf("-nic");
    if (nicIndex !== -1 && nicIndex + 1 < next.length) {
      next[nicIndex + 1] = nicSpec;
    } else {
      next.push("-nic", nicSpec);
    }
    log(`net mode enabled: -nic ${nicSpec}`);
    return next;
  }

  // ?res=800x600 (or 800x600x8) rewrites the framebuffer geometry (-g WxHxD).
  // Smaller framebuffers also mean less per-frame main-thread blit/composite,
  // which helps headed stability. Depth defaults to 8.
  function applyResolution(args) {
    const params = new URLSearchParams(window.location.search);
    const res = (params.get("res") || params.get("g") || "").toLowerCase().trim();
    if (!res) return args;
    const geometry = parseDisplayGeometry(res);
    if (!geometry) {
      log(`ignoring invalid ?res=${res} (use WxH, e.g. 800x600)`);
      return args;
    }
    const geom = `${geometry.width}x${geometry.height}x${geometry.depth}`;
    const next = [...args];
    const gIndex = next.indexOf("-g");
    if (gIndex !== -1 && gIndex + 1 < next.length) {
      next[gIndex + 1] = geom;
    } else {
      next.push("-g", geom);
    }
    log(`display geometry: ${geom}`);
    return next;
  }

  function applyDisplayMode(args) {
    const params = new URLSearchParams(window.location.search);
    const displayMode = (params.get("display") || "").toLowerCase();
    if (displayMode !== "none") {
      return args;
    }

    const next = [...args];
    const displayIndex = next.indexOf("-display");
    if (displayIndex !== -1 && displayIndex + 1 < next.length) {
      next[displayIndex + 1] = "none";
    } else {
      next.push("-display", "none");
    }
    return next;
  }

  function normalizeInputMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "sdl") return "sdl";
    if (mode === "hmp") return "hmp";
    if (mode === "shared" || mode === "wasm" || mode === "sab" || mode === "68kweb") return "shared";
    if (mode === "hybrid" || mode === "split" || mode === "hmp-mouse") return "hybrid";
    return "shared";
  }

  function initializeBootOptionsFromQuery() {
    const params = new URLSearchParams(window.location.search);
    if (ramSizeSelect && params.has("ram")) {
      ramSizeSelect.value = String(normalizeRamMb(params.get("ram")));
    }
    const displayGeometry = parseDisplayGeometry(params.get("res") || params.get("g") || "");
    if (displayGeometry) {
      setCanvasDisplaySize(displayGeometry.width, displayGeometry.height, {
        lock: true,
        resizeBacking: true,
        reason: "query resolution",
      });
    } else {
      setCanvasDisplaySize(canvas.width, canvas.height);
    }
    hmpInputMode = normalizeInputMode(params.get("input") || params.get("inputMode") || "shared");
    hostCursorMode = normalizeCursorMode(params.get("cursor") || params.get("cursorMode") || "host");
    applyHostCursorMode();
    screenFpsLimit = normalizeFpsLimit(params.get("fps"));
    if (paceCpuCheckbox) {
      const pace = (params.get("pace") || "").toLowerCase();
      if (pace === "0" || pace === "false" || pace === "off" || params.has("nopace")) {
        paceCpuCheckbox.checked = false;
      } else if (pace === "1" || pace === "true" || pace === "on" || params.has("icount")) {
        paceCpuCheckbox.checked = true;
      }
    }
  }

  function applyTraceOptions(args) {
    const params = new URLSearchParams(window.location.search);
    const traceMode = params.get("trace");
    if (!traceMode || args.includes("-trace")) {
      return args;
    }

    const next = [...args];
    const traceAliases = {
      via1: [
        "via1_rtc_internal_*",
        "via1_rtc_cmd_*",
        "via1_adb_*",
        "via1_auxmode",
        "via1_timer_hack_state",
      ],
      scsi: [
        "esp_get_cmd",
        "esp_do_command_phase",
        "esp_transfer_data",
        "esp_command_complete*",
        "scsi_req_parsed*",
        "scsi_req_parse_bad",
        "scsi_disk_new_request",
        "scsi_disk_dma_command_*",
      ],
    };
    const patterns = traceMode
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .flatMap((item) => traceAliases[item] || [item]);

    for (const pattern of patterns) {
      next.push("-trace", pattern);
    }
    if (patterns.length) {
      log(`qemu trace enabled: ${patterns.join(", ")}`);
    }
    return next;
  }

  function buildLaunchPlan() {
    const rom = files.rom ? files.rom.name : "Quadra800.rom";
    const disk = files.disk ? files.disk.name : "aux-3.1.1-disk.img";
    const disk2 = files.disk2 ? files.disk2.name : null;
    const pram = files.pram ? files.pram.name : "pram.img";
    const args = applyCpuPacing([
      "qemu-system-m68k",
      "-M", "q800",
      "-m", String(selectedRamMb()),
      "-accel", "tcg,tb-size=500",
      "-L", "/pack/",
      "-bios", `/pack/${rom}`,
      "-display", "sdl,gl=off,show-cursor=off",
      "-g", "1152x870x8",
      "-audio", "none",
      "-drive", `file=/pack/${pram},format=raw,if=mtd,file.locking=off`,
      "-drive", `file=/pack/${disk},media=disk,format=raw,if=none,id=hd2,file.locking=off`,
      "-device", "scsi-hd,scsi-id=1,drive=hd2",
      ...(disk2
        ? [
          "-drive", `file=/pack/${disk2},media=disk,format=raw,if=none,id=hd3,file.locking=off`,
          "-device", "scsi-hd,scsi-id=0,drive=hd3",
        ]
        : []),
      "-monitor", "stdio",
      "-serial", "none",
    ]);

    const planNetMode = new URLSearchParams(window.location.search).get("net");
    if (planNetMode === "1" || planNetMode === "relay") {
      args.push("-nic", `wasmbridge,model=dp83932,mac=${AUX_NET_MAC}`);
    } else {
      args.push("-nic", "none");
    }

    log("Draft launch plan:");
    log(args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" "));
    setStatus(qemuStatus, "Launch planned", "warn");
  }

  async function checkBundle(runtimeDir, quiet = false) {
    const runtime = runtimes[runtimeDir];

    if (!quiet) setStatus(qemuStatus, `Checking ${runtime.label}`, "warn");
    const results = await Promise.all(runtime.artifacts.map(async (artifact) => {
      const url = `./__exists.json?path=${encodeURIComponent(`/${runtimeDir}/${artifact}`)}`;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          return { artifact, ok: false, range: "" };
        }
        const payload = await response.json();
        return { artifact, ok: Boolean(payload.ok), range: payload.acceptRanges || "" };
      } catch {
        return { artifact, ok: false, range: "" };
      }
    }));

    if (!quiet) {
      for (const result of results) {
        const rangeNote = result.artifact.endsWith(".img") && result.ok ? ` (${result.range || "no ranges"})` : "";
        log(`${result.ok ? "found" : "missing"} ${runtimeDir}/${result.artifact}${rangeNote}`);
      }
    }

    if (results.every((result) => result.ok)) {
      for (const button of runtimeStartButtons(runtimeDir)) {
        button.dataset.available = "true";
        button.disabled = qemuStarted;
      }
      if (!quiet) {
        setStatus(qemuStatus, `${runtime.label} ready`, "ready");
        log(`${runtime.label} runtime artifacts are present`);
      }
      return true;
    }

    for (const button of runtimeStartButtons(runtimeDir)) {
      button.dataset.available = "false";
      button.disabled = true;
    }
    if (!quiet) {
      setStatus(qemuStatus, `${runtime.label} incomplete`, "error");
    }
    return false;
  }

  async function checkBundles(quiet = false) {
    const results = [];
    for (const runtimeDir of Object.keys(runtimes)) {
      results.push([runtimeDir, await checkBundle(runtimeDir, quiet)]);
    }

    if (quiet) {
      const ready = results.filter(([, ok]) => ok).map(([runtimeDir]) => runtimes[runtimeDir].label);
      if (ready.length) {
        setStatus(qemuStatus, `${ready.join(", ")} ready`, "ready");
      } else {
        setStatus(qemuStatus, "QEMU not packaged", "warn");
      }
    } else {
      const ready = results.filter(([, ok]) => ok).map(([runtimeDir]) => runtimes[runtimeDir].label);
      log(`available runtimes: ${ready.length ? ready.join(", ") : "none"}`);
    }
  }

  async function startQemu(runtimeDir = "qemu", options = {}) {
    if (qemuStarted) {
      log("QEMU is already starting or running");
      return;
    }

    const runtime = runtimes[runtimeDir];
    if (!runtime) {
      log(`unknown runtime: ${runtimeDir}`);
      return;
    }

    if (document.getElementById(runtime.startButton).dataset.available !== "true") {
      const ok = await checkBundle(runtimeDir);
      if (!ok) return;
    }

    qemuStarted = true;
    const resetButton = document.getElementById("resetQemu");
    qemuRuntimeDir = runtimeDir;
    qemuSharedInput = createSharedInputQueue();
    allocScreenShared();
    qemuPty = createPtyShim(qemuSharedInput);
    qemuControlWorker = startControlWorker(qemuSharedInput);
    qemuDiskWorker = startDiskWorker(runtime, runtimeDir);
    qemuStartPaused = Boolean(options.startPaused);
    qemuHeapMb = selectedHeapMb();
    const ptyWaitOptions = selectedPtyWaitOptions();
    qemuPtyMinWaitMs = ptyWaitOptions.min;
    qemuPtyIdleWaitMs = ptyWaitOptions.idle;
    qemuAutoPulseMode = options.autoPulseMode === "yield" ? "yield" : "sample";
    qemuAutoPulseMs = normalizePulseIntervalMs(options.autoPulseMs, qemuAutoPulseMode === "yield" ? 1000 : 5000);
    hmpMonitorActive = false;
    guestMouseX = 0;
    guestMouseY = 0;
    guestMouseKnown = false;
    mouseButtons = 0;
    hmpKeyboardTextBuffer = "";
    if (hmpKeyboardTextTimer) {
      window.clearTimeout(hmpKeyboardTextTimer);
      hmpKeyboardTextTimer = 0;
    }
    setStartButtonsDisabled(true);
    setHmpButtonsDisabled(false);
    resetButton.disabled = true;
    focusCanvas();
    setStatus(qemuStatus, qemuStartPaused ? "Starting QEMU paused" : "Starting QEMU", "warn");
    log(`loading ${runtime.label} qemu-wasm runtime from ${runtimeDir}${qemuStartPaused ? " with -S" : ""}`);

    window.AuxQemuModuleArguments = null;
    window.Module = {
      canvas,
      pty: qemuPty,
      c89Disk: qemuDiskShared || undefined,
      c89Screen: qemuScreenShared || undefined,
      c89PtyMinWaitMs: qemuPtyMinWaitMs,
      c89PtyIdleWaitMs: qemuPtyIdleWaitMs,
      preRun: [createRuntimeDirs],
      // Pointer lock OFF: auto-requesting it on any canvas click engages real
      // pointer lock in a headed browser (no-op in headless), and the ensuing
      // relative-mouse event flood through synchronous main-thread->worker
      // input proxying wedges the renderer ("clicking crashes it"; headless
      // never reproduced it). A/UX uses the absolute/relative mouse fine
      // without lock. Re-enable only after input proxying is made non-blocking.
      elementPointerLock: false,
      thisProgram: "qemu-system-m68k",
      mainScriptUrlOrBlob: qemuAsset(runtimeDir, "out.js"),
      locateFile(path) {
        return qemuAsset(runtimeDir, path);
      },
      ptyWaitIndex(atomicIndex, memory) {
        if (!qemuControlWorker || !memory || !memory.buffer) return;
        qemuControlWorker.postMessage({
          type: "wait-index",
          atomicIndex,
          wasmBuffer: memory.buffer,
        });
      },
      setStatus(text) {
        if (!text) return;
        const isRunning = text === "Running...";
        setStatus(qemuStatus, isRunning ? (qemuStartPaused ? "QEMU paused" : "QEMU running") : text, isRunning ? "ready" : "warn");
        displayPanel.classList.toggle("runtime-active", isRunning);
        log(`qemu status: ${text}`);
      },
      print(text) {
        if (text) log(`qemu: ${text}`);
      },
      printErr(text) {
        if (text) log(`qemu err: ${text}`);
      },
      onAbort(reason) {
        qemuStarted = false;
        qemuInstance = null;
        qemuRuntimeDir = null;
        qemuPty = null;
        qemuStartPaused = false;
        qemuHeapMb = null;
        qemuAutoPulseMs = 0;
        qemuAutoPulseMode = "sample";
        stopSharedInputBridge();
        stopScreenRenderer();
        stopControlWorker();
        stopDiskWorker();
        closeAuxAgent();
        hmpMonitorActive = false;
        setStartButtonsDisabled(false);
        setHmpButtonsDisabled(true);
        setStatus(qemuStatus, "QEMU aborted", "error");
        displayPanel.classList.remove("runtime-active");
        log(`qemu abort: ${reason}`);
      },
    };

    try {
      await confirmDiskWriteMode();
      await loadScript(`./${runtimeDir}/module.js`);
      if (qemuStartPaused) {
        const args = window.AuxQemuModuleArguments || window.Module.arguments || [];
        if (!args.includes("-S")) {
          window.AuxQemuModuleArguments = ["-S", ...args];
        }
      }
      window.Module.arguments = applyNetMode(applyResolution(applyDiskWriteMode(applyDisplayMode(
        applyTraceOptions(
          applyCpuPacing(applyRamSize(window.AuxQemuModuleArguments || window.Module.arguments || []))
        )
      ))));
      log(`RAM configured: ${selectedRamMb()} MB`);
      if (qemuHeapMb) {
        window.Module.INITIAL_MEMORY = qemuHeapMb * 1024 * 1024;
        log(`wasm heap configured: ${qemuHeapMb} MB`);
      }
      log(`pty bounded wait: min=${qemuPtyMinWaitMs}ms idle=${qemuPtyIdleWaitMs}ms`);
      if (window.Module.arguments.includes("-icount")) {
        const icountIndex = window.Module.arguments.indexOf("-icount");
        log(`cpu pacing enabled: -icount ${window.Module.arguments[icountIndex + 1] || ""}`);
      }
      log(`qemu args: ${window.Module.arguments.join(" ")}`);

      await loadScript(`./${runtimeDir}/load.js`);
      log(`importing ${runtimeDir}/out.js`);
      const initQemu = (await import(qemuImportAsset(runtimeDir, "out.js"))).default;
      log("qemu/out.js imported; invoking runtime");
      const ready = initQemu(window.Module);
      window.AuxQemuReady = ready;
      setStatus(qemuStatus, "QEMU initializing", "warn");
      log("qemu runtime invoked");

      ready.then((instance) => {
        qemuInstance = instance;
        window.AuxQemu = instance;
        startScreenRenderer();
        setStatus(qemuStatus, qemuStartPaused ? "QEMU paused" : "QEMU running", "ready");
        displayPanel.classList.add("runtime-active");
        focusCanvas();
        log(qemuStartPaused ? "qemu runtime initialized with guest CPU paused" : "qemu runtime initialized");
        startSharedInputBridge();
        if (runInputSelfTestAfterQemuReady) {
          runInputSelfTestAfterQemuReady = false;
          runInputSelfTest();
        }
        if (qemuAutoPulseMs) {
          window.setTimeout(() => startPulseRun(qemuAutoPulseMs, qemuAutoPulseMode), 250);
        }
        // With ?net=1, connect the relay bridge automatically once the runtime
        // (and the wasmbridge export) are live, so network access is one step.
        if (netModeRequested && typeof window.AuxQemu.c89NetSharedPtr === "function") {
          window.setTimeout(() => { if (!netBridge || !netBridge.isRunning()) connectNetwork(); }, 500);
        }
      }).catch((error) => {
        qemuStarted = false;
        qemuInstance = null;
        qemuRuntimeDir = null;
        qemuPty = null;
        qemuStartPaused = false;
        qemuHeapMb = null;
        qemuAutoPulseMs = 0;
        qemuAutoPulseMode = "sample";
        stopSharedInputBridge();
        stopScreenRenderer();
        stopControlWorker();
        stopDiskWorker();
        closeAuxAgent();
        hmpMonitorActive = false;
        setStatus(qemuStatus, "QEMU start failed", "error");
        displayPanel.classList.remove("runtime-active");
        log(`qemu start failed: ${formatError(error)}`);
        setStartButtonsDisabled(false);
        setHmpButtonsDisabled(true);
      });
    } catch (error) {
      qemuStarted = false;
      qemuInstance = null;
      qemuRuntimeDir = null;
      qemuPty = null;
      qemuStartPaused = false;
      qemuHeapMb = null;
      qemuAutoPulseMs = 0;
      qemuAutoPulseMode = "sample";
      stopSharedInputBridge();
      stopScreenRenderer();
      stopControlWorker();
      stopDiskWorker();
      closeAuxAgent();
      hmpMonitorActive = false;
      setStatus(qemuStatus, "QEMU start failed", "error");
      displayPanel.classList.remove("runtime-active");
      log(`qemu start failed: ${formatError(error)}`);
      setStartButtonsDisabled(false);
      setHmpButtonsDisabled(true);
    }
  }

  // Bridge guest NIC frames to the relay /ethernet endpoint. Requires the
  // runtime to have been launched with ?net=1 (so -nic wasmbridge is active
  // and window.AuxQemu.c89NetSharedPtr exists) and the relay reachable at the
  // WebSocket URL. The relay's slirp provides TCP/IP at 10.68.0.1.
  function connectNetwork() {
    if (netBridge && netBridge.isRunning()) return;

    if (!window.AuxQemu || typeof window.AuxQemu.c89NetSharedPtr !== "function") {
      setStatus(netStatus, "Net backend off", "error");
      log("cannot connect network: launch with ?net=1 (wasmbridge NIC not present in this run)");
      return;
    }

    if (!netZone) netZone = `aux-${Math.random().toString(36).slice(2, 8)}`;

    setStatus(netStatus, "Connecting", "warn");
    try {
      netBridge = window.createAuxNetBridge({
        module: window.AuxQemu,
        wsUrl: wsUrl.value,
        mac: AUX_NET_MAC,
        zone: netZone,
        log,
        onOpen() {
          setStatus(netStatus, "Network connected", "ready");
          document.getElementById("connectNet").disabled = true;
          document.getElementById("disconnectNet").disabled = false;
        },
        onClose() {
          setStatus(netStatus, "Network offline", "");
          document.getElementById("connectNet").disabled = false;
          document.getElementById("disconnectNet").disabled = true;
        },
        onError() {
          setStatus(netStatus, "Network error", "error");
        },
      });
      netBridge.start();
    } catch (error) {
      setStatus(netStatus, "Net start failed", "error");
      log(`network bridge failed: ${formatError(error)}`);
      netBridge = null;
    }
  }

  function disconnectNetwork() {
    if (netBridge) {
      netBridge.stop();
      netBridge = null;
    }
    closeAuxAgent();
  }

  function closeAuxAgent() {
    if (auxAgent) {
      auxAgent.close();
      auxAgent = null;
    }
  }

  // Probe/automation surface for the network bridge.
  window.AuxQemuNet = {
    connect: connectNetwork,
    disconnect: disconnectNetwork,
    stats() {
      return netBridge ? netBridge.stats() : null;
    },
  };

  // In-page auxagent (AAP) client: drives A/UX over the same relay zone as the
  // NIC bridge. Lazily created; requires net mode + a connected bridge so the
  // guest is in the zone.
  function ensureAuxAgent() {
    if (auxAgent) return auxAgent;
    if (!netModeRequested) {
      log("aux agent unavailable: launch with ?net=1");
      return null;
    }
    if (typeof window.createAuxAgent !== "function") {
      log("aux agent unavailable: aux-agent.js not loaded");
      return null;
    }
    if (!netZone) netZone = `aux-${Math.random().toString(36).slice(2, 8)}`;
    const params = new URLSearchParams(window.location.search);
    auxAgent = window.createAuxAgent({
      wsUrl: wsUrl.value,
      zone: netZone,
      token: params.get("aapToken") || "",
      log,
    });
    return auxAgent;
  }

  // The agent needs the guest in the relay zone, i.e. the NIC bridge running.
  function withAuxAgent(fn) {
    const agent = ensureAuxAgent();
    if (!agent) return Promise.reject(new Error("aux agent unavailable (need ?net=1)"));
    if (!netBridge || !netBridge.isRunning()) connectNetwork();
    return fn(agent);
  }

  function appendAgentOut(text) {
    if (!agentOut) return;
    agentOut.textContent += text;
    agentOut.scrollTop = agentOut.scrollHeight;
  }

  async function runAgentCommand() {
    const cmd = (agentCmd && agentCmd.value || "").trim();
    if (!cmd) return;
    setStatus(agentStatus, "running", "warn");
    appendAgentOut(`$ ${cmd}\n`);
    try {
      const r = await withAuxAgent((a) => a.exec(cmd));
      appendAgentOut(r.output + (r.output.endsWith("\n") ? "" : "\n") + `[exit ${r.exitCode}]\n\n`);
      setStatus(agentStatus, "ready", "ready");
    } catch (error) {
      appendAgentOut(`[error: ${formatError(error)}]\n\n`);
      setStatus(agentStatus, "error", "error");
    }
  }

  async function pingAgent() {
    setStatus(agentStatus, "pinging", "warn");
    try {
      const r = await withAuxAgent((a) => a.ping());
      appendAgentOut(`/ping -> ${r.text || "(no body)"} [${r.status}]\n`);
      setStatus(agentStatus, r.ok ? "ready" : "error", r.ok ? "ready" : "error");
    } catch (error) {
      appendAgentOut(`[ping error: ${formatError(error)}]\n`);
      setStatus(agentStatus, "error", "error");
    }
  }

  // Reconfigure the guest for outbound internet via the relay slirp gateway,
  // mirroring scripts/aux-online.sh (ephemeral; the disk runs with -snapshot).
  async function bringAuxOnline() {
    setStatus(agentStatus, "configuring", "warn");
    appendAgentOut("# bringing A/UX online (default route -> relay 10.68.0.1)\n");
    const steps = [
      "/etc/ifconfig ao0 10.1.1.20 netmask 255.0.0.0 up",
      "/usr/etc/route delete default 10.1.1.1 2>/dev/null; /usr/etc/route add default 10.68.0.1 1",
      "echo nameserver 10.68.0.1 > /etc/resolv.conf; echo domain local >> /etc/resolv.conf",
      "netstat -rn | grep -E 'default|^10 '",
    ];
    try {
      for (const c of steps) {
        const r = await withAuxAgent((a) => a.exec(c));
        if (r.output.trim()) appendAgentOut(r.output.trim() + "\n");
      }
      appendAgentOut("# online. Try: telnet 1.1.1.1 80\n\n");
      setStatus(agentStatus, "online", "ready");
    } catch (error) {
      appendAgentOut(`[online error: ${formatError(error)}]\n\n`);
      setStatus(agentStatus, "error", "error");
    }
  }

  window.AuxAgent = {
    exec: (cmd) => withAuxAgent((a) => a.exec(cmd)),
    ping: () => withAuxAgent((a) => a.ping()),
    getFile: (path) => withAuxAgent((a) => a.getFile(path)),
    putFile: (path, bytes) => withAuxAgent((a) => a.putFile(path, bytes)),
    online: bringAuxOnline,
  };

  window.AuxQemuProbe = {
    snapshot: readProbeSnapshot,
    focusCanvas,
    inputSelfTest: runInputSelfTest,
    queueInputHmp,
    runFor,
    startPulseRun,
    stopPulseRun,
  };
  window.AuxQemuInput = {
    hmp: sendHmp,
    key: sendHmpKey,
    text: sendGuestText,
  };

  function hmpShouldAppendCont(command, returnToGuest) {
    return returnToGuest && command.trim().toLowerCase() !== "cont";
  }

  function setHmpButtonsDisabled(disabled) {
    for (const id of [
      "sendHmpA",
      "sendHmpReturn",
      "sendHmpHelp",
      "sendHmpStatus",
      "sendHmpCont",
      "sendHmpStop",
      "runFor1s",
      "runFor2s",
      "runFor5s",
      "runFor10s",
      "runFor30s",
      "runFor60s",
      "pulseYield2s",
      "pulseRun30s",
      "pulseRunOff",
      "sendGuestText",
      "sendGuestTab",
      "sendGuestReturn",
      "sendHmpCommand",
    ]) {
      document.getElementById(id).disabled = disabled;
    }
    if (!disabled) {
      setPulseRunState(pulseRunActive);
    }
  }

  function sendHmp(command, returnToGuest = true) {
    const trimmed = command.trim();
    if (!qemuPty) {
      log(`hmp unavailable: ${trimmed}`);
      return;
    }
    if (!trimmed) return;

    const appendCont = hmpShouldAppendCont(trimmed, returnToGuest);
    if (qemuControlWorker) {
      qemuControlWorker.postMessage({
        type: "queue-hmp",
        command: trimmed,
        returnToGuest,
      });
      hmpMonitorActive = !returnToGuest;
      log(`hmp queued to worker: ${trimmed}${appendCont ? " + cont" : ""}`);
      updateProbeState();
      return;
    }

    qemuPty.pushText(`${trimmed}\r`);
    if (appendCont) {
      qemuPty.pushText("cont\r");
    }
    hmpMonitorActive = !returnToGuest;
    log(`hmp queued: ${trimmed}${appendCont ? " + cont" : ""}`);
    updateProbeState();
  }

  function sendHmpKey(key) {
    if (qemuControlWorker) {
      qemuControlWorker.postMessage({ type: "queue-key", key });
      hmpMonitorActive = false;
      log(`hmp key queued to worker: ${key} + cont`);
      updateProbeState();
      return;
    }
    sendHmp(`sendkey ${key}`);
  }

  function sendGuestText(text, delayMs = 45, options = {}) {
    const value = String(text || "");
    if (!value) return;
    if (!qemuPty) {
      log("guest text unavailable: QEMU is not running");
      return;
    }
    if (!qemuControlWorker) {
      log("guest text unavailable: control worker is not running");
      return;
    }

    qemuControlWorker.postMessage({ type: "queue-text", text: value, delayMs });
    hmpMonitorActive = false;
    if (!options.quiet) {
      log(`guest text queued: ${value.length} char${value.length === 1 ? "" : "s"}`);
    }
    updateProbeState();
  }

  function runFor(durationMs) {
    const boundedMs = Math.max(250, Math.min(120000, Number(durationMs) || 2000));

    if (!qemuPty) {
      log("timed run unavailable: QEMU is not running");
      return;
    }

    if (qemuControlWorker) {
      qemuControlWorker.postMessage({ type: "run-for", durationMs: boundedMs });
      hmpMonitorActive = false;
      setStatus(qemuStatus, `VM running ${(boundedMs / 1000).toFixed(1)}s`, "ready");
      log(`timed run queued to worker: ${(boundedMs / 1000).toFixed(1)}s`);
      updateProbeState();
      return;
    }

    sendHmp("cont", true);
    window.setTimeout(() => {
      sendHmp("stop", false);
      sendHmp("info status", false);
    }, boundedMs);
  }

  function clearPulseRunTimer() {
    if (pulseRunTimer) {
      window.clearInterval(pulseRunTimer);
      pulseRunTimer = 0;
    }
    pulseRunActive = false;
  }

  function setPulseRunState(active, intervalMs = 30000, mode = pulseRunMode) {
    pulseRunActive = active;
    pulseRunMode = mode === "yield" ? "yield" : "sample";
    const yieldButton = document.getElementById("pulseYield2s");
    const startButton = document.getElementById("pulseRun30s");
    const stopButton = document.getElementById("pulseRunOff");
    if (yieldButton) yieldButton.disabled = !qemuPty || (active && pulseRunMode === "yield");
    if (startButton) startButton.disabled = !qemuPty || (active && pulseRunMode === "sample");
    if (stopButton) stopButton.disabled = !qemuPty || !active;
    if (active) {
      const label = pulseRunMode === "yield" ? "yield pulse" : "sample pulse";
      setStatus(qemuStatus, `VM ${label} ${(intervalMs / 1000).toFixed(1)}s`, "ready");
    }
  }

  function queuePulseSample(mode = pulseRunMode) {
    if (mode === "yield") {
      sendHmp("stop", false);
      sendHmp("cont", true);
      return;
    }

    sendHmp("stop", false);
    sendHmp("info status", false);
    sendHmp("info registers", false);
    sendHmp("info block", false);
    sendHmp("cont", true);
  }

  function startPulseRun(intervalMs = 30000, mode = "sample") {
    const normalizedMode = mode === "yield" ? "yield" : "sample";
    const minMs = normalizedMode === "yield" ? 1000 : 5000;
    const fallbackMs = normalizedMode === "yield" ? 2000 : 30000;
    const boundedMs = Math.max(minMs, Math.min(60000, Number(intervalMs) || fallbackMs));

    if (!qemuPty) {
      log("pulse run unavailable: QEMU is not running");
      return;
    }

    clearPulseRunTimer();

    if (qemuControlWorker) {
      qemuControlWorker.postMessage({ type: "start-pulse", intervalMs: boundedMs, mode: normalizedMode });
    } else {
      sendHmp("cont", true);
      pulseRunTimer = window.setInterval(() => queuePulseSample(normalizedMode), boundedMs);
    }

    hmpMonitorActive = false;
    setPulseRunState(true, boundedMs, normalizedMode);
    log(`${normalizedMode} pulse run started: ${(boundedMs / 1000).toFixed(1)}s cadence`);
    updateProbeState();
  }

  function stopPulseRun() {
    if (qemuControlWorker) {
      qemuControlWorker.postMessage({ type: "stop-pulse" });
    }
    clearPulseRunTimer();
    setPulseRunState(false);
    log("pulse run stopped");
    updateProbeState();
  }

  async function waitForQemuRuntime(timeoutMs = 60000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (window.AuxQemu) {
        return window.AuxQemu;
      }
      if (window.AuxQemuReady && typeof window.AuxQemuReady.then === "function") {
        const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
        return Promise.race([
          window.AuxQemuReady,
          new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error("timeout waiting for QEMU runtime")), remaining);
          }),
        ]);
      }
      await delay(250);
    }

    throw new Error("timeout waiting for QEMU runtime");
  }

  async function refreshProbe(note) {
    sampleFramebuffer();
    await pollDiskIoStats();
    renderProbeLog(note);
  }

  async function runRomProbe() {
    if (diagnosticLive) {
      log("diagnostic probe is already running");
      return;
    }

    const runId = diagnosticRunId + 1;
    diagnosticRunId = runId;
    diagnosticLive = true;
    runRomProbeButton.disabled = true;
    setStatus(qemuStatus, "ROM probe starting", "warn");
    log("diagnostic: ROM 5s probe starting");

    try {
      if (!qemuStarted) {
        const ok = await checkBundle("qemu-lazy", true);
        if (!ok) throw new Error("qemu-lazy bundle is incomplete");
        await startQemu("qemu-lazy", { startPaused: true });
      }

      await waitForQemuRuntime(60000);
      await refreshProbe("runtime ready before ROM probe");

      sendHmp("info status", false);
      sendHmp("info block", false);
      await delay(1000);
      await refreshProbe("pre-run status queued");

      runFor(5000);
      await delay(2500);
      if (diagnosticRunId !== runId) return;
      await refreshProbe("ROM probe halfway");

      await delay(4500);
      if (diagnosticRunId !== runId) return;
      sendHmp("info status", false);
      sendHmp("info registers", false);
      sendHmp("info block", false);
      await delay(2000);
      await refreshProbe("ROM probe complete");
      setStatus(qemuStatus, "ROM probe complete", "ready");
      log("diagnostic: ROM 5s probe complete; monitor commands queued");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus(qemuStatus, "ROM probe failed", "error");
      log(`diagnostic failed: ${message}`);
      renderProbeLog(`diagnostic failed: ${message}`);
    } finally {
      if (diagnosticRunId === runId) {
        diagnosticLive = false;
        runRomProbeButton.disabled = false;
        updateProbeState();
      }
    }
  }

  async function applyQueryAutomation() {
    const params = new URLSearchParams(window.location.search);
    const autostart = params.get("autostart");
    const shouldRunInputSelfTest = params.get("inputSelfTest") === "1";
    const queryPulseMode = (params.get("pulseMode") || params.get("pulse_mode") || "").toLowerCase();
    const normalizedQueryPulseMode = queryPulseMode === "yield" ? "yield" : "sample";
    const queryPulseMs = normalizePulseIntervalMs(
      params.get("pulseMs") || params.get("pulse") || params.get("pulse_ms"),
      normalizedQueryPulseMode === "yield" ? 1000 : 5000
    );

    if (!autostart && shouldRunInputSelfTest) {
      window.setTimeout(runInputSelfTest, 250);
      return;
    }

    if (!autostart) return;

    const autostartMap = {
      "lazy": ["qemu-lazy", {}],
      "lazy-pulse": ["qemu-lazy", {
        startPaused: true,
        autoPulseMs: queryPulseMs || (normalizedQueryPulseMode === "yield" ? 2000 : 30000),
        autoPulseMode: normalizedQueryPulseMode,
      }],
      "lazy-paused": ["qemu-lazy", { startPaused: true }],
      "smoke": ["qemu-smoke", {}],
    };
    const entry = autostartMap[autostart];
    if (!entry) {
      log(`query automation ignored unknown autostart=${autostart}`);
      return;
    }

    const [runtimeDir, options] = entry;
    log(`query automation autostart=${autostart}`);
    if (shouldRunInputSelfTest) {
      runInputSelfTestAfterQemuReady = true;
    }
    await startQemu(runtimeDir, options);
  }

  async function pollControlFile() {
    if (qemuControlWorker) return;

    let command;
    try {
      const response = await fetch(`./control.local.json?ts=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      command = await response.json();
    } catch {
      return;
    }

    const commands = Array.isArray(command.commands)
      ? command.commands
      : Array.isArray(command)
        ? command
        : [command];
    const pending = commands
      .filter((item) => item && typeof item.id === "number" && item.id > lastControlId)
      .sort((a, b) => a.id - b.id);

    if (!pending.length) {
      return;
    }

    if (!qemuStarted || !qemuPty) {
      lastControlId = pending[pending.length - 1].id;
      log(`control queue ignored before QEMU start: ${pending.length} command${pending.length === 1 ? "" : "s"}`);
      updateProbeState();
      return;
    }

    for (const item of pending) {
      lastControlId = item.id;
      if (item.type === "hmp" && item.command) {
        sendHmp(item.command, item.returnToGuest !== false);
      } else if (item.type === "key" && item.key) {
        sendHmpKey(item.key);
      } else if (item.type === "pulse") {
        if (item.action === "start") {
          startPulseRun(item.intervalMs, item.mode);
        } else if (item.action === "stop") {
          stopPulseRun();
        } else {
          log(`control ignored: ${JSON.stringify(item)}`);
        }
      } else {
        log(`control ignored: ${JSON.stringify(item)}`);
      }
    }
    updateProbeState();
  }

  window.addEventListener("error", (event) => {
    const message = event.error && event.error.stack ? event.error.stack : event.message;
    log(`browser error: ${message}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason && event.reason.stack ? event.reason.stack : event.reason;
    log(`browser rejection: ${reason}`);
  });

  document.getElementById("romFile").addEventListener("change", (event) => onFile("rom", event));
  document.getElementById("diskFile").addEventListener("change", (event) => onFile("disk", event));
  document.getElementById("disk2File").addEventListener("change", (event) => onFile("disk2", event));
  document.getElementById("pramFile").addEventListener("change", (event) => onFile("pram", event));
  document.getElementById("planBoot").addEventListener("click", buildLaunchPlan);
  document.getElementById("loadRuntime").addEventListener("click", () => checkBundles(false));
  document.getElementById("startSmoke").addEventListener("click", () => startQemu("qemu-smoke"));
  document.getElementById("startLazy").addEventListener("click", () => startQemu("qemu-lazy", { startPaused: true, autoPulseMs: 30000 }));
  document.getElementById("startLazyPaused").addEventListener("click", () => startQemu("qemu-lazy", { startPaused: true }));
  document.getElementById("startQemu").addEventListener("click", () => startQemu("qemu"));
  document.getElementById("connectNet").addEventListener("click", connectNetwork);
  document.getElementById("disconnectNet").addEventListener("click", disconnectNetwork);
  document.getElementById("agentRun").addEventListener("click", runAgentCommand);
  document.getElementById("agentPing").addEventListener("click", pingAgent);
  document.getElementById("agentOnline").addEventListener("click", bringAuxOnline);
  document.getElementById("agentClear").addEventListener("click", () => { if (agentOut) agentOut.textContent = ""; });
  agentCmd.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runAgentCommand(); } });
  document.getElementById("sendHmpA").addEventListener("click", () => sendHmpKey("a"));
  document.getElementById("sendHmpReturn").addEventListener("click", () => sendHmpKey("ret"));
  document.getElementById("sendGuestTab").addEventListener("click", () => sendHmpKey("tab"));
  document.getElementById("sendGuestReturn").addEventListener("click", () => sendHmpKey("ret"));
  document.getElementById("sendHmpHelp").addEventListener("click", () => sendHmp("help", false));
  document.getElementById("sendHmpStatus").addEventListener("click", () => sendHmp("info status", false));
  document.getElementById("sendHmpCont").addEventListener("click", () => sendHmp("cont", true));
  document.getElementById("sendHmpStop").addEventListener("click", () => sendHmp("stop", false));
  document.getElementById("runFor1s").addEventListener("click", () => runFor(1000));
  document.getElementById("runFor2s").addEventListener("click", () => runFor(2000));
  document.getElementById("runFor5s").addEventListener("click", () => runFor(5000));
  document.getElementById("runFor10s").addEventListener("click", () => runFor(10000));
  document.getElementById("runFor30s").addEventListener("click", () => runFor(30000));
  document.getElementById("runFor60s").addEventListener("click", () => runFor(60000));
  document.getElementById("pulseYield2s").addEventListener("click", () => startPulseRun(2000, "yield"));
  document.getElementById("pulseRun30s").addEventListener("click", () => startPulseRun(30000, "sample"));
  document.getElementById("pulseRunOff").addEventListener("click", stopPulseRun);
  inputSelfTestButton.addEventListener("click", runInputSelfTest);
  runRomProbeButton.addEventListener("click", runRomProbe);
  probeSnapshotButton.addEventListener("click", () => refreshProbe("manual snapshot"));
  document.getElementById("guestTextForm").addEventListener("submit", (event) => {
    event.preventDefault();
    sendGuestText(guestTextInput.value);
    guestTextInput.value = "";
  });
  document.getElementById("hmpForm").addEventListener("submit", (event) => {
    event.preventDefault();
    sendHmp(
      document.getElementById("hmpCommand").value,
      document.getElementById("hmpReturnToGuest").checked,
    );
  });
  document.getElementById("clearSerial").addEventListener("click", () => {
    serialLines.length = 0;
    serial.textContent = "";
  });

  // One-click copy of the whole serial log (no fighting the auto-scroll/refresh).
  const copySerialButton = document.getElementById("copySerial");
  if (copySerialButton) {
    copySerialButton.addEventListener("click", async () => {
      const text = serialLines.join("\n");
      try {
        await navigator.clipboard.writeText(text);
        copySerialButton.textContent = "Copied";
        window.setTimeout(() => { copySerialButton.textContent = "Copy log"; }, 1200);
      } catch (e) {
        // Fallback for non-secure contexts: select the log so the user can Cmd/Ctrl+C.
        const range = document.createRange();
        range.selectNodeContents(serial);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }

  // Don't wipe an in-progress selection in the serial log on the next log line.
  serial.addEventListener("mousedown", () => { serialFrozen = true; });
  document.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    const selecting = sel && !sel.isCollapsed && serial.contains(sel.anchorNode);
    if (!selecting && serialFrozen) {
      serialFrozen = false;
      renderSerial();
    }
  });

  captureKeysButton.addEventListener("click", () => {
    keyCapture = !keyCapture;
    focusCanvas();
    updateCaptureState();
    log(`keyboard capture ${keyCapture ? "on" : "off"}`);
  });

  capturePointerButton.addEventListener("click", () => {
    focusCanvas();
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
      return;
    }
    // Pointer lock is currently a renderer-wedge hazard in headed browsers
    // (relative-mouse flood through blocking input proxying). Disabled until
    // input proxying is non-blocking; focusing the canvas is enough for input.
    log("pointer lock disabled (known headed-browser wedge); canvas focused for input");
  });

  fullscreenButton.addEventListener("click", () => {
    focusCanvas();
    if (document.fullscreenElement === displayPanel) {
      document.exitFullscreen();
      return;
    }
    displayPanel.requestFullscreen();
  });

  canvas.addEventListener("focus", updateCaptureState);
  canvas.addEventListener("blur", updateCaptureState);
  canvas.addEventListener("click", focusCanvas);
  canvas.addEventListener("contextmenu", (event) => {
    if (qemuStarted || keyCapture || hmpInputMode === "shared") {
      event.preventDefault();
      stopNativeInputPropagation(event);
    }
  });

  window.addEventListener("keydown", (event) => {
    handleSharedKeyboardCapture(event, true);
  }, { capture: true });

  window.addEventListener("keyup", (event) => {
    handleSharedKeyboardCapture(event, false);
  }, { capture: true });

  canvas.addEventListener("keydown", (event) => {
    recordEvent("keydown");
    lastKey.textContent = event.code;
    if (shouldCaptureEvent(event)) {
      event.preventDefault();
    }
    if (hmpInputMode === "shared" && shouldCaptureEvent(event)) {
      if (useSharedInputBridge()) {
        sharedInputBridge.keyEvent(event, true);
      }
      stopNativeInputPropagation(event);
      return;
    }
    if (useHmpKeyboardFallback()) {
      queueKeyboardEvent(event);
    }
  });

  canvas.addEventListener("keyup", (event) => {
    recordEvent("keyup");
    lastKey.textContent = event.code;
    if (shouldCaptureEvent(event)) {
      event.preventDefault();
    }
    if (hmpInputMode === "shared" && shouldCaptureEvent(event)) {
      if (useSharedInputBridge()) {
        sharedInputBridge.keyEvent(event, false);
      }
      stopNativeInputPropagation(event);
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (handleSharedKeyboardCapture(event, true)) return;
    if (event.target === canvas || isEditableTarget(event.target) || !keyCapture) return;
    recordEvent("keydown");
    lastKey.textContent = event.code;
    event.preventDefault();
    if (hmpInputMode === "shared") {
      if (useSharedInputBridge()) {
        sharedInputBridge.keyEvent(event, true);
      }
      stopNativeInputPropagation(event);
      return;
    }
    if (useHmpKeyboardFallback()) {
      queueKeyboardEvent(event);
    }
  }, { capture: true });

  document.addEventListener("keyup", (event) => {
    if (handleSharedKeyboardCapture(event, false)) return;
    if (event.target === canvas || isEditableTarget(event.target) || !keyCapture) return;
    recordEvent("keyup");
    lastKey.textContent = event.code;
    event.preventDefault();
    if (hmpInputMode === "shared") {
      if (useSharedInputBridge()) {
        sharedInputBridge.keyEvent(event, false);
      }
      stopNativeInputPropagation(event);
      return;
    }
  }, { capture: true });

  canvas.addEventListener("pointerdown", handleSharedPointerEvent, { capture: true });
  canvas.addEventListener("pointermove", handleSharedPointerEvent, { capture: true });
  canvas.addEventListener("pointerup", handleSharedPointerEvent, { capture: true });
  canvas.addEventListener("pointercancel", handleSharedPointerEvent, { capture: true });

  document.addEventListener("mousedown", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("mouseup", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("mousemove", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("click", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("dblclick", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("contextmenu", trapSharedMouseCompatibilityEvent, { capture: true });
  document.addEventListener("wheel", trapSharedMouseCompatibilityEvent, { capture: true, passive: false });

  canvas.addEventListener("mousedown", (event) => {
    recordEvent("mousedown");
    focusCanvas();
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
    if (hmpInputMode === "shared") {
      const point = useSharedInputBridge() ? sharedInputBridge.mouseEvent(event) : canvasGuestPoint(event);
      if (point) setMouseMetric(point.x, point.y);
      stopNativeInputPropagation(event);
      return;
    }
    if (useHmpMouseFallback()) {
      queueMouseMoveToEvent(event, true);
    }
    queueMouseButtons(event);
  });

  canvas.addEventListener("mouseup", (event) => {
    recordEvent("mouseup");
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
    if (hmpInputMode === "shared") {
      const point = useSharedInputBridge() ? sharedInputBridge.mouseEvent(event) : canvasGuestPoint(event);
      if (point) setMouseMetric(point.x, point.y);
      stopNativeInputPropagation(event);
      return;
    }
    if (useHmpMouseFallback()) {
      queueMouseMoveToEvent(event, true);
    }
    queueMouseButtons(event);
  });

  canvas.addEventListener("mousemove", (event) => {
    recordEvent("mousemove");
    const point = canvasGuestPoint(event);
    if (point) {
      setMouseMetric(point.x, point.y);
    }
    if (hmpInputMode === "shared") {
      event.preventDefault();
      if (useSharedInputBridge()) {
        sharedInputBridge.mouseEvent(event);
      }
      stopNativeInputPropagation(event);
      return;
    }
    if (useHmpMouseFallback()) {
      // HMP input is a monitor command channel, not a high-rate event pipe.
      // Only drag movement goes through continuously; ordinary hover movement
      // is applied on the next click so boot/login cannot be flooded.
      if (event.buttons) {
        queueMouseMoveToEvent(event);
      }
      return;
    }
    mouseX += event.movementX || 0;
    mouseY += event.movementY || 0;
    setMouseMetric(mouseX, mouseY);
    if (window.AuxQemu && typeof window.AuxQemu.sendMouse === "function") {
      window.AuxQemu.sendMouse({
        dx: event.movementX || 0,
        dy: event.movementY || 0,
        buttons: event.buttons,
      });
    }
  });

  canvas.addEventListener("wheel", (event) => {
    recordEvent("wheel");
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
    if (hmpInputMode === "shared") {
      stopNativeInputPropagation(event);
    }
  }, { passive: false });

  document.addEventListener("pointerlockchange", () => {
    updateCaptureState();
    log(document.pointerLockElement === canvas ? "pointer lock on" : "pointer lock off");
  });

  document.addEventListener("fullscreenchange", updateCaptureState);
  window.addEventListener("blur", () => {
    if (sharedInputBridge) sharedInputBridge.releaseAll();
  });

  initializeBootOptionsFromQuery();
  drawPlaceholder();
  sampleFramebuffer();
  setStatus(
    isolationStatus,
    window.crossOriginIsolated ? "Isolation ready" : "Isolation missing",
    window.crossOriginIsolated ? "ready" : "warn",
  );
  setStatus(qemuStatus, "QEMU not loaded", "");
  setStatus(netStatus, "Network offline", "");
  updateCaptureState();
  updateEventMetric();
  setHmpButtonsDisabled(true);
  pollDiskIoStats();
  renderProbeLog("initial");
  updateProbeState();
  window.setInterval(() => {
    heartbeat += 1;
    lastHeartbeatAt = performance.now();
    heartbeatMetric.textContent = String(heartbeat);
    syncDisplayToCanvasBacking("heartbeat");
    pollSharedCursor();
    applyHostCursorMode();
    if (heartbeat % 2 === 0) sampleFramebuffer();
    if (heartbeat % 3 === 0) pollDiskIoStats();
    updateProbeState();
  }, 1000);
  window.setInterval(pollControlFile, 750);
  log("browser shell ready");
  checkBundles(true)
    .then(applyQueryAutomation)
    .catch((error) => {
      log(`query automation failed: ${formatError(error)}`);
    });
})();
