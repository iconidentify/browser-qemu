/**
 * DiskManager - Orchestrates disk operations between UI, worker, and persistence
 *
 * Handles mounting, ejecting, creating, and downloading disk images.
 * Manages communication with the emulator worker and IndexedDB persistence.
 */

import { diskPersistence, type DiskMetadata } from './DiskPersistence';
import { logger } from '../logger';
import type { DiskInfo, MountedDiskInfo } from '../types/disk-messages';

export interface DiskManagerOptions {
  worker: Worker;
  onDiskListChange?: (disks: MountedDiskInfo[]) => void;
  onDiskDirtyChange?: (diskId: string, isDirty: boolean) => void;
  onError?: (error: string) => void;
}

export class DiskManager {
  private worker: Worker;
  private mountedDisks: Map<string, MountedDiskInfo> = new Map();
  private pendingDataRequests: Map<string, (data: ArrayBuffer) => void> = new Map();
  private options: DiskManagerOptions;

  constructor(options: DiskManagerOptions) {
    this.options = options;
    this.worker = options.worker;
    this.setupWorkerListener();
  }

  /**
   * Set up listener for worker messages
   */
  private setupWorkerListener(): void {
    this.worker.addEventListener('message', (event) => {
      const { type } = event.data;

      switch (type) {
        case 'disk_mounted':
          this.handleDiskMounted(event.data);
          break;
        case 'disk_ejected':
          this.handleDiskEjected(event.data);
          break;
        case 'disk_dirty':
          this.handleDiskDirty(event.data);
          break;
        case 'disk_data':
          this.handleDiskData(event.data);
          break;
        case 'disk_error':
          this.handleDiskError(event.data);
          break;
        case 'disk_list_response':
          this.handleDiskListResponse(event.data);
          break;
      }
    });
  }

  private handleDiskMounted(data: { diskId: string; name: string; sizeBytes: number; isBootDisk: boolean }): void {
    const disk: MountedDiskInfo = {
      diskId: data.diskId,
      name: data.name,
      size: data.sizeBytes,
      isDirty: false,
      isBootDisk: data.isBootDisk,
      mountedAt: Date.now(),
    };
    this.mountedDisks.set(data.diskId, disk);
    this.notifyDiskListChange();
  }

  private handleDiskEjected(data: { diskId: string }): void {
    this.mountedDisks.delete(data.diskId);
    this.notifyDiskListChange();
  }

  private handleDiskDirty(data: { diskId: string; isDirty: boolean; dirtyBytes?: number }): void {
    const disk = this.mountedDisks.get(data.diskId);
    if (disk) {
      disk.isDirty = data.isDirty;
      disk.lastWriteTime = data.isDirty ? Date.now() : undefined;
      this.options.onDiskDirtyChange?.(data.diskId, data.isDirty);
      this.notifyDiskListChange();
    }
  }

  private handleDiskData(data: { diskId: string; data: ArrayBuffer }): void {
    const resolver = this.pendingDataRequests.get(data.diskId);
    if (resolver) {
      resolver(data.data);
      this.pendingDataRequests.delete(data.diskId);
    }
  }

  private handleDiskError(data: { diskId: string; error: string }): void {
    console.error(`[DiskManager] Disk error (${data.diskId}):`, data.error);
    this.options.onError?.(data.error);
  }

  private handleDiskListResponse(data: { disks: DiskInfo[] }): void {
    this.mountedDisks.clear();
    for (const disk of data.disks) {
      this.mountedDisks.set(disk.diskId, {
        ...disk,
        mountedAt: Date.now(),
      });
    }
    this.notifyDiskListChange();
  }

  private notifyDiskListChange(): void {
    this.options.onDiskListChange?.(this.getMountedDisks());
  }

  /**
   * Mount a disk image from a File
   */
  async mountDisk(file: File): Promise<string> {
    const diskId = this.generateDiskId();
    const arrayBuffer = await file.arrayBuffer();

    this.worker.postMessage(
      {
        type: 'disk_mount',
        diskId,
        name: file.name,
        data: arrayBuffer,
      },
      [arrayBuffer]
    );

    return diskId;
  }

  /**
   * Mount a disk from raw data
   */
  mountDiskFromData(diskId: string, name: string, data: ArrayBuffer): void {
    this.worker.postMessage(
      {
        type: 'disk_mount',
        diskId,
        name,
        data,
      },
      [data]
    );
  }

  /**
   * Create and mount a new blank HFS disk
   */
  async createBlankDisk(name: string, sizeBytes: number): Promise<string> {
    const diskId = this.generateDiskId();

    // Fetch the appropriate template
    const templateData = await this.fetchDiskTemplate(sizeBytes);

    // Update volume name in template
    this.setHFSVolumeName(templateData, name);

    this.worker.postMessage(
      {
        type: 'disk_create',
        diskId,
        name: name + '.img',
        templateData: templateData.buffer,
      },
      [templateData.buffer]
    );

    return diskId;
  }

  /**
   * Eject a disk
   */
  ejectDisk(diskId: string): void {
    this.worker.postMessage({
      type: 'disk_eject',
      diskId,
    });
  }

  /**
   * Download a disk image to user's computer
   */
  async downloadDisk(diskId: string): Promise<void> {
    const disk = this.mountedDisks.get(diskId);
    if (!disk) {
      throw new Error('Disk not found');
    }

    const data = await this.requestDiskData(diskId);
    const blob = new Blob([data], { type: 'application/octet-stream' });

    // Try modern File System Access API first
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: disk.name,
          types: [{
            description: 'Disk Image',
            accept: { 'application/octet-stream': ['.img', '.dsk'] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        // Fall through to legacy download
      }
    }

    // Legacy download via anchor click
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = disk.name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /**
   * Save disk to IndexedDB
   */
  async saveDiskToStorage(diskId: string): Promise<void> {
    const disk = this.mountedDisks.get(diskId);
    if (!disk) {
      throw new Error('Disk not found');
    }

    const data = await this.requestDiskData(diskId);
    await diskPersistence.saveDisk({
      diskId,
      name: disk.name,
      data: new Uint8Array(data),
    });

    // Clear dirty state in worker
    this.worker.postMessage({
      type: 'disk_clear_dirty',
      diskId,
    });
  }

  /**
   * Load a persisted disk from IndexedDB
   */
  async loadPersistedDisk(diskId: string): Promise<void> {
    const data = await diskPersistence.loadDisk(diskId);
    if (!data) {
      throw new Error('Disk not found in storage');
    }

    const metadata = await diskPersistence.getDiskMetadata(diskId);
    const name = metadata?.name || 'Unknown';

    this.worker.postMessage(
      {
        type: 'disk_mount',
        diskId,
        name,
        data: data.buffer,
      },
      [data.buffer]
    );
  }

  /**
   * List persisted disks
   */
  async listPersistedDisks(): Promise<DiskMetadata[]> {
    return diskPersistence.listDisks();
  }

  /**
   * Delete a persisted disk
   */
  async deletePersistedDisk(diskId: string): Promise<void> {
    await diskPersistence.deleteDisk(diskId);
  }

  /**
   * Get list of currently mounted disks
   */
  getMountedDisks(): MountedDiskInfo[] {
    return Array.from(this.mountedDisks.values()).sort((a, b) => {
      // Boot disk first, then by mount time
      if (a.isBootDisk && !b.isBootDisk) return -1;
      if (!a.isBootDisk && b.isBootDisk) return 1;
      return (a.mountedAt || 0) - (b.mountedAt || 0);
    });
  }

  /**
   * Get a specific mounted disk
   */
  getMountedDisk(diskId: string): MountedDiskInfo | undefined {
    return this.mountedDisks.get(diskId);
  }

  /**
   * Check if any disks have unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return Array.from(this.mountedDisks.values()).some(d => d.isDirty);
  }

  /**
   * Request disk data from worker
   */
  private requestDiskData(diskId: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDataRequests.delete(diskId);
        reject(new Error('Disk data request timed out'));
      }, 30000);

      this.pendingDataRequests.set(diskId, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });

      this.worker.postMessage({
        type: 'disk_get_data',
        diskId,
      });
    });
  }

  /**
   * Fetch disk template for creating blank disks
   */
  private async fetchDiskTemplate(sizeBytes: number): Promise<Uint8Array> {
    // Find the closest template size >= requested
    const templateSizes = [800 * 1024, 1.4 * 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024];
    const templateSize = templateSizes.find(s => s >= sizeBytes) || templateSizes[templateSizes.length - 1];
    const sizeMB = Math.round(templateSize / (1024 * 1024));

    try {
      const response = await fetch(`/templates/blank-hfs-${sizeMB}mb.img`);
      if (!response.ok) {
        throw new Error(`Template not found: ${sizeMB}MB`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      // Fallback: create a minimal blank disk
      logger.warn('[DiskManager] Template not found, creating minimal disk');
      return this.createMinimalDisk(sizeBytes);
    }
  }

  /**
   * Create a minimal blank disk (may need formatting in Mac OS)
   */
  private createMinimalDisk(sizeBytes: number): Uint8Array {
    const disk = new Uint8Array(sizeBytes);
    // Fill with zeros - user will need to format in System 7
    return disk;
  }

  /**
   * Set HFS volume name in a disk image
   */
  private setHFSVolumeName(disk: Uint8Array, name: string): void {
    // HFS Master Directory Block starts at offset 1024 (after boot blocks)
    // Volume name is at offset 0x24 within MDB (1024 + 0x24 = 1060)
    const MDB_OFFSET = 1024;
    const NAME_OFFSET_IN_MDB = 0x24;
    const nameOffset = MDB_OFFSET + NAME_OFFSET_IN_MDB;

    // Check if this looks like an HFS volume (signature at MDB + 0 should be 0x4244 'BD')
    if (disk.length > MDB_OFFSET + 2) {
      const sig = (disk[MDB_OFFSET] << 8) | disk[MDB_OFFSET + 1];
      if (sig !== 0x4244) {
        logger.warn('[DiskManager] Disk does not appear to be HFS formatted');
        return;
      }
    }

    // Pascal string: first byte is length, max 27 chars for HFS
    const encoder = new TextEncoder();
    const nameBytes = encoder.encode(name.slice(0, 27));

    if (disk.length > nameOffset + 28) {
      disk[nameOffset] = nameBytes.length;
      disk.set(nameBytes, nameOffset + 1);
    }
  }

  /**
   * Generate unique disk ID
   */
  private generateDiskId(): string {
    return `disk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
