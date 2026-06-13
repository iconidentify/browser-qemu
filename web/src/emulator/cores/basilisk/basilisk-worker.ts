/**
 * Simplified BasiliskII Worker
 *
 * Loads BasiliskII WASM and provides minimal workerApi for:
 * - Video output
 * - Input handling
 * - Ethernet (via DialtoneEthernet)
 * - Disk access
 */

/// <reference lib="webworker" />

import { logger } from '../../logger';
import { createDisk, LockConflictError } from '../../disk/DiskFactory';
import { getHeartbeatInfo } from '../../disk/DiskLockManager';
import type { Disk, DiskStorageMode } from '../../disk/types';
import { InputBufferAddresses, LockStates, mapKeyCode } from '../../input';

// Unique worker ID for debugging multiple worker instances
const WORKER_ID = Math.random().toString(36).substring(2, 8);

// Worker state machine - tracks initialization progress
type WorkerState = 'idle' | 'starting' | 'loading_disks' | 'loading_wasm' | 'running' | 'stopped';
let workerState: WorkerState = 'idle';

// Emscripten module reference
let Module: any = null;
// Set AFTER createEmulator completes - guarantees HEAPU8 is ready
let currentModule: any = null;
// Flag to indicate module is fully initialized (HEAPU8 ready for disk reads)
let moduleFullyInitialized = false;

// Guard against duplicate didOpenVideo calls causing WASM memory corruption
// C++ calls video_close() then video_open() during switch_to_current_mode(),
// which triggers TWO didOpenVideo callbacks. The second corrupts FrameBaseDiff.
let videoOpened = false;

// Ethernet packet receive queue
const ethernetReceiveQueue: Uint8Array[] = [];

// Input state via SharedArrayBuffer (if available) or fallback array
let inputBuffer: Int32Array | null = null;
// Fallback input values when SharedArrayBuffer not available
const inputValues: number[] = new Array(32).fill(0);

// Ethernet receive buffer via SharedArrayBuffer
let ethernetDataBuffer: Uint8Array | null = null;
let ethernetCtrlBuffer: Int32Array | null = null;
let ethernetReadIdx = 0;

// Audio buffer via SharedArrayBuffer
let audioDataBuffer: Uint8Array | null = null;
let audioCtrlBuffer: Int32Array | null = null;

// Video buffer via SharedArrayBuffer for zero-copy frame transfer
let screenBuffer: Uint8Array | null = null;
let videoModeBuffer: Int32Array | null = null;

// Frame timing for smooth video playback
let nextExpectedBlitTime = 0;
let lastBlitFrameId = 0;
let lastIdleWaitFrameId = 0;

// Disk storage - uses SimpleDisk for direct relay I/O
const loadedDisks: Map<string, Disk> = new Map();
const openedDisks: Map<number, Disk> = new Map();
let diskIdCounter = 0;
const warnedDiskIds: Set<number> = new Set();

// HD activity throttling - avoid spamming main thread
let lastHdActivityTime = 0;
const HD_ACTIVITY_THROTTLE_MS = 30;

// Cursor queue - handles race condition where C++ calls setCursor before module ready
import { CursorQueue, isCursorPtrInBounds } from '../../CursorQueue';
const cursorQueue = new CursorQueue();

function signalHdActivity() {
  const now = performance.now();
  if (now - lastHdActivityTime >= HD_ACTIVITY_THROTTLE_MS) {
    lastHdActivityTime = now;
    postMessage({ type: 'emulator_hd_activity' });
  }
}

// Guest CPU load estimation. The emulator blocks this thread, so wall-clock
// duty cycle is always ~100% - instead we classify time by how the guest
// behaves. An idle guest churns through idleWait every couple of ms (and
// occasionally sleeps in Atomics.wait); a busy guest executes 68k code in
// long stretches between idleWait calls. Time slept plus short between-call
// gaps count as idle; long gaps count as work.
let cpuWindowStart = 0;
let cpuIdleAccum = 0;
let cpuLastIdleEntry = 0;
let cpuLastIdleSleep = 0;
const CPU_LOAD_WINDOW_MS = 500;
// Between-call gaps shorter than this are idle-loop churn, not real work
const CPU_IDLE_CHURN_MS = 5;

function maybePostCpuLoad() {
  const now = performance.now();
  if (cpuWindowStart === 0) {
    cpuWindowStart = now;
    return;
  }
  const elapsed = now - cpuWindowStart;
  if (elapsed < CPU_LOAD_WINDOW_MS) return;
  const load = Math.min(1, Math.max(0, 1 - cpuIdleAccum / elapsed));
  cpuWindowStart = now;
  cpuIdleAccum = 0;
  postMessage({ type: 'emulator_cpu_load', load });
}

function trackIdleWaitEntry() {
  const entry = performance.now();
  if (cpuLastIdleEntry > 0) {
    const work = entry - cpuLastIdleEntry - cpuLastIdleSleep;
    if (work >= 0 && work < CPU_IDLE_CHURN_MS) {
      cpuIdleAccum += work;
    }
  }
  cpuLastIdleEntry = entry;
  cpuLastIdleSleep = 0;
}

/**
 * Process any pending cursor update that was queued before module was ready.
 * Called from preRun after currentModule is set.
 */
function processPendingCursor() {
  const pending = cursorQueue.dequeue();
  if (pending && currentModule?.HEAPU8) {
    const { dataPtr, hotspotX, hotspotY, visible } = pending;
    logger.log('[Worker] Processing pending cursor update');
    workerApi.setCursor(dataPtr, hotspotX, hotspotY, visible);
  }
}

/**
 * workerApi - Called by BasiliskII WASM via EM_ASM
 */
const workerApi = {
  InputBufferAddresses,

  // Video
  // Guard against duplicate didOpenVideo calls that cause WASM memory corruption.
  // C++ calls video_close() then video_open() during switch_to_current_mode(),
  // triggering TWO callbacks. Only the first should be processed.
  didOpenVideo(width: number, height: number) {
    if (videoOpened) {
      logger.warn('[Worker] didOpenVideo called TWICE - ignoring duplicate to prevent WASM corruption');
      return;
    }
    videoOpened = true;
    // CRITICAL: Set workerState to 'running' here because createEmulator() doesn't return
    // until the emulator exits. The main loop runs inside createEmulator(), so we need
    // to signal "running" when the emulator actually starts processing frames.
    workerState = 'running';
    logger.log('[Worker] didOpenVideo called:', width, 'x', height, '- workerState now:', workerState);
    postMessage({ type: 'emulator_video_open', width, height });
  },

  blit(bufPtr: number, bufSize: number) {
    maybePostCpuLoad();

    const mod = currentModule || Module;

    if (!mod) {
      // Try to get module from globalThis as last resort (Safari workaround)
      const globalMod = (globalThis as any).__BASILISK_MODULE__;
      if (globalMod?.HEAPU8) {
        currentModule = globalMod;
      } else {
        return;
      }
    }
    if (!bufPtr) {
      return;
    }

    const actualMod = currentModule || Module;
    if (!actualMod?.HEAPU8) return;

    // Validate buffer parameters
    if (bufSize <= 0 || bufSize > 1600 * 1200 * 4) {
      logger.warn('[Worker] blit: invalid bufSize:', bufSize);
      return;
    }

    // Validate bufPtr is within WASM heap bounds
    if (bufPtr + bufSize > actualMod.HEAPU8.length) {
      logger.warn('[Worker] blit: bufPtr out of bounds:', bufPtr, 'size:', bufSize, 'heap:', actualMod.HEAPU8.length);
      return;
    }

    // Use SharedArrayBuffer for zero-copy frame transfer
    if (screenBuffer && videoModeBuffer) {
      // Track frame timing for synchronization
      lastBlitFrameId++;
      nextExpectedBlitTime = performance.now() + 16; // Target 60fps (16ms per frame)

      // subarray creates a view (no allocation), set copies to pre-allocated SAB
      const data = actualMod.HEAPU8.subarray(bufPtr, bufPtr + bufSize);
      videoModeBuffer[0] = bufSize;
      screenBuffer.set(data);
      // Just send notification - pixels are already in SharedArrayBuffer
      postMessage({ type: 'emulator_blit' });
    } else {
      // This shouldn't happen - log it for debugging
      logger.warn('[Worker] blit: video buffers not ready, screenBuffer:', !!screenBuffer, 'videoModeBuffer:', !!videoModeBuffer);
    }
  },

  // Cursor - called by C++ when Mac OS changes the cursor
  setCursor(dataPtr: number, hotspotX: number, hotspotY: number, visible: number) {
    const mod = currentModule || Module;

    // If module not ready (HEAPU8 not available), queue the update for later
    // This fixes a race condition where C++ calls setCursor before preRun completes
    if (!mod?.HEAPU8) {
      cursorQueue.enqueue({ dataPtr, hotspotX, hotspotY, visible });
      return;
    }

    // Validate the pointer is within bounds using the tested helper
    if (!isCursorPtrInBounds(dataPtr, mod.HEAPU8.length)) {
      logger.warn(`[Worker] setCursor: dataPtr ${dataPtr} out of bounds (heap size: ${mod.HEAPU8.length})`);
      return;
    }

    // Clear any pending update since we're processing now
    cursorQueue.clear();

    // Read 64 bytes of cursor data (32 bytes bitmap + 32 bytes mask)
    const cursorData = mod.HEAPU8.slice(dataPtr, dataPtr + 64);

    postMessage({
      type: 'emulator_cursor_change',
      dataBitmap: new Uint8Array(cursorData.slice(0, 32)),
      maskBitmap: new Uint8Array(cursorData.slice(32, 64)),
      hotspotX,
      hotspotY,
      visible: visible === 1,
    });
  },

  // Debug version with content counts
  setCursorDebug(dataPtr: number, hotspotX: number, hotspotY: number, dataContent: number, maskContent: number) {
    const mod = currentModule || Module;
    if (!mod) return;

    const cursorData = mod.HEAPU8.slice(dataPtr, dataPtr + 64);
    const d0 = cursorData[0], d1 = cursorData[1];
    const m0 = cursorData[32], m1 = cursorData[33];

    logger.log(`[Worker] setCursor: data=${d0.toString(16).padStart(2,'0')}${d1.toString(16).padStart(2,'0')} mask=${m0.toString(16).padStart(2,'0')}${m1.toString(16).padStart(2,'0')} dataBytes=${dataContent} maskBytes=${maskContent} hotspot=(${hotspotX},${hotspotY})`);

    postMessage({
      type: 'emulator_cursor_change',
      dataBitmap: new Uint8Array(cursorData.slice(0, 32)),
      maskBitmap: new Uint8Array(cursorData.slice(32, 64)),
      hotspotX,
      hotspotY,
    });
  },

  // Audio
  didOpenAudio(sampleRate: number, sampleSize: number, channels: number) {
    logger.log(`[Worker] didOpenAudio called: ${sampleRate}Hz, ${sampleSize}-bit, ${channels}ch - init sequence continues...`);
    postMessage({ type: 'emulator_audio_open', sampleRate, sampleSize, channels });
  },

  audioBufferSize(): number {
    // Returns bytes available to read (how full the buffer is)
    // Used by C++ for back-pressure: if buffer is too full, skip audio interrupt
    if (!audioCtrlBuffer || !audioDataBuffer) return 0;

    const writeIdx = Atomics.load(audioCtrlBuffer, 0);
    const readIdx = Atomics.load(audioCtrlBuffer, 1);
    const capacity = audioDataBuffer.length;

    return writeIdx >= readIdx
      ? writeIdx - readIdx
      : capacity - readIdx + writeIdx;
  },

  enqueueAudio(bufPtr: number, nbytes: number) {
    const mod = currentModule || Module;
    if (!mod || !audioDataBuffer || !audioCtrlBuffer) return;

    const capacity = audioDataBuffer.length;
    const writeIdx = Atomics.load(audioCtrlBuffer, 0);
    const readIdx = Atomics.load(audioCtrlBuffer, 1);

    // Calculate available space (same ring buffer math as ethernet)
    const used = writeIdx >= readIdx
      ? writeIdx - readIdx
      : capacity - readIdx + writeIdx;
    const available = capacity - used - 1;

    if (nbytes > available) {
      // Buffer full - drop audio (back-pressure should prevent this)
      logger.warn('[Worker] Audio buffer full, dropping', nbytes, 'bytes');
      return;
    }

    // Copy audio data from WASM memory to ring buffer
    const audioData = mod.HEAPU8.subarray(bufPtr, bufPtr + nbytes);

    // Write with wrap handling
    if (writeIdx + nbytes <= capacity) {
      // No wrap - simple copy
      audioDataBuffer.set(audioData, writeIdx);
    } else {
      // Wrap around - copy in two parts
      const firstPart = capacity - writeIdx;
      audioDataBuffer.set(audioData.subarray(0, firstPart), writeIdx);
      audioDataBuffer.set(audioData.subarray(firstPart), 0);
    }

    // Update write index
    const newWriteIdx = (writeIdx + nbytes) % capacity;
    Atomics.store(audioCtrlBuffer, 0, newWriteIdx);
  },

  // Input lock - 4-state cyclical protocol to prevent dropped input
  // Protocol: UI (0->1->2) -> Worker (2->3->0) -> UI (0->1->2) -> ...
  // Mouse position bypasses the lock for low latency, so we also check flags directly.
  acquireInputLock(): number {
    // Don't process input until emulator is fully running
    // This prevents garbage input from corrupting state during initialization
    if (workerState !== 'running') {
      return 0;
    }

    if (!inputBuffer) {
      // No SharedArrayBuffer - fallback behavior, always succeed
      return 1;
    }

    // Try to transition READY_FOR_EMUL_THREAD (2) -> EMUL_THREAD_LOCK (3)
    const prevState = Atomics.compareExchange(
      inputBuffer,
      InputBufferAddresses.globalLockAddr,
      LockStates.READY_FOR_EMUL_THREAD,
      LockStates.EMUL_THREAD_LOCK
    );

    if (prevState === LockStates.READY_FOR_EMUL_THREAD) {
      // Successfully acquired lock - there's queued input to read
      return 1;
    }

    // If lock is at state 1 (UI writing), don't interfere - wait for it to finish
    if (prevState === LockStates.UI_THREAD_LOCK) {
      return 0;
    }

    // Lock at state 0 or 3 - check for DIRECT input only (bypasses queue)
    // Mouse position and ethernet are written directly without the lock protocol.
    // Key events go through the queue (lock protocol), so DON'T check keyEventFlagAddr here
    // to avoid race condition where we return 1 but lock transitions 0->2 before we read it.
    const hasMouseInput = Atomics.load(inputBuffer, InputBufferAddresses.mousePositionFlagAddr);
    const hasEthernetInterrupt = Atomics.load(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr);

    if (hasMouseInput || hasEthernetInterrupt) {
      return 1; // There's direct input to read
    }

    // No input ready
    return 0;
  },

  releaseInputLock() {
    // Reset input flags and values after emulator reads them
    if (inputBuffer) {
      Atomics.store(inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 0);
      Atomics.store(inputBuffer, InputBufferAddresses.keyEventFlagAddr, 0);
      // Reset mouseButtonStateAddr to -1 (no event) so stale values don't trigger events
      // The C++ checks `mouse_button_state > -1` to determine if there's a button event
      Atomics.store(inputBuffer, InputBufferAddresses.mouseButtonStateAddr, -1);
      // Note: DO NOT clear useMouseDeltasFlagAddr - it's a one-time mode setting, not per-event

      // Only transition lock if we actually acquired it (state 3)
      // If we just read mouse position (lock at 0), don't change lock state
      const currentState = Atomics.load(inputBuffer, InputBufferAddresses.globalLockAddr);
      if (currentState === LockStates.EMUL_THREAD_LOCK) {
        // Transition EMUL_THREAD_LOCK (3) -> READY_FOR_UI_THREAD (0)
        Atomics.store(inputBuffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);
      }
    }
    inputValues[InputBufferAddresses.mousePositionFlagAddr] = 0;
    inputValues[InputBufferAddresses.keyEventFlagAddr] = 0;
  },

  getInputValue(addr: number): number {
    if (inputBuffer) {
      // Just read - don't clear flags here, let releaseInputLock() handle it
      // This prevents race conditions where UI overwrites data between flag read and data read
      return Atomics.load(inputBuffer, addr);
    }
    // Fallback: use regular array (won't work well with blocking WASM)
    return inputValues[addr] || 0;
  },

  setInputValue(addr: number, value: number) {
    if (inputBuffer) {
      Atomics.store(inputBuffer, addr, value);
    } else {
      // Fallback: use regular array
      inputValues[addr] = value;
    }
  },

  // Idle wait - called during emulator loop
  // This is critical for frame timing - synchronizes emulator with display refresh
  idleWait(): boolean {
    maybePostCpuLoad();
    trackIdleWaitEntry();

    // Don't do more than one wait per frame (prevents frame skipping)
    if (lastIdleWaitFrameId === lastBlitFrameId) {
      return false;
    }
    lastIdleWaitFrameId = lastBlitFrameId;

    // Check if there are ethernet packets waiting (don't sleep if packets pending)
    if (ethernetCtrlBuffer) {
      const packetCount = Atomics.load(ethernetCtrlBuffer, 2);
      if (packetCount > 0) {
        return true; // Packets waiting
      }
    }

    // Check if there's input waiting (don't sleep if input pending)
    if (inputBuffer) {
      // Check for queued input (lock at state 2 means UI wrote and is waiting for worker)
      const lockState = Atomics.load(inputBuffer, InputBufferAddresses.globalLockAddr);
      if (lockState === LockStates.READY_FOR_EMUL_THREAD) {
        return true; // Queued input waiting (mouse button, key events via queue)
      }

      // Check for direct input flags
      const hasMouseInput = Atomics.load(inputBuffer, InputBufferAddresses.mousePositionFlagAddr);
      const hasKeyInput = Atomics.load(inputBuffer, InputBufferAddresses.keyEventFlagAddr);
      const hasEthernetInterrupt = Atomics.load(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr);

      if (hasMouseInput || hasKeyInput || hasEthernetInterrupt) {
        return true; // Signal there's input to process
      }

      // Calculate time until next frame (leave 2ms for blit and CPU work)
      const idleWaitTime = nextExpectedBlitTime - performance.now() - 2;

      if (idleWaitTime > 0 && idleWaitTime < 20) {
        // Use Atomics.wait to sleep until next frame or input arrives
        // This synchronizes the emulator with display refresh rate
        const sleepStart = performance.now();
        const waitResult = Atomics.wait(
          inputBuffer,
          InputBufferAddresses.globalLockAddr,
          0, // Expected value (will wake on any change)
          idleWaitTime
        );
        const slept = performance.now() - sleepStart;
        cpuIdleAccum += slept;
        cpuLastIdleSleep = slept;
        // Return true if we were woken by input, false if timed out
        return waitResult === 'ok';
      }
    }

    return false;
  },

  sleep(_timeSeconds: number) {
    // Mini vMac style sleep
  },

  // Ethernet
  etherSeed(): number {
    const seed = new Uint32Array(1);
    crypto.getRandomValues(seed);
    return seed[0];
  },

  etherInit(macAddress: string) {
    logger.log('[Worker] etherInit called with MAC:', macAddress);
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'emulator_ethernet_init', macAddress });
  },

  etherWrite(destination: string, packetPtr: number, packetLength: number) {
    const mod = currentModule || Module;
    if (!mod) {
      logger.error('[ETHER TX] ERROR: Module not available!');
      return;
    }

    const packet: Uint8Array = mod.HEAPU8.slice(packetPtr, packetPtr + packetLength) as Uint8Array;

    // Derive destination routing hint from the actual Ethernet header
    let derivedDestination = destination;
    if (packetLength >= 14) {
      const dstMAC = Array.from(packet.subarray(0, 6)).map((b: number) => b.toString(16).padStart(2, '0')).join(':');
      if (dstMAC === 'ff:ff:ff:ff:ff:ff') {
        derivedDestination = '*';
      } else if (dstMAC.toLowerCase().startsWith('09:00:07')) {
        derivedDestination = 'AT'; // AppleTalk multicast
      } else {
        derivedDestination = dstMAC;
      }
    }

    // Use same postMessage format as Infinite Mac for compatibility
    ;(self as DedicatedWorkerGlobalScope).postMessage(
      {
        type: 'emulator_ethernet_write',
        destination: derivedDestination,
        packet,
      },
      [packet.buffer]
    );
  },

  etherRead(packetPtr: number, packetMaxLength: number): number {
    const mod = currentModule || Module;
    if (!mod) {
      return 0;
    }

    // Try SharedArrayBuffer first (works while WASM is blocking)
    if (ethernetDataBuffer && ethernetCtrlBuffer) {
      // Check if there are packets waiting
      const packetCount = Atomics.load(ethernetCtrlBuffer, 2);
      if (packetCount <= 0) {
        // No packets - ensure interrupt flag is cleared to avoid tight polling
        if (inputBuffer) {
          Atomics.store(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr, 0);
        }
        return 0;
      }
      const bufferSize = ethernetDataBuffer.length;
      const writeIdx = Atomics.load(ethernetCtrlBuffer, 0);

      // Calculate available bytes using proper ring buffer math
      const available = writeIdx >= ethernetReadIdx
        ? (writeIdx - ethernetReadIdx)
        : (bufferSize - ethernetReadIdx + writeIdx);

      if (available < 2) {
        // Not enough data for packet header
        return 0;
      }

      // Read packet length with wrap handling (2 bytes, big-endian)
      const byte0 = ethernetDataBuffer[ethernetReadIdx];
      const byte1 = ethernetDataBuffer[(ethernetReadIdx + 1) % bufferSize];
      const packetLen = (byte0 << 8) | byte1;

      // Check for wrap marker (length = 0 means skip to start of buffer)
      if (packetLen === 0) {
        ethernetReadIdx = 0;
        Atomics.store(ethernetCtrlBuffer, 1, ethernetReadIdx);
        // Don't decrement packet count - the actual packet is at position 0
        // Re-read from start
        const newByte0 = ethernetDataBuffer[0];
        const newByte1 = ethernetDataBuffer[1];
        const newPacketLen = (newByte0 << 8) | newByte1;
        if (newPacketLen <= 0 || newPacketLen > 1514) {
          logger.error(`[Worker] Invalid packetLen after wrap=${newPacketLen}`);
          return 0;
        }
        // Continue with packet at position 0
        const length = Math.min(newPacketLen, packetMaxLength);
        mod.HEAPU8.set(ethernetDataBuffer.subarray(2, 2 + length), packetPtr);
        ethernetReadIdx = 2 + newPacketLen;
        Atomics.store(ethernetCtrlBuffer, 1, ethernetReadIdx);
        const remaining = Atomics.sub(ethernetCtrlBuffer, 2, 1) - 1;
        if (remaining <= 0 && inputBuffer) {
          Atomics.store(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr, 0);
        }
        return length;
      }

      if (packetLen > 1514) {
        // Invalid packet length - decrement count and skip
        logger.error(`[Worker] Invalid packetLen=${packetLen} at readIdx=${ethernetReadIdx}, writeIdx=${writeIdx}, available=${available}`);
        const newCount = Atomics.sub(ethernetCtrlBuffer, 2, 1) - 1;
        if (newCount <= 0 && inputBuffer) {
          Atomics.store(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr, 0);
        }
        return 0;
      }

      if (available < 2 + packetLen) {
        // Incomplete packet - wait for more data
        return 0;
      }

      const length = Math.min(packetLen, packetMaxLength);

      // Copy packet data to WASM memory with wrap handling
      const packetStart = (ethernetReadIdx + 2) % bufferSize;
      if (packetStart + length <= bufferSize) {
        // No wrap - simple copy
        mod.HEAPU8.set(ethernetDataBuffer.subarray(packetStart, packetStart + length), packetPtr);
      } else {
        // Packet wraps around buffer end - copy in two parts
        const firstPart = bufferSize - packetStart;
        mod.HEAPU8.set(ethernetDataBuffer.subarray(packetStart, bufferSize), packetPtr);
        mod.HEAPU8.set(ethernetDataBuffer.subarray(0, length - firstPart), packetPtr + firstPart);
      }

      // Advance read index past this packet (with wrap)
      ethernetReadIdx = (ethernetReadIdx + 2 + packetLen) % bufferSize;

      // Update shared read index so writer knows how much space is available
      Atomics.store(ethernetCtrlBuffer, 1, ethernetReadIdx);

      // Decrement packet count
      const remaining = Atomics.sub(ethernetCtrlBuffer, 2, 1) - 1;

      // Clear ethernet interrupt flag if no more packets
      if (remaining <= 0 && inputBuffer) {
        Atomics.store(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr, 0);
      }

      // Log packet delivery (throttled - every 10th packet or when queue backs up)
      if (remaining > 3 || Math.random() < 0.1) {
        logger.log(`[ETHER RX] Delivered ${length}B to Mac, queue: ${remaining}`);
      }

      return length;
    }

    // Fallback to postMessage queue (won't work while WASM is blocking)
    if (ethernetReceiveQueue.length === 0) {
      return 0;
    }

    const packet = ethernetReceiveQueue.shift()!;
    const length = Math.min(packet.byteLength, packetMaxLength);

    mod.HEAPU8.set(packet.subarray(0, length), packetPtr);
    return length;
  },

  // Track when disk operations happen relative to video/audio init
  _diskOpenCount: 0,

  // Disk operations
  disks: {
    open(name: string): number {
      workerApi._diskOpenCount++;
      logger.log(`[Worker:${WORKER_ID}] Disk open requested:`, name, 'openCount:', workerApi._diskOpenCount, 'loadedDisks.size:', loadedDisks.size);
      logger.log(`[Worker:${WORKER_ID}] Available disks:`, Array.from(loadedDisks.keys()));

      // Find disk by name - try exact match first, then try variations
      let disk = loadedDisks.get(name);

      // If not found, try without leading slash or path
      if (!disk) {
        const basename = name.split('/').pop() || name;
        disk = loadedDisks.get(basename);
        if (disk) {
          logger.log('[Worker] Found disk by basename:', basename);
        }
      }

      // Try matching any disk if only one is loaded
      if (!disk && loadedDisks.size === 1) {
        disk = loadedDisks.values().next().value;
        logger.log('[Worker] Using only available disk');
      }

      if (!disk) {
        logger.warn('[Worker] Disk not found:', name);
        return -1;
      }

      // Assign ID and track opened disk
      const diskId = diskIdCounter++;
      openedDisks.set(diskId, disk);
      logger.log('[Worker] Opened disk', name, 'as ID', diskId, 'size:', disk.size);
      return diskId;
    },

    close(diskId: number) {
      logger.log('[Worker] Disk close:', diskId);
      openedDisks.delete(diskId);
    },

    read(diskId: number, bufPtr: number, offset: number, length: number): number {
      const disk = openedDisks.get(diskId);
      // Use currentModule which is set AFTER createEmulator completes
      const mod = currentModule;

      // Strict checks - module must be fully initialized
      if (!moduleFullyInitialized) {
        logger.warn('[Worker] Disk read rejected - module not fully initialized');
        return 0;
      }

      if (!disk || !mod) {
        // Only log once per disk ID to avoid spam
        if (!warnedDiskIds.has(diskId)) {
          warnedDiskIds.add(diskId);
          logger.warn('[Worker] Disk read failed - disk:', !!disk, 'module:', !!mod, 'diskId:', diskId);
        }
        return 0;
      }

      // Bounds check against disk size
      const actualLength = Math.min(length, disk.size - offset);
      if (actualLength <= 0) {
        return 0;
      }

      // Bounds check against WASM heap - critical for memory safety
      const heapSize = mod.HEAPU8?.length ?? 0;
      if (bufPtr + actualLength > heapSize) {
        logger.error(`[Worker] Disk read out of bounds: ptr=${bufPtr}, len=${actualLength}, heap=${heapSize}`);
        return 0;
      }

      // Signal HD activity (throttled)
      signalHdActivity();

      // Read from disk (now uses chunked loading)
      const buffer = mod.HEAPU8.subarray(bufPtr, bufPtr + actualLength);
      try {
        return disk.read(buffer, offset, actualLength);
      } catch (error) {
        logger.error(`[Worker] Disk read threw: diskId=${diskId}, offset=${offset}, length=${actualLength}`, error);
        return 0;
      }
    },

    write(diskId: number, bufPtr: number, offset: number, length: number): number {
      const disk = openedDisks.get(diskId);
      const mod = currentModule;

      // Strict checks - module must be fully initialized
      if (!moduleFullyInitialized) {
        logger.warn('[Worker] Disk write rejected - module not fully initialized');
        return 0;
      }

      if (!disk || !mod) {
        logger.warn('[Worker] Disk write failed - disk:', !!disk, 'module:', !!mod);
        return 0;
      }

      // Bounds check against disk size
      const actualLength = Math.min(length, disk.size - offset);
      if (actualLength <= 0) {
        return 0;
      }

      // Bounds check against WASM heap - critical for memory safety
      const heapSize = mod.HEAPU8?.length ?? 0;
      if (bufPtr + actualLength > heapSize) {
        logger.error(`[Worker] Disk write out of bounds: ptr=${bufPtr}, len=${actualLength}, heap=${heapSize}`);
        return 0;
      }

      // Signal HD activity (throttled)
      signalHdActivity();

      // Write to disk (now uses chunked loading)
      const buffer = mod.HEAPU8.subarray(bufPtr, bufPtr + actualLength);
      return disk.write(buffer, offset, actualLength);
    },

    size(diskId: number): number {
      const disk = openedDisks.get(diskId);
      if (!disk) {
        logger.warn('[Worker] Disk size failed - disk not found:', diskId);
        return 0;
      }
      return disk.size;
    },

    isMediaPresent(diskId: number): boolean {
      return openedDisks.has(diskId);
    },

    isFixedDisk(_diskId: number): boolean {
      return true;
    },

    eject(diskId: number) {
      logger.log('[Worker] Disk eject:', diskId);
      openedDisks.delete(diskId);
    },

    pendingDiskName(): string | null {
      return null;
    },
  },

  // Clipboard
  setClipboardText(_text: string) {
    // TODO: implement clipboard
  },

  getClipboardText(): string | null {
    return null;
  },

  // File uploads (stub)
  uploadFile(): any {
    return null;
  },

  // Error handling
  emulatorDidHaveError(status: number, error?: Error) {
    logger.error('[Worker] Emulator error:', status, error);
    postMessage({
      type: 'emulator_error',
      error: error?.message || `Exit status ${status}`
    });
  },

  exit() {
    logger.log('[Worker] Emulator exit requested');
    postMessage({ type: 'emulator_stopped' });
  },
};

// Register workerApi globally - but only after receiving start message
// This prevents "phantom" workers (Safari blob URL issue) from having an empty workerApi
logger.log(`[Worker:${WORKER_ID}] Worker module loaded, waiting for start message...`);

function registerWorkerApi() {
  (globalThis as any).workerApi = workerApi;
  (globalThis as any).__WORKER_ID__ = WORKER_ID;
  logger.log(`[Worker:${WORKER_ID}] workerApi registered globally - Input addresses:`, JSON.stringify(InputBufferAddresses));
}

/**
 * Reset all worker state - called before starting new emulator instance
 * This ensures clean state even if previous instance didn't clean up properly
 */
function resetWorkerState(): void {
  logger.log(`[Worker:${WORKER_ID}] Resetting worker state`);

  // Clear module references
  currentModule = null;
  Module = null;
  moduleFullyInitialized = false;
  videoOpened = false; // Reset video guard for fresh start
  delete (globalThis as any).__BASILISK_MODULE__;

  // Clear disk state
  for (const [name, disk] of loadedDisks) {
    try {
      disk.dispose();
    } catch (e) {
      logger.warn(`[Worker:${WORKER_ID}] Error disposing disk ${name}:`, e);
    }
  }
  loadedDisks.clear();
  openedDisks.clear();
  diskIdCounter = 0;
  warnedDiskIds.clear();

  // Reset audio/ethernet/video state
  ethernetReadIdx = 0;

  // Clear video buffers and frame timing (will be re-set from config on next start)
  screenBuffer = null;
  videoModeBuffer = null;
  nextExpectedBlitTime = 0;
  lastBlitFrameId = 0;
  lastIdleWaitFrameId = 0;

  // Clear buffers
  ethernetReceiveQueue.length = 0;

  workerState = 'idle';
  logger.log(`[Worker:${WORKER_ID}] Worker state reset complete`);
}

/**
 * Message handler
 */
self.onmessage = async (event: MessageEvent) => {
  const { type, ...data } = event.data;
  logger.log(`[Worker:${WORKER_ID}] Received message: ${type}`);

  switch (type) {
    case 'start':
      // Register workerApi before loading disks and WASM
      // This ensures only the worker that receives 'start' has a valid workerApi
      registerWorkerApi();

      // Enable debug logging in worker if main thread has it enabled
      if (data.config?.debug) {
        (globalThis as any).__DIALTONE_DEBUG__ = true;
        logger.log(`[Worker:${WORKER_ID}] Debug logging enabled via config`);
      }
      await startEmulator(data.config);
      break;

    case 'ethernet_receive':
      // Queue packet for emulator to read
      ethernetReceiveQueue.push(new Uint8Array(data.packet));
      break;

    case 'input':
      // Handle input event (keyboard/mouse)
      handleInput(data);
      break;

    case 'stop':
      logger.log(`[Worker:${WORKER_ID}] Stop received, state: ${workerState}, disposing ${loadedDisks.size} disks`);
      // Use resetWorkerState for thorough cleanup
      resetWorkerState();
      workerState = 'stopped';
      logger.log(`[Worker:${WORKER_ID}] Stop complete, sending acknowledgment`);
      // Send acknowledgment so main thread knows cleanup is complete
      postMessage({ type: 'stopped' });
      break;

    default:
      logger.warn('[Worker] Unknown message type:', type);
  }
};

/**
 * Handle input events
 */
let inputLogCounter = 0;
function handleInput(event: any) {
  // Debug: log first few inputs unconditionally
  if (inputLogCounter < 5) {
    logger.log('[Worker] handleInput called:', event);
  }

  const { inputType, x, y, button, code } = event;

  switch (inputType) {
    case 'mousemove':
      // Set mouse position
      workerApi.setInputValue(InputBufferAddresses.mousePositionXAddr, Math.floor(x));
      workerApi.setInputValue(InputBufferAddresses.mousePositionYAddr, Math.floor(y));
      workerApi.setInputValue(InputBufferAddresses.mousePositionFlagAddr, 1);
      // Log occasionally
      if (inputLogCounter++ % 100 === 0) {
        logger.log('[Worker] Mouse move:', Math.floor(x), Math.floor(y));
      }
      break;

    case 'mousedown':
      if (button === 0) {
        workerApi.setInputValue(InputBufferAddresses.mouseButtonStateAddr, 1);
      } else if (button === 2) {
        workerApi.setInputValue(InputBufferAddresses.mouseButton2StateAddr, 1);
      }
      break;

    case 'mouseup':
      if (button === 0) {
        workerApi.setInputValue(InputBufferAddresses.mouseButtonStateAddr, 0);
      } else if (button === 2) {
        workerApi.setInputValue(InputBufferAddresses.mouseButton2StateAddr, 0);
      }
      break;

    case 'keydown':
      workerApi.setInputValue(InputBufferAddresses.keyCodeAddr, mapKeyCode(code));
      workerApi.setInputValue(InputBufferAddresses.keyStateAddr, 1);
      workerApi.setInputValue(InputBufferAddresses.keyEventFlagAddr, 1);
      break;

    case 'keyup':
      workerApi.setInputValue(InputBufferAddresses.keyCodeAddr, mapKeyCode(code));
      workerApi.setInputValue(InputBufferAddresses.keyStateAddr, 0);
      workerApi.setInputValue(InputBufferAddresses.keyEventFlagAddr, 1);
      break;
  }
}

/**
 * Fetch a binary file
 */
async function fetchBinary(url: string): Promise<Uint8Array> {
  logger.log('[Worker] Fetching:', url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}


/**
 * Generate BasiliskII prefs string
 */
function generatePrefs(options: {
  romFileName: string;
  diskNames: string[];
  width: number;
  height: number;
  jit: boolean;
}): string {
  const { romFileName, diskNames, width, height, jit } = options;

  let prefs = '';
  prefs += `rom ${romFileName}\n`;
  prefs += `ramsize 16777216\n`; // 16MB RAM
  prefs += `screen win/${width}/${height}\n`;

  for (const diskName of diskNames) {
    prefs += `disk ${diskName}\n`;
  }

  // Network settings - CRITICAL: 'ether js' enables the JavaScript ethernet driver
  // Without this, BasiliskII won't use the workerApi.etherWrite/etherRead functions for IP traffic
  prefs += `ether js\n`;

  // Disable ExtFS / "The Outside World" - set to non-existent path
  prefs += `extfs /disabled\n`;

  // Other important settings from Infinite Mac
  prefs += `nogui true\n`;
  prefs += `idlewait true\n`;  // Important for the idle loop to work with our workerApi.idleWait()
  prefs += `frameskip 0\n`;
  prefs += `fpu true\n`;
  prefs += `nocdrom false\n`;
  prefs += `nosound false\n`;

  // JIT compilation - can be disabled for compatibility
  prefs += `jit ${jit ? 'true' : 'false'}\n`;

  logger.log('[Worker] Generated prefs:\n', prefs);
  return prefs;
}

/**
 * Start the emulator
 */
async function startEmulator(config: any) {
  logger.log(`[Worker:${WORKER_ID}] startEmulator called, state: ${workerState}, loadedDisks.size:`, loadedDisks.size);
  logger.log('[Worker] Starting emulator with config:', config);

  // Check for invalid state - starting when already running
  if (workerState !== 'idle' && workerState !== 'stopped') {
    logger.warn(`[Worker:${WORKER_ID}] startEmulator called in invalid state: ${workerState} - resetting`);
  }

  // Reset all state for clean start
  resetWorkerState();
  workerState = 'starting';

  try {
    // Base URL for assets (supports reverse-proxy deployments under a path prefix)
    // Example: baseUrl="/foo/" => assets live at https://host/foo/{rom,disk,emulator}/...
    const baseUrl: string = typeof config.baseUrl === 'string' ? config.baseUrl : '/'
    const ensureTrailingSlash = (s: string) => (s.endsWith('/') ? s : s + '/')
    const base = ensureTrailingSlash(baseUrl)
    const resolveAssetUrl = (relativePath: string) =>
      new URL(base + relativePath.replace(/^\//, ''), self.location.origin).href

    // Pre-load disk images - support multiple disks (boot + data disks)
    const diskPaths: string[] = config.diskPaths || [base + 'disk/dialtone-system.dsk'];
    const romPath = config.romPath || (base + 'rom/quadra650.rom');
    const width = config.width || 1024;
    const height = config.height || 768;
    const jit = config.jit ?? true; // JIT compilation enabled by default

    // Set up SharedArrayBuffer for input if provided
    if (config.inputBuffer) {
      inputBuffer = new Int32Array(config.inputBuffer);
      logger.log('[Worker] Using SharedArrayBuffer for input');

      // CRITICAL: Reset lock state to 0 (READY_FOR_UI_THREAD) on startup
      // If previous session crashed, lock could be stuck at 1, 2, or 3
      // which would cause the new session to read garbage or hang
      Atomics.store(inputBuffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);

      // Clear all input flags to ensure clean state
      Atomics.store(inputBuffer, InputBufferAddresses.mousePositionFlagAddr, 0);
      Atomics.store(inputBuffer, InputBufferAddresses.keyEventFlagAddr, 0);
      Atomics.store(inputBuffer, InputBufferAddresses.ethernetInterruptFlagAddr, 0);
      Atomics.store(inputBuffer, InputBufferAddresses.stopFlagAddr, 0);
      // Initialize mouseButtonStateAddr to -1 (no event) - C++ checks > -1 for button events
      Atomics.store(inputBuffer, InputBufferAddresses.mouseButtonStateAddr, -1);

      // Explicitly set absolute mouse mode (not deltas) - this tells ADB to use absolute coords
      Atomics.store(inputBuffer, InputBufferAddresses.useMouseDeltasFlagAddr, 1);
      Atomics.store(inputBuffer, InputBufferAddresses.useMouseDeltasAddr, 0); // 0 = absolute, 1 = relative
      logger.log('[Worker] Set mouse mode to absolute coordinates');
    } else {
      logger.log('[Worker] SharedArrayBuffer not available, input will not work in WASM loop');
    }

    // Set up SharedArrayBuffer for ethernet receive if provided
    if (config.ethernetBuffer && config.ethernetControl) {
      ethernetDataBuffer = new Uint8Array(config.ethernetBuffer);
      ethernetCtrlBuffer = new Int32Array(config.ethernetControl);
      ethernetReadIdx = 0;
      logger.log('[Worker] Using SharedArrayBuffer for ethernet receive');
    } else {
      logger.log('[Worker] Ethernet SharedArrayBuffer not available, using postMessage fallback');
    }

    // Set up SharedArrayBuffer for audio if provided
    if (config.audioBuffer && config.audioControl) {
      audioDataBuffer = new Uint8Array(config.audioBuffer);
      audioCtrlBuffer = new Int32Array(config.audioControl);
      logger.log('[Worker] Using SharedArrayBuffer for audio, buffer size:', audioDataBuffer.length);
    } else {
      logger.log('[Worker] Audio SharedArrayBuffer not available, audio will not work');
    }

    // Set up SharedArrayBuffer for video if provided (zero-copy frame transfer)
    if (config.screenBuffer && config.videoModeBuffer) {
      screenBuffer = new Uint8Array(config.screenBuffer);
      videoModeBuffer = new Int32Array(config.videoModeBuffer);
      logger.log('[Worker] Using SharedArrayBuffer for video, buffer size:', screenBuffer.length);
    } else {
      logger.log('[Worker] Video SharedArrayBuffer not available, video performance may be degraded');
    }

    // Extract just the filename from paths
    const romFileName = romPath.split('/').pop() || 'rom.bin';
    const diskFileNames = diskPaths.map(p => p.split('/').pop() || 'disk.img');

    // Relay URL for disk access - convert WS URL to HTTP if needed
    let relayUrl = config.relayUrl || 'http://localhost:8081';
    // If we got a WebSocket URL, convert to HTTP for disk operations
    if (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://')) {
      try {
        const url = new URL(relayUrl);
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        // Remove the /ethernet path if present
        url.pathname = url.pathname.replace(/\/ethernet$/, '');
        relayUrl = url.origin + url.pathname;
        logger.log('[Worker] Converted WS URL to HTTP:', relayUrl);
      } catch (e) {
        logger.warn('[Worker] Failed to convert WS URL:', e);
      }
    }
    // Remove trailing slash to avoid double-slash in URL construction
    if (relayUrl.endsWith('/')) {
      relayUrl = relayUrl.slice(0, -1);
    }
    const userId = config.userId || 'anonymous';
    const diskMode: DiskStorageMode = config.diskMode || 'disk-server';

    // Create disks using factory (respects storage mode setting)
    // Boot disk is first, followed by optional data disks
    workerState = 'loading_disks';
    postMessage({ type: 'emulator_loading', message: 'Connecting to disks...' });

    logger.log(`[Worker:${WORKER_ID}] Starting disk loading, loadedDisks.size before:`, loadedDisks.size);

    for (let i = 0; i < diskFileNames.length; i++) {
      const diskFileName = diskFileNames[i];
      const diskType = i === 0 ? 'boot' : 'data';
      postMessage({ type: 'emulator_loading', message: `Loading ${diskType} disk: ${diskFileName}...` });

      try {
        logger.log(`[Worker:${WORKER_ID}] Creating disk:`, diskFileName);
        const disk = await createDisk({
          name: diskFileName,
          relayUrl,
          userId,
          mode: diskMode,
          sessionId: config.sessionId, // For OPFS cache invalidation
          tabId: config.tabId, // For disk locking (from main thread)
          adminToken: config.adminToken, // Admin JWT for writable base-image edits
        });
        logger.log(`[Worker:${WORKER_ID}] Disk created, adding to map:`, diskFileName);
        loadedDisks.set(diskFileName, disk);
        logger.log(`[Worker:${WORKER_ID}] Disk ready:`, diskFileName, 'size:', disk.size, 'map size:', loadedDisks.size);
      } catch (diskError) {
        logger.error(`[Worker:${WORKER_ID}] Failed to create disk:`, diskFileName, diskError);
        throw diskError;
      }
    }
    logger.log(`[Worker:${WORKER_ID}] All disks loaded:`, diskFileNames.length, 'disks, loadedDisks.size:', loadedDisks.size);

    // Send heartbeat info to main thread (worker's event loop is blocked by emulator)
    if (diskMode === 'disk-server') {
      const heartbeatInfo = getHeartbeatInfo();
      if (heartbeatInfo) {
        logger.log(`[Worker:${WORKER_ID}] Sending heartbeat info to main thread:`, heartbeatInfo.diskNames);
        postMessage({
          type: 'heartbeat_info',
          relayUrl: heartbeatInfo.relayUrl,
          tabId: heartbeatInfo.tabId,
          diskNames: heartbeatInfo.diskNames,
        });
      }
    }

    // Load ROM
    postMessage({ type: 'emulator_loading', message: 'Loading ROM...' });
    const romData = await fetchBinary(romPath.startsWith('http') ? romPath : resolveAssetUrl(romPath));
    logger.log('[Worker] Loaded ROM:', romFileName, 'size:', romData.byteLength);

    // Generate prefs file - boot disk first, then data disks
    const prefsContent = generatePrefs({
      romFileName,
      diskNames: diskFileNames,
      width,
      height,
      jit,
    });
    const prefsData = new TextEncoder().encode(prefsContent);

    // Load the WASM module using importScripts (standard for workers)
    workerState = 'loading_wasm';
    postMessage({ type: 'emulator_loading', message: 'Loading WASM module...' });

    // The BasiliskII.js exports a default function called 'emulator'
    // We need to load it and access the exported function
    const wasmJsUrl = resolveAssetUrl('emulator/BasiliskII.js');

    // Fetch and evaluate the module (since it's an ES module with export default)
    const response = await fetch(wasmJsUrl);
    const moduleCode = await response.text();

    // The module exports `emulator` as default, we need to extract it
    // Create a blob URL that we can import as a module
    const blob = new Blob([moduleCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    // @ts-ignore - dynamic import from blob URL
    const emulatorModule = await import(/* @vite-ignore */ blobUrl);
    URL.revokeObjectURL(blobUrl);

    const createEmulator = emulatorModule.default;
    if (!createEmulator) {
      throw new Error('Failed to load emulator function from BasiliskII.js');
    }

    logger.log('[Worker] BasiliskII module imported, creating emulator...');

    // Configure and initialize the emulator
    const moduleConfig: any = {
      // Emscripten configuration - use --config prefs like Infinite Mac
      arguments: ['--config', 'prefs'],

      // Called when module is ready
      onRuntimeInitialized() {
        logger.log('[Worker] WASM runtime initialized - main() about to run');
        postMessage({ type: 'emulator_ready' });
      },

      // Locate WASM file
      locateFile(path: string) {
        if (path.endsWith('.wasm')) {
          return '/emulator/BasiliskII.wasm';
        }
        return '/emulator/' + path;
      },

      // Print functions
      print: (text: string) => logger.log('[BasiliskII]', text),
      printErr: (text: string) => console.error('[BasiliskII]', text),

      // Quit handler
      quit(status: number, toThrow?: Error) {
        workerApi.emulatorDidHaveError(status, toThrow);
      },
    };

    // Pre-run hook to set up filesystem
    // Must be added after moduleConfig is defined so we can reference moduleConfig.FS
    // NOTE: We set currentModule here because disk reads happen DURING createEmulator
    // HEAPU8 is ready by preRun time (Emscripten sets it up before calling preRun)
    moduleConfig.preRun = [
      function() {
        // Set currentModule NOW so disk reads work during WASM boot
        // HEAPU8 is available at this point - Emscripten initializes it before preRun
        currentModule = moduleConfig;
        moduleFullyInitialized = true;
        (globalThis as any).__BASILISK_MODULE__ = moduleConfig;
        logger.log('[Worker] preRun: currentModule set, HEAPU8 available:', !!moduleConfig.HEAPU8);

        // Process any cursor updates that were queued before module was ready
        processPendingCursor();

        // Access FS from the module config (set by Emscripten before preRun)
        const FS = moduleConfig.FS;
        if (!FS) {
          logger.error('[Worker] FS not available in preRun!');
          return;
        }

        logger.log('[Worker] preRun: Setting up filesystem');

        // Create ROM file
        FS.createDataFile('/', romFileName, romData, true, true, true);
        logger.log('[Worker] Created ROM file:', romFileName);

        // Create prefs file
        FS.createDataFile('/', 'prefs', prefsData, true, true, true);
        logger.log('[Worker] Created prefs file');
      }
    ];

    // Call the factory function to create the module
    // Wrap in try-catch to detect Safari-specific WASM issues
    try {
      Module = await createEmulator(moduleConfig);
      // Note: currentModule and moduleFullyInitialized were already set in preRun
      // because disk reads happen during createEmulator (before it returns)
      workerState = 'running';
      logger.log('[Worker] Emulator module initialized, workerState:', workerState);
    } catch (wasmError) {
      logger.error('[Worker] WASM module creation failed:', wasmError);
      workerState = 'stopped';
      throw wasmError;
    }

  } catch (err) {
    logger.error('[Worker] Failed to start emulator:', err);
    workerState = 'stopped';

    // Check if this is a lock conflict error
    if (err instanceof LockConflictError) {
      postMessage({
        type: 'lock_conflict',
        diskName: err.holder.diskName,
        holder: err.holder
      });
    } else {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if this is a recoverable "memory access out of bounds" error
      // These often happen due to stale state and can be fixed with a retry
      const isRecoverable = errorMessage.includes('memory access out of bounds') ||
                           errorMessage.includes('RuntimeError');

      postMessage({
        type: 'emulator_error',
        error: errorMessage,
        recoverable: isRecoverable
      });
    }
  }
}

logger.log(`[Worker:${WORKER_ID}] BasiliskII worker module loaded (waiting for start message)`);
