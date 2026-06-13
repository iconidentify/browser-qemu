/**
 * DiskController - Manages disk images in the emulator worker
 *
 * Handles mounting, reading, writing, and tracking dirty state
 * for multiple disk images including boot disk and mounted volumes.
 */

import { DirtyBlockTracker } from './DirtyBlockTracker';
import { logger } from '../logger';

export interface DiskEntry {
  diskId: string;
  name: string;
  data: Uint8Array;
  size: number;
  dirtyTracker: DirtyBlockTracker;
  isBootDisk: boolean;
  isEjecting: boolean;
  mountedAt: number;
  wasmDiskId: number | null;
}

export interface DiskInfo {
  diskId: string;
  name: string;
  size: number;
  isDirty: boolean;
  isBootDisk: boolean;
}

// Callback type for notifying main thread
type NotifyCallback = (message: unknown) => void;

export class DiskController {
  private diskMap: Map<string, DiskEntry> = new Map();
  private wasmIdToDiskId: Map<number, string> = new Map();
  private nextWasmId = 1;
  private notify: NotifyCallback;
  private dirtyNotifyTimeout: ReturnType<typeof setTimeout> | null = null;
  private wasmModule: { HEAPU8: Uint8Array } | null = null;

  constructor(notify: NotifyCallback) {
    this.notify = notify;
  }

  /**
   * Set the WASM module reference for memory access
   */
  setWasmModule(module: { HEAPU8: Uint8Array }): void {
    this.wasmModule = module;
  }

  /**
   * Add a new disk from provided data
   */
  addDisk(diskId: string, name: string, data: Uint8Array, isBootDisk = false): void {
    if (this.diskMap.has(diskId)) {
      logger.warn(`[DiskController] Disk ${diskId} already exists, replacing`);
      this.removeDisk(diskId);
    }

    const entry: DiskEntry = {
      diskId,
      name,
      data,
      size: data.byteLength,
      dirtyTracker: new DirtyBlockTracker(data.byteLength),
      isBootDisk,
      isEjecting: false,
      mountedAt: Date.now(),
      wasmDiskId: null,
    };

    this.diskMap.set(diskId, entry);
    logger.log(`[DiskController] Added disk: ${name} (${this.formatBytes(data.byteLength)})`);

    this.notify({
      type: 'disk_mounted',
      diskId,
      name,
      sizeBytes: data.byteLength,
      isBootDisk,
    });
  }

  /**
   * Create a blank disk (data should be a valid HFS image)
   */
  createBlankDisk(diskId: string, name: string, templateData: Uint8Array): void {
    // The template already has HFS structure, just add it
    this.addDisk(diskId, name, templateData, false);

    // Mark as immediately dirty since it's "new"
    const entry = this.diskMap.get(diskId);
    if (entry) {
      entry.dirtyTracker.markDirty(0, 1); // Mark first block dirty
      this.scheduleDirtyNotification(entry);
    }
  }

  /**
   * Open a disk by name (called by WASM)
   */
  openDisk(name: string): number {
    // Find disk by name or ID
    for (const entry of this.diskMap.values()) {
      if (entry.name === name || entry.diskId === name) {
        if (entry.wasmDiskId !== null) {
          return entry.wasmDiskId;
        }

        const wasmId = this.nextWasmId++;
        entry.wasmDiskId = wasmId;
        this.wasmIdToDiskId.set(wasmId, entry.diskId);
        logger.log(`[DiskController] Opened disk ${name} as WASM ID ${wasmId}`);
        return wasmId;
      }
    }

    logger.warn(`[DiskController] Disk not found: ${name}`);
    return -1;
  }

  /**
   * Read from disk (called by WASM)
   */
  readDisk(wasmDiskId: number, bufPtr: number, offset: number, length: number): number {
    const diskId = this.wasmIdToDiskId.get(wasmDiskId);
    if (!diskId) return 0;

    const entry = this.diskMap.get(diskId);
    if (!entry || !this.wasmModule) return 0;

    const actualLength = Math.min(length, entry.size - offset);
    if (actualLength <= 0) return 0;

    // Copy from disk to WASM memory
    const source = entry.data.subarray(offset, offset + actualLength);
    this.wasmModule.HEAPU8.set(source, bufPtr);

    return actualLength;
  }

  /**
   * Write to disk (called by WASM)
   */
  writeDisk(wasmDiskId: number, bufPtr: number, offset: number, length: number): number {
    const diskId = this.wasmIdToDiskId.get(wasmDiskId);
    if (!diskId) return 0;

    const entry = this.diskMap.get(diskId);
    if (!entry || !this.wasmModule || entry.isEjecting) return 0;

    const actualLength = Math.min(length, entry.size - offset);
    if (actualLength <= 0) return 0;

    // Copy from WASM memory to disk
    const source = this.wasmModule.HEAPU8.subarray(bufPtr, bufPtr + actualLength);
    entry.data.set(source, offset);

    // Track dirty blocks
    entry.dirtyTracker.markDirty(offset, actualLength);
    this.scheduleDirtyNotification(entry);

    return actualLength;
  }

  /**
   * Get disk size (called by WASM)
   */
  getDiskSize(wasmDiskId: number): number {
    const diskId = this.wasmIdToDiskId.get(wasmDiskId);
    if (!diskId) return 0;

    const entry = this.diskMap.get(diskId);
    return entry ? entry.size : 0;
  }

  /**
   * Eject a disk and return its data
   */
  ejectDisk(diskId: string): Uint8Array | null {
    const entry = this.diskMap.get(diskId);
    if (!entry) return null;

    if (entry.isBootDisk) {
      logger.warn(`[DiskController] Cannot eject boot disk`);
      return null;
    }

    entry.isEjecting = true;

    // Remove from WASM mapping
    if (entry.wasmDiskId !== null) {
      this.wasmIdToDiskId.delete(entry.wasmDiskId);
    }

    // Copy data for return
    const dataCopy = new Uint8Array(entry.data);

    // Clean up
    this.diskMap.delete(diskId);

    logger.log(`[DiskController] Ejected disk: ${entry.name}`);

    this.notify({
      type: 'disk_ejected',
      diskId,
      name: entry.name,
    });

    return dataCopy;
  }

  /**
   * Get disk data for download/persistence
   */
  getDiskData(diskId: string): Uint8Array | null {
    const entry = this.diskMap.get(diskId);
    if (!entry) return null;
    return new Uint8Array(entry.data);
  }

  /**
   * Check if disk is dirty
   */
  isDiskDirty(diskId: string): boolean {
    const entry = this.diskMap.get(diskId);
    return entry ? entry.dirtyTracker.isDirty() : false;
  }

  /**
   * Clear dirty state (after save)
   */
  clearDirtyState(diskId: string): void {
    const entry = this.diskMap.get(diskId);
    if (entry) {
      entry.dirtyTracker.clear();
      this.notify({
        type: 'disk_dirty',
        diskId,
        isDirty: false,
      });
    }
  }

  /**
   * Get list of all mounted disks
   */
  getDisks(): DiskInfo[] {
    return Array.from(this.diskMap.values()).map(entry => ({
      diskId: entry.diskId,
      name: entry.name,
      size: entry.size,
      isDirty: entry.dirtyTracker.isDirty(),
      isBootDisk: entry.isBootDisk,
    }));
  }

  /**
   * Get disk by ID
   */
  getDisk(diskId: string): DiskEntry | undefined {
    return this.diskMap.get(diskId);
  }

  /**
   * Remove disk without ejection protocol (internal use)
   */
  private removeDisk(diskId: string): void {
    const entry = this.diskMap.get(diskId);
    if (entry && entry.wasmDiskId !== null) {
      this.wasmIdToDiskId.delete(entry.wasmDiskId);
    }
    this.diskMap.delete(diskId);
  }

  /**
   * Schedule debounced dirty notification to main thread
   */
  private scheduleDirtyNotification(entry: DiskEntry): void {
    if (this.dirtyNotifyTimeout) return;

    this.dirtyNotifyTimeout = setTimeout(() => {
      this.dirtyNotifyTimeout = null;
      this.notify({
        type: 'disk_dirty',
        diskId: entry.diskId,
        isDirty: entry.dirtyTracker.isDirty(),
        dirtyBytes: entry.dirtyTracker.getDirtyBytes(),
      });
    }, 500);
  }

  /**
   * Format bytes for logging
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}
