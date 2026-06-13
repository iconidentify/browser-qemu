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
  let qemuAutoPulseMs = 0;
  let qemuControlWorker = null;
  let qemuSharedInput = null;
  let qemuDiskWorker = null;
  let qemuDiskShared = null;
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
  let mouseButtons = 0;
  let pendingMouseDx = 0;
  let pendingMouseDy = 0;
  let mouseFlushTimer = 0;
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
  const serialLines = [];
  const maxSerialLines = 1500;
  const maxSerialChars = 220000;
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
    serial.textContent = `${serialLines.join("\n")}\n`;
    serial.scrollTop = serial.scrollHeight;
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
    const cacheMb = Number(params.get("diskCacheMb")) || 512;
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
    updateEventMetric();
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
      qemuAutoPulseMs,
      lastControlId,
      hmpMonitorActive,
      qemuStatus: qemuStatus.textContent,
      netStatus: netStatus.textContent,
      activeElement: document.activeElement ? document.activeElement.id || document.activeElement.tagName : "",
      capture: captureMetric.textContent,
      lastKey: lastKey.textContent,
      mouse: mouseMetric.textContent,
      ptyQueuedBytes: qemuPty ? qemuPty.queuedBytes() : 0,
      controlWorkerPollCount,
      controlWorkerPollAgeMs: controlWorkerPollAt ? Date.now() - controlWorkerPollAt : -1,
      controlWorkerPollOkCount,
      controlWorkerPollLastError,
      ptyDroppedBytes: qemuPty ? qemuPty.droppedBytes() : 0,
      events: { ...eventCounters },
      canvas: {
        width: canvas.width,
        height: canvas.height,
        clientWidth: Math.round(canvas.getBoundingClientRect().width),
        clientHeight: Math.round(canvas.getBoundingClientRect().height),
      },
      framebuffer: framebufferProbe,
      cpu: lastCpuRegister,
      diskIo: diskIoStats,
      serialTail: serial.textContent.slice(-4000),
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

  function queueKeyboardEvent(event) {
    if (!shouldCaptureEvent(event) || event.repeat || event.type !== "keydown") return;
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
    // SDL delivers mouse input directly once the runtime is live; HMP
    // mouse_move floods can wedge the monitor PTY during boot.
    if (qemuInstance && !inputSelfTestStayPaused) return;
    pendingMouseDx += Math.max(-512, Math.min(512, Math.trunc(dx || 0)));
    pendingMouseDy += Math.max(-512, Math.min(512, Math.trunc(dy || 0)));
    if (!mouseFlushTimer) {
      mouseFlushTimer = window.setTimeout(flushMouseMove, 80);
    }
  }

  function queueMouseButtons(event) {
    if (!qemuStarted || (!keyCapture && document.pointerLockElement !== canvas && document.activeElement !== canvas)) {
      return;
    }
    if (qemuInstance && !inputSelfTestStayPaused) return;
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

  function normalizePulseIntervalMs(value) {
    const intervalMs = Number.parseInt(value, 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
    return Math.max(5000, Math.min(60000, intervalMs));
  }

  function selectedHeapMb() {
    const params = new URLSearchParams(window.location.search);
    return params.has("heap") ? normalizeHeapMb(params.get("heap")) : null;
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
    const m = /^(\d{3,4})x(\d{3,4})(?:x(\d+))?$/.exec(res);
    if (!m) {
      log(`ignoring invalid ?res=${res} (use WxH, e.g. 800x600)`);
      return args;
    }
    const geom = `${m[1]}x${m[2]}x${m[3] || "8"}`;
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

  function initializeBootOptionsFromQuery() {
    const params = new URLSearchParams(window.location.search);
    if (ramSizeSelect && params.has("ram")) {
      ramSizeSelect.value = String(normalizeRamMb(params.get("ram")));
    }
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
      "-display", "sdl,gl=off,show-cursor=on",
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
    qemuPty = createPtyShim(qemuSharedInput);
    qemuControlWorker = startControlWorker(qemuSharedInput);
    qemuDiskWorker = startDiskWorker(runtime, runtimeDir);
    qemuStartPaused = Boolean(options.startPaused);
    qemuHeapMb = selectedHeapMb();
    qemuAutoPulseMs = normalizePulseIntervalMs(options.autoPulseMs);
    hmpMonitorActive = false;
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
        setStatus(qemuStatus, qemuStartPaused ? "QEMU paused" : "QEMU running", "ready");
        displayPanel.classList.add("runtime-active");
        focusCanvas();
        log(qemuStartPaused ? "qemu runtime initialized with guest CPU paused" : "qemu runtime initialized");
        if (runInputSelfTestAfterQemuReady) {
          runInputSelfTestAfterQemuReady = false;
          runInputSelfTest();
        }
        if (qemuAutoPulseMs) {
          window.setTimeout(() => startPulseRun(qemuAutoPulseMs), 250);
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
      "pulseRun30s",
      "pulseRunOff",
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

  function setPulseRunState(active, intervalMs = 30000) {
    pulseRunActive = active;
    const startButton = document.getElementById("pulseRun30s");
    const stopButton = document.getElementById("pulseRunOff");
    if (startButton) startButton.disabled = !qemuPty || active;
    if (stopButton) stopButton.disabled = !qemuPty || !active;
    if (active) {
      setStatus(qemuStatus, `VM pulse ${(intervalMs / 1000).toFixed(0)}s`, "ready");
    }
  }

  function queuePulseSample() {
    sendHmp("stop", false);
    sendHmp("info status", false);
    sendHmp("info registers", false);
    sendHmp("info block", false);
    sendHmp("cont", true);
  }

  function startPulseRun(intervalMs = 30000) {
    const boundedMs = Math.max(5000, Math.min(60000, Number(intervalMs) || 30000));

    if (!qemuPty) {
      log("pulse run unavailable: QEMU is not running");
      return;
    }

    clearPulseRunTimer();

    if (qemuControlWorker) {
      qemuControlWorker.postMessage({ type: "start-pulse", intervalMs: boundedMs });
    } else {
      sendHmp("cont", true);
      pulseRunTimer = window.setInterval(queuePulseSample, boundedMs);
    }

    hmpMonitorActive = false;
    setPulseRunState(true, boundedMs);
    log(`pulse run started: ${(boundedMs / 1000).toFixed(0)}s cadence`);
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
    const queryPulseMs = normalizePulseIntervalMs(
      params.get("pulseMs") || params.get("pulse") || params.get("pulse_ms")
    );

    if (!autostart && shouldRunInputSelfTest) {
      window.setTimeout(runInputSelfTest, 250);
      return;
    }

    if (!autostart) return;

    const autostartMap = {
      "lazy": ["qemu-lazy", {}],
      "lazy-pulse": ["qemu-lazy", { startPaused: true, autoPulseMs: queryPulseMs || 30000 }],
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
          startPulseRun(item.intervalMs);
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
  document.getElementById("pulseRun30s").addEventListener("click", () => startPulseRun(30000));
  document.getElementById("pulseRunOff").addEventListener("click", stopPulseRun);
  inputSelfTestButton.addEventListener("click", runInputSelfTest);
  runRomProbeButton.addEventListener("click", runRomProbe);
  probeSnapshotButton.addEventListener("click", () => refreshProbe("manual snapshot"));
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
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
  });

  canvas.addEventListener("keydown", (event) => {
    recordEvent("keydown");
    lastKey.textContent = event.code;
    if (shouldCaptureEvent(event)) {
      event.preventDefault();
    }
    // Once the runtime is live, SDL's own listeners deliver keys to the
    // guest; injecting from the shell as well doubles every keystroke.
    if (inputSelfTestStayPaused || !qemuInstance) {
      queueKeyboardEvent(event);
    }
  });

  canvas.addEventListener("keyup", (event) => {
    recordEvent("keyup");
    lastKey.textContent = event.code;
    if (shouldCaptureEvent(event)) {
      event.preventDefault();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.target === canvas || isEditableTarget(event.target) || !keyCapture) return;
    recordEvent("keydown");
    lastKey.textContent = event.code;
    event.preventDefault();
    if (inputSelfTestStayPaused || !qemuInstance) {
      queueKeyboardEvent(event);
    }
  }, { capture: true });

  document.addEventListener("keyup", (event) => {
    if (event.target === canvas || isEditableTarget(event.target) || !keyCapture) return;
    recordEvent("keyup");
    lastKey.textContent = event.code;
    event.preventDefault();
  }, { capture: true });

  canvas.addEventListener("mousedown", (event) => {
    recordEvent("mousedown");
    focusCanvas();
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
    queueMouseButtons(event);
  });

  canvas.addEventListener("mouseup", (event) => {
    recordEvent("mouseup");
    if (qemuStarted || keyCapture) {
      event.preventDefault();
    }
    queueMouseButtons(event);
  });

  canvas.addEventListener("mousemove", (event) => {
    recordEvent("mousemove");
    mouseX += event.movementX || 0;
    mouseY += event.movementY || 0;
    mouseMetric.textContent = `${mouseX}, ${mouseY}`;
    queueMouseMove(event.movementX || 0, event.movementY || 0);
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
  }, { passive: false });

  document.addEventListener("pointerlockchange", () => {
    updateCaptureState();
    log(document.pointerLockElement === canvas ? "pointer lock on" : "pointer lock off");
  });

  document.addEventListener("fullscreenchange", updateCaptureState);

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
