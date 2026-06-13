/**
 * Tests for DirtyBlockTracker
 *
 * DirtyBlockTracker uses a bitmap to efficiently track which 512-byte blocks
 * of a disk image have been modified. This enables differential saves.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DirtyBlockTracker } from './DirtyBlockTracker';

describe('DirtyBlockTracker', () => {
  const BLOCK_SIZE = 512;
  const DISK_SIZE = 1024 * 1024; // 1MB = 2048 blocks
  let tracker: DirtyBlockTracker;

  beforeEach(() => {
    tracker = new DirtyBlockTracker(DISK_SIZE);
  });

  describe('initial state', () => {
    it('should start with no dirty blocks', () => {
      expect(tracker.isDirty()).toBe(false);
    });

    it('should have zero dirty block count initially', () => {
      expect(tracker.getDirtyBlockCount()).toBe(0);
    });

    it('should have zero dirty bytes initially', () => {
      expect(tracker.getDirtyBytes()).toBe(0);
    });

    it('should return empty ranges initially', () => {
      expect(tracker.getDirtyRanges()).toEqual([]);
    });
  });

  describe('markDirty', () => {
    it('should mark a single block as dirty', () => {
      tracker.markDirty(0, 1);

      expect(tracker.isDirty()).toBe(true);
      expect(tracker.getDirtyBlockCount()).toBe(1);
    });

    it('should mark exactly one block for writes within a block', () => {
      tracker.markDirty(100, 50); // Write within first block

      expect(tracker.getDirtyBlockCount()).toBe(1);
      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE);
    });

    it('should mark two blocks for writes spanning a block boundary', () => {
      tracker.markDirty(500, 100); // Spans blocks 0 and 1

      expect(tracker.getDirtyBlockCount()).toBe(2);
      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE * 2);
    });

    it('should mark multiple blocks for large writes', () => {
      tracker.markDirty(0, 1536); // 3 blocks

      expect(tracker.getDirtyBlockCount()).toBe(3);
      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE * 3);
    });

    it('should not double-count already dirty blocks', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.markDirty(0, BLOCK_SIZE);

      expect(tracker.getDirtyBlockCount()).toBe(1);
    });

    it('should handle overlapping dirty regions correctly', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.markDirty(256, BLOCK_SIZE); // Overlaps first block, extends into second

      expect(tracker.getDirtyBlockCount()).toBe(2);
    });

    it('should handle writes at exact block boundaries', () => {
      tracker.markDirty(BLOCK_SIZE, BLOCK_SIZE); // Exactly block 1

      expect(tracker.getDirtyBlockCount()).toBe(1);
    });

    it('should handle writes at end of disk', () => {
      const lastBlockOffset = DISK_SIZE - BLOCK_SIZE;
      tracker.markDirty(lastBlockOffset, BLOCK_SIZE);

      expect(tracker.getDirtyBlockCount()).toBe(1);
    });

    it('should handle zero-length writes (no-op)', () => {
      tracker.markDirty(0, 0);

      expect(tracker.isDirty()).toBe(false);
      expect(tracker.getDirtyBlockCount()).toBe(0);
    });
  });

  describe('getDirtyRanges', () => {
    it('should return single range for contiguous dirty blocks', () => {
      tracker.markDirty(0, BLOCK_SIZE * 3);

      const ranges = tracker.getDirtyRanges();

      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual({
        startByte: 0,
        endByte: BLOCK_SIZE * 3,
      });
    });

    it('should return separate ranges for non-contiguous dirty blocks', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.markDirty(BLOCK_SIZE * 4, BLOCK_SIZE);

      const ranges = tracker.getDirtyRanges();

      expect(ranges).toHaveLength(2);
      expect(ranges[0]).toEqual({ startByte: 0, endByte: BLOCK_SIZE });
      expect(ranges[1]).toEqual({
        startByte: BLOCK_SIZE * 4,
        endByte: BLOCK_SIZE * 5,
      });
    });

    it('should merge adjacent dirty regions into single range', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.markDirty(BLOCK_SIZE, BLOCK_SIZE);
      tracker.markDirty(BLOCK_SIZE * 2, BLOCK_SIZE);

      const ranges = tracker.getDirtyRanges();

      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toEqual({
        startByte: 0,
        endByte: BLOCK_SIZE * 3,
      });
    });

    it('should handle dirty range at end of disk', () => {
      const lastBlockStart = DISK_SIZE - BLOCK_SIZE;
      tracker.markDirty(lastBlockStart, BLOCK_SIZE);

      const ranges = tracker.getDirtyRanges();

      expect(ranges).toHaveLength(1);
      expect(ranges[0].endByte).toBe(DISK_SIZE);
    });
  });

  describe('clear', () => {
    it('should reset to clean state', () => {
      tracker.markDirty(0, BLOCK_SIZE * 10);

      tracker.clear();

      expect(tracker.isDirty()).toBe(false);
      expect(tracker.getDirtyBlockCount()).toBe(0);
      expect(tracker.getDirtyRanges()).toEqual([]);
    });

    it('should allow new dirty marks after clear', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.clear();
      tracker.markDirty(BLOCK_SIZE * 5, BLOCK_SIZE);

      expect(tracker.getDirtyBlockCount()).toBe(1);
      const ranges = tracker.getDirtyRanges();
      expect(ranges[0].startByte).toBe(BLOCK_SIZE * 5);
    });
  });

  describe('getDirtyBytes', () => {
    it('should return correct byte count for single block', () => {
      tracker.markDirty(0, 100);

      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE);
    });

    it('should return correct byte count for multiple blocks', () => {
      tracker.markDirty(0, BLOCK_SIZE * 5);

      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE * 5);
    });

    it('should account for non-contiguous blocks', () => {
      tracker.markDirty(0, BLOCK_SIZE);
      tracker.markDirty(BLOCK_SIZE * 10, BLOCK_SIZE);

      expect(tracker.getDirtyBytes()).toBe(BLOCK_SIZE * 2);
    });
  });

  describe('edge cases', () => {
    it('should handle small disk (single block)', () => {
      const smallTracker = new DirtyBlockTracker(BLOCK_SIZE);

      smallTracker.markDirty(0, 256);

      expect(smallTracker.getDirtyBlockCount()).toBe(1);
    });

    it('should handle disk size not aligned to block size', () => {
      const oddTracker = new DirtyBlockTracker(1000); // ~2 blocks

      oddTracker.markDirty(0, 1000);

      expect(oddTracker.getDirtyBlockCount()).toBe(2);
    });

    it('should handle large disk efficiently', () => {
      const largeTracker = new DirtyBlockTracker(100 * 1024 * 1024); // 100MB

      // Mark first and last blocks
      largeTracker.markDirty(0, BLOCK_SIZE);
      largeTracker.markDirty(100 * 1024 * 1024 - BLOCK_SIZE, BLOCK_SIZE);

      expect(largeTracker.getDirtyBlockCount()).toBe(2);
    });
  });
});
