/**
 * OPFSCache - Persistent disk cache using Origin Private File System
 *
 * Uses FileSystemSyncAccessHandle for synchronous read/write in Web Workers.
 * This is 3-4x faster than IndexedDB and provides true sync API.
 *
 * Architecture:
 * - Per-tab isolation: /disk-cache/{disk-name}/{session-id}/
 * - chunks.bin: Raw chunk data at fixed offsets (chunkId * CHUNK_SIZE)
 * - bitmap.bin: 1 bit per chunk indicating if it's cached
 *
 * Benefits:
 * - Survives page reload (persistent storage)
 * - Sync API in workers (no await needed for reads)
 * - Much faster than sync XHR for cached data
 * - Up to 16GB capacity
 * - Multi-tab support: each tab gets isolated cache via session ID
 */

import { logger } from '../logger';

const CHUNK_SIZE = 128 * 1024; // 128KB chunks (matches CachedRelayDisk)

// Type augmentation for FileSystemDirectoryHandle.entries() which exists at runtime
// but may not be in TypeScript's lib types
type DirectoryEntries = AsyncIterableIterator<[string, FileSystemHandle]>;

export class OPFSCache {
  #diskName: string;
  #totalChunks: number;

  // Sync file handles (only available in Web Workers)
  #dataHandle: FileSystemSyncAccessHandle | null = null;
  #bitmapHandle: FileSystemSyncAccessHandle | null = null;

  // In-memory bitmap for fast lookups
  #bitmap: Uint8Array | null = null;

  private constructor(diskName: string, totalChunks: number) {
    this.#diskName = diskName;
    this.#totalChunks = totalChunks;
  }

  /**
   * Create or open an OPFS cache for a disk.
   * Must be called from a Web Worker (SyncAccessHandle only works in workers).
   * @param sessionId - Session ID for per-tab isolation (required for multi-tab support)
   */
  static async create(
    diskName: string,
    diskSize: number,
    sessionId: string
  ): Promise<OPFSCache | null> {
    // Check if OPFS is available
    if (!navigator.storage?.getDirectory) {
      logger.warn('[OPFSCache] OPFS not available in this browser');
      return null;
    }

    if (!sessionId) {
      logger.warn('[OPFSCache] Session ID is required for multi-tab isolation');
      return null;
    }

    try {
      const totalChunks = Math.ceil(diskSize / CHUNK_SIZE);
      const cache = new OPFSCache(diskName, totalChunks);

      const root = await navigator.storage.getDirectory();

      // Create disk cache directory structure: /disk-cache/{disk-name}/{session-id}/
      const cacheDir = await root.getDirectoryHandle('disk-cache', {
        create: true,
      });

      // Get or create disk-specific directory
      const diskDir = await cacheDir.getDirectoryHandle(
        sanitizeName(diskName),
        { create: true }
      );

      // Create session-specific subdirectory for per-tab isolation
      // This prevents multiple tabs from fighting over the same file handles
      let sessionDir = await diskDir.getDirectoryHandle(
        sanitizeName(sessionId),
        { create: true }
      );

      // Helper to open all handles
      const openHandles = async (dir: FileSystemDirectoryHandle) => {
        // Open data file (will hold raw chunk data)
        const dataFile = await dir.getFileHandle('chunks.bin', {
          create: true,
        });
        cache.#dataHandle = await dataFile.createSyncAccessHandle();

        // Open bitmap file (tracks which chunks are cached)
        const bitmapFile = await dir.getFileHandle('bitmap.bin', {
          create: true,
        });
        cache.#bitmapHandle = await bitmapFile.createSyncAccessHandle();
      };

      try {
        await openHandles(sessionDir);
      } catch (e) {
        // Handle orphaned handles from crashed workers
        // Note: Use duck typing instead of instanceof (doesn't work across contexts)
        const isLockError = e && typeof e === 'object' && 'name' in e &&
          (e as { name: string }).name === 'NoModificationAllowedError';

        if (isLockError) {
          logger.warn(`[OPFSCache] Handle locked for ${diskName}/${sessionId}, clearing and retrying...`);

          // Close any partially-opened handles first
          cache.#dataHandle?.close();
          cache.#dataHandle = null;
          cache.#bitmapHandle?.close();
          cache.#bitmapHandle = null;

          // Delete just this session's cache directory to release locks
          try {
            await diskDir.removeEntry(sanitizeName(sessionId), { recursive: true });
          } catch {
            // Ignore if doesn't exist
          }

          // Recreate session directory and try again
          sessionDir = await diskDir.getDirectoryHandle(sanitizeName(sessionId), { create: true });
          await openHandles(sessionDir);

          logger.log(`[OPFSCache] Recovered from orphaned handle for ${diskName}/${sessionId}`);
        } else {
          throw e;
        }
      }

      // Load or initialize bitmap
      cache.#loadBitmap();

      logger.log(
        `[OPFSCache] Initialized for ${diskName} (session: ${sessionId.slice(0, 8)}...): ` +
          `${totalChunks} chunks, ${cache.#countCachedChunks()} already cached`
      );

      return cache;
    } catch (e) {
      // Better error logging - extract message from various error types
      const errorMsg = e && typeof e === 'object'
        ? ('message' in e ? (e as Error).message : ('name' in e ? (e as { name: string }).name : String(e)))
        : String(e);
      logger.warn(`[OPFSCache] Failed to initialize ${diskName}: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Check if a chunk is in the cache.
   * SYNCHRONOUS - safe to call from WASM.
   */
  hasChunk(chunkId: number): boolean {
    if (!this.#bitmap || chunkId >= this.#totalChunks) return false;

    const byteIndex = Math.floor(chunkId / 8);
    const bitIndex = chunkId % 8;
    return (this.#bitmap[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Read a chunk from the cache into the provided buffer.
   * SYNCHRONOUS - safe to call from WASM.
   *
   * @returns true if chunk was found and read, false if not cached
   */
  readChunk(chunkId: number, buffer: Uint8Array): boolean {
    if (!this.hasChunk(chunkId) || !this.#dataHandle) {
      return false;
    }

    const offset = chunkId * CHUNK_SIZE;
    const bytesRead = this.#dataHandle.read(buffer, { at: offset });

    return bytesRead === buffer.length;
  }

  /**
   * Write a chunk to the cache.
   * SYNCHRONOUS - safe to call from WASM.
   */
  writeChunk(chunkId: number, data: Uint8Array): void {
    if (!this.#dataHandle || !this.#bitmapHandle || !this.#bitmap) {
      return;
    }

    if (chunkId >= this.#totalChunks) {
      logger.warn(`[OPFSCache] Chunk ${chunkId} out of range`);
      return;
    }

    // Write chunk data
    const offset = chunkId * CHUNK_SIZE;
    this.#dataHandle.write(data, { at: offset });

    // Mark as cached in bitmap
    const byteIndex = Math.floor(chunkId / 8);
    const bitIndex = chunkId % 8;
    this.#bitmap[byteIndex] |= 1 << bitIndex;

    // Persist bitmap (write just the affected byte for efficiency)
    this.#bitmapHandle.write(this.#bitmap.subarray(byteIndex, byteIndex + 1), {
      at: byteIndex,
    });

    // Flush to ensure durability
    this.#dataHandle.flush();
    this.#bitmapHandle.flush();
  }

  /**
   * Clear a specific chunk from the cache.
   * SYNCHRONOUS.
   */
  clearChunk(chunkId: number): void {
    if (!this.#bitmapHandle || !this.#bitmap) return;

    const byteIndex = Math.floor(chunkId / 8);
    const bitIndex = chunkId % 8;
    this.#bitmap[byteIndex] &= ~(1 << bitIndex);

    this.#bitmapHandle.write(this.#bitmap.subarray(byteIndex, byteIndex + 1), {
      at: byteIndex,
    });
    this.#bitmapHandle.flush();
  }

  /**
   * Clear the entire cache.
   */
  clearAll(): void {
    if (!this.#bitmapHandle || !this.#bitmap) return;

    this.#bitmap.fill(0);
    this.#bitmapHandle.write(this.#bitmap, { at: 0 });
    this.#bitmapHandle.flush();

    logger.log('[OPFSCache] Cache cleared');
  }

  /**
   * Get cache statistics.
   */
  getStats(): { cachedChunks: number; totalChunks: number; hitRate: number } {
    const cachedChunks = this.#countCachedChunks();
    return {
      cachedChunks,
      totalChunks: this.#totalChunks,
      hitRate: this.#totalChunks > 0 ? cachedChunks / this.#totalChunks : 0,
    };
  }

  /**
   * Close file handles. Call when done with the cache.
   */
  close(): void {
    this.#dataHandle?.close();
    this.#bitmapHandle?.close();
    this.#dataHandle = null;
    this.#bitmapHandle = null;
    logger.log(`[OPFSCache] Closed cache for ${this.#diskName}`);
  }

  /**
   * Load bitmap from OPFS or initialize if new.
   */
  #loadBitmap(): void {
    if (!this.#bitmapHandle) return;

    const bitmapSize = Math.ceil(this.#totalChunks / 8);
    this.#bitmap = new Uint8Array(bitmapSize);

    const fileSize = this.#bitmapHandle.getSize();

    if (fileSize >= bitmapSize) {
      // Load existing bitmap
      this.#bitmapHandle.read(this.#bitmap, { at: 0 });
    } else {
      // Initialize new bitmap (all zeros = nothing cached)
      this.#bitmap.fill(0);
      this.#bitmapHandle.write(this.#bitmap, { at: 0 });
      this.#bitmapHandle.flush();
    }
  }

  /**
   * Count how many chunks are currently cached.
   */
  #countCachedChunks(): number {
    if (!this.#bitmap) return 0;

    let count = 0;
    for (let i = 0; i < this.#bitmap.length; i++) {
      // Count set bits (Brian Kernighan's algorithm)
      let byte = this.#bitmap[i];
      while (byte) {
        count++;
        byte &= byte - 1;
      }
    }
    return count;
  }
}

/**
 * Sanitize disk name for use as directory name.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Delete all cached data for a disk.
 */
export async function clearDiskCache(diskName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const cacheDir = await root.getDirectoryHandle('disk-cache');
    await cacheDir.removeEntry(sanitizeName(diskName), { recursive: true });
    logger.log(`[OPFSCache] Deleted cache for ${diskName}`);
  } catch (e) {
    // Directory might not exist
    logger.log(`[OPFSCache] No cache to delete for ${diskName}`);
  }
}

/**
 * Delete all cached disk data.
 */
export async function clearAllDiskCache(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('disk-cache', { recursive: true });
    logger.log('[OPFSCache] Deleted all disk cache');
  } catch (e) {
    // Directory might not exist
    logger.log('[OPFSCache] No disk cache to delete');
  }
}

/**
 * Get storage usage info.
 */
export async function getCacheStorageInfo(): Promise<{
  used: number;
  quota: number;
}> {
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return {
      used: estimate.usage || 0,
      quota: estimate.quota || 0,
    };
  }
  return { used: 0, quota: 0 };
}

/**
 * Clean up old session cache directories.
 * Should be called on app startup to prevent unbounded cache growth.
 *
 * NOTE: This uses async file API (not sync handles) so it's safe to call from main thread.
 * Removes all sessions except the current one (we can't reliably get creation time via OPFS).
 *
 * @param currentSessionId - The current session ID to preserve
 */
export async function cleanupOldSessionCaches(currentSessionId: string): Promise<void> {
  if (!navigator.storage?.getDirectory) {
    return; // OPFS not available
  }

  try {
    const root = await navigator.storage.getDirectory();
    let cacheDir: FileSystemDirectoryHandle;

    try {
      cacheDir = await root.getDirectoryHandle('disk-cache');
    } catch {
      // Cache directory doesn't exist yet
      return;
    }

    let totalCleaned = 0;

    // Iterate through disk directories
    // Cast to get entries() - exists at runtime but not always in TS types
    const cacheDirEntries = (cacheDir as unknown as { entries(): DirectoryEntries }).entries();
    for await (const [diskName, diskHandle] of cacheDirEntries) {
      if (diskHandle.kind !== 'directory') continue;

      const diskDir = diskHandle as FileSystemDirectoryHandle;

      // Iterate through session directories within each disk
      const sessionsToRemove: string[] = [];

      const diskDirEntries = (diskDir as unknown as { entries(): DirectoryEntries }).entries();
      for await (const [sessionName, sessionHandle] of diskDirEntries) {
        if (sessionHandle.kind !== 'directory') continue;

        // Keep current session
        if (sessionName === sanitizeName(currentSessionId)) {
          continue;
        }

        // Remove all other sessions (from crashed tabs or previous page loads)
        sessionsToRemove.push(sessionName);
      }

      // Remove old session directories
      for (const sessionName of sessionsToRemove) {
        try {
          await diskDir.removeEntry(sessionName, { recursive: true });
          totalCleaned++;
          logger.log(`[OPFSCache] Cleaned up old session cache: ${diskName}/${sessionName}`);
        } catch (e) {
          // May fail if handles are still open (unlikely for old sessions)
          logger.warn(`[OPFSCache] Failed to clean session ${diskName}/${sessionName}:`, e);
        }
      }

      // If disk directory is now empty, remove it too
      try {
        let hasEntries = false;
        const checkEntries = (diskDir as unknown as { entries(): DirectoryEntries }).entries();
        for await (const _ of checkEntries) {
          hasEntries = true;
          break;
        }
        if (!hasEntries) {
          await cacheDir.removeEntry(diskName, { recursive: true });
          logger.log(`[OPFSCache] Removed empty disk cache directory: ${diskName}`);
        }
      } catch {
        // Ignore errors checking/removing empty directories
      }
    }

    if (totalCleaned > 0) {
      logger.log(`[OPFSCache] Cleaned up ${totalCleaned} old session caches`);
    }
  } catch (e) {
    logger.warn('[OPFSCache] Error during session cache cleanup:', e);
  }
}
