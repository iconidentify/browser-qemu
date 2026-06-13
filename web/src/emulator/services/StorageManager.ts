/**
 * StorageManager - Centralized storage orchestration with session awareness
 *
 * Handles fresh start detection, OPFS cache clearing, and persistence mode.
 * By default, clears all ephemeral storage (OPFS cache) on every page load
 * unless user has explicitly enabled persistent mode.
 */

import { logger } from '../logger';
import { clearAllDiskCache, getCacheStorageInfo, cleanupOldSessionCaches } from '../disk/OPFSCache';

// Storage keys
const PERSISTENCE_MODE_KEY = 'dialtone-persistence-mode';
const SETTINGS_KEY = 'dialtone-disk-settings-v2';
const THEME_KEY = 'dialtone-theme';
const MODE_OVERRIDE_KEY = 'emulator-mode-override';
const TAB_ID_KEY = 'dialtone-tab-id';

export type PersistenceMode = 'ephemeral' | 'persistent';

export interface StorageInfo {
  opfsCacheUsed: number;
  opfsCacheQuota: number;
  localStorageKeys: string[];
}

class StorageManagerClass {
  private sessionId: string;
  private shouldClearCache: boolean;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    // Generate unique session ID for this page load
    this.sessionId = crypto.randomUUID();

    // Check persistence mode - default is ephemeral (clear on every reload)
    const persistenceMode = this.getPersistenceMode();
    this.shouldClearCache = persistenceMode !== 'persistent';

    logger.log(
      `[StorageManager] Session: ${this.sessionId.slice(0, 8)}...`,
      `persistence: ${persistenceMode}`,
      `shouldClear: ${this.shouldClearCache}`
    );
  }

  /**
   * Initialize storage for this session.
   * MUST be called before rendering the emulator.
   * Clears ephemeral storage if in ephemeral mode (default).
   */
  async initializeForSession(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      if (this.shouldClearCache) {
        logger.log('[StorageManager] Clearing ephemeral storage for fresh start...');
        await this.clearEphemeralStorage();
        logger.log('[StorageManager] Ephemeral storage cleared');
      } else {
        // Persistent mode - clean up old sessions from other tabs/crashed workers
        // but preserve current session's cache for faster startup
        logger.log('[StorageManager] Persistent mode - cleaning up old sessions...');
        try {
          await cleanupOldSessionCaches(this.sessionId);
        } catch (err) {
          logger.warn('[StorageManager] Failed to cleanup old sessions:', err);
        }
        logger.log('[StorageManager] Persistent mode - preserving cache');
      }

      // Clear any stale global references from previous session
      this.clearGlobalReferences();

      this.initialized = true;
    } catch (err) {
      logger.error('[StorageManager] Initialization error:', err);
      // Still mark as initialized so app can proceed
      this.initialized = true;
      throw err;
    }
  }

  /**
   * Clear ephemeral storage (OPFS cache, global refs).
   * Does NOT clear user settings (localStorage).
   */
  async clearEphemeralStorage(): Promise<void> {
    try {
      // Clear OPFS disk cache
      await clearAllDiskCache();
    } catch (err) {
      logger.warn('[StorageManager] Failed to clear OPFS cache:', err);
      // Continue - OPFS may not be available in all browsers
    }

    // Clear global module references that may persist
    this.clearGlobalReferences();
  }

  /**
   * Clear ALL storage including user settings.
   * Use for "Reset Everything" functionality.
   */
  async clearAllStorage(): Promise<void> {
    // Clear ephemeral storage first
    await this.clearEphemeralStorage();

    // Clear localStorage settings
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(MODE_OVERRIDE_KEY);
    localStorage.removeItem(PERSISTENCE_MODE_KEY);

    // Clear IndexedDB persisted disks
    try {
      const { DiskPersistence } = await import('./DiskPersistence');
      const persistence = new DiskPersistence();
      await persistence.init();
      const disks = await persistence.listDisks();
      for (const disk of disks) {
        await persistence.deleteDisk(disk.diskId);
      }
      logger.log(`[StorageManager] Cleared ${disks.length} persisted disks from IndexedDB`);
    } catch (err) {
      logger.warn('[StorageManager] Failed to clear IndexedDB:', err);
    }
  }

  /**
   * Clear global JavaScript references that may persist across workers/reloads.
   */
  private clearGlobalReferences(): void {
    // Clear WASM module references
    if (typeof globalThis !== 'undefined') {
      delete (globalThis as any).__BASILISK_MODULE__;
      delete (globalThis as any).__WORKER_ID__;
      delete (globalThis as any).workerApi;
    }
  }

  /**
   * Get the current session ID.
   * Each page load gets a unique ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get or create a persistent tab ID.
   * Uses sessionStorage which survives page refresh but is unique per tab.
   * This is used for disk locking to identify this tab across page refreshes.
   */
  getTabId(): string {
    let tabId = sessionStorage.getItem(TAB_ID_KEY);
    if (!tabId) {
      tabId = crypto.randomUUID();
      sessionStorage.setItem(TAB_ID_KEY, tabId);
      logger.log(`[StorageManager] Created new tab ID: ${tabId.slice(0, 8)}...`);
    }
    return tabId;
  }

  /**
   * Check if storage has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get current persistence mode.
   */
  getPersistenceMode(): PersistenceMode {
    const stored = localStorage.getItem(PERSISTENCE_MODE_KEY);
    return stored === 'persistent' ? 'persistent' : 'ephemeral';
  }

  /**
   * Set persistence mode.
   * Changes take effect on next page load.
   */
  setPersistenceMode(mode: PersistenceMode): void {
    if (mode === 'persistent') {
      localStorage.setItem(PERSISTENCE_MODE_KEY, 'persistent');
    } else {
      localStorage.removeItem(PERSISTENCE_MODE_KEY);
    }
    logger.log(`[StorageManager] Persistence mode set to: ${mode}`);
  }

  /**
   * Get storage usage information.
   */
  async getStorageInfo(): Promise<StorageInfo> {
    let opfsInfo = { used: 0, quota: 0 };
    try {
      opfsInfo = await getCacheStorageInfo();
    } catch {
      // OPFS not available
    }

    // Get localStorage keys related to our app
    const localStorageKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('dialtone')) {
        localStorageKeys.push(key);
      }
    }

    return {
      opfsCacheUsed: opfsInfo.used,
      opfsCacheQuota: opfsInfo.quota,
      localStorageKeys,
    };
  }

  /**
   * Check if we should clear cache on this session.
   * Returns true for ephemeral mode (default), false for persistent mode.
   */
  shouldClearOnLoad(): boolean {
    return this.shouldClearCache;
  }
}

// Singleton instance for app-wide access
export const storageManager = new StorageManagerClass();
