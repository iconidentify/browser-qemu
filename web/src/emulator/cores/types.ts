/**
 * Core Abstraction Layer Types
 *
 * This module defines the interfaces that allow multiple emulator cores
 * (Basilisk II, DOSBox, etc.) to work with the same frontend infrastructure.
 */

import type { DiskStorageMode } from '../disk/types';

// Re-export for convenience
export type { DiskStorageMode };

/**
 * Capabilities that vary between emulator cores.
 * Used by UI to show/hide features and by worker to enable/disable functionality.
 */
export interface EmulatorCapabilities {
  // Display
  maxScreenWidth: number;
  maxScreenHeight: number;
  supportsHardwareCursor: boolean;

  // Input
  supportsMouseDeltas: boolean;

  // Networking
  supportsEthernet: boolean;
  supportsAppleTalk: boolean;
  supportsIPX: boolean;

  // Features
  supportsClipboard: boolean;
  supportsSound: boolean;

  // Disk
  supportedDiskExtensions: string[];
}

/**
 * Cursor data normalized across different emulator formats.
 */
export interface CursorData {
  format: 'mac-1bit' | 'win-mono' | 'win-color' | 'hidden';
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  data: Uint8Array;
  mask?: Uint8Array;
}

/**
 * Configuration passed to the emulator core.
 * Core-agnostic; each adapter translates to native format.
 */
export interface EmulatorConfig {
  // Display
  screenWidth: number;
  screenHeight: number;

  // Memory
  ramSizeMB: number;

  // Disks
  diskPaths: string[];
  diskMode: DiskStorageMode;

  // Networking
  relayUrl: string;
  networkZone?: string;

  // Performance
  jit: boolean;

  // Core-specific (opaque to framework)
  coreConfig?: Record<string, unknown>;
}

/**
 * Adapter interface that each emulator core must implement.
 */
export interface CoreAdapter {
  /** Unique identifier for this core */
  readonly id: string;

  /** Human-readable name */
  readonly displayName: string;

  /** Feature capabilities */
  readonly capabilities: EmulatorCapabilities;

  // === Worker Management ===

  /** Create a new Web Worker for this core */
  createWorker(): Worker;

  /** Path to WASM module (relative to base URL) */
  getWasmPath(): string;

  // === Configuration ===

  /** Generate native config file content from EmulatorConfig */
  generateConfig(config: EmulatorConfig): string;

  /** Get ROM/BIOS path for this core (if applicable) */
  getRomPath?(config: EmulatorConfig): string;

  // === Input Translation ===

  /** Map browser KeyboardEvent.code to native keycode */
  mapKeyCode(browserCode: string): number;

  /** Get modifier mask from keyboard event (core-specific format) */
  getModifierMask?(event: KeyboardEvent): number;

  // === Cursor Handling ===

  /** Parse raw cursor data from WASM into normalized CursorData */
  parseCursor(rawData: Uint8Array, hotspotX: number, hotspotY: number): CursorData;

  /** Convert CursorData to CSS cursor string */
  cursorToCss(cursor: CursorData, scale: number): string;

  // === Lifecycle Hooks ===

  /** Called before worker starts (optional setup) */
  onBeforeStart?(config: EmulatorConfig): Promise<void>;

  /** Called when emulator is fully stopped (optional cleanup) */
  onStopped?(): void;
}

// ============================================================================
// Worker Message Types
// ============================================================================

/**
 * Message types from main thread to worker.
 * All cores must handle these message types.
 */
export type MainToWorkerMessage =
  | { type: 'start'; config: WorkerStartConfig }
  | { type: 'stop' }
  | { type: 'input'; inputType: string; [key: string]: unknown }
  | { type: 'ethernet_receive'; packet: ArrayBuffer };

/**
 * Message types from worker to main thread.
 * All cores must emit these message types at appropriate times.
 */
export type WorkerToMainMessage =
  | { type: 'emulator_ready' }
  | { type: 'emulator_loading'; message: string }
  | { type: 'emulator_loading_progress'; fileName: string; bytesLoaded: number; bytesTotal: number; percentage: number }
  | { type: 'emulator_video_open'; width: number; height: number }
  | { type: 'emulator_blit' }
  | { type: 'emulator_cursor_change'; dataBitmap?: Uint8Array; maskBitmap?: Uint8Array; hotspotX: number; hotspotY: number; visible: boolean }
  | { type: 'emulator_audio_open'; sampleRate: number; sampleSize: number; channels: number }
  | { type: 'emulator_ethernet_init'; macAddress: string }
  | { type: 'emulator_ethernet_write'; destination: string; packet: ArrayBuffer }
  | { type: 'emulator_hd_activity' }
  | { type: 'emulator_cpu_load'; load: number }
  | { type: 'emulator_error'; error: string; recoverable?: boolean }
  | { type: 'emulator_stopped' }
  | { type: 'stopped' }
  | { type: 'heartbeat_info'; relayUrl: string; tabId: string; diskNames: string[] }
  | { type: 'lock_conflict'; diskName: string; holder: unknown };

/**
 * Configuration passed to worker on start.
 */
export interface WorkerStartConfig {
  // Base URL for assets
  baseUrl: string;

  // Display
  width: number;
  height: number;

  // Disks
  diskPaths: string[];
  diskMode: DiskStorageMode;

  // ROM (optional, core-specific)
  romPath?: string;

  // SharedArrayBuffers (if available)
  inputBuffer?: SharedArrayBuffer;
  ethernetBuffer?: SharedArrayBuffer;
  ethernetControl?: SharedArrayBuffer;
  screenBuffer?: SharedArrayBuffer;
  videoModeBuffer?: SharedArrayBuffer;
  audioBuffer?: SharedArrayBuffer;
  audioControl?: SharedArrayBuffer;

  // Networking
  relayUrl: string;

  // Performance
  jit: boolean;

  // Session
  sessionId?: string;
  tabId?: string;

  // Debug
  debug?: boolean;
}

// ============================================================================
// Worker API Interface
// ============================================================================

/**
 * workerApi interface that WASM cores call via EM_ASM.
 * Each worker must expose this as globalThis.workerApi.
 */
export interface WorkerApi {
  // Input buffer addresses (imported from input/constants)
  InputBufferAddresses: Record<string, number>;

  // === Video (required) ===
  didOpenVideo(width: number, height: number): void;
  blit(bufPtr: number, bufSize: number): void;

  // === Cursor (optional) ===
  setCursor?(dataPtr: number, hotspotX: number, hotspotY: number, visible: number): void;

  // === Audio (required) ===
  didOpenAudio(sampleRate: number, sampleSize: number, channels: number): void;
  enqueueAudio(bufPtr: number, nbytes: number): void;
  audioBufferSize(): number;

  // === Input (required) ===
  acquireInputLock(): number;
  releaseInputLock(): void;
  getInputValue(addr: number): number;
  setInputValue(addr: number, value: number): void;
  idleWait(): boolean;
  sleep(timeSeconds: number): void;

  // === Ethernet (optional) ===
  etherSeed?(): number;
  etherInit?(macAddress: string): void;
  etherWrite?(destination: string, packetPtr: number, packetLength: number): void;
  etherRead?(packetPtr: number, maxLength: number): number;

  // === Disk (required) ===
  disks: WorkerDiskApi;

  // === Clipboard (optional) ===
  setClipboardText?(text: string): void;
  getClipboardText?(): string | null;

  // === Error handling (required) ===
  emulatorDidHaveError(status: number, error?: Error): void;
  exit(): void;
}

/**
 * Disk operations exposed to WASM.
 */
export interface WorkerDiskApi {
  open(name: string): number;
  close(diskId: number): void;
  read(diskId: number, bufPtr: number, offset: number, length: number): number;
  write(diskId: number, bufPtr: number, offset: number, length: number): number;
  size(diskId: number): number;
  isMediaPresent(diskId: number): boolean;
  isFixedDisk(diskId: number): boolean;
  eject(diskId: number): void;
  pendingDiskName(): string | null;
}
