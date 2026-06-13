/**
 * DiskPersistence - IndexedDB storage for disk images
 *
 * Stores disk images as Blobs for efficient handling of large files.
 * Supports up to 100MB disk images.
 */

import { logger } from '../logger';

const DB_NAME = 'dialtone-emulator';
const STORE_NAME = 'disks';
const METADATA_STORE = 'disk-metadata';
const DB_VERSION = 1;

export interface PersistedDiskRecord {
  diskId: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
  data: ArrayBuffer;
}

export interface DiskMetadata {
  diskId: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  modifiedAt: number;
}

export class DiskPersistence {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the database
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[DiskPersistence] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        logger.log('[DiskPersistence] Database opened successfully');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Main disk storage
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'diskId' });
        }

        // Lightweight metadata for listing
        if (!db.objectStoreNames.contains(METADATA_STORE)) {
          const metaStore = db.createObjectStore(METADATA_STORE, { keyPath: 'diskId' });
          metaStore.createIndex('name', 'name', { unique: false });
          metaStore.createIndex('modifiedAt', 'modifiedAt', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Save a disk to IndexedDB
   */
  async saveDisk(disk: {
    diskId: string;
    name: string;
    data: Uint8Array;
  }): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    // Ensure the data stored in IndexedDB is backed by a plain ArrayBuffer (not SharedArrayBuffer)
    // so it can be properly cloned by IndexedDB's structured cloning algorithm.
    const dataCopy = new Uint8Array(disk.data);
    const record: PersistedDiskRecord = {
      diskId: disk.diskId,
      name: disk.name,
      sizeBytes: disk.data.byteLength,
      createdAt: now,
      modifiedAt: now,
      data: dataCopy.buffer,
    };

    const metadata: DiskMetadata = {
      diskId: disk.diskId,
      name: disk.name,
      sizeBytes: disk.data.byteLength,
      createdAt: now,
      modifiedAt: now,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME, METADATA_STORE], 'readwrite');

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        logger.log(`[DiskPersistence] Saved disk: ${disk.name}`);
        resolve();
      };

      tx.objectStore(STORE_NAME).put(record);
      tx.objectStore(METADATA_STORE).put(metadata);
    });
  }

  /**
   * Load a disk from IndexedDB
   */
  async loadDisk(diskId: string): Promise<Uint8Array | null> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(diskId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (!request.result) {
          resolve(null);
          return;
        }

        try {
          const arrayBuffer = request.result.data as ArrayBuffer;
          logger.log(`[DiskPersistence] Loaded disk: ${request.result.name}`);
          resolve(new Uint8Array(arrayBuffer));
        } catch (err) {
          reject(err);
        }
      };
    });
  }

  /**
   * List all persisted disks (metadata only)
   */
  async listDisks(): Promise<DiskMetadata[]> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(METADATA_STORE, 'readonly');
      const store = tx.objectStore(METADATA_STORE);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const disks = request.result.sort((a, b) => b.modifiedAt - a.modifiedAt);
        resolve(disks);
      };
    });
  }

  /**
   * Get metadata for a single disk
   */
  async getDiskMetadata(diskId: string): Promise<DiskMetadata | null> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(METADATA_STORE, 'readonly');
      const store = tx.objectStore(METADATA_STORE);
      const request = store.get(diskId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * Delete a persisted disk
   */
  async deleteDisk(diskId: string): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME, METADATA_STORE], 'readwrite');

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        logger.log(`[DiskPersistence] Deleted disk: ${diskId}`);
        resolve();
      };

      tx.objectStore(STORE_NAME).delete(diskId);
      tx.objectStore(METADATA_STORE).delete(diskId);
    });
  }

  /**
   * Update modified timestamp
   */
  async updateModifiedTime(diskId: string): Promise<void> {
    await this.init();
    if (!this.db) throw new Error('Database not initialized');

    const metadata = await this.getDiskMetadata(diskId);
    if (!metadata) return;

    metadata.modifiedAt = Date.now();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(METADATA_STORE, 'readwrite');
      const store = tx.objectStore(METADATA_STORE);
      const request = store.put(metadata);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get total storage used by disks
   */
  async getStorageUsed(): Promise<number> {
    const disks = await this.listDisks();
    return disks.reduce((sum, disk) => sum + disk.sizeBytes, 0);
  }

  /**
   * Check if IndexedDB is available
   */
  static isAvailable(): boolean {
    return typeof indexedDB !== 'undefined';
  }
}

// Singleton instance
export const diskPersistence = new DiskPersistence();
