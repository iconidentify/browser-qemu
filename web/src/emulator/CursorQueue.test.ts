/**
 * Tests for CursorQueue - cursor update queueing during module initialization.
 *
 * These tests ensure cursor updates are properly queued when the WASM module
 * isn't ready, preventing the race condition that causes out-of-bounds errors:
 *   do_get_mem_byte(0x20645c63) out of bounds (EMSCRIPTEN_HEAP_SIZE=0x12000000)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CursorQueue,
  CursorUpdate,
  isValidCursorUpdate,
  isCursorPtrInBounds,
} from './CursorQueue';

describe('CursorQueue', () => {
  let queue: CursorQueue;

  beforeEach(() => {
    queue = new CursorQueue();
  });

  describe('basic operations', () => {
    it('should start empty', () => {
      expect(queue.hasPending()).toBe(false);
      expect(queue.peek()).toBeNull();
      expect(queue.dequeue()).toBeNull();
    });

    it('should enqueue a cursor update', () => {
      const update: CursorUpdate = {
        dataPtr: 0x1000,
        hotspotX: 1,
        hotspotY: 1,
        visible: 1,
      };

      queue.enqueue(update);

      expect(queue.hasPending()).toBe(true);
      expect(queue.peek()).toEqual(update);
    });

    it('should dequeue and clear the pending update', () => {
      const update: CursorUpdate = {
        dataPtr: 0x2000,
        hotspotX: 8,
        hotspotY: 8,
        visible: 1,
      };

      queue.enqueue(update);
      const dequeued = queue.dequeue();

      expect(dequeued).toEqual(update);
      expect(queue.hasPending()).toBe(false);
      expect(queue.dequeue()).toBeNull();
    });

    it('should allow peeking without removing', () => {
      const update: CursorUpdate = {
        dataPtr: 0x3000,
        hotspotX: 0,
        hotspotY: 0,
        visible: 0,
      };

      queue.enqueue(update);

      // Peek multiple times
      expect(queue.peek()).toEqual(update);
      expect(queue.peek()).toEqual(update);
      expect(queue.hasPending()).toBe(true);

      // Still there after peeking
      expect(queue.dequeue()).toEqual(update);
    });

    it('should clear pending updates', () => {
      queue.enqueue({
        dataPtr: 0x4000,
        hotspotX: 5,
        hotspotY: 5,
        visible: 1,
      });

      expect(queue.hasPending()).toBe(true);
      queue.clear();
      expect(queue.hasPending()).toBe(false);
      expect(queue.peek()).toBeNull();
    });
  });

  describe('update replacement (only latest matters)', () => {
    it('should replace older updates with newer ones', () => {
      const update1: CursorUpdate = {
        dataPtr: 0x1000,
        hotspotX: 1,
        hotspotY: 1,
        visible: 1,
      };
      const update2: CursorUpdate = {
        dataPtr: 0x2000,
        hotspotX: 8,
        hotspotY: 8,
        visible: 1,
      };

      queue.enqueue(update1);
      queue.enqueue(update2);

      // Only the latest update should be returned
      expect(queue.dequeue()).toEqual(update2);
      expect(queue.dequeue()).toBeNull();
    });

    it('should handle rapid cursor changes (simulating fast mouse movement)', () => {
      // Simulate many rapid cursor updates during initialization
      for (let i = 0; i < 100; i++) {
        queue.enqueue({
          dataPtr: 0x1000 + i * 64,
          hotspotX: i % 16,
          hotspotY: i % 16,
          visible: 1,
        });
      }

      // Only the last one matters
      const final = queue.dequeue();
      expect(final?.dataPtr).toBe(0x1000 + 99 * 64);
      expect(final?.hotspotX).toBe(99 % 16);
      expect(queue.hasPending()).toBe(false);
    });
  });

  describe('statistics', () => {
    it('should track queued count', () => {
      expect(queue.getStats().queued).toBe(0);

      queue.enqueue({ dataPtr: 0x1000, hotspotX: 0, hotspotY: 0, visible: 1 });
      expect(queue.getStats().queued).toBe(1);

      queue.enqueue({ dataPtr: 0x2000, hotspotX: 0, hotspotY: 0, visible: 1 });
      expect(queue.getStats().queued).toBe(2);
    });

    it('should track processed count', () => {
      expect(queue.getStats().processed).toBe(0);

      queue.enqueue({ dataPtr: 0x1000, hotspotX: 0, hotspotY: 0, visible: 1 });
      queue.dequeue();
      expect(queue.getStats().processed).toBe(1);

      // Dequeue when empty doesn't increment
      queue.dequeue();
      expect(queue.getStats().processed).toBe(1);
    });

    it('should reset statistics', () => {
      queue.enqueue({ dataPtr: 0x1000, hotspotX: 0, hotspotY: 0, visible: 1 });
      queue.dequeue();

      expect(queue.getStats().queued).toBe(1);
      expect(queue.getStats().processed).toBe(1);

      queue.resetStats();

      expect(queue.getStats().queued).toBe(0);
      expect(queue.getStats().processed).toBe(0);
    });

    it('should count multiple enqueues even when they replace', () => {
      // This helps debug race condition frequency
      queue.enqueue({ dataPtr: 0x1000, hotspotX: 0, hotspotY: 0, visible: 1 });
      queue.enqueue({ dataPtr: 0x2000, hotspotX: 0, hotspotY: 0, visible: 1 });
      queue.enqueue({ dataPtr: 0x3000, hotspotX: 0, hotspotY: 0, visible: 1 });

      expect(queue.getStats().queued).toBe(3);
      expect(queue.getStats().processed).toBe(0);

      queue.dequeue();

      expect(queue.getStats().queued).toBe(3);
      expect(queue.getStats().processed).toBe(1);
    });
  });

  describe('race condition scenarios', () => {
    it('should handle cursor update before module ready', () => {
      // Simulate: C++ calls setCursor, but HEAPU8 not available
      const earlyUpdate: CursorUpdate = {
        dataPtr: 0x844, // TheCrsr location in Mac low memory
        hotspotX: 1,
        hotspotY: 1,
        visible: 1,
      };

      // Queue the update since module not ready
      queue.enqueue(earlyUpdate);
      expect(queue.hasPending()).toBe(true);

      // Later: preRun completes, module is ready
      // Process the pending cursor
      const pending = queue.dequeue();
      expect(pending).toEqual(earlyUpdate);
    });

    it('should handle direct processing when module is ready', () => {
      // Simulate: Module is ready, so we process directly
      // No need to queue, but clear any stale pending updates
      queue.enqueue({
        dataPtr: 0x1000,
        hotspotX: 0,
        hotspotY: 0,
        visible: 1,
      });

      // Module becomes ready, direct processing succeeds
      queue.clear();

      expect(queue.hasPending()).toBe(false);
    });

    it('should not lose cursor state during restart', () => {
      // Simulate: User restarts emulator, cursor state resets
      queue.enqueue({
        dataPtr: 0x1000,
        hotspotX: 1,
        hotspotY: 1,
        visible: 1,
      });

      // Restart clears everything
      queue.clear();
      queue.resetStats();

      expect(queue.hasPending()).toBe(false);
      expect(queue.getStats().queued).toBe(0);

      // New cursor update after restart
      queue.enqueue({
        dataPtr: 0x2000,
        hotspotX: 8,
        hotspotY: 8,
        visible: 1,
      });

      expect(queue.hasPending()).toBe(true);
      expect(queue.peek()?.dataPtr).toBe(0x2000);
    });
  });
});

describe('isValidCursorUpdate', () => {
  it('should accept valid cursor updates', () => {
    expect(isValidCursorUpdate({
      dataPtr: 0,
      hotspotX: 0,
      hotspotY: 0,
      visible: 0,
    })).toBe(true);

    expect(isValidCursorUpdate({
      dataPtr: 0x12345678,
      hotspotX: 15,
      hotspotY: 15,
      visible: 1,
    })).toBe(true);

    expect(isValidCursorUpdate({
      dataPtr: 0x844, // TheCrsr
      hotspotX: 1,
      hotspotY: 1,
      visible: 1,
    })).toBe(true);
  });

  it('should reject negative data pointer', () => {
    expect(isValidCursorUpdate({
      dataPtr: -1,
      hotspotX: 0,
      hotspotY: 0,
      visible: 1,
    })).toBe(false);
  });

  it('should reject out-of-bounds hotspot X', () => {
    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: -1,
      hotspotY: 0,
      visible: 1,
    })).toBe(false);

    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: 16,
      hotspotY: 0,
      visible: 1,
    })).toBe(false);
  });

  it('should reject out-of-bounds hotspot Y', () => {
    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: 0,
      hotspotY: -1,
      visible: 1,
    })).toBe(false);

    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: 0,
      hotspotY: 16,
      visible: 1,
    })).toBe(false);
  });

  it('should reject invalid visible values', () => {
    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: 0,
      hotspotY: 0,
      visible: 2,
    })).toBe(false);

    expect(isValidCursorUpdate({
      dataPtr: 0x1000,
      hotspotX: 0,
      hotspotY: 0,
      visible: -1,
    })).toBe(false);
  });
});

describe('isCursorPtrInBounds', () => {
  const EMSCRIPTEN_HEAP_SIZE = 0x12000000; // 301MB - typical heap size

  it('should accept valid pointers', () => {
    expect(isCursorPtrInBounds(0, EMSCRIPTEN_HEAP_SIZE)).toBe(true);
    expect(isCursorPtrInBounds(0x844, EMSCRIPTEN_HEAP_SIZE)).toBe(true);
    expect(isCursorPtrInBounds(0x1000000, EMSCRIPTEN_HEAP_SIZE)).toBe(true);
  });

  it('should accept pointer at max valid position', () => {
    // Max valid pointer = heap size - 64 (cursor data size)
    const maxValid = EMSCRIPTEN_HEAP_SIZE - 64;
    expect(isCursorPtrInBounds(maxValid, EMSCRIPTEN_HEAP_SIZE)).toBe(true);
  });

  it('should reject pointers that would overflow', () => {
    // Pointer where cursor data would extend past heap
    const justOverflow = EMSCRIPTEN_HEAP_SIZE - 63;
    expect(isCursorPtrInBounds(justOverflow, EMSCRIPTEN_HEAP_SIZE)).toBe(false);

    // Way out of bounds
    expect(isCursorPtrInBounds(EMSCRIPTEN_HEAP_SIZE, EMSCRIPTEN_HEAP_SIZE)).toBe(false);
    expect(isCursorPtrInBounds(0x20645c63, EMSCRIPTEN_HEAP_SIZE)).toBe(false); // Actual error from logs
  });

  it('should reject negative pointers', () => {
    expect(isCursorPtrInBounds(-1, EMSCRIPTEN_HEAP_SIZE)).toBe(false);
    expect(isCursorPtrInBounds(-64, EMSCRIPTEN_HEAP_SIZE)).toBe(false);
  });

  it('should handle small heap sizes', () => {
    // Tiny heap - only room for cursor data at position 0
    expect(isCursorPtrInBounds(0, 64)).toBe(true);
    expect(isCursorPtrInBounds(1, 64)).toBe(false);

    // No room at all
    expect(isCursorPtrInBounds(0, 63)).toBe(false);
    expect(isCursorPtrInBounds(0, 0)).toBe(false);
  });
});
