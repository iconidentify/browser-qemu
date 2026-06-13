/**
 * EmulatorCanvas - Hosts the BasiliskII emulator
 *
 * Handles:
 * - Video rendering to canvas
 * - Keyboard and mouse input
 * - Worker lifecycle management
 * - Ethernet integration via DialtoneEthernet
 */

import { useEffect, useRef, useState, useImperativeHandle, forwardRef, useMemo } from 'react';
import { DialtoneEthernet, defaultRelayUrl, type ConnectionStatus } from './DialtoneEthernet';
import { EmulatorAudio } from './audio/EmulatorAudio';
import type { VUMeterData } from './audio/types';
import type { DiskStorageMode } from './disk/types';
import type { DiskLockInfo } from './disk/DiskLockManager';
import { logger } from './logger';
import { InputBufferAddresses, useInputManager } from './input';
import { DEFAULT_MAC_CURSOR, parseCssCursor } from './cursors';
import { storageManager } from './services/StorageManager';
import { LockTakeoverDialog } from './components/settings/LockTakeoverDialog';
import { getCore } from './cores';
import { AutomationBridge } from './services/AutomationBridge';
import './LoadingScreen.css';

// Re-export for consumers
export type { VUMeterData } from './audio/types';

// Module-level worker tracking - guarantees only ONE worker across all component instances
// This handles React StrictMode's double-mount by ensuring:
// 1. Both mounts increment activeInstanceId
// 2. Only the LATEST instance creates a worker
// 3. Any existing worker is killed before creating a new one
let activeWorkerInstance: Worker | null = null;
let activeInstanceId: number = 0;

/**
 * Imperative handle for controlling emulator externally
 */
export interface EmulatorCanvasHandle {
  /** Set audio volume (0-1) */
  setVolume: (volume: number) => void;
  /** Get current audio volume (0-1) */
  getVolume: () => number;
}

export interface EmulatorCanvasProps {
  /** Emulator core to use (default: 'basilisk') */
  coreId?: string;
  /** Path to ROM file */
  romPath?: string;
  /** Paths to disk images (boot disk first, then data disks) */
  diskPaths?: string[];
  /** Disk storage mode */
  diskMode?: DiskStorageMode;
  /** Screen width */
  width?: number;
  /** Screen height */
  height?: number;
  /** Relay URL for ethernet */
  relayUrl?: string;
  /** Network zone for multiplayer (empty = private isolated zone) */
  networkZone?: string;
  /** Enable JIT compilation (default: true) */
  jit?: boolean;
  /** Called when emulator status changes */
  onStatusChange?: (status: EmulatorStatus) => void;
  /** Called when network connection status changes */
  onNetworkStatusChange?: (status: ConnectionStatus) => void;
  /** Called when a packet is sent */
  onPacketSent?: () => void;
  /** Called when a packet is received */
  onPacketReceived?: () => void;
  /** Called when disk activity occurs */
  onHdActivity?: () => void;
  /** Called with emulator CPU load (0-1), roughly twice per second */
  onCpuLoad?: (load: number) => void;
  /** Called when audio VU meter updates (~10 times per second) */
  onVUMeterUpdate?: (data: VUMeterData) => void;
  /** Initial audio volume (0-1) */
  initialVolume?: number;
  /** Called when input buffer is ready (for mobile trackpad) */
  onInputBufferReady?: (buffer: Int32Array) => void;
  /** Hide the floating virtual keyboard button (for when parent provides keyboard) */
  hideVirtualKeyboardButton?: boolean;
  /** Enable glide mode - single finger pans, no clicks on canvas */
  glideMode?: boolean;
  /** Called when panning in glide mode */
  onGlidePan?: (deltaX: number, deltaY: number) => void;
  /** Use hardware cursor overlay (default: true) */
  hardwareCursor?: boolean;
  /** Hardware cursor size multiplier (default: 1) */
  cursorScale?: number;
  /** Cursor position for overlay on touch devices (from Trackpad) */
  cursorPosition?: { x: number; y: number };
  /** Enable automation bridge for MCP server control */
  enableAutomation?: boolean;
}

export type EmulatorStatus =
  | 'loading'
  | 'ready'
  | 'running'
  | 'error'
  | 'stopped';

// Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const EmulatorCanvas = forwardRef<EmulatorCanvasHandle, EmulatorCanvasProps>(function EmulatorCanvas({
  coreId = 'basilisk',
  romPath,
  diskPaths,
  diskMode = 'client-cached',
  width = 800,
  height = 600,
  relayUrl = defaultRelayUrl(),
  networkZone = '',
  jit = true,
  onStatusChange,
  onNetworkStatusChange,
  onPacketSent,
  onPacketReceived,
  onHdActivity,
  onCpuLoad,
  onVUMeterUpdate,
  initialVolume = 1.0,
  onInputBufferReady,
  hideVirtualKeyboardButton = false,
  glideMode = false,
  onGlidePan,
  hardwareCursor = true,
  cursorScale = 1,
  cursorPosition,
  enableAutomation = false,
}, ref) {
  // Get the emulator core adapter
  const adapter = useMemo(() => getCore(coreId), [coreId]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const ethernetRef = useRef<DialtoneEthernet | null>(null);
  const audioRef = useRef<EmulatorAudio | null>(null);
  const initializingRef = useRef<boolean>(false); // Guard against concurrent inits
  const cleaningUpRef = useRef<boolean>(false); // Track if cleanup is in progress (prevents race conditions on rapid power cycling)
  const terminationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Track pending termination
  // Note: instanceIdRef replaced by module-level activeInstanceId for single-worker guarantee

  // Refs for callbacks to avoid stale closures in worker message handler
  const onHdActivityRef = useRef(onHdActivity);
  onHdActivityRef.current = onHdActivity;

  const onCpuLoadRef = useRef(onCpuLoad);
  onCpuLoadRef.current = onCpuLoad;

  // Ref for cursor scale to access current value in message handler
  const cursorScaleRef = useRef(cursorScale);
  cursorScaleRef.current = cursorScale;

  // Expose control methods to parent via ref
  useImperativeHandle(ref, () => ({
    setVolume: (volume: number) => {
      audioRef.current?.setVolume(volume);
    },
    getVolume: () => {
      return audioRef.current?.getVolume() ?? 1.0;
    },
  }), []);

  const [inputBuffer, setInputBuffer] = useState<Int32Array | null>(null);
  // Ref that mirrors inputBuffer state for use in callbacks (closures capture ref object, not value)
  const inputBufferCallbackRef = useRef<Int32Array | null>(null);
  const ethernetBufferRef = useRef<Uint8Array | null>(null);
  const ethernetControlRef = useRef<Int32Array | null>(null);

  // Video SharedArrayBuffer refs for zero-copy frame transfer
  const screenBufferRef = useRef<Uint8Array | null>(null);
  const videoModeBufferRef = useRef<Int32Array | null>(null);

  // Frame timing for smooth video playback
  const pendingFrameRef = useRef<boolean>(false);
  const lastFrameTimeRef = useRef<number>(0);

  // Pre-allocated ImageData to avoid per-frame allocation (reduces GC pressure)
  const screenImageDataRef = useRef<ImageData | null>(null);
  const screenPixelDataRef = useRef<Uint8ClampedArray | null>(null);

  // Throttle identical cursor updates to reduce React re-renders
  const lastCursorUpdateRef = useRef<number>(0);
  const lastRenderedCursorKeyRef = useRef<string>(''); // Track what cursor is currently displayed
  const cursorThrottleMs = 16; // ~60fps max for identical cursor shape updates

  // Store last cursor data for re-rendering when scale changes
  const lastCursorDataRef = useRef<{
    dataBitmap: Uint8Array;
    maskBitmap: Uint8Array;
    hotspotX: number;
    hotspotY: number;
    visible: boolean;
  } | null>(null);

  // Auto-retry counter for recoverable WASM errors (memory access out of bounds)
  const retryCountRef = useRef<number>(0);
  const MAX_RETRIES = 2;

  // Track if hardware cursor mode was ever activated this session.
  // Once WASM patches vectors, we MUST keep showing CSS cursor for the session.
  // Setting toggle only controls initial mode, not mid-session behavior.
  const hardwareCursorActiveRef = useRef<boolean>(false);

  const [status, setStatus] = useState<EmulatorStatus>('loading');
  const [error, setError] = useState<string>('');
  const [cursorStyle, setCursorStyle] = useState<string>(DEFAULT_MAC_CURSOR);
  const [loadingProgress, setLoadingProgress] = useState<{
    fileName: string;
    bytesLoaded: number;
    bytesTotal: number;
    percentage: number;
  } | null>(null);
  // Lock conflict state for showing takeover dialog
  const [lockConflict, setLockConflict] = useState<{
    diskName: string;
    holder: DiskLockInfo;
  } | null>(null);
  // Capture mode (pointer lock / keyboard lock) removed for now.

  // Update parent on status change
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // Initialize emulator
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let mounted = true;

    async function init() {
      // Increment module-level instance ID IMMEDIATELY
      // This ensures both StrictMode mounts get different IDs
      const localInstanceId = ++activeInstanceId;

      // Delay to let React StrictMode's cleanup fire first and browser state settle
      // 200ms is long enough to ensure both StrictMode mounts have fired
      // and we can determine which is the "winner" (highest instance ID)
      await new Promise(r => setTimeout(r, 200));

      // Check if a newer instance has started during the debounce
      if (localInstanceId !== activeInstanceId) {
        logger.log('[EmulatorCanvas] Init aborted - newer instance exists:', activeInstanceId, '>', localInstanceId);
        return;
      }

      if (!mounted) {
        logger.log('[EmulatorCanvas] Init aborted - component unmounted during debounce');
        return;
      }

      // Wait for any pending cleanup to finish before starting new worker
      // This prevents race conditions during rapid power on/off cycles
      if (cleaningUpRef.current) {
        logger.log('[EmulatorCanvas] Waiting for pending cleanup to finish...');
        while (cleaningUpRef.current) {
          await new Promise(r => setTimeout(r, 50));
          if (!mounted || localInstanceId !== activeInstanceId) {
            logger.log('[EmulatorCanvas] Init aborted while waiting for cleanup');
            return;
          }
        }
        logger.log('[EmulatorCanvas] Cleanup finished, proceeding with init');
      }

      // Guard against concurrent initializations (React StrictMode, prop changes, etc.)
      if (initializingRef.current) {
        logger.log('[EmulatorCanvas] Init already in progress, skipping');
        return;
      }
      initializingRef.current = true;

      // Kill any existing worker BEFORE creating new one
      // This ensures only ONE worker exists at a time across all component instances
      if (activeWorkerInstance) {
        logger.log('[EmulatorCanvas] Terminating existing worker before creating new one');
        activeWorkerInstance.postMessage({ type: 'stop' });
        // Give it a moment to clean up, then terminate
        await new Promise(r => setTimeout(r, 100));
        activeWorkerInstance.terminate();
        activeWorkerInstance = null;
      }

      logger.log('[EmulatorCanvas] Init starting, instance:', localInstanceId);

      try {
        setStatus('loading');

        // Create ethernet provider
        const ethernet = new DialtoneEthernet({
          relayUrl,
          zone: networkZone || undefined, // Empty string = use isolated session zone
          onPacketReceived: (packet) => {
            // Write packet to SharedArrayBuffer ring buffer
            const dataBuffer = ethernetBufferRef.current;
            const ctrlBuffer = ethernetControlRef.current;
            if (!dataBuffer || !ctrlBuffer) {
              logger.warn('[EmulatorCanvas] Ethernet packet received but no SharedArrayBuffer');
              return;
            }

            const packetLen = packet.length;
            if (packetLen > 1514) {
              logger.warn('[EmulatorCanvas] Packet too large:', packetLen);
              return;
            }

            // Ring buffer format: [2-byte length][packet data]
            const writeIdx = Atomics.load(ctrlBuffer, 0);
            const readIdx = Atomics.load(ctrlBuffer, 1);
            const bufferSize = dataBuffer.length;
            const entrySize = 2 + packetLen;

            // Calculate available space (proper ring buffer math)
            const used = writeIdx >= readIdx
              ? (writeIdx - readIdx)
              : (bufferSize - readIdx + writeIdx);
            const available = bufferSize - used - 1; // -1 to distinguish full from empty

            if (entrySize > available) {
              // Buffer full - drop packet (TCP will recover via retransmission)
              logger.warn('[EmulatorCanvas] Ring buffer full, dropping packet. used:', used, 'available:', available);
              return;
            }

            // Write packet to ring buffer
            let newWriteIdx = writeIdx + entrySize;
            if (newWriteIdx > bufferSize) {
              // Wrap around - write marker at current position to tell reader to skip
              // Marker: length = 0 means "wrap to start of buffer"
              if (writeIdx + 2 <= bufferSize) {
                dataBuffer[writeIdx] = 0;
                dataBuffer[writeIdx + 1] = 0;
              }
              // Write actual packet at start of buffer
              newWriteIdx = entrySize;
              dataBuffer[0] = (packetLen >> 8) & 0xff;
              dataBuffer[1] = packetLen & 0xff;
              dataBuffer.set(packet, 2);
              Atomics.store(ctrlBuffer, 0, entrySize);
            } else {
              // Write at current position
              dataBuffer[writeIdx] = (packetLen >> 8) & 0xff;
              dataBuffer[writeIdx + 1] = packetLen & 0xff;
              dataBuffer.set(packet, writeIdx + 2);
              Atomics.store(ctrlBuffer, 0, newWriteIdx);
            }

            // Increment packet count
            Atomics.add(ctrlBuffer, 2, 1);

            // Signal ethernet interrupt to wake up WASM
            const inputBuf = inputBufferCallbackRef.current;
            if (inputBuf) {
              Atomics.store(inputBuf, InputBufferAddresses.ethernetInterruptFlagAddr, 1);
              // Notify the worker to wake up from any Atomics.wait()
              Atomics.notify(inputBuf, InputBufferAddresses.globalLockAddr);
            }

            // Notify parent of packet received
            onPacketReceived?.();

            // Log packet details for debugging
            let packetInfo = `${packetLen} bytes`;
            if (packetLen >= 14) {
              const etherType = (packet[12] << 8) | packet[13];
              const dstMAC = Array.from(packet.subarray(0, 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
              packetInfo = `${packetLen} bytes, type=0x${etherType.toString(16).padStart(4, '0')}, dst=${dstMAC}`;
              if (etherType === 0x0806) {
                const op = (packet[20] << 8) | packet[21];
                packetInfo += ` ARP ${op === 2 ? 'REPLY' : 'REQUEST'}`;
              }
            }
            logger.log('[EmulatorCanvas] Queued packet:', packetInfo, 'count:', Atomics.load(ctrlBuffer, 2));
          },
          onStatusChange: (ethernetStatus) => {
            logger.log('[EmulatorCanvas] Ethernet status:', ethernetStatus);
            onNetworkStatusChange?.(ethernetStatus);
          },
          onError: (err) => {
            console.error('[EmulatorCanvas] Ethernet error:', err);
          },
        });
        ethernetRef.current = ethernet;

        // Create audio controller
        const audio = new EmulatorAudio({
          onVUMeter: (data) => onVUMeterUpdate?.(data),
          onReady: () => {
            // Signal emulator that audio context is running
            const buffer = inputBufferCallbackRef.current;
            if (buffer) {
              Atomics.store(buffer, InputBufferAddresses.ethernetInterruptFlagAddr + 1, 1); // audioContextRunningFlagAddr = 10
              logger.log('[EmulatorCanvas] Signaled emulator that audio is ready');
            }
          },
          onUnderrun: () => {
            // Could track underrun stats here if needed
          },
        });
        audioRef.current = audio;

        // Set initial volume
        if (initialVolume !== 1.0) {
          audio.setVolume(initialVolume);
        }

        // Create worker using adapter
        logger.log('[EmulatorCanvas] Creating new worker for core:', adapter.id, ', previous worker:', workerRef.current ? 'exists' : 'none');
        const worker = adapter.createWorker();
        workerRef.current = worker;
        activeWorkerInstance = worker; // Module-level tracking for single-worker guarantee
        // Page-host cores (e.g. QEMU) render to a real DOM canvas and bind SDL
        // input/cursor to it, so hand them the canvas. Worker-hosted cores
        // (Basilisk) have no attachCanvas and are unaffected.
        const pageHost = worker as unknown as { attachCanvas?: (c: HTMLCanvasElement) => void };
        if (typeof pageHost.attachCanvas === 'function' && canvasRef.current) {
          pageHost.attachCanvas(canvasRef.current);
        }
        logger.log('[EmulatorCanvas] Worker created, instance:', localInstanceId);

        // Handle worker messages
        worker.onmessage = (e) => {
          // Ignore messages from stale workers (React StrictMode creates multiple)
          if (localInstanceId !== activeInstanceId) {
            logger.log('[EmulatorCanvas] Ignoring message from stale instance:', localInstanceId, 'current:', activeInstanceId, 'type:', e.data.type);
            return;
          }

          const { type, ...data } = e.data;

          switch (type) {
            case 'emulator_ready':
              if (mounted) {
                setStatus('ready');
              }
              break;

            case 'emulator_loading':
              logger.log('[EmulatorCanvas] Loading:', data.message);
              break;

            case 'emulator_loading_progress':
              setLoadingProgress({
                fileName: data.fileName,
                bytesLoaded: data.bytesLoaded,
                bytesTotal: data.bytesTotal,
                percentage: data.percentage,
              });
              // Trigger HD activity during loading
              onHdActivityRef.current?.();
              break;

            case 'emulator_hd_activity':
              // Trigger HD activity LED
              onHdActivityRef.current?.();
              break;

            case 'emulator_cpu_load':
              if (typeof data.load === 'number') {
                onCpuLoadRef.current?.(data.load);
              }
              break;

            case 'emulator_video_open': {
              logger.log('[EmulatorCanvas] Video opened:', data.width, 'x', data.height);
              // Pre-allocate ImageData to avoid per-frame allocation
              const videoWidth = data.width as number;
              const videoHeight = data.height as number;
              screenImageDataRef.current = new ImageData(videoWidth, videoHeight);
              screenPixelDataRef.current = screenImageDataRef.current.data;
              logger.log('[EmulatorCanvas] Pre-allocated ImageData:', videoWidth * videoHeight * 4, 'bytes');
              break;
            }

            case 'emulator_blit': {
              // Render frame from SharedArrayBuffer with rAF timing
              if (!canvas) break;

              const sbRef = screenBufferRef.current;
              const vmRef = videoModeBufferRef.current;
              const imageData = screenImageDataRef.current;
              const pixelData = screenPixelDataRef.current;
              if (!sbRef || !vmRef || !imageData || !pixelData) break;

              // Use requestAnimationFrame for smooth frame timing
              // This aligns frame display with browser vsync
              if (!pendingFrameRef.current) {
                pendingFrameRef.current = true;
                requestAnimationFrame(() => {
                  pendingFrameRef.current = false;

                  // Skip if too soon (frame rate limiting for very fast emulation)
                  const now = performance.now();
                  const elapsed = now - lastFrameTimeRef.current;
                  if (elapsed < 8) { // Cap at ~120fps
                    return;
                  }
                  lastFrameTimeRef.current = now;

                  const ctx = canvas.getContext('2d');
                  if (!ctx) return;

                  try {
                    const bufferSize = vmRef[0];
                    if (bufferSize <= 0 || bufferSize > sbRef.length) {
                      return; // Invalid buffer size
                    }
                    // Copy from SharedArrayBuffer to pre-allocated buffer (no allocation)
                    pixelData.set(new Uint8Array(sbRef.buffer, 0, bufferSize));
                    // Use pre-allocated ImageData (no allocation)
                    ctx.putImageData(imageData, 0, 0);
                  } catch (err) {
                    console.error('[EmulatorCanvas] Blit error:', err);
                  }
                });
              }
              break;
            }

            case 'emulator_ethernet_init':
              // Use BasiliskII's MAC address for relay registration
              // This ensures the relay tracks clients by the same MAC that appears in frames
              // IMPORTANT: Only connect once! The emulator may call etherInit multiple times
              // during boot (e.g., when AppleTalk reinitializes), but we should only establish
              // one WebSocket connection with the first MAC address.
              if (ethernet.currentStatus === 'disconnected') {
                if (data.macAddress) {
                  logger.log('[EmulatorCanvas] Using emulator MAC:', data.macAddress);
                  ethernet.setMac(data.macAddress);
                }
                // Connect to relay
                ethernet.connect();
              } else {
                logger.log('[EmulatorCanvas] Ignoring duplicate etherInit, already connected/connecting:', data.macAddress);
              }
              break;

            case 'emulator_ethernet_write':
              // Forward packet to relay
              ethernet.sendPacket(
                new Uint8Array(data.packet),
                data.destination
              );
              // Notify parent of packet sent
              onPacketSent?.();
              break;

            case 'emulator_audio_open':
              // Initialize audio when emulator reports audio config
              logger.log('[EmulatorCanvas] Audio open:', data);
              audio.init({
                sampleRate: data.sampleRate,
                sampleSize: data.sampleSize,
                channels: data.channels,
              }).catch((err) => {
                console.error('[EmulatorCanvas] Audio init failed:', err);
              });
              break;

            case 'emulator_cursor_change':
              // Update cursor when Mac OS changes it (hardware cursor mode)
              // Use hardwareCursorActiveRef - once WASM patches vectors, we must keep showing CSS cursor
              if (hardwareCursorActiveRef.current && data.dataBitmap && data.maskBitmap) {
                try {
                  // Store cursor data for re-rendering when scale changes
                  const dataBitmap = new Uint8Array(data.dataBitmap);
                  const maskBitmap = new Uint8Array(data.maskBitmap);
                  lastCursorDataRef.current = {
                    dataBitmap,
                    maskBitmap,
                    hotspotX: data.hotspotX,
                    hotspotY: data.hotspotY,
                    visible: data.visible !== false,
                  };
                  logger.log('[EmulatorCanvas] Cursor data received, visible:', data.visible !== false, 'scale:', cursorScaleRef.current);

                  // Hide cursor immediately if Mac OS has it hidden
                  if (data.visible === false) {
                    setCursorStyle('none');
                    break;
                  }

                  // Use user's cursor scale setting (from ref to get current value)
                  const effectiveScale = cursorScaleRef.current;

                  // Create a key to identify this cursor (fast comparison)
                  // Use a few bytes from bitmap + hotspot + scale for quick identity check
                  const cursorKey = `${dataBitmap[0]},${dataBitmap[15]},${dataBitmap[31]},${maskBitmap[0]},${maskBitmap[15]},${maskBitmap[31]},${data.hotspotX},${data.hotspotY},${effectiveScale}`;

                  // Check if cursor actually changed
                  const cursorChanged = cursorKey !== lastRenderedCursorKeyRef.current;

                  // Only throttle IDENTICAL cursor updates (reduces React re-renders)
                  // Always process cursor CHANGES immediately to avoid stuck cursors
                  const now = performance.now();
                  const elapsed = now - lastCursorUpdateRef.current;
                  if (cursorChanged || elapsed >= cursorThrottleMs) {
                    lastCursorUpdateRef.current = now;
                    lastRenderedCursorKeyRef.current = cursorKey;

                    // Parse and convert cursor using adapter
                    const rawCursorData = new Uint8Array(64);
                    rawCursorData.set(dataBitmap, 0);
                    rawCursorData.set(maskBitmap, 32);
                    const cursorData = adapter.parseCursor(rawCursorData, data.hotspotX, data.hotspotY);
                    const newCursor = adapter.cursorToCss(cursorData, effectiveScale);
                    setCursorStyle(newCursor);
                  }
                } catch (err) {
                  console.error('[EmulatorCanvas] Cursor conversion error:', err);
                }
              }
              break;

            case 'emulator_error':
              console.error('[EmulatorCanvas] Emulator error:', data.error);
              if (mounted) {
                // Check if this is a recoverable error and we haven't exceeded retries
                if (data.recoverable && retryCountRef.current < MAX_RETRIES) {
                  retryCountRef.current++;
                  logger.log(`[EmulatorCanvas] Recoverable error, auto-retrying (attempt ${retryCountRef.current}/${MAX_RETRIES})...`);

                  // Terminate current worker
                  if (workerRef.current) {
                    workerRef.current.terminate();
                    workerRef.current = null;
                  }

                  // Wait a moment then retry by triggering re-render
                  setTimeout(() => {
                    if (mounted) {
                      setStatus('loading');
                      setError('');
                      // Force re-init by updating a key state (resets the effect)
                      setInputBuffer(null);
                    }
                  }, 500);
                } else {
                  setStatus('error');
                  setError(data.error);
                }
              }
              break;

            case 'lock_conflict':
              logger.log('[EmulatorCanvas] Lock conflict:', data.diskName, data.holder);
              if (mounted) {
                setLockConflict({
                  diskName: data.diskName,
                  holder: data.holder
                });
              }
              break;

            case 'heartbeat_info':
              // Worker's event loop is blocked by emulator, so main thread handles heartbeats
              logger.log('[EmulatorCanvas] Setting up heartbeats for:', data.diskNames);
              if (mounted && data.diskNames?.length > 0) {
                const HEARTBEAT_INTERVAL = 5000;
                const sendHeartbeats = async () => {
                  for (const diskName of data.diskNames) {
                    try {
                      const url = `${data.relayUrl}/disk/heartbeat?name=${encodeURIComponent(diskName)}&tabId=${encodeURIComponent(data.tabId)}`;
                      const resp = await fetch(url, { method: 'POST' });
                      if (resp.status === 410) {
                        logger.warn(`[EmulatorCanvas] Lock on ${diskName} was taken over`);
                        // Could notify user here
                      } else if (!resp.ok) {
                        logger.warn(`[EmulatorCanvas] Heartbeat failed for ${diskName}: ${resp.status}`);
                      } else {
                        logger.log(`[EmulatorCanvas] Heartbeat OK for ${diskName}`);
                      }
                    } catch (e) {
                      logger.warn(`[EmulatorCanvas] Heartbeat error for ${diskName}:`, e);
                    }
                  }
                };

                // Send first heartbeat immediately
                sendHeartbeats();

                // Set up interval for subsequent heartbeats
                const intervalId = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL);

                // Store interval ID for cleanup (using a ref would be cleaner but this works)
                (window as unknown as { __heartbeatInterval?: ReturnType<typeof setInterval> }).__heartbeatInterval = intervalId;
                logger.log('[EmulatorCanvas] Heartbeat interval started:', intervalId);
              }
              break;

            case 'emulator_stopped':
              if (mounted) {
                setStatus('stopped');
              }
              break;

            default:
              logger.log('[EmulatorCanvas] Worker message:', type, data);
          }
        };

        worker.onerror = (err) => {
          console.error('[EmulatorCanvas] Worker error:', err);
          if (mounted) {
            setStatus('error');
            setError(err.message);
          }
        };

        // Create SharedArrayBuffer for input (if available)
        // Requires COOP/COEP headers - check vite.config.ts
        let sharedInputBuffer: SharedArrayBuffer | null = null;
        let ethernetBuffer: SharedArrayBuffer | null = null;
        let ethernetControl: SharedArrayBuffer | null = null;
        let screenBuffer: SharedArrayBuffer | null = null;
        let videoModeBuffer: SharedArrayBuffer | null = null;
        logger.log('[EmulatorCanvas] SharedArrayBuffer typeof:', typeof SharedArrayBuffer);
        if (typeof SharedArrayBuffer !== 'undefined') {
          try {
            sharedInputBuffer = new SharedArrayBuffer(128); // 32 int32 values
            const inputBufferView = new Int32Array(sharedInputBuffer);
            setInputBuffer(inputBufferView);
            inputBufferCallbackRef.current = inputBufferView; // Mirror to ref for callbacks

            // Set hardware cursor mode flag
            if (hardwareCursor) {
              Atomics.store(inputBufferView, InputBufferAddresses.hardwareCursorModeAddr, 1);
              hardwareCursorActiveRef.current = true; // Mark that HW cursor is active for this session
              logger.log('[EmulatorCanvas] Hardware cursor mode enabled');
            }

            // Notify parent that input buffer is ready (for mobile trackpad)
            if (onInputBufferReady) {
              onInputBufferReady(inputBufferView);
            }

            // Ethernet ring buffer: 1MB for packet data (handles high-throughput transfers)
            ethernetBuffer = new SharedArrayBuffer(1024 * 1024);
            ethernetBufferRef.current = new Uint8Array(ethernetBuffer);

            // Ethernet control: [writeIndex, readIndex, packetCount]
            ethernetControl = new SharedArrayBuffer(16);
            ethernetControlRef.current = new Int32Array(ethernetControl);

            // Video screen buffer: pre-allocate for max resolution (1600x1200 RGBA = 7.68MB)
            // Using SharedArrayBuffer eliminates per-frame allocation in blit path
            const VIDEO_MODE_BUFFER_SIZE = 10; // [bufferSize, width, height, ...]
            screenBuffer = new SharedArrayBuffer(1600 * 1200 * 4);
            screenBufferRef.current = new Uint8Array(screenBuffer);
            videoModeBuffer = new SharedArrayBuffer(VIDEO_MODE_BUFFER_SIZE * 4);
            videoModeBufferRef.current = new Int32Array(videoModeBuffer);

            logger.log('[EmulatorCanvas] SharedArrayBuffers created successfully!',
              'Input:', sharedInputBuffer.byteLength,
              'Ethernet:', ethernetBuffer.byteLength,
              'Video:', screenBuffer.byteLength);
          } catch (e) {
            console.error('[EmulatorCanvas] SharedArrayBuffer creation failed:', e);
            console.error('[EmulatorCanvas] COOP/COEP headers may be missing. Check browser console for cross-origin isolation status.');
          }
        } else {
          console.error('[EmulatorCanvas] SharedArrayBuffer is NOT available - input will not work!');
          console.error('[EmulatorCanvas] Ensure COOP/COEP headers are set in vite.config.ts');
        }

        // Get audio buffers
        const audioBuffers = audio.getBuffers();

        // Check if debug mode is enabled (for passing to worker)
        const isDebugMode = typeof window !== 'undefined' && (
          new URLSearchParams(window.location.search).get('debug') === 'true' ||
          localStorage.getItem('dialtone-debug') === 'true' ||
          (window as any).__DIALTONE_DEBUG__
        );

        // Admin token (Dialtone JWT) for writable base-image editing. Supplied
        // via ?adminToken=... by the Dialtone /admin/disk launcher. Without it,
        // the relay rejects writes and this is just a normal read-only session.
        const adminToken = typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('adminToken') || undefined
          : undefined;

        // Start emulator - status stays 'loading' until worker sends 'emulator_ready'
        worker.postMessage({
          type: 'start',
          config: {
            // Base URL for assets; enables reverse-proxy under path prefixes
            baseUrl: (import.meta as any)?.env?.BASE_URL || '/',
            romPath,
            diskPaths,
            diskMode,
            width,
            height,
            inputBuffer: sharedInputBuffer,
            ethernetBuffer,
            ethernetControl,
            // Video SharedArrayBuffer for zero-copy frame transfer
            screenBuffer,
            videoModeBuffer,
            audioBuffer: audioBuffers.dataBuffer,
            audioControl: audioBuffers.controlBuffer,
            relayUrl,
            jit,
            debug: isDebugMode,
            // Session ID for OPFS cache invalidation
            sessionId: storageManager.getSessionId(),
            // Tab ID for disk locking (persistent across page refreshes)
            tabId: storageManager.getTabId(),
            // Admin JWT for writable base-image editing (undefined for normal sessions)
            adminToken,
          },
        });

      } catch (err) {
        console.error('[EmulatorCanvas] Init error:', err);
        if (mounted) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    init();

    return () => {
      logger.log('[EmulatorCanvas] Cleanup: mounted flag set to false, initializingRef was:', initializingRef.current);
      mounted = false;
      initializingRef.current = false; // Allow re-init on next mount
      cleaningUpRef.current = true; // Signal that cleanup is in progress

      // Clear any pending termination timeout
      if (terminationTimeoutRef.current) {
        clearTimeout(terminationTimeoutRef.current);
        terminationTimeoutRef.current = null;
      }

      // Clear heartbeat interval if running
      const heartbeatInterval = (window as unknown as { __heartbeatInterval?: ReturnType<typeof setInterval> }).__heartbeatInterval;
      if (heartbeatInterval) {
        logger.log('[EmulatorCanvas] Cleanup: clearing heartbeat interval');
        clearInterval(heartbeatInterval);
        delete (window as unknown as { __heartbeatInterval?: ReturnType<typeof setInterval> }).__heartbeatInterval;
      }

      // Graceful shutdown: send stop message and wait for worker acknowledgment
      if (workerRef.current) {
        const worker = workerRef.current;
        logger.log('[EmulatorCanvas] Cleanup: sending stop to worker and waiting for acknowledgment');

        // Wait for worker to acknowledge stop (or timeout after 500ms)
        const cleanupComplete = () => {
          logger.log('[EmulatorCanvas] Cleanup: terminating worker');
          worker.terminate();
          cleaningUpRef.current = false; // Signal cleanup complete
        };

        // Listen for 'stopped' acknowledgment from worker
        const stopHandler = (e: MessageEvent) => {
          if (e.data.type === 'stopped') {
            logger.log('[EmulatorCanvas] Cleanup: received stopped acknowledgment from worker');
            worker.removeEventListener('message', stopHandler);
            if (terminationTimeoutRef.current) {
              clearTimeout(terminationTimeoutRef.current);
              terminationTimeoutRef.current = null;
            }
            cleanupComplete();
          }
        };
        worker.addEventListener('message', stopHandler);

        worker.postMessage({ type: 'stop' });

        // Timeout fallback - terminate after 500ms if no acknowledgment
        terminationTimeoutRef.current = setTimeout(() => {
          logger.log('[EmulatorCanvas] Cleanup: timeout waiting for worker acknowledgment');
          worker.removeEventListener('message', stopHandler);
          cleanupComplete();
        }, 500);

        workerRef.current = null; // Clear ref to prevent stale references
        // Also clear module-level reference if this was the active worker
        if (activeWorkerInstance === worker) {
          activeWorkerInstance = null;
        }
      } else {
        cleaningUpRef.current = false; // No worker, cleanup complete immediately
      }

      ethernetRef.current?.disconnect();
      audioRef.current?.stop();
      ethernetRef.current = null;
      audioRef.current = null;
    };
  }, [romPath, diskPaths, diskMode, width, height, relayUrl, networkZone, jit]);

  // Sync hardwareCursor prop to input buffer for dynamic toggling
  // The WASM reads this flag every frame and handles mode transitions
  useEffect(() => {
    if (inputBuffer) {
      const newValue = hardwareCursor ? 1 : 0;
      Atomics.store(inputBuffer, InputBufferAddresses.hardwareCursorModeAddr, newValue);
      logger.log('[EmulatorCanvas] Hardware cursor mode updated:', hardwareCursor);
    }
  }, [hardwareCursor, inputBuffer]);

  // Automation bridge for MCP server control
  useEffect(() => {
    if (!enableAutomation || !inputBuffer || !canvasRef.current) return;
    const bridge = new AutomationBridge({
      canvas: canvasRef.current,
      inputBuffer,
    });
    logger.log('[EmulatorCanvas] Automation bridge started');
    return () => {
      bridge.dispose();
      logger.log('[EmulatorCanvas] Automation bridge stopped');
    };
  }, [enableAutomation, inputBuffer]);

  // Re-render cursor when scale changes (using stored cursor data)
  useEffect(() => {
    logger.log('[EmulatorCanvas] Cursor scale effect triggered, scale:', cursorScale, 'hardwareCursorActive:', hardwareCursorActiveRef.current, 'hasCursorData:', !!lastCursorDataRef.current);
    const storedCursorData = lastCursorDataRef.current;
    // Use hardwareCursorActiveRef - once activated, keep cursor working even if setting toggled
    if (hardwareCursorActiveRef.current && storedCursorData && storedCursorData.visible) {
      try {
        // Parse and convert cursor using adapter
        const rawCursorData = new Uint8Array(64);
        rawCursorData.set(storedCursorData.dataBitmap, 0);
        rawCursorData.set(storedCursorData.maskBitmap, 32);
        const cursorData = adapter.parseCursor(rawCursorData, storedCursorData.hotspotX, storedCursorData.hotspotY);
        const newCursor = adapter.cursorToCss(cursorData, cursorScale);
        setCursorStyle(newCursor);
        logger.log('[EmulatorCanvas] Cursor re-rendered at scale:', cursorScale);
      } catch (err) {
        console.error('[EmulatorCanvas] Cursor re-render error:', err);
      }
    }
  }, [cursorScale, adapter]);

  // Use the new unified input manager
  const {
    releaseAllKeys,
    showVirtualKeyboardButton,
    triggerVirtualKeyboard,
    showTouchHint,
    dismissTouchHint,
    viewportOffset,
    resetViewportOffset,
  } = useInputManager(canvasRef, inputBuffer, {
    enabled: status === 'running' || status === 'ready',
    canvasWidth: width,
    canvasHeight: height,
    glideMode,
    onGlidePan,
    onClipboardText: (text) => {
      logger.log('[EmulatorCanvas] Clipboard text received:', text.length, 'chars');
    },
  });

  // Check if viewport is panned (for showing reset button)
  const isViewportPanned = viewportOffset.x !== 0 || viewportOffset.y !== 0;

  // Bridge canvas blur to release all keys
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleBlur = () => releaseAllKeys();
    canvas.addEventListener('blur', handleBlur);

    return () => canvas.removeEventListener('blur', handleBlur);
  }, [releaseAllKeys]);

  return (
    <div className="emulator-canvas-container">
      {status === 'loading' && (
        <div className="loading-screen">
          <div className="loading-title">Loading System Disk...</div>
          {loadingProgress ? (
            <div className="loading-details">
              <div className="loading-filename">{loadingProgress.fileName}</div>
              <div
                className="loading-progress-bar"
                role="progressbar"
                aria-valuenow={loadingProgress.percentage}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Downloading ${loadingProgress.fileName}`}
              >
                <div
                  className="loading-progress-fill"
                  style={{ width: `${loadingProgress.percentage}%` }}
                />
              </div>
              <div className="loading-stats">
                <span className="loading-size">
                  {formatBytes(loadingProgress.bytesLoaded)} / {formatBytes(loadingProgress.bytesTotal)}
                </span>
                <span className="loading-percentage">{loadingProgress.percentage}%</span>
              </div>
            </div>
          ) : (
            <div className="loading-details">
              <div className="loading-filename">Preparing download...</div>
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="emulator-error">
          Error: {error}
        </div>
      )}

      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          tabIndex={0}
          style={{
            // Page-host cores (QEMU) run SDL on this real canvas and must init
            // its rendering context while the guest boots; a display:none canvas
            // makes the context creation fail (undefined GLctx -> createShader
            // crash), so keep it visible from mount for those cores.
            display: status === 'running' || status === 'ready' || coreId === 'qemu' ? 'block' : 'none',
            width: '100%',
            height: '100%',
            cursor: hardwareCursorActiveRef.current ? cursorStyle : 'none',
            imageRendering: 'pixelated',
            backgroundColor: '#000',
            objectFit: 'contain',
            // Apply two-finger pan offset
            transform: `translate(${viewportOffset.x}px, ${viewportOffset.y}px)`,
            transformOrigin: 'top left',
          }}
        />

        {/* Cursor overlay for touch devices where CSS cursors aren't visible */}
        {cursorPosition && hardwareCursorActiveRef.current && (status === 'ready' || status === 'running') && (() => {
          const parsed = parseCssCursor(cursorStyle);
          if (!parsed) return null;
          // Calculate cursor size as percentage of canvas width so it scales proportionally
          // Native Mac cursor is 16x16 pixels, scaled by cursorScale
          const cursorSizeMacPixels = 16 * cursorScaleRef.current;
          const cursorWidthPercent = (cursorSizeMacPixels / width) * 100;
          // Hotspot is also proportional
          const hotspotXPercent = (parsed.hotspotX / cursorSizeMacPixels) * 100;
          const hotspotYPercent = (parsed.hotspotY / cursorSizeMacPixels) * 100;
          return (
            <img
              src={parsed.imageUrl}
              alt=""
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: `${(cursorPosition.x / width) * 100}%`,
                top: `${(cursorPosition.y / height) * 100}%`,
                width: `${cursorWidthPercent}%`,
                height: 'auto',
                transform: `translate(-${hotspotXPercent}%, -${hotspotYPercent}%)`,
                pointerEvents: 'none',
                imageRendering: 'pixelated',
                filter: 'drop-shadow(1px 1px 1px rgba(0,0,0,0.5))',
              }}
            />
          );
        })()}

        {/* Virtual keyboard button for mobile devices - fixed position for visibility */}
        {showVirtualKeyboardButton && !hideVirtualKeyboardButton && (status === 'running' || status === 'ready') && (
          <button
            onClick={triggerVirtualKeyboard}
            aria-label="Show keyboard"
            style={{
              position: 'fixed',
              bottom: 'max(16px, env(safe-area-inset-bottom))',
              right: '16px',
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(0, 0, 0, 0.7)',
              border: '2px solid rgba(255, 255, 255, 0.3)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
              <path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/>
            </svg>
          </button>
        )}

        {/* Reset viewport button - shown when viewport is panned */}
        {isViewportPanned && (status === 'running' || status === 'ready') && (
          <button
            onClick={resetViewportOffset}
            aria-label="Reset viewport"
            style={{
              position: 'fixed',
              bottom: 'max(16px, env(safe-area-inset-bottom))',
              left: '16px',
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(0, 0, 0, 0.7)',
              border: '2px solid rgba(255, 255, 255, 0.3)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            }}
          >
            {/* Crosshair/center icon */}
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
              <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
            </svg>
          </button>
        )}

        {/* Touch hint tooltip for first-time touch users */}
        {showTouchHint && (
          <div
            onClick={dismissTouchHint}
            style={{
              position: 'fixed',
              bottom: 'max(90px, calc(env(safe-area-inset-bottom) + 80px))',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(0, 0, 0, 0.85)',
              color: 'white',
              padding: '10px 20px',
              borderRadius: 12,
              fontSize: 14,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              zIndex: 1001,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            }}
          >
            Tip: Long-press for right-click
          </div>
        )}
      </div>

      {/* Lock conflict takeover dialog */}
      {lockConflict && (
        <LockTakeoverDialog
          diskName={lockConflict.diskName}
          lockInfo={lockConflict.holder}
          onConfirm={async () => {
            logger.log('[EmulatorCanvas] User confirmed takeover of', lockConflict.diskName);
            try {
              // Call takeover API directly from main thread
              const tabId = storageManager.getTabId();
              const sessionId = storageManager.getSessionId();

              // Convert WS URL to HTTP URL for fetch
              let httpRelayUrl = relayUrl;
              if (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://')) {
                const url = new URL(relayUrl);
                url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
                url.pathname = url.pathname.replace(/\/ethernet$/, '');
                httpRelayUrl = url.origin + url.pathname;
              }

              const takeoverUrl = new URL('/disk/lock/takeover', httpRelayUrl);
              takeoverUrl.searchParams.set('name', lockConflict.diskName);
              takeoverUrl.searchParams.set('tabId', tabId);
              takeoverUrl.searchParams.set('sessionId', sessionId);

              const resp = await fetch(takeoverUrl.toString(), { method: 'POST' });
              if (!resp.ok) {
                throw new Error(`Takeover failed: ${resp.status}`);
              }
              logger.log('[EmulatorCanvas] Lock takeover successful');
              setLockConflict(null);
              // Reload to restart emulator with the new lock
              window.location.reload();
            } catch (err) {
              logger.error('[EmulatorCanvas] Lock takeover failed:', err);
              setLockConflict(null);
              setStatus('error');
              setError('Failed to take over disk lock. Please try again.');
            }
          }}
          onCancel={() => {
            logger.log('[EmulatorCanvas] User cancelled lock takeover');
            setLockConflict(null);
            setStatus('error');
            setError('Disk is in use by another tab. Close the other tab or use a different disk.');
          }}
        />
      )}
    </div>
  );
});
