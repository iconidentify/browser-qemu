/**
 * DiskFactory - Creates disk instances based on storage mode
 *
 * Error handling:
 * - disk-server + relay unavailable: Throws error (cannot boot)
 * - disk-server + disk locked: Throws LockConflictError (another tab has access)
 * - client-cached + relay unavailable (first run): Throws error (cannot boot)
 * - client-cached + relay unavailable (cached): Uses offline cache
 */

import { SimpleDisk } from './SimpleDisk';
import type { Disk, DiskConfig, DiskInfo } from './types';
import { logger } from '../logger';
import { getLockManager, LockConflictError } from './DiskLockManager';

export { LockConflictError };

/**
 * Create a disk based on the storage mode configuration
 * For disk-server mode, acquires an exclusive lock first.
 * Throws LockConflictError if another tab holds the lock.
 */
export async function createDisk(config: DiskConfig): Promise<Disk> {
  if (config.mode === 'disk-server') {
    // Disk server mode - requires exclusive lock
    const lockManager = getLockManager(
      config.relayUrl,
      config.sessionId || 'unknown-session',
      config.tabId
    );

    // Acquire lock before creating disk
    // This will throw LockConflictError if another tab has the lock
    await lockManager.acquireLock(config.name);
    logger.log(`[DiskFactory] Acquired lock for ${config.name} in disk-server mode`);

    try {
      const disk = await SimpleDisk.create(config.name, config.relayUrl, config.userId, config.adminToken);

      // Wrap dispose to release lock when disk is disposed
      const originalDispose = disk.dispose.bind(disk);
      disk.dispose = async () => {
        await lockManager.releaseLock(config.name);
        logger.log(`[DiskFactory] Released lock for ${config.name}`);
        return originalDispose();
      };

      return disk;
    } catch (error) {
      // If disk creation fails, release the lock
      await lockManager.releaseLock(config.name);
      throw error;
    }
  } else {
    // Client-cached mode - try relay first, fall back to offline cache
    const { CachedRelayDisk } = await import('./CachedRelayDisk');

    try {
      return await CachedRelayDisk.create(
        config.name,
        config.relayUrl,
        config.userId,
        config.sessionId
      );
    } catch (error) {
      // Try offline cache fallback
      logger.warn(
        '[DiskFactory] Relay unavailable, attempting offline cache:',
        error
      );

      const offlineDisk = await CachedRelayDisk.createOffline(config.name);
      if (offlineDisk) {
        logger.log(
          '[DiskFactory] Using offline cache - writes will be local only'
        );
        return offlineDisk;
      }

      // No cache available - re-throw original error
      throw error;
    }
  }
}

/**
 * Disk list response from relay server
 */
export interface DiskListResponse {
  bootable: DiskInfo[];
  data: DiskInfo[];
}

/**
 * Fetch available disks from relay server
 * Returns bootable and data disks separately
 */
export async function fetchDiskList(relayUrl: string): Promise<DiskListResponse> {
  const resp = await fetch(`${relayUrl}/disk/list`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch disk list: ${resp.status} ${resp.statusText}`);
  }
  const result = await resp.json();
  // Ensure arrays are never undefined
  return {
    bootable: result.bootable || [],
    data: result.data || [],
  };
}

/**
 * Create a new empty disk image on the relay server
 * Only available in local mode
 */
export async function createDiskImage(
  relayUrl: string,
  name: string,
  sizeBytes: number
): Promise<DiskInfo> {
  const resp = await fetch(
    `${relayUrl}/disk/create?name=${encodeURIComponent(name)}&size=${sizeBytes}`,
    { method: 'POST' }
  );
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(errorText || `Failed to create disk: ${resp.status}`);
  }
  return resp.json();
}
