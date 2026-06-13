/**
 * Tests for GestureRecognizer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GestureRecognizer, type GestureCallback } from './GestureRecognizer';
import type { Point, GestureEvent } from './types';

// Create a mock PointerEvent
function createPointerEvent(
  type: string,
  pointerId: number,
  pointerType: 'touch' | 'mouse' | 'pen' = 'touch'
): PointerEvent {
  return {
    type,
    pointerId,
    pointerType,
    clientX: 0,
    clientY: 0,
    button: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as PointerEvent;
}

describe('GestureRecognizer', () => {
  let gestureCallback: GestureCallback;
  let capturedGestures: GestureEvent[];
  let recognizer: GestureRecognizer;

  beforeEach(() => {
    capturedGestures = [];
    gestureCallback = (event) => capturedGestures.push(event);
    recognizer = new GestureRecognizer(gestureCallback);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    recognizer.reset();
  });

  describe('tap gesture', () => {
    it('should recognize a tap after defer delay', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // Tap is deferred by 250ms to allow double-tap detection
      expect(capturedGestures.length).toBe(0);

      // After delay, tap should be emitted
      vi.advanceTimersByTime(250);
      expect(capturedGestures.length).toBe(1);
      expect(capturedGestures[0].type).toBe('tap');
      expect(capturedGestures[0].position).toEqual(position);
    });

    it('should defer tap emission for double-tap detection', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // Tap should NOT be emitted immediately
      expect(capturedGestures.length).toBe(0);

      // After partial delay, still not emitted
      vi.advanceTimersByTime(100);
      expect(capturedGestures.length).toBe(0);

      // After full delay, tap should be emitted
      vi.advanceTimersByTime(150);
      expect(capturedGestures.length).toBe(1);
      expect(capturedGestures[0].type).toBe('tap');
    });

    it('should not recognize tap if movement exceeds threshold', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const endPosition: Point = { x: 150, y: 100 }; // 50px movement

      recognizer.onPointerDown(event, startPosition);
      recognizer.onPointerMove(event, endPosition);
      recognizer.onPointerUp(event, endPosition);

      // Should be a drag, not a tap
      const tapGestures = capturedGestures.filter(g => g.type === 'tap');
      expect(tapGestures.length).toBe(0);
    });

    it('should not recognize tap for mouse events', () => {
      const event = createPointerEvent('pointerdown', 1, 'mouse');
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      expect(capturedGestures.length).toBe(0);
    });
  });

  describe('double-tap gesture', () => {
    it('should recognize a double-tap without emitting first tap', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      // First tap
      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // First tap is deferred, not emitted yet
      expect(capturedGestures.length).toBe(0);

      // Second tap quickly after (before defer timer expires)
      vi.advanceTimersByTime(100);
      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // Should emit ONLY double-tap, not tap + double-tap
      expect(capturedGestures.length).toBe(1);
      expect(capturedGestures[0].type).toBe('double-tap');
    });

    it('should not recognize double-tap if too slow', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      // First tap
      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // Wait too long (500ms > 300ms double-tap threshold)
      // This also exceeds the 250ms defer delay, so first tap is emitted
      vi.advanceTimersByTime(500);

      // First tap should have been emitted
      expect(capturedGestures.filter(g => g.type === 'tap').length).toBe(1);

      // Second tap
      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // Second tap is deferred too, wait for it
      vi.advanceTimersByTime(250);

      // Should be two separate taps
      expect(capturedGestures.filter(g => g.type === 'tap').length).toBe(2);
      expect(capturedGestures.filter(g => g.type === 'double-tap').length).toBe(0);
    });

    it('should not recognize double-tap if too far apart', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position1: Point = { x: 100, y: 100 };
      const position2: Point = { x: 200, y: 100 }; // 100px apart

      // First tap
      recognizer.onPointerDown(event, position1);
      recognizer.onPointerUp(event, position1);

      // Second tap at different position (before defer delay expires)
      vi.advanceTimersByTime(100);
      recognizer.onPointerDown(event, position2);
      recognizer.onPointerUp(event, position2);

      // Wait for deferred taps to be emitted
      vi.advanceTimersByTime(250);

      // Should be two separate taps (no double-tap due to distance)
      expect(capturedGestures.filter(g => g.type === 'tap').length).toBe(2);
      expect(capturedGestures.filter(g => g.type === 'double-tap').length).toBe(0);
    });
  });

  describe('long-press gesture', () => {
    it('should recognize a long-press', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);

      // Wait for long-press delay
      vi.advanceTimersByTime(600);

      expect(capturedGestures.length).toBe(1);
      expect(capturedGestures[0].type).toBe('long-press');
      expect(capturedGestures[0].position).toEqual(position);
    });

    it('should not recognize long-press if finger moves', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition: Point = { x: 150, y: 100 };

      recognizer.onPointerDown(event, startPosition);

      // Move finger
      vi.advanceTimersByTime(200);
      recognizer.onPointerMove(event, movePosition);

      // Wait for long-press delay
      vi.advanceTimersByTime(400);

      // Should have started a drag, not long-press
      const longPressGestures = capturedGestures.filter(g => g.type === 'long-press');
      expect(longPressGestures.length).toBe(0);
    });

    it('should not recognize long-press if released early', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);

      // Release before long-press delay
      vi.advanceTimersByTime(200);
      recognizer.onPointerUp(event, position);

      // Tap is deferred, not emitted yet
      expect(capturedGestures.length).toBe(0);

      // Wait for deferred tap
      vi.advanceTimersByTime(250);

      // Should be a tap, not long-press
      expect(capturedGestures.length).toBe(1);
      expect(capturedGestures[0].type).toBe('tap');
    });
  });

  describe('drag gesture', () => {
    it('should recognize a drag', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition1: Point = { x: 130, y: 100 };
      const movePosition2: Point = { x: 160, y: 100 };
      const endPosition: Point = { x: 200, y: 100 };

      recognizer.onPointerDown(event, startPosition);
      recognizer.onPointerMove(event, movePosition1);
      recognizer.onPointerMove(event, movePosition2);
      recognizer.onPointerUp(event, endPosition);

      const dragStart = capturedGestures.find(g => g.type === 'drag-start');
      const dragMoves = capturedGestures.filter(g => g.type === 'drag-move');
      const dragEnd = capturedGestures.find(g => g.type === 'drag-end');

      expect(dragStart).toBeDefined();
      expect(dragStart?.startPosition).toEqual(startPosition);
      expect(dragMoves.length).toBe(2);
      expect(dragEnd).toBeDefined();
      expect(dragEnd?.position).toEqual(endPosition);
    });

    it('should report isDragActive during drag', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition: Point = { x: 150, y: 100 };

      expect(recognizer.isDragActive()).toBe(false);

      recognizer.onPointerDown(event, startPosition);
      expect(recognizer.isDragActive()).toBe(false);

      recognizer.onPointerMove(event, movePosition);
      expect(recognizer.isDragActive()).toBe(true);

      recognizer.onPointerUp(event, movePosition);
      expect(recognizer.isDragActive()).toBe(false);
    });
  });

  describe('pointer cancel', () => {
    it('should handle pointer cancel during drag', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition: Point = { x: 150, y: 100 };

      recognizer.onPointerDown(event, startPosition);
      recognizer.onPointerMove(event, movePosition);
      recognizer.onPointerCancel(event);

      // Should emit drag-end
      const dragEnd = capturedGestures.find(g => g.type === 'drag-end');
      expect(dragEnd).toBeDefined();
      expect(recognizer.isDragActive()).toBe(false);
    });

    it('should cancel long-press timer on cancel', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      recognizer.onPointerCancel(event);

      // Wait for long-press delay - should not fire
      vi.advanceTimersByTime(600);

      const longPressGestures = capturedGestures.filter(g => g.type === 'long-press');
      expect(longPressGestures.length).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all state on reset', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      expect(recognizer.isTouchActive()).toBe(true);

      recognizer.reset();

      expect(recognizer.isTouchActive()).toBe(false);
      expect(recognizer.isDragActive()).toBe(false);
    });

    it('should cancel long-press timer on reset', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      recognizer.reset();

      // Wait for long-press delay - should not fire
      vi.advanceTimersByTime(600);

      expect(capturedGestures.length).toBe(0);
    });

    it('should cancel pending tap timer on reset', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      // First tap (deferred)
      recognizer.onPointerDown(event, position);
      recognizer.onPointerUp(event, position);

      // No tap emitted yet
      expect(capturedGestures.length).toBe(0);

      // Reset before defer timer expires
      recognizer.reset();

      // Wait for defer delay - should not fire because reset cancelled it
      vi.advanceTimersByTime(300);

      expect(capturedGestures.length).toBe(0);
    });

    it('should emit drag-end when reset during active drag', () => {
      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition: Point = { x: 150, y: 100 };

      // Start a drag
      recognizer.onPointerDown(event, startPosition);
      recognizer.onPointerMove(event, movePosition);

      // Verify drag is active
      expect(recognizer.isDragActive()).toBe(true);
      expect(capturedGestures.some(g => g.type === 'drag-start')).toBe(true);

      // Reset while dragging (simulates entering pan mode)
      recognizer.reset();

      // Should emit drag-end to release mouse button
      expect(capturedGestures.some(g => g.type === 'drag-end')).toBe(true);
      expect(recognizer.isDragActive()).toBe(false);
    });
  });

  describe('pending tap handling on new touch', () => {
    it('should flush pending tap when new touch is far away', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position1: Point = { x: 100, y: 100 };
      const position2: Point = { x: 300, y: 300 }; // Far from position1 (> 30px)

      // First tap at position1 (deferred)
      recognizer.onPointerDown(event, position1);
      recognizer.onPointerUp(event, position1);

      // No tap emitted yet (deferred by 250ms)
      expect(capturedGestures.length).toBe(0);

      // New touch starts at position2 before defer timer expires
      vi.advanceTimersByTime(100);
      recognizer.onPointerDown(event, position2);

      // The pending tap from position1 should be FLUSHED immediately (emitted)
      // because new touch is far away (not a potential double-tap)
      const tapAtPosition1 = capturedGestures.find(
        g => g.type === 'tap' && g.position.x === 100 && g.position.y === 100
      );
      expect(tapAtPosition1).toBeDefined();
    });

    it('should preserve pending tap when new touch is nearby (potential double-tap)', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position1: Point = { x: 100, y: 100 };
      const position2: Point = { x: 110, y: 110 }; // Close to position1 (< 30px)

      // First tap at position1 (deferred)
      recognizer.onPointerDown(event, position1);
      recognizer.onPointerUp(event, position1);

      // No tap emitted yet
      expect(capturedGestures.length).toBe(0);

      // New touch starts at position2 (nearby) before defer timer expires
      vi.advanceTimersByTime(100);
      recognizer.onPointerDown(event, position2);

      // Pending tap should NOT be emitted yet (preserved for double-tap detection)
      expect(capturedGestures.length).toBe(0);

      // Complete the second tap
      recognizer.onPointerUp(event, position2);

      // Should emit double-tap (not two separate taps)
      expect(capturedGestures.filter(g => g.type === 'double-tap').length).toBe(1);
      expect(capturedGestures.filter(g => g.type === 'tap').length).toBe(0);
    });
  });

  describe('long-press state cleanup', () => {
    it('should clear currentTouch after long-press', () => {
      const event = createPointerEvent('pointerdown', 1);
      const position: Point = { x: 100, y: 100 };

      recognizer.onPointerDown(event, position);
      expect(recognizer.isTouchActive()).toBe(true);

      // Wait for long-press
      vi.advanceTimersByTime(600);

      // After long-press fires, touch should be cleared
      expect(capturedGestures.some(g => g.type === 'long-press')).toBe(true);
      expect(recognizer.isTouchActive()).toBe(false);
    });
  });

  describe('multiple pointers', () => {
    it('should ignore events from different pointer IDs', () => {
      const event1 = createPointerEvent('pointerdown', 1);
      const event2 = createPointerEvent('pointermove', 2);
      const position1: Point = { x: 100, y: 100 };
      const position2: Point = { x: 200, y: 200 };

      recognizer.onPointerDown(event1, position1);
      recognizer.onPointerMove(event2, position2); // Different pointer ID

      // The move should be ignored, so no drag should start
      expect(recognizer.isDragActive()).toBe(false);
    });
  });

  describe('custom thresholds', () => {
    it('should use custom thresholds', () => {
      const customRecognizer = new GestureRecognizer(gestureCallback, {
        tapMovement: 5,
        longPressDelay: 1000,
      });

      const event = createPointerEvent('pointerdown', 1);
      const startPosition: Point = { x: 100, y: 100 };
      const movePosition: Point = { x: 107, y: 100 }; // 7px - exceeds custom 5px threshold

      customRecognizer.onPointerDown(event, startPosition);
      customRecognizer.onPointerMove(event, movePosition);

      // Should start drag because movement exceeds custom threshold
      expect(capturedGestures.some(g => g.type === 'drag-start')).toBe(true);
    });
  });
});
