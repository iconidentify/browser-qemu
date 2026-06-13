/**
 * CachedRelayDisk - Fetch from relay, cache locally in OPFS
 *
 * Hybrid approach combining the best of both modes:
 * - Fetches disk data from the Go relay server
 * - Caches chunks locally in OPFS for fast repeat access
 * - Works offline once cached (reads only)
 *
 * Cache hierarchy (fastest to slowest):
 * 1. In-memory LRU cache (32MB, instant)
 * 2. OPFS persistent cache (up to 16GB, sync access, survives reload)
 * 3. Sync XHR to relay (when chunk not cached)
 *
 * Benefits:
 * - Fast startup - emulator starts immediately
 * - Low memory usage (~32MB with LRU + OPFS backing)
 * - Persistent cache survives page reload
 * - Can work offline once disk is cached
 */

import { OPFSCache } from './OPFSCache';
import { logger } from '../logger';
import type { Disk, DiskStorageMode } from './types';

const CHUNK_SIZE = 128 * 1024; // 128KB chunks
const OPFS_INIT_TIMEOUT_MS = 2000; // Max wait for OPFS initialization

export class CachedRelayDisk implements Disk {
  readonly name: string;
  readonly size: number;
  readonly mode: DiskStorageMode = 'client-cached';

  #relayUrl: string;
  #userId: string;
  #loadedChunks: Map<number, Uint8Array> = new Map();
  #accessOrder: number[] = []; // For LRU eviction
  #opfsCache: OPFSCache | null = null;
  #writeOverlay: Map<number, Uint8Array> = new Map(); // Local write overlay
  #disposed = false; // Track if dispose() was called (for OPFS init race)
  #isReady = false; // Track if OPFS initialization is complete

  // Max chunks to keep in memory (256 * 128KB = 32MB)
  static MAX_LOADED_CHUNKS = 256;

  private constructor(
    name: string,
    size: number,
    relayUrl: string,
    userId: string
  ) {
    this.name = name;
    this.size = size;
    this.#relayUrl = relayUrl;
    this.#userId = userId;
  }

  /**
   * Create a CachedRelayDisk by fetching disk info from the relay
   * @param sessionId - Optional session ID for cache invalidation
   */
  static async create(
    name: string,
    relayUrl: string,
    userId: string,
    sessionId?: string
  ): Promise<CachedRelayDisk> {
    // Get disk size from relay
    const resp = await fetch(
      `${relayUrl}/disk/info?name=${encodeURIComponent(name)}`
    );
    if (!resp.ok) {
      throw new Error(`Disk not found: ${name} (${resp.status})`);
    }
    const info = await resp.json();
    if (!info.size) {
      throw new Error(`Invalid disk info for ${name}: missing size`);
    }

    const disk = new CachedRelayDisk(name, info.size, relayUrl, userId);

    // Initialize OPFS cache with timeout - wait for it to complete
    // This prevents reads from happening before cache is ready
    try {
      // Generate fallback session ID if not provided (for backwards compatibility)
      const effectiveSessionId = sessionId || crypto.randomUUID();
      const opfsPromise = OPFSCache.create(name, info.size, effectiveSessionId);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), OPFS_INIT_TIMEOUT_MS)
      );

      const cache = await Promise.race([opfsPromise, timeoutPromise]);

      if (disk.#disposed) {
        // dispose() was called while init was pending - close immediately
        cache?.close();
        logger.log(`[CachedRelayDisk] OPFS cache closed (disposed during init): ${name}`);
      } else if (cache) {
        disk.#opfsCache = cache;
        const stats = cache.getStats();
        logger.log(
          `[CachedRelayDisk] OPFS cache enabled: ${stats.cachedChunks}/${stats.totalChunks} chunks cached`
        );
      } else {
        logger.warn(`[CachedRelayDisk] OPFS init timed out after ${OPFS_INIT_TIMEOUT_MS}ms for ${name}`);
      }
    } catch (e) {
      logger.warn(`[CachedRelayDisk] OPFS init failed for ${name}:`, e);
    }

    // Mark disk as ready after OPFS initialization attempt completes
    disk.#isReady = true;

    logger.log(
      `[CachedRelayDisk] Created disk: ${name}, size: ${info.size}, user: ${userId}`
    );
    return disk;
  }

  /**
   * Create from offline cache (when relay is unavailable)
   * Returns null if disk is not cached
   */
  static async createOffline(_name: string): Promise<CachedRelayDisk | null> {
    // Try to get disk info from OPFS metadata
    // For now, we need the size - could store it in OPFS metadata
    logger.warn(
      '[CachedRelayDisk] Offline mode not fully implemented yet'
    );
    return null;
  }

  /**
   * Read data from disk into the provided buffer
   */
  read(buffer: Uint8Array, offset: number, length: number): number {
    return this.#forEachChunkInRange(
      offset,
      length,
      (chunk, chunkOffset, len, bufOffset) => {
        buffer.set(chunk.subarray(chunkOffset, chunkOffset + len), bufOffset);
      }
    );
  }

  /**
   * Write data from the buffer to the disk (local overlay only)
   */
  write(buffer: Uint8Array, offset: number, length: number): number {
    return this.#forEachChunkInRange(
      offset,
      length,
      (chunk, chunkOffset, len, bufOffset) => {
        // Write to the chunk in memory
        chunk.set(buffer.subarray(bufOffset, bufOffset + len), chunkOffset);

        // Mark chunk as dirty in write overlay
        const chunkIndex = Math.floor(offset / CHUNK_SIZE);
        this.#writeOverlay.set(chunkIndex, chunk);

        // Also update OPFS cache with the modified chunk
        this.#opfsCache?.writeChunk(chunkIndex, chunk);
      }
    );
  }

  /**
   * Clean up resources
   * Sets disposed flag to handle race condition with OPFS init
   */
  dispose(): void {
    this.#disposed = true;
    this.#opfsCache?.close();
    this.#opfsCache = null;
    this.#loadedChunks.clear();
    this.#writeOverlay.clear();
    this.#accessOrder = [];
  }

  /**
   * Check if disk is fully initialized and ready for reads/writes.
   */
  isReady(): boolean {
    return this.#isReady;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    memoryChunks: number;
    opfsChunks: number;
    totalChunks: number;
  } {
    const opfsStats = this.#opfsCache?.getStats();
    return {
      memoryChunks: this.#loadedChunks.size,
      opfsChunks: opfsStats?.cachedChunks ?? 0,
      totalChunks: Math.ceil(this.size / CHUNK_SIZE),
    };
  }

  /**
   * Load a chunk using cache hierarchy:
   * 1. In-memory LRU cache (instant)
   * 2. OPFS persistent cache (sync, fast)
   * 3. Sync XHR to relay (slow, last resort)
   */
  #loadChunk(chunkIndex: number): Uint8Array {
    // 1. Check in-memory LRU cache
    let chunk = this.#loadedChunks.get(chunkIndex);
    if (chunk) {
      this.#updateAccessOrder(chunkIndex);
      return chunk;
    }

    // 2. Check OPFS persistent cache (SYNC - instant!)
    if (this.#opfsCache?.hasChunk(chunkIndex)) {
      chunk = new Uint8Array(CHUNK_SIZE);
      if (this.#opfsCache.readChunk(chunkIndex, chunk)) {
        // Promote to in-memory cache
        this.#loadedChunks.set(chunkIndex, chunk);
        this.#updateAccessOrder(chunkIndex);
        this.#evictIfNeeded();
        return chunk;
      }
    }

    // 3. Not in any cache - fetch from relay
    const start = chunkIndex * CHUNK_SIZE;
    const length = Math.min(CHUNK_SIZE, this.size - start);

    chunk = this.#loadChunkFromRelay(start, length);

    // Pad to full chunk size if at end of file
    if (chunk.length < CHUNK_SIZE) {
      const padded = new Uint8Array(CHUNK_SIZE);
      padded.set(chunk);
      chunk = padded;
    }

    // 4. Store in OPFS cache for next time (persistent)
    this.#opfsCache?.writeChunk(chunkIndex, chunk);

    // 5. Store in memory cache and update LRU
    this.#loadedChunks.set(chunkIndex, chunk);
    this.#updateAccessOrder(chunkIndex);
    this.#evictIfNeeded();

    return chunk;
  }

  /**
   * Load chunk via sync XHR to relay
   */
  #loadChunkFromRelay(offset: number, length: number): Uint8Array {
    const xhr = new XMLHttpRequest();
    const url = `${this.#relayUrl}/disk/read?name=${encodeURIComponent(this.name)}&offset=${offset}&length=${length}`;

    try {
      xhr.open('GET', url, false); // Synchronous for WASM compatibility
    } catch (e) {
      logger.error(
        `[CachedRelayDisk] Sync XHR open() failed - Safari may block this in workers over HTTPS:`,
        e
      );
      return new Uint8Array(length);
    }

    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('X-User-Id', this.#userId);

    try {
      xhr.send();
    } catch (e) {
      logger.error(
        `[CachedRelayDisk] Sync XHR send() failed at offset ${offset}:`,
        e
      );
      return new Uint8Array(length);
    }

    if (xhr.status === 200) {
      if (!xhr.response) {
        logger.error(
          `[CachedRelayDisk] Read returned null response at offset ${offset}`
        );
        return new Uint8Array(length);
      }
      return new Uint8Array(xhr.response as ArrayBuffer);
    }

    logger.error(
      `[CachedRelayDisk] Failed to load chunk at offset ${offset}: HTTP ${xhr.status}`
    );
    return new Uint8Array(length);
  }

  /**
   * Iterate over each chunk that intersects the given byte range
   */
  #forEachChunkInRange(
    offset: number,
    length: number,
    callback: (
      chunk: Uint8Array,
      chunkOffset: number,
      len: number,
      bufOffset: number
    ) => void
  ): number {
    const end = Math.min(offset + length, this.size);
    let bytesProcessed = 0;
    let currentOffset = offset;

    while (currentOffset < end) {
      const chunkIndex = Math.floor(currentOffset / CHUNK_SIZE);
      const chunkStart = chunkIndex * CHUNK_SIZE;
      const offsetInChunk = currentOffset - chunkStart;
      const bytesInChunk = Math.min(
        CHUNK_SIZE - offsetInChunk,
        end - currentOffset
      );

      const chunk = this.#loadChunk(chunkIndex);
      callback(chunk, offsetInChunk, bytesInChunk, bytesProcessed);

      bytesProcessed += bytesInChunk;
      currentOffset += bytesInChunk;
    }

    return bytesProcessed;
  }

  /**
   * Update access order for LRU eviction
   */
  #updateAccessOrder(chunkIndex: number): void {
    const idx = this.#accessOrder.indexOf(chunkIndex);
    if (idx !== -1) {
      this.#accessOrder.splice(idx, 1);
    }
    this.#accessOrder.push(chunkIndex);
  }

  /**
   * Evict oldest chunks if over memory limit
   */
  #evictIfNeeded(): void {
    while (
      this.#loadedChunks.size > CachedRelayDisk.MAX_LOADED_CHUNKS &&
      this.#accessOrder.length > 0
    ) {
      const oldest = this.#accessOrder.shift();
      if (oldest !== undefined && !this.#writeOverlay.has(oldest)) {
        // Don't evict dirty chunks
        this.#loadedChunks.delete(oldest);
      }
    }
  }
}
