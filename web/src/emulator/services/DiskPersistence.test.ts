/**
 * Tests for DiskPersistence
 *
 * Uses fake-indexeddb to provide a real IndexedDB implementation in Node.js.
 * Tests verify disk storage, retrieval, listing, and deletion operations.
 *
 * Note: All tests share the same IndexedDB database, so each test uses
 * unique disk IDs to avoid conflicts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiskPersistence } from './DiskPersistence';

// Counter to generate unique disk IDs per test to avoid conflicts
let testCounter = 0;

function uniqueId(prefix: string): string {
  return `${prefix}-${testCounter++}-${Date.now()}`;
}

describe('DiskPersistence', () => {
  let persistence: DiskPersistence;

  beforeEach(() => {
    persistence = new DiskPersistence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('init', () => {
    it('should initialize the database', async () => {
      await persistence.init();
      // If init succeeds without throwing, the database is ready
      expect(true).toBe(true);
    });

    it('should only initialize once per instance', async () => {
      // First init opens the database
      await persistence.init();

      // Create a spy after first init
      const openSpy = vi.spyOn(indexedDB, 'open');

      // Subsequent inits should not open again
      await persistence.init();
      await persistence.init();

      expect(openSpy).not.toHaveBeenCalled();
    });
  });

  describe('saveDisk', () => {
    it('should save a disk to IndexedDB', async () => {
      const diskId = uniqueId('save');
      const testData = new Uint8Array([1, 2, 3, 4, 5]);

      await persistence.saveDisk({
        diskId,
        name: 'Test Disk',
        data: testData,
      });

      const loaded = await persistence.loadDisk(diskId);
      expect(loaded).toEqual(testData);
    });

    it('should store metadata alongside disk data', async () => {
      const diskId = uniqueId('meta');
      const testData = new Uint8Array([1, 2, 3, 4, 5]);

      await persistence.saveDisk({
        diskId,
        name: 'My Disk',
        data: testData,
      });

      const metadata = await persistence.getDiskMetadata(diskId);

      expect(metadata).not.toBeNull();
      expect(metadata?.diskId).toBe(diskId);
      expect(metadata?.name).toBe('My Disk');
      expect(metadata?.sizeBytes).toBe(5);
    });

    it('should set createdAt and modifiedAt timestamps', async () => {
      const diskId = uniqueId('timestamps');
      const before = Date.now();

      await persistence.saveDisk({
        diskId,
        name: 'Timestamped Disk',
        data: new Uint8Array([1, 2, 3]),
      });

      const after = Date.now();
      const metadata = await persistence.getDiskMetadata(diskId);

      expect(metadata?.createdAt).toBeGreaterThanOrEqual(before);
      expect(metadata?.createdAt).toBeLessThanOrEqual(after);
      expect(metadata?.modifiedAt).toBe(metadata?.createdAt);
    });

    it('should overwrite existing disk with same ID', async () => {
      const diskId = uniqueId('overwrite');

      await persistence.saveDisk({
        diskId,
        name: 'Original',
        data: new Uint8Array([1, 1, 1]),
      });

      await persistence.saveDisk({
        diskId,
        name: 'Updated',
        data: new Uint8Array([2, 2, 2, 2]),
      });

      const loaded = await persistence.loadDisk(diskId);
      expect(loaded).toEqual(new Uint8Array([2, 2, 2, 2]));

      const metadata = await persistence.getDiskMetadata(diskId);
      expect(metadata?.name).toBe('Updated');
      expect(metadata?.sizeBytes).toBe(4);
    });

    it('should handle large disk data', async () => {
      const diskId = uniqueId('large');
      // Create 1MB of test data
      const largeData = new Uint8Array(1024 * 1024);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      await persistence.saveDisk({
        diskId,
        name: 'Large Disk',
        data: largeData,
      });

      const loaded = await persistence.loadDisk(diskId);
      expect(loaded?.length).toBe(largeData.length);
      expect(loaded?.[0]).toBe(0);
      expect(loaded?.[255]).toBe(255);
      expect(loaded?.[256]).toBe(0);
    });

    it('should handle empty disk data', async () => {
      const diskId = uniqueId('empty');

      await persistence.saveDisk({
        diskId,
        name: 'Empty',
        data: new Uint8Array(0),
      });

      const loaded = await persistence.loadDisk(diskId);
      expect(loaded?.length).toBe(0);

      const metadata = await persistence.getDiskMetadata(diskId);
      expect(metadata?.sizeBytes).toBe(0);
    });
  });

  describe('loadDisk', () => {
    it('should return null for non-existent disk', async () => {
      const loaded = await persistence.loadDisk(uniqueId('nonexistent'));
      expect(loaded).toBeNull();
    });

    it('should return Uint8Array with correct data', async () => {
      const diskId = uniqueId('loadtest');
      const testData = new Uint8Array([10, 20, 30, 40, 50]);

      await persistence.saveDisk({
        diskId,
        name: 'Load Test',
        data: testData,
      });

      const loaded = await persistence.loadDisk(diskId);

      expect(loaded).toBeInstanceOf(Uint8Array);
      expect(loaded).toEqual(testData);
    });
  });

  describe('listDisks', () => {
    it('should include saved disks', async () => {
      const diskId1 = uniqueId('list-a');
      const diskId2 = uniqueId('list-b');

      await persistence.saveDisk({
        diskId: diskId1,
        name: 'Disk A',
        data: new Uint8Array([1]),
      });

      await persistence.saveDisk({
        diskId: diskId2,
        name: 'Disk B',
        data: new Uint8Array([2, 3]),
      });

      const disks = await persistence.listDisks();
      const diskIds = disks.map((d) => d.diskId);

      expect(diskIds).toContain(diskId1);
      expect(diskIds).toContain(diskId2);
    });

    it('should sort by modifiedAt descending (most recent first)', async () => {
      const diskId1 = uniqueId('older');
      const diskId2 = uniqueId('newer');

      await persistence.saveDisk({
        diskId: diskId1,
        name: 'Older',
        data: new Uint8Array([1]),
      });

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await persistence.saveDisk({
        diskId: diskId2,
        name: 'Newer',
        data: new Uint8Array([2]),
      });

      const disks = await persistence.listDisks();

      // Find these two disks and check their order
      const idx1 = disks.findIndex((d) => d.diskId === diskId1);
      const idx2 = disks.findIndex((d) => d.diskId === diskId2);

      // Newer disk should come before older
      expect(idx2).toBeLessThan(idx1);
    });

    it('should not include disk data in listing', async () => {
      const diskId = uniqueId('nodata');

      await persistence.saveDisk({
        diskId,
        name: 'Data Test',
        data: new Uint8Array([1, 2, 3, 4, 5]),
      });

      const disks = await persistence.listDisks();
      const disk = disks.find((d) => d.diskId === diskId);

      expect(disk).not.toHaveProperty('data');
    });
  });

  describe('getDiskMetadata', () => {
    it('should return null for non-existent disk', async () => {
      const metadata = await persistence.getDiskMetadata(
        uniqueId('nonexistent')
      );
      expect(metadata).toBeNull();
    });

    it('should return metadata without disk data', async () => {
      const diskId = uniqueId('getmeta');

      await persistence.saveDisk({
        diskId,
        name: 'Metadata Test',
        data: new Uint8Array([1, 2, 3, 4, 5]),
      });

      const metadata = await persistence.getDiskMetadata(diskId);

      expect(metadata).not.toBeNull();
      expect(metadata?.diskId).toBe(diskId);
      expect(metadata?.name).toBe('Metadata Test');
      expect(metadata?.sizeBytes).toBe(5);
      expect(metadata).not.toHaveProperty('data');
    });
  });

  describe('deleteDisk', () => {
    it('should delete disk data and metadata', async () => {
      const diskId = uniqueId('delete');

      await persistence.saveDisk({
        diskId,
        name: 'Delete Test',
        data: new Uint8Array([1, 2, 3]),
      });

      await persistence.deleteDisk(diskId);

      const loaded = await persistence.loadDisk(diskId);
      const metadata = await persistence.getDiskMetadata(diskId);

      expect(loaded).toBeNull();
      expect(metadata).toBeNull();
    });

    it('should not throw when deleting non-existent disk', async () => {
      await expect(
        persistence.deleteDisk(uniqueId('nonexistent'))
      ).resolves.toBeUndefined();
    });

    it('should only delete specified disk', async () => {
      const keepId = uniqueId('keep');
      const deleteId = uniqueId('delete');

      await persistence.saveDisk({
        diskId: keepId,
        name: 'Keep',
        data: new Uint8Array([1]),
      });

      await persistence.saveDisk({
        diskId: deleteId,
        name: 'Delete',
        data: new Uint8Array([2]),
      });

      await persistence.deleteDisk(deleteId);

      const kept = await persistence.loadDisk(keepId);
      expect(kept).not.toBeNull();

      const deleted = await persistence.loadDisk(deleteId);
      expect(deleted).toBeNull();
    });
  });

  describe('updateModifiedTime', () => {
    it('should update modifiedAt timestamp', async () => {
      const diskId = uniqueId('update');

      await persistence.saveDisk({
        diskId,
        name: 'Update Test',
        data: new Uint8Array([1]),
      });

      const originalMeta = await persistence.getDiskMetadata(diskId);
      const originalModified = originalMeta?.modifiedAt;

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await persistence.updateModifiedTime(diskId);

      const updatedMeta = await persistence.getDiskMetadata(diskId);

      expect(updatedMeta?.modifiedAt).toBeGreaterThan(originalModified!);
    });

    it('should not throw for non-existent disk', async () => {
      await expect(
        persistence.updateModifiedTime(uniqueId('nonexistent'))
      ).resolves.toBeUndefined();
    });

    it('should preserve other metadata fields', async () => {
      const diskId = uniqueId('preserve');

      await persistence.saveDisk({
        diskId,
        name: 'Preserve Test',
        data: new Uint8Array([1, 2, 3]),
      });

      const before = await persistence.getDiskMetadata(diskId);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await persistence.updateModifiedTime(diskId);

      const after = await persistence.getDiskMetadata(diskId);

      expect(after?.diskId).toBe(before?.diskId);
      expect(after?.name).toBe(before?.name);
      expect(after?.sizeBytes).toBe(before?.sizeBytes);
      expect(after?.createdAt).toBe(before?.createdAt);
    });
  });

  describe('getStorageUsed', () => {
    it('should include size of saved disks', async () => {
      const diskId1 = uniqueId('storage1');
      const diskId2 = uniqueId('storage2');
      const diskId3 = uniqueId('storage3');

      const sizeBefore = await persistence.getStorageUsed();

      await persistence.saveDisk({
        diskId: diskId1,
        name: 'Disk 1',
        data: new Uint8Array(100),
      });

      await persistence.saveDisk({
        diskId: diskId2,
        name: 'Disk 2',
        data: new Uint8Array(250),
      });

      await persistence.saveDisk({
        diskId: diskId3,
        name: 'Disk 3',
        data: new Uint8Array(150),
      });

      const sizeAfter = await persistence.getStorageUsed();
      expect(sizeAfter - sizeBefore).toBe(500);
    });
  });

  describe('isAvailable', () => {
    it('should return true when indexedDB is available', () => {
      expect(DiskPersistence.isAvailable()).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should throw if database fails to initialize before save', async () => {
      const badPersistence = new DiskPersistence();
      Object.defineProperty(badPersistence, 'initPromise', {
        value: Promise.resolve(),
      });

      await expect(
        badPersistence.saveDisk({
          diskId: 'test',
          name: 'Test',
          data: new Uint8Array([1]),
        })
      ).rejects.toThrow('Database not initialized');
    });

    it('should throw if database fails to initialize before load', async () => {
      const badPersistence = new DiskPersistence();
      Object.defineProperty(badPersistence, 'initPromise', {
        value: Promise.resolve(),
      });

      await expect(badPersistence.loadDisk('test')).rejects.toThrow(
        'Database not initialized'
      );
    });

    it('should throw if database fails to initialize before list', async () => {
      const badPersistence = new DiskPersistence();
      Object.defineProperty(badPersistence, 'initPromise', {
        value: Promise.resolve(),
      });

      await expect(badPersistence.listDisks()).rejects.toThrow(
        'Database not initialized'
      );
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple concurrent saves', async () => {
      const prefix = uniqueId('concurrent');
      const saves = [];
      for (let i = 0; i < 5; i++) {
        saves.push(
          persistence.saveDisk({
            diskId: `${prefix}-${i}`,
            name: `Concurrent ${i}`,
            data: new Uint8Array([i]),
          })
        );
      }

      await Promise.all(saves);

      // Verify all were saved
      for (let i = 0; i < 5; i++) {
        const loaded = await persistence.loadDisk(`${prefix}-${i}`);
        expect(loaded).toEqual(new Uint8Array([i]));
      }
    });

    it('should handle concurrent init calls', async () => {
      const diskId = uniqueId('afterinit');

      const inits = [
        persistence.init(),
        persistence.init(),
        persistence.init(),
      ];

      await Promise.all(inits);

      await persistence.saveDisk({
        diskId,
        name: 'After Init',
        data: new Uint8Array([1]),
      });

      const loaded = await persistence.loadDisk(diskId);
      expect(loaded).toEqual(new Uint8Array([1]));
    });
  });
});
