/**
 * Tests for DiskController
 *
 * DiskController manages disk images in the emulator worker, handling:
 * - Mounting and ejecting disks
 * - Reading and writing disk data via WASM
 * - Tracking dirty state for persistence
 * - Notifying the main thread of disk state changes
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DiskController, DiskEntry } from './DiskController';

describe('DiskController', () => {
  let controller: DiskController;
  let notifySpy: ReturnType<typeof vi.fn>;
  let mockWasmModule: { HEAPU8: Uint8Array };

  beforeEach(() => {
    vi.useFakeTimers();
    notifySpy = vi.fn();
    controller = new DiskController(notifySpy);

    // Create a mock WASM module with 1MB of memory
    mockWasmModule = {
      HEAPU8: new Uint8Array(1024 * 1024),
    };
    controller.setWasmModule(mockWasmModule);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create with notify callback', () => {
      const notify = vi.fn();
      const ctrl = new DiskController(notify);
      expect(ctrl).toBeDefined();
    });
  });

  describe('addDisk', () => {
    it('should add a disk and notify', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      controller.addDisk('disk-1', 'Test Disk', data);

      expect(notifySpy).toHaveBeenCalledWith({
        type: 'disk_mounted',
        diskId: 'disk-1',
        name: 'Test Disk',
        sizeBytes: 5,
        isBootDisk: false,
      });
    });

    it('should add a boot disk', () => {
      const data = new Uint8Array(1024);

      controller.addDisk('boot', 'Boot Disk', data, true);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          isBootDisk: true,
        })
      );
    });

    it('should replace existing disk with same ID', () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6, 7, 8]);

      controller.addDisk('disk-1', 'Disk 1', data1);
      controller.addDisk('disk-1', 'Disk 1 Updated', data2);

      const disks = controller.getDisks();
      expect(disks.length).toBe(1);
      expect(disks[0].name).toBe('Disk 1 Updated');
      expect(disks[0].size).toBe(5);
    });

    it('should track disk in disk list', () => {
      const data = new Uint8Array(1024);

      controller.addDisk('disk-1', 'Test Disk', data);

      const disks = controller.getDisks();
      expect(disks.length).toBe(1);
      expect(disks[0].diskId).toBe('disk-1');
      expect(disks[0].name).toBe('Test Disk');
      expect(disks[0].size).toBe(1024);
    });
  });

  describe('createBlankDisk', () => {
    it('should create a blank disk and mark it dirty', () => {
      const template = new Uint8Array(1024);

      controller.createBlankDisk('new-disk', 'New Disk', template);

      expect(controller.isDiskDirty('new-disk')).toBe(true);
    });

    it('should notify about disk mount', () => {
      const template = new Uint8Array(1024);

      controller.createBlankDisk('new-disk', 'New Disk', template);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'disk_mounted',
          diskId: 'new-disk',
        })
      );
    });
  });

  describe('openDisk', () => {
    it('should return WASM ID for existing disk', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);

      const wasmId = controller.openDisk('Test Disk');

      expect(wasmId).toBeGreaterThan(0);
    });

    it('should return same WASM ID for already opened disk', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);

      const wasmId1 = controller.openDisk('Test Disk');
      const wasmId2 = controller.openDisk('Test Disk');

      expect(wasmId1).toBe(wasmId2);
    });

    it('should return -1 for non-existent disk', () => {
      const wasmId = controller.openDisk('Non Existent');

      expect(wasmId).toBe(-1);
    });

    it('should assign unique WASM IDs to different disks', () => {
      controller.addDisk('disk-1', 'Disk 1', new Uint8Array(1024));
      controller.addDisk('disk-2', 'Disk 2', new Uint8Array(1024));

      const id1 = controller.openDisk('Disk 1');
      const id2 = controller.openDisk('Disk 2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('readDisk', () => {
    it('should read data from disk into WASM memory', () => {
      const data = new Uint8Array([10, 20, 30, 40, 50]);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      const bufPtr = 0;
      const bytesRead = controller.readDisk(wasmId, bufPtr, 0, 5);

      expect(bytesRead).toBe(5);
      expect(mockWasmModule.HEAPU8[0]).toBe(10);
      expect(mockWasmModule.HEAPU8[1]).toBe(20);
      expect(mockWasmModule.HEAPU8[4]).toBe(50);
    });

    it('should read partial data with offset', () => {
      const data = new Uint8Array([10, 20, 30, 40, 50]);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      const bufPtr = 100;
      const bytesRead = controller.readDisk(wasmId, bufPtr, 2, 2);

      expect(bytesRead).toBe(2);
      expect(mockWasmModule.HEAPU8[100]).toBe(30);
      expect(mockWasmModule.HEAPU8[101]).toBe(40);
    });

    it('should limit read to available data', () => {
      const data = new Uint8Array([10, 20, 30]);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      const bytesRead = controller.readDisk(wasmId, 0, 0, 100);

      expect(bytesRead).toBe(3);
    });

    it('should return 0 for invalid WASM ID', () => {
      const bytesRead = controller.readDisk(999, 0, 0, 100);

      expect(bytesRead).toBe(0);
    });

    it('should return 0 when WASM module not set', () => {
      const ctrl = new DiskController(vi.fn());
      ctrl.addDisk('disk-1', 'Test', new Uint8Array(100));
      const wasmId = ctrl.openDisk('Test');

      const bytesRead = ctrl.readDisk(wasmId, 0, 0, 10);

      expect(bytesRead).toBe(0);
    });
  });

  describe('writeDisk', () => {
    it('should write data from WASM memory to disk', () => {
      const data = new Uint8Array(10);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      // Put data in WASM memory
      mockWasmModule.HEAPU8[0] = 100;
      mockWasmModule.HEAPU8[1] = 200;

      const bytesWritten = controller.writeDisk(wasmId, 0, 0, 2);

      expect(bytesWritten).toBe(2);
      expect(controller.getDiskData('disk-1')?.[0]).toBe(100);
      expect(controller.getDiskData('disk-1')?.[1]).toBe(200);
    });

    it('should mark disk as dirty after write', () => {
      const data = new Uint8Array(10);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      expect(controller.isDiskDirty('disk-1')).toBe(false);

      controller.writeDisk(wasmId, 0, 0, 2);

      expect(controller.isDiskDirty('disk-1')).toBe(true);
    });

    it('should send dirty notification after debounce', () => {
      const data = new Uint8Array(10);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      notifySpy.mockClear();
      controller.writeDisk(wasmId, 0, 0, 2);

      // No notification yet
      expect(
        notifySpy.mock.calls.filter((c) => c[0].type === 'disk_dirty')
      ).toHaveLength(0);

      // Advance timers
      vi.advanceTimersByTime(500);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'disk_dirty',
          diskId: 'disk-1',
          isDirty: true,
        })
      );
    });

    it('should not write to ejecting disk', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      // Simulate ejecting (by accessing the entry directly)
      const entry = controller.getDisk('disk-1');
      if (entry) entry.isEjecting = true;

      mockWasmModule.HEAPU8[0] = 100;
      const bytesWritten = controller.writeDisk(wasmId, 0, 0, 1);

      expect(bytesWritten).toBe(0);
      expect(controller.getDiskData('disk-1')?.[0]).toBe(1); // Original data
    });

    it('should return 0 for invalid WASM ID', () => {
      const bytesWritten = controller.writeDisk(999, 0, 0, 100);

      expect(bytesWritten).toBe(0);
    });
  });

  describe('getDiskSize', () => {
    it('should return disk size for valid WASM ID', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      const size = controller.getDiskSize(wasmId);

      expect(size).toBe(1024);
    });

    it('should return 0 for invalid WASM ID', () => {
      const size = controller.getDiskSize(999);

      expect(size).toBe(0);
    });
  });

  describe('ejectDisk', () => {
    it('should return disk data and remove disk', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      controller.addDisk('disk-1', 'Test Disk', data);

      const ejectedData = controller.ejectDisk('disk-1');

      expect(ejectedData).toEqual(data);
      expect(controller.getDisk('disk-1')).toBeUndefined();
    });

    it('should notify about disk ejection', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);

      notifySpy.mockClear();
      controller.ejectDisk('disk-1');

      expect(notifySpy).toHaveBeenCalledWith({
        type: 'disk_ejected',
        diskId: 'disk-1',
        name: 'Test Disk',
      });
    });

    it('should not allow ejecting boot disk', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('boot', 'Boot Disk', data, true);

      const ejectedData = controller.ejectDisk('boot');

      expect(ejectedData).toBeNull();
      expect(controller.getDisk('boot')).toBeDefined();
    });

    it('should return null for non-existent disk', () => {
      const ejectedData = controller.ejectDisk('non-existent');

      expect(ejectedData).toBeNull();
    });

    it('should clean up WASM ID mapping', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      controller.ejectDisk('disk-1');

      // WASM ID should no longer work
      expect(controller.getDiskSize(wasmId)).toBe(0);
    });
  });

  describe('getDiskData', () => {
    it('should return copy of disk data', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      controller.addDisk('disk-1', 'Test Disk', data);

      const retrieved = controller.getDiskData('disk-1');

      expect(retrieved).toEqual(data);
      // Should be a copy, not the same reference
      expect(retrieved).not.toBe(data);
    });

    it('should return null for non-existent disk', () => {
      const retrieved = controller.getDiskData('non-existent');

      expect(retrieved).toBeNull();
    });
  });

  describe('isDiskDirty', () => {
    it('should return false for clean disk', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);

      expect(controller.isDiskDirty('disk-1')).toBe(false);
    });

    it('should return true after write', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      controller.writeDisk(wasmId, 0, 0, 1);

      expect(controller.isDiskDirty('disk-1')).toBe(true);
    });

    it('should return false for non-existent disk', () => {
      expect(controller.isDiskDirty('non-existent')).toBe(false);
    });
  });

  describe('clearDirtyState', () => {
    it('should clear dirty state', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      controller.writeDisk(wasmId, 0, 0, 1);
      expect(controller.isDiskDirty('disk-1')).toBe(true);

      controller.clearDirtyState('disk-1');

      expect(controller.isDiskDirty('disk-1')).toBe(false);
    });

    it('should notify about dirty state change', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      controller.writeDisk(wasmId, 0, 0, 1);
      notifySpy.mockClear();

      controller.clearDirtyState('disk-1');

      expect(notifySpy).toHaveBeenCalledWith({
        type: 'disk_dirty',
        diskId: 'disk-1',
        isDirty: false,
      });
    });
  });

  describe('getDisks', () => {
    it('should return empty array when no disks', () => {
      const disks = controller.getDisks();

      expect(disks).toEqual([]);
    });

    it('should return info for all mounted disks', () => {
      controller.addDisk('disk-1', 'Disk 1', new Uint8Array(1024));
      controller.addDisk('disk-2', 'Disk 2', new Uint8Array(2048), true);

      const disks = controller.getDisks();

      expect(disks.length).toBe(2);
      expect(disks.find((d) => d.diskId === 'disk-1')).toEqual({
        diskId: 'disk-1',
        name: 'Disk 1',
        size: 1024,
        isDirty: false,
        isBootDisk: false,
      });
      expect(disks.find((d) => d.diskId === 'disk-2')).toEqual({
        diskId: 'disk-2',
        name: 'Disk 2',
        size: 2048,
        isDirty: false,
        isBootDisk: true,
      });
    });

    it('should reflect current dirty state', () => {
      controller.addDisk('disk-1', 'Disk 1', new Uint8Array(1024));
      const wasmId = controller.openDisk('Disk 1');

      expect(controller.getDisks()[0].isDirty).toBe(false);

      controller.writeDisk(wasmId, 0, 0, 1);

      expect(controller.getDisks()[0].isDirty).toBe(true);
    });
  });

  describe('getDisk', () => {
    it('should return disk entry', () => {
      const data = new Uint8Array([1, 2, 3]);
      controller.addDisk('disk-1', 'Test Disk', data);

      const entry = controller.getDisk('disk-1');

      expect(entry).toBeDefined();
      expect(entry?.diskId).toBe('disk-1');
      expect(entry?.name).toBe('Test Disk');
      expect(entry?.data).toEqual(data);
    });

    it('should return undefined for non-existent disk', () => {
      const entry = controller.getDisk('non-existent');

      expect(entry).toBeUndefined();
    });
  });

  describe('debounced dirty notification', () => {
    it('should debounce multiple writes', () => {
      const data = new Uint8Array(1024);
      controller.addDisk('disk-1', 'Test Disk', data);
      const wasmId = controller.openDisk('Test Disk');

      notifySpy.mockClear();

      // Multiple writes
      controller.writeDisk(wasmId, 0, 0, 1);
      controller.writeDisk(wasmId, 0, 1, 1);
      controller.writeDisk(wasmId, 0, 2, 1);

      // Should still be waiting
      expect(
        notifySpy.mock.calls.filter((c) => c[0].type === 'disk_dirty')
      ).toHaveLength(0);

      vi.advanceTimersByTime(500);

      // Should only have one notification
      expect(
        notifySpy.mock.calls.filter((c) => c[0].type === 'disk_dirty')
      ).toHaveLength(1);
    });
  });
});
