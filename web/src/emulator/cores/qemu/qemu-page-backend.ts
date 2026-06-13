/**
 * QEMU page-host backend.
 *
 * Unlike Basilisk II (which compiles to a single-threaded core that runs INSIDE
 * a Web Worker and calls back through `workerApi`), the QEMU m68k wasm runtime
 * is built with `-sPROXY_TO_PTHREAD=1` and drives SDL: it makes ~100 synchronous
 * `proxyToMainThread` calls and touches `document`/`window` for display, input,
 * cursor, fullscreen and pointer lock. Those only exist on the page main thread,
 * so QEMU cannot run inside a worker without a deep SDL rewrite. Its natural home
 * is the page.
 *
 * This class hosts QEMU on the page but presents the SAME surface a `Worker`
 * does (`postMessage` / `onmessage` / `terminate`), so `EmulatorCanvas` drives it
 * with no special-casing. The display is decoupled exactly like BasiliskII's:
 * the patched SDL blit (scripts/patch-qemu-out-js-display.mjs) records the live
 * framebuffer into a small shared control block (`Module.c89Screen`) instead of
 * doing a synchronous main-thread `putImageData`; this backend copies that
 * framebuffer into the common `screenBuffer` SAB and posts `emulator_blit`, and
 * `EmulatorCanvas` renders it on its own rAF. Input and the CSS hardware cursor
 * keep flowing through SDL's DOM listeners on the shared canvas (the proven path).
 *
 * Boot only needs the lean loader: window.Module + the runtime's module.js
 * (sets the q800 args + lazy disk) + load.js (downloads the ROM/PRAM .data pack)
 * + out.js. pty / control-worker / ethernet are optional and omitted here (the
 * lazyfile patch supplies a default PTY stub when Module.pty is absent).
 */

// c89Screen control-block slots (mirror of patch-qemu-out-js-display.mjs / app.js)
const C89_SCREEN_MAGIC = 0x53435231; // "SCR1"
const SCR_W = 1;
const SCR_H = 2;
const SCR_PTR = 3;
const SCR_GEN = 4;

const RUNTIME_DIR = 'qemu-lazy';

interface QemuStartConfig {
  baseUrl?: string;
  width?: number;
  height?: number;
  screenBuffer?: SharedArrayBuffer | null;
  videoModeBuffer?: SharedArrayBuffer | null;
  inputBuffer?: SharedArrayBuffer | null;
  debug?: boolean;
  [key: string]: unknown;
}

type WorkerMessage = { data: Record<string, unknown> };
type Listener = (ev: WorkerMessage) => void;

declare global {
  interface Window {
    Module?: Record<string, unknown>;
    AuxQemu?: Record<string, unknown>;
    AuxQemuReady?: Promise<Record<string, unknown>>;
    AuxQemuModuleArguments?: string[] | null;
    AuxQemuDiskWritable?: boolean;
  }
}

export class QemuPageBackend {
  // Worker-compatible surface ------------------------------------------------
  onmessage: Listener | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private listeners = new Map<string, Set<Listener>>();
  private canvas: HTMLCanvasElement | null = null;

  private instance: Record<string, unknown> | null = null;
  private screenCtl: Int32Array | null = null;
  private screenBuf32: Int32Array | null = null;
  private screenBuf8: Uint8Array | null = null;
  private videoMode: Int32Array | null = null;
  private rafId = 0;
  private pumpTicks = 0;
  private blits = 0;
  private lastGen = -1;

  // PTY-wait driver: QEMU's main loop (a pthread) blocks in a bounded
  // Atomics.wait on a monitor-stdin "readable" index; with -monitor stdio and an
  // infinite poll timeout it sleeps until woken. The stock app delegates that
  // wake to a control worker via Module.ptyWaitIndex. We do the same wake here on
  // the page with a timer -- storing 0 + notifying the index drives the boot.
  private ptyWaitHeap: Int32Array | null = null;
  private ptyWaitIdx = -1;
  private ptyWakeTimer: ReturnType<typeof setInterval> | 0 = 0;
  private ptyWaitSeen = 0;
  private lastW = 0;
  private lastH = 0;
  private stopped = false;
  private debug = false;

  /** EmulatorCanvas hands us its canvas (page-host cores render to a real DOM
   *  canvas: SDL binds input + the CSS cursor to it, we render frames to it). */
  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(msg: { type: string; config?: QemuStartConfig }): void {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'start') {
      this.start(msg.config || {}).catch((err) => this.fail(err));
    } else if (msg.type === 'stop') {
      this.stop();
    }
    // 'input' / 'ethernet_receive' are no-ops: QEMU takes DOM input via SDL on
    // the shared canvas, so the common input SAB path isn't used for this core.
  }

  terminate(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------

  private diag(...args: unknown[]): void {
    if (this.debug) console.log('[QemuPageBackend]', ...args);
  }

  private emit(type: string, payload: Record<string, unknown> = {}): void {
    const ev: WorkerMessage = { data: { type, ...payload } };
    try {
      this.onmessage?.(ev);
    } catch (e) {
      console.error('[QemuPageBackend] onmessage handler threw', e);
    }
    const set = this.listeners.get('message');
    if (set) for (const fn of set) {
      try { fn(ev); } catch (e) { console.error('[QemuPageBackend] listener threw', e); }
    }
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[QemuPageBackend] error:', err);
    this.emit('emulator_error', { error: message, recoverable: false });
  }

  private asset(path: string): string {
    const base = (typeof window !== 'undefined' && window.location)
      ? window.location.href : 'http://localhost/';
    return new URL(`./${RUNTIME_DIR}/${path}`, base).href;
  }

  private importAsset(path: string): string {
    const url = new URL(this.asset(path));
    // Cache-bust out.js per session like app.js does.
    const buildParam = (typeof window !== 'undefined')
      ? new URLSearchParams(window.location.search).get('build') : null;
    url.searchParams.set('build', buildParam || 'qemu-core');
    return url.href;
  }

  /**
   * Minimal xterm-pty-compatible TTY for QEMU's `-monitor stdio` chardev.
   *
   * This is the real fix for the boot stall: with no Module.pty the runtime
   * falls back to a stub whose `readable` is always false and whose onReadable
   * never registers, so xterm-pty asks the main loop to wait indefinitely
   * (PTY_pollTimeout = -1 -> Infinity) and the QEMU CPU thread parks forever
   * after the first disk read. A proper readable/onReadable model makes
   * xterm-pty set a bounded poll timeout, so the patched bounded Atomics.wait
   * (min 8ms) ticks the main loop and the guest boots. We don't feed it any
   * monitor input here (HMP is unused by this core); it only needs to behave
   * like a live, momentarily-empty TTY.
   */
  private createPty() {
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const input: number[] = [];
    const readableListeners = new Set<() => void>();
    const signalListeners = new Set<(name: string) => void>();
    const self = this;
    const notifyReadable = () => { for (const l of readableListeners) { try { l(); } catch { /* ignore */ } } };
    return {
      get readable() { return input.length > 0; },
      writable: true,
      read(length?: number) {
        const count = Math.max(0, length || input.length);
        return input.splice(0, count);
      },
      write(bytes: ArrayLike<number>) {
        if (!bytes || !bytes.length) return;
        if (!self.debug) return;
        const text = decoder ? decoder.decode(new Uint8Array(Array.from(bytes)))
          : String.fromCharCode.apply(null, Array.from(bytes));
        if (text.trim()) console.log('[qemu stdio]', text.replace(/\s+$/, ''));
      },
      ioctl(request: string) {
        if (request === 'TCGETS') return { iflag: 0, oflag: 0, cflag: 0, lflag: 0, cc: new Uint8Array(32) };
        if (request === 'TIOCGWINSZ') return [0, 0, 80, 24];
        return 0;
      },
      onReadable(listener: () => void) {
        if (typeof listener !== 'function') return { dispose() { /* noop */ } };
        readableListeners.add(listener);
        return { dispose() { readableListeners.delete(listener); } };
      },
      onSignal(listener: (name: string) => void) {
        if (typeof listener !== 'function') return { dispose() { /* noop */ } };
        signalListeners.add(listener);
        return { dispose() { signalListeners.delete(listener); } };
      },
      signal(name: string) { for (const l of signalListeners) { try { l(name); } catch { /* ignore */ } } },
      pushText(text: string) {
        const enc = encoder ? Array.from(encoder.encode(text)) : Array.from(text).map((c) => c.charCodeAt(0) & 0xff);
        input.push(...enc);
        notifyReadable();
      },
      queuedBytes() { return input.length; },
      droppedBytes() { return 0; },
    };
  }

  private loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  private async start(config: QemuStartConfig): Promise<void> {
    this.debug = Boolean(config.debug);
    this.diag('start()', { hasCanvas: !!this.canvas, coi: (window as any).crossOriginIsolated,
      hasScreenBuf: !!config.screenBuffer, hasVideoMode: !!config.videoModeBuffer });
    if (!this.canvas) {
      throw new Error('QemuPageBackend.start: no canvas attached');
    }
    try {
      const cs = getComputedStyle(this.canvas);
      this.diag(`canvas state connected=${this.canvas.isConnected} display=${cs.display} ` +
        `offset=${this.canvas.offsetWidth}x${this.canvas.offsetHeight} attr=${this.canvas.width}x${this.canvas.height}`);
    } catch { /* ignore */ }

    // Lock the canvas to a 2D context BEFORE SDL initialises. SDL's renderer
    // probe tries the opengles2 (WebGL) driver first; on a fresh canvas in a
    // GPU-less/headless context it gets a half-built WebGL context and crashes
    // in createShader. Grabbing a 2D context first makes getContext('webgl')
    // return null, so SDL falls back to the software renderer (which uses this
    // same 2D context) -- exactly what the stock app.js does at page load. The
    // decoupled blit short-circuits before any draw, and EmulatorCanvas reuses
    // this 2D context to present frames from the screenBuffer.
    try { this.canvas.getContext('2d'); } catch { /* ignore */ }
    if (typeof SharedArrayBuffer === 'undefined' || !window.crossOriginIsolated) {
      throw new Error('QEMU core requires cross-origin isolation (COOP/COEP)');
    }
    if (!config.screenBuffer || !config.videoModeBuffer) {
      throw new Error('QEMU core requires screenBuffer + videoModeBuffer');
    }

    this.screenBuf32 = new Int32Array(config.screenBuffer);
    this.screenBuf8 = new Uint8Array(config.screenBuffer);
    this.videoMode = new Int32Array(config.videoModeBuffer);

    // Shared screen control block for the decoupled blit (out.js writes here).
    const screenShared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    this.screenCtl = new Int32Array(screenShared);
    Atomics.store(this.screenCtl, 0, C89_SCREEN_MAGIC);

    this.emit('emulator_loading', { message: 'Loading QEMU runtime' });

    // Build the page Module exactly as the proven app.js loader does (minus the
    // pty/control-worker/disk-worker/net wiring, which boot-to-login doesn't need).
    window.AuxQemuModuleArguments = null;
    window.AuxQemuDiskWritable = false; // read-only base image
    const self = this;
    window.Module = {
      canvas: this.canvas,
      c89Screen: screenShared,
      pty: this.createPty(),
      preRun: [
        (Module: any) => {
          Module.FS_createPath('/', 'tmp', true, true);
          Module.FS_createPath('/', 'var/tmp', true, true);
        },
      ],
      // Pointer lock OFF (relative-mouse flood through SDL wedges headed tabs;
      // A/UX uses absolute mouse fine). Mirrors app.js.
      elementPointerLock: false,
      thisProgram: 'qemu-system-m68k',
      mainScriptUrlOrBlob: this.asset('out.js'),
      locateFile(path: string) {
        return self.asset(path);
      },
      // Wake the QEMU main-loop PTY wait (see ptyWait* fields above).
      ptyWaitIndex(atomicIndex: number, memory: { buffer: ArrayBufferLike }) {
        if (!memory || !memory.buffer) return;
        self.ptyWaitSeen++;
        if (self.ptyWaitSeen <= 2) self.diag('ptyWaitIndex called idx=' + atomicIndex);
        self.ptyWaitHeap = new Int32Array(memory.buffer as ArrayBuffer);
        self.ptyWaitIdx = atomicIndex;
        if (!self.ptyWakeTimer) {
          self.ptyWakeTimer = setInterval(() => {
            if (self.ptyWaitHeap && self.ptyWaitIdx >= 0) {
              Atomics.store(self.ptyWaitHeap, self.ptyWaitIdx, 0);
              Atomics.notify(self.ptyWaitHeap, self.ptyWaitIdx);
            }
          }, 16);
        }
      },
      setStatus(text: string) {
        if (!text) return;
        if (text === 'Running...') self.emit('emulator_ready');
        if (self.debug) console.log('[QemuPageBackend] status:', text);
      },
      print(text: string) {
        if (text && self.debug) console.log('[qemu]', text);
      },
      printErr(text: string) {
        if (text && self.debug) console.warn('[qemu err]', text);
      },
      onAbort(reason: unknown) {
        self.fail(new Error(`qemu abort: ${reason}`));
      },
    };

    // module.js sets window.Module.arguments + pushes the lazy-disk preRun.
    await this.loadScript(this.asset('module.js'));
    // load.js registers the ROM/PRAM .data package download.
    await this.loadScript(this.asset('load.js'));

    const mod = await import(/* @vite-ignore */ this.importAsset('out.js'));
    const initQemu = mod.default as (m: unknown) => Promise<Record<string, unknown>>;
    const ready = initQemu(window.Module);
    window.AuxQemuReady = ready;

    this.diag('runtime init invoked; awaiting ready');
    const instance = await ready;
    if (this.stopped) return;
    this.instance = instance;
    window.AuxQemu = instance;
    this.diag('runtime ready; HEAP32?', !!(instance as any).HEAP32, 'starting frame pump');
    this.emit('emulator_ready');
    this.startFramePump();
  }

  /** rAF loop: detect a new framebuffer generation, push it into the common
   *  screenBuffer SAB (forcing opaque alpha), and signal EmulatorCanvas to draw. */
  private startFramePump(): void {
    if (this.rafId) return;
    const pump = () => {
      if (this.stopped) { this.rafId = 0; return; }
      this.pumpFrame();
      this.rafId = requestAnimationFrame(pump);
    };
    this.rafId = requestAnimationFrame(pump);
  }

  private pumpFrame(): void {
    const ctl = this.screenCtl;
    const inst = this.instance;
    const sb32 = this.screenBuf32;
    const sb8 = this.screenBuf8;
    const vm = this.videoMode;
    if (!ctl || !inst || !sb32 || !sb8 || !vm) return;

    const gen = Atomics.load(ctl, SCR_GEN);
    if (this.debug) {
      this.pumpTicks++;
      if (this.pumpTicks <= 3 || this.pumpTicks % 180 === 0) {
        this.diag(`pump tick ${this.pumpTicks} gen=${gen} lastGen=${this.lastGen} w=${Atomics.load(ctl, SCR_W)} h=${Atomics.load(ctl, SCR_H)} ptr=${Atomics.load(ctl, SCR_PTR)}`);
      }
    }
    if (gen === this.lastGen) return;
    const w = Atomics.load(ctl, SCR_W);
    const h = Atomics.load(ctl, SCR_H);
    const ptr = Atomics.load(ctl, SCR_PTR);
    if (w <= 0 || h <= 0 || !ptr) return;

    const heap32 = inst.HEAP32 as Int32Array | undefined;
    if (!heap32 || !heap32.length) { this.diag('pump: no HEAP32'); return; }
    const n = w * h;
    const src = ptr >>> 2;
    if (src + n > heap32.length) return; // stale ptr across a mode change
    if (n * 4 > sb32.length * 4) return; // exceeds the 1600x1200 screenBuffer

    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w;
      this.lastH = h;
      this.emit('emulator_video_open', { width: w, height: h });
    }

    // Copy framebuffer -> screenBuffer; QEMU's macfb packs RGB in the low three
    // bytes with an undefined 4th byte, so force alpha = 0xff (EmulatorCanvas
    // blits screenBuffer verbatim and does not fix alpha itself).
    sb32.set(heap32.subarray(src, src + n));
    const end = n * 4;
    for (let i = 3; i < end; i += 4) sb8[i] = 0xff;

    vm[0] = end; // bufferSize in bytes (EmulatorCanvas reads videoModeBuffer[0])
    vm[1] = w;
    vm[2] = h;

    this.lastGen = gen;
    this.blits++;
    if (this.blits <= 2 || this.blits % 120 === 0) this.diag('emitted blit', this.blits, { w, h, bytes: end });
    this.emit('emulator_blit');
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (this.ptyWakeTimer) { clearInterval(this.ptyWakeTimer); this.ptyWakeTimer = 0; }
    // QEMU has no clean in-process shutdown here; the page navigates/reloads to
    // fully reset. Signal the shell that we're done.
    this.emit('emulator_stopped');
  }
}
