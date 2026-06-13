/**
 * Disk storage mode types and interfaces
 */

/**
 * Storage mode for disk access
 * - disk-server: Direct I/O to relay, per-user overlays on server
 * - client-cached: Fetch from relay, cache locally in OPFS
 */
export type DiskStorageMode = 'disk-server' | 'client-cached';

/**
 * Disk metadata returned from relay /disk/list endpoint
 */
export interface DiskInfo {
  name: string;
  size: number;
  modTime: number; // Unix timestamp in milliseconds
}

/**
 * Configuration for disk creation
 */
export interface DiskConfig {
  name: string;
  relayUrl: string;
  userId: string;
  mode: DiskStorageMode;
  /** Optional session ID for cache invalidation across page loads */
  sessionId?: string;
  /** Optional tab ID for disk locking (persistent across page refreshes) */
  tabId?: string;
  /**
   * Optional admin bearer token (Dialtone JWT). When present, it is sent with
   * write/lock/create requests so the relay authorizes writes to the shared
   * base image. Without it the relay rejects writes (read-only session).
   */
  adminToken?: string;
}

/**
 * Core disk interface - both implementations must satisfy this
 */
export interface Disk {
  readonly name: string;
  readonly size: number;
  readonly mode: DiskStorageMode;

  /**
   * Read data from disk (synchronous for WASM compatibility)
   * @returns Number of bytes actually read
   */
  read(buffer: Uint8Array, offset: number, length: number): number;

  /**
   * Write data to disk (synchronous for WASM compatibility)
   * @returns Number of bytes actually written
   */
  write(buffer: Uint8Array, offset: number, length: number): number;

  /**
   * Clean up resources (file handles, caches, etc.)
   */
  dispose(): void;
}
