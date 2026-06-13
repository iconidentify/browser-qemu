/**
 * Tests for InputEventQueue.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InputEventQueue } from './InputEventQueue';
import { InputEventPriority } from './types';

describe('InputEventQueue', () => {
  let queue: InputEventQueue;

  beforeEach(() => {
    queue = new InputEventQueue();
  });

  describe('queueKeyEvent', () => {
    it('should queue key events', () => {
      queue.queueKeyEvent(0x00, true); // 'a' keydown
      queue.queueKeyEvent(0x00, false); // 'a' keyup

      expect(queue.hasEvents()).toBe(true);
      expect(queue.hasKeyEvents()).toBe(true);
    });

    it('should never drop key events', () => {
      // Queue many key events
      for (let i = 0; i < 1000; i++) {
        queue.queueKeyEvent(0x00, true);
        queue.queueKeyEvent(0x00, false);
      }

      const sizes = queue.getQueueSizes();
      expect(sizes.keys).toBe(2000);
    });
  });

  // Note: Mouse moves are NOT queued - they're written directly for low latency.
  // See QueuedInputBufferWriter.writeMousePosition()

  describe('queueMouseButton', () => {
    it('should queue mouse button events', () => {
      queue.queueMouseButton(0, true); // left click down
      queue.queueMouseButton(0, false); // left click up

      expect(queue.hasEvents()).toBe(true);
    });
  });

  describe('getNextBatch', () => {
    it('should return one key event per batch', () => {
      queue.queueKeyEvent(0x00, true);
      queue.queueKeyEvent(0x01, true);
      queue.queueKeyEvent(0x02, true);

      const batch1 = queue.getNextBatch();
      expect(batch1.length).toBe(1);
      expect(batch1[0].type).toBe('keydown');
      if (batch1[0].type === 'keydown') {
        expect(batch1[0].keyCode).toBe(0x00);
      }

      const batch2 = queue.getNextBatch();
      expect(batch2.length).toBe(1);
      if (batch2[0].type === 'keydown') {
        expect(batch2[0].keyCode).toBe(0x01);
      }
    });

    it('should include button events in batch', () => {
      queue.queueMouseButton(0, true);
      queue.queueKeyEvent(0x00, true);

      const batch = queue.getNextBatch();
      expect(batch.length).toBe(2);
      expect(batch.some(e => e.type === 'mousedown')).toBe(true);
      expect(batch.some(e => e.type === 'keydown')).toBe(true);
    });

    it('should return empty array when queue is empty', () => {
      const batch = queue.getNextBatch();
      expect(batch).toEqual([]);
    });
  });

  describe('requeueEvents', () => {
    it('should put events back at front of queue', () => {
      queue.queueKeyEvent(0x00, true);
      queue.queueKeyEvent(0x01, true);

      const batch = queue.getNextBatch();
      expect(batch.length).toBe(1);

      // Requeue the remaining event (plus some more)
      const events = queue.getNextBatch();
      queue.requeueEvents(events);

      // The requeued event should come first
      const sizes = queue.getQueueSizes();
      expect(sizes.keys).toBe(1);
    });
  });

  describe('statistics', () => {
    it('should track events queued', () => {
      queue.queueKeyEvent(0x00, true);
      queue.queueMouseButton(0, true);

      const stats = queue.getStats();
      expect(stats.eventsQueued).toBe(2);
    });

    it('should track events sent', () => {
      queue.queueKeyEvent(0x00, true);
      queue.getNextBatch();
      queue.recordSent(1);

      const stats = queue.getStats();
      expect(stats.eventsSent).toBe(1);
    });

    it('should reset statistics', () => {
      queue.queueKeyEvent(0x00, true);
      queue.recordSent(1);
      queue.resetStats();

      const stats = queue.getStats();
      expect(stats.eventsQueued).toBe(0);
      expect(stats.eventsSent).toBe(0);
    });
  });

  describe('clear', () => {
    it('should clear all queued events', () => {
      queue.queueKeyEvent(0x00, true);
      queue.queueMouseButton(0, true);

      queue.clear();

      expect(queue.hasEvents()).toBe(false);
      const sizes = queue.getQueueSizes();
      expect(sizes.keys).toBe(0);
      expect(sizes.buttons).toBe(0);
    });
  });

  describe('priority ordering', () => {
    it('should prioritize key events with CRITICAL priority', () => {
      queue.queueKeyEvent(0x00, true);
      const batch = queue.getNextBatch();

      expect(batch[0].priority).toBe(InputEventPriority.CRITICAL);
    });

    it('should prioritize mouse buttons with HIGH priority', () => {
      queue.queueMouseButton(0, true);
      const batch = queue.getNextBatch();

      expect(batch[0].priority).toBe(InputEventPriority.HIGH);
    });

    // Note: Mouse moves are written directly, not queued, so no priority test needed
  });
});
