/**
 * DiskLockManager - Client-side disk locking for multi-tab support
 *
 * Manages exclusive access to disks in disk-server mode, ensuring only one
 * tab can write to a disk at a time. Uses heartbeats to maintain locks and
 * detects when locks are taken over by other tabs.
 *
 * Tab ID: Stored in sessionStorage (survives page refresh but unique per tab)
 * Session ID: From StorageManager (unique per page load)
 */

import { logger } from '../logger';

// Lock endpoint paths
const LOCK_PATH = '/disk/lock';
const UNLOCK_PATH = '/disk/unlock';
const HEARTBEAT_PATH = '/disk/heartbeat';
const STATUS_PATH = '/disk/lock/status';
const TAKEOVER_PATH = '/disk/lock/takeover';

// Heartbeat interval (should be < server's LockExpiryTime)
const HEARTBEAT_INTERVAL_MS = 5000;

// Session storage key for tab ID
const TAB_ID_KEY = 'dialtone-tab-id';

// Worker-local tab ID (used when sessionStorage is not available)
let workerLocalTabId: string | null = null;

/**
 * Check if sessionStorage is available
 * Web Workers don't have access to sessionStorage
 * This also handles test environments that mock sessionStorage
 */
function isSessionStorageAvailable(): boolean {
  try {
    // Check if sessionStorage exists and has the expected methods
    return typeof sessionStorage !== 'undefined' && typeof sessionStorage.getItem === 'function';
  } catch {
    // In some contexts, just accessing sessionStorage can throw
    return false;
  }
}

/**
 * Check if window event listeners are available (not in workers)
 */
function isWindowAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.addEventListener === 'function';
}

/**
 * Information about a disk lock holder
 */
export interface DiskLockInfo {
  diskName: string;
  tabId: string;
  sessionId: string;
  acquiredAt: string; // ISO timestamp
  lastHeartbeat: string; // ISO timestamp
  userAgent: string;
}

/**
 * Error thrown when lock acquisition fails due to conflict
 */
export class LockConflictError extends Error {
  holder: DiskLockInfo;

  constructor(diskName: string, holder: DiskLockInfo) {
    super(`Disk "${diskName}" is locked by another tab`);
    this.name = 'LockConflictError';
    this.holder = holder;
  }
}

interface HeldLock {
  diskName: string;
  heartbeatInterval: ReturnType<typeof setInterval>;
}

interface DiskLockManagerOptions {
  relayUrl: string;
  sessionId: string;
  onLockLost?: (diskName: string) => void;
  /** Optional tab ID from main thread (preferred over auto-generated) */
  tabId?: string;
}

/**
 * Get or create a persistent tab ID
 * Uses sessionStorage which survives page refresh but is unique per tab
 * In Web Worker context, uses a worker-local UUID (won't persist across restarts)
 */
function getTabId(): string {
  // Web Workers don't have sessionStorage - use worker-local ID
  if (!isSessionStorageAvailable()) {
    if (!workerLocalTabId) {
      workerLocalTabId = crypto.randomUUID();
      logger.log(`[DiskLockManager] Created worker-local tab ID: ${workerLocalTabId.slice(0, 8)}...`);
    }
    return workerLocalTabId;
  }

  let tabId = sessionStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, tabId);
    logger.log(`[DiskLockManager] Created new tab ID: ${tabId.slice(0, 8)}...`);
  }
  return tabId;
}

/**
 * Manages disk locks for multi-tab support in disk-server mode
 */
export class DiskLockManager {
  private relayUrl: string;
  private tabId: string;
  private sessionId: string;
  private heldLocks: Map<string, HeldLock> = new Map();
  private onLockLost: ((diskName: string) => void) | undefined;
  private unloadHandler: (() => void) | null = null;

  constructor(options: DiskLockManagerOptions) {
    this.relayUrl = options.relayUrl;
    this.sessionId = options.sessionId;
    // Prefer tab ID from main thread (passed via config), fall back to auto-generated
    this.tabId = options.tabId || getTabId();
    this.onLockLost = options.onLockLost;

    // Set up page unload handler to release locks (only in main thread, not workers)
    if (isWindowAvailable()) {
      this.unloadHandler = () => this.releaseAllLocks();
      window.addEventListener('beforeunload', this.unloadHandler);
    }

    logger.log(
      `[DiskLockManager] Initialized with tabId: ${this.tabId.slice(0, 8)}..., sessionId: ${this.sessionId.slice(0, 8)}...`
    );
  }

  /**
   * Acquire a lock on a disk
   * Throws LockConflictError if another tab holds the lock
   */
  async acquireLock(diskName: string): Promise<DiskLockInfo> {
    const url = new URL(LOCK_PATH, this.relayUrl);
    url.searchParams.set('name', diskName);
    url.searchParams.set('tabId', this.tabId);
    url.searchParams.set('sessionId', this.sessionId);

    logger.log(`[DiskLockManager] Acquiring lock: ${url.toString()}`);
    const resp = await fetch(url.toString(), { method: 'POST' });
    logger.log(`[DiskLockManager] Lock response: ${resp.status}`);

    if (resp.status === 409) {
      // Conflict - another tab holds the lock
      const data = await resp.json();
      throw new LockConflictError(diskName, data.holder);
    }

    if (!resp.ok) {
      throw new Error(`Failed to acquire lock: ${resp.status}`);
    }

    const lock: DiskLockInfo = await resp.json();

    // NOTE: We do NOT start heartbeat intervals here because the worker's event loop
    // is blocked by the emulator's main loop (setInterval callbacks never fire).
    // Instead, we track acquired locks and the main thread handles heartbeats.

    this.heldLocks.set(diskName, { diskName, heartbeatInterval: 0 as unknown as ReturnType<typeof setInterval> });

    logger.log(`[DiskLockManager] Acquired lock on ${diskName} (heartbeats handled by main thread)`);
    return lock;
  }

  /**
   * Release a lock on a disk
   */
  async releaseLock(diskName: string): Promise<void> {
    const held = this.heldLocks.get(diskName);
    if (!held) {
      logger.warn(`[DiskLockManager] Attempted to release non-held lock: ${diskName}`);
      return;
    }

    // Stop heartbeat
    clearInterval(held.heartbeatInterval);
    this.heldLocks.delete(diskName);

    // Send release to server
    const url = new URL(UNLOCK_PATH, this.relayUrl);
    url.searchParams.set('name', diskName);
    url.searchParams.set('tabId', this.tabId);

    try {
      await fetch(url.toString(), { method: 'POST' });
      logger.log(`[DiskLockManager] Released lock on ${diskName}`);
    } catch (e) {
      // Best effort - lock will expire eventually
      logger.warn(`[DiskLockManager] Failed to release lock on ${diskName}:`, e);
    }
  }

  /**
   * Check the lock status of a disk
   */
  async checkLockStatus(diskName: string): Promise<DiskLockInfo | null> {
    const url = new URL(STATUS_PATH, this.relayUrl);
    url.searchParams.set('name', diskName);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      throw new Error(`Failed to check lock status: ${resp.status}`);
    }

    const data = await resp.json();
    return data.locked ? data.holder : null;
  }

  /**
   * Force takeover of a lock from another tab
   */
  async takeoverLock(diskName: string): Promise<{ lock: DiskLockInfo; previous: DiskLockInfo | null }> {
    const url = new URL(TAKEOVER_PATH, this.relayUrl);
    url.searchParams.set('name', diskName);
    url.searchParams.set('tabId', this.tabId);
    url.searchParams.set('sessionId', this.sessionId);

    const resp = await fetch(url.toString(), { method: 'POST' });
    if (!resp.ok) {
      throw new Error(`Failed to takeover lock: ${resp.status}`);
    }

    const data = await resp.json();

    // Start heartbeat for this lock
    const heartbeatInterval = setInterval(
      () => this.sendHeartbeat(diskName),
      HEARTBEAT_INTERVAL_MS
    );

    this.heldLocks.set(diskName, { diskName, heartbeatInterval });

    logger.log(`[DiskLockManager] Took over lock on ${diskName}`);
    return { lock: data.lock, previous: data.previous };
  }

  /**
   * Check if we currently hold a lock on a disk
   */
  holdsLock(diskName: string): boolean {
    return this.heldLocks.has(diskName);
  }

  /**
   * Get list of all held locks
   */
  getHeldLocks(): string[] {
    return Array.from(this.heldLocks.keys());
  }

  /**
   * Release all held locks (called on page unload)
   */
  releaseAllLocks(): void {
    for (const [diskName, held] of this.heldLocks) {
      // Stop heartbeat
      clearInterval(held.heartbeatInterval);

      // Use sendBeacon for reliable delivery on page unload
      const url = new URL(UNLOCK_PATH, this.relayUrl);
      url.searchParams.set('name', diskName);
      url.searchParams.set('tabId', this.tabId);

      // sendBeacon is fire-and-forget but more reliable during unload
      // In worker context, sendBeacon may not be available - use fetch instead
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(url.toString());
      } else {
        // Fire-and-forget fetch for worker context
        fetch(url.toString(), { method: 'POST' }).catch(() => {});
      }
      logger.log(`[DiskLockManager] Released lock on ${diskName} (beforeunload)`);
    }

    this.heldLocks.clear();
  }

  /**
   * Get the relay URL (for main thread heartbeats)
   */
  getRelayUrl(): string {
    return this.relayUrl;
  }

  /**
   * Get the tab ID (for main thread heartbeats)
   */
  getTabId(): string {
    return this.tabId;
  }

  /**
   * Get names of all held disks (for main thread heartbeats)
   */
  getHeldDiskNames(): string[] {
    return Array.from(this.heldLocks.keys());
  }

  /**
   * Clean up resources (remove event listeners, stop heartbeats)
   */
  dispose(): void {
    // Release all locks
    this.releaseAllLocks();

    // Remove unload handler (only in main thread, not workers)
    if (this.unloadHandler && isWindowAvailable()) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }

    logger.log('[DiskLockManager] Disposed');
  }

  /**
   * Send heartbeat for a held lock
   * If heartbeat fails (410 Gone), the lock was taken over
   */
  private async sendHeartbeat(diskName: string): Promise<void> {
    const url = new URL(HEARTBEAT_PATH, this.relayUrl);
    url.searchParams.set('name', diskName);
    url.searchParams.set('tabId', this.tabId);

    try {
      logger.log(`[DiskLockManager] Sending heartbeat for ${diskName}...`);
      const resp = await fetch(url.toString(), { method: 'POST' });

      if (resp.status === 410) {
        // Lock was taken over by another tab
        logger.warn(`[DiskLockManager] Lock on ${diskName} was taken over by another tab`);

        // Clean up local state
        const held = this.heldLocks.get(diskName);
        if (held) {
          clearInterval(held.heartbeatInterval);
          this.heldLocks.delete(diskName);
        }

        // Notify callback
        this.onLockLost?.(diskName);
        return;
      }

      if (!resp.ok) {
        logger.warn(`[DiskLockManager] Heartbeat failed for ${diskName}: ${resp.status}`);
      } else {
        // Log successful heartbeat occasionally (every 6th = ~30s)
        const held = this.heldLocks.get(diskName);
        if (held) {
          const count = ((held as unknown as { heartbeatCount?: number }).heartbeatCount || 0) + 1;
          (held as unknown as { heartbeatCount: number }).heartbeatCount = count;
          if (count % 6 === 1) {
            logger.log(`[DiskLockManager] Heartbeat OK for ${diskName} (count: ${count})`);
          }
        }
      }
    } catch (e) {
      // Network error - log but don't remove lock (might be temporary)
      logger.warn(`[DiskLockManager] Heartbeat error for ${diskName}:`, e);
    }
  }
}

// Singleton instance (created lazily when needed)
let lockManagerInstance: DiskLockManager | null = null;

/**
 * Get or create the global lock manager instance
 * @param tabId Optional tab ID from main thread (preferred over auto-generated)
 */
export function getLockManager(relayUrl: string, sessionId: string, tabId?: string, onLockLost?: (diskName: string) => void): DiskLockManager {
  if (!lockManagerInstance) {
    lockManagerInstance = new DiskLockManager({
      relayUrl,
      sessionId,
      tabId,
      onLockLost,
    });
  }
  return lockManagerInstance;
}

/**
 * Get the existing lock manager instance (if any)
 */
export function getExistingLockManager(): DiskLockManager | null {
  return lockManagerInstance;
}

/**
 * Get info needed for main thread to send heartbeats
 */
export function getHeartbeatInfo(): { relayUrl: string; tabId: string; diskNames: string[] } | null {
  if (!lockManagerInstance) return null;
  return {
    relayUrl: lockManagerInstance.getRelayUrl(),
    tabId: lockManagerInstance.getTabId(),
    diskNames: lockManagerInstance.getHeldDiskNames(),
  };
}

/**
 * Dispose of the global lock manager instance
 */
export function disposeLockManager(): void {
  if (lockManagerInstance) {
    lockManagerInstance.dispose();
    lockManagerInstance = null;
  }
}
