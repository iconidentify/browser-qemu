/**
 * Tests for TrackpadHandler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrackpadHandler } from './TrackpadHandler';
import type { InputBufferWriter } from './types';

// Polyfill PointerEvent for jsdom
class MockPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}
(globalThis as unknown as { PointerEvent: typeof MockPointerEvent }).PointerEvent = MockPointerEvent;

// Mock buffer writer that records all calls
function createMockBufferWriter(): InputBufferWriter & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    writeMousePosition(x: number, y: number) {
      calls.push({ method: 'writeMousePosition', args: [x, y] });
    },
    writeMouseButton(button: number, pressed: boolean) {
      calls.push({ method: 'writeMouseButton', args: [button, pressed] });
    },
    writeKeyEvent(keyCode: number, pressed: boolean) {
      calls.push({ method: 'writeKeyEvent', args: [keyCode, pressed] });
    },
    writeModifiers(modifiers: number) {
      calls.push({ method: 'writeModifiers', args: [modifiers] });
    },
  };
}

// Create a mock pointer event
function createPointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType: string = 'touch'
): PointerEvent {
  return new PointerEvent(type, {
    pointerId,
    clientX,
    clientY,
    pointerType,
    bubbles: true,
    cancelable: true,
  });
}

// Mock element with pointer capture support and proper dimensions
function createMockElement(): HTMLElement {
  const element = document.createElement('div');
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn().mockReturnValue(false);
  // Mock getBoundingClientRect to return sensible dimensions for bounds checking
  element.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    right: 400,
    top: 0,
    bottom: 300,
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return element;
}

describe('TrackpadHandler', () => {
  let handler: TrackpadHandler;
  let mockWriter: ReturnType<typeof createMockBufferWriter>;
  let element: HTMLElement;

  beforeEach(() => {
    mockWriter = createMockBufferWriter();
    handler = new TrackpadHandler(mockWriter);
    element = createMockElement();
    vi.useFakeTimers();
  });

  afterEach(() => {
    handler.detach();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create handler with default config', () => {
      expect(handler).toBeDefined();
      expect(handler.getCursorPosition()).toEqual({ x: 320, y: 240 });
    });

    it('should create handler with custom sensitivity', () => {
      const customHandler = new TrackpadHandler(mockWriter, { sensitivity: 2.0 });
      expect(customHandler).toBeDefined();
    });

    it('should set screen bounds', () => {
      handler.setScreenBounds(800, 600);
      // Cursor should be clamped if it was out of bounds
      expect(handler.getCursorPosition()).toEqual({ x: 320, y: 240 });
    });
  });

  describe('attach/detach', () => {
    it('should attach to element', () => {
      handler.attach(element);
      expect(element.style.touchAction).toBe('none');
    });

    it('should throw when attaching to window', () => {
      expect(() => handler.attach(window)).toThrow('TrackpadHandler must be attached to an element');
    });

    it('should not attach twice', () => {
      handler.attach(element);
      handler.attach(element); // Should not throw
      expect(element.style.touchAction).toBe('none');
    });

    it('should detach from element', () => {
      handler.attach(element);
      handler.detach();
      expect(element.style.touchAction).toBe('');
    });

    it('should reset state on detach', () => {
      handler.attach(element);

      // Simulate a touch
      const downEvent = createPointerEvent('pointerdown', 1, 100, 100);
      element.dispatchEvent(downEvent);

      handler.detach();

      // Should have released any held buttons
      const buttonReleaseCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[1] === false
      );
      expect(buttonReleaseCalls.length).toBeGreaterThan(0);
    });
  });

  describe('single tap', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should defer single tap click for double-tap detection', () => {
      const downEvent = createPointerEvent('pointerdown', 1, 100, 100);
      const upEvent = createPointerEvent('pointerup', 1, 100, 100);

      element.dispatchEvent(downEvent);
      element.dispatchEvent(upEvent);

      // Immediately after tap, should NOT have any button presses yet (deferred)
      const immediateButtonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(immediateButtonDownCalls.length).toBe(0);
    });

    it('should trigger left click after TAP_DEFER_DELAY', () => {
      const downEvent = createPointerEvent('pointerdown', 1, 100, 100);
      const upEvent = createPointerEvent('pointerup', 1, 100, 100);

      element.dispatchEvent(downEvent);
      element.dispatchEvent(upEvent);

      // Wait for TAP_DEFER_DELAY (250ms) + button release (50ms)
      vi.advanceTimersByTime(300);

      // Should have written mouse button press
      const buttonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(buttonDownCalls.length).toBe(1);

      // Should have released
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBe(1);
    });

    it('should not trigger click for mouse events', () => {
      const downEvent = createPointerEvent('pointerdown', 1, 100, 100, 'mouse');
      const upEvent = createPointerEvent('pointerup', 1, 100, 100, 'mouse');

      element.dispatchEvent(downEvent);
      element.dispatchEvent(upEvent);

      vi.advanceTimersByTime(300);

      // Should not have any mouse button calls
      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.length).toBe(0);
    });
  });

  describe('double tap', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should trigger double-click on double tap with exactly 2 clicks', () => {
      // First tap (deferred - should NOT send click yet)
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // No clicks should be sent yet (first tap is deferred)
      const afterFirstTapCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(afterFirstTapCalls.length).toBe(0);

      // Second tap quickly (within 100ms, before TAP_DEFER_DELAY)
      vi.advanceTimersByTime(100);
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 102, 102));
      element.dispatchEvent(createPointerEvent('pointerup', 2, 102, 102));

      // Advance past double-click sequence timing (150ms for all button events)
      vi.advanceTimersByTime(200);

      // Should have exactly 2 button presses for double-click (not 3!)
      const buttonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(buttonDownCalls.length).toBe(2);

      // And exactly 2 releases
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBe(2);
    });

    it('should not double-click if taps are too far apart', () => {
      // First tap
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));
      vi.advanceTimersByTime(100);

      mockWriter.calls.length = 0; // Clear previous calls

      // Second tap far away - should flush first tap and start new pending tap
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 200, 200));
      element.dispatchEvent(createPointerEvent('pointerup', 2, 200, 200));

      // First tap should be flushed immediately (1 click)
      const afterSecondTapCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(afterSecondTapCalls.length).toBe(1); // First tap flushed

      // Wait for second tap's defer delay
      vi.advanceTimersByTime(300);

      // Now second tap should also have been sent
      const finalButtonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(finalButtonDownCalls.length).toBe(2); // Both taps as single clicks
    });

    it('should not double-click if too slow', () => {
      // First tap
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Wait past TAP_DEFER_DELAY - first tap should be sent
      vi.advanceTimersByTime(300);

      const afterFirstTapCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(afterFirstTapCalls.length).toBe(1); // First tap sent

      mockWriter.calls.length = 0;

      // Second tap (too late for double-tap)
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 102, 102));
      element.dispatchEvent(createPointerEvent('pointerup', 2, 102, 102));
      vi.advanceTimersByTime(300);

      // Should only have single click (second tap)
      const buttonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(buttonDownCalls.length).toBe(1);
    });
  });

  describe('two-finger tap (right-click)', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should trigger right-click on two-finger tap', () => {
      // Two fingers down
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 150, 100));

      // Both fingers up quickly
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 2, 150, 100));

      vi.advanceTimersByTime(100);

      // Should have Ctrl modifier
      const modifierCalls = mockWriter.calls.filter(
        c => c.method === 'writeModifiers' && c.args[0] !== 0
      );
      expect(modifierCalls.length).toBeGreaterThan(0);

      // Should have button press
      const buttonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(buttonDownCalls.length).toBeGreaterThan(0);
    });
  });

  describe('cursor movement', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should move cursor with finger drag', () => {
      // Start touch
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));

      // Move finger
      element.dispatchEvent(createPointerEvent('pointermove', 1, 120, 110));

      // Check cursor moved (uses acceleration curve internally)
      // Note: writeMousePosition is batched via RAF for performance,
      // so we check cursor position directly which updates immediately
      const position = handler.getCursorPosition();
      expect(position.x).toBeGreaterThan(320); // Moved right
      expect(position.y).toBeGreaterThan(240); // Moved down
    });

    it('should apply sensitivity with acceleration curve to movement', () => {
      const sensitiveHandler = new TrackpadHandler(mockWriter, { sensitivity: 3.0 });
      sensitiveHandler.attach(element);

      // Get initial position
      const initialPos = sensitiveHandler.getCursorPosition();

      // Start touch
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointermove', 1, 110, 100));

      // With acceleration curve: Math.pow(10, 1.3) * 3.0 = ~59.86
      // The cursor uses non-linear acceleration where fast movements are amplified
      const newPos = sensitiveHandler.getCursorPosition();
      const expectedMove = Math.pow(10, 1.3) * 3.0;
      expect(newPos.x - initialPos.x).toBeCloseTo(expectedMove, 0);

      sensitiveHandler.detach();
    });

    it('should clamp cursor to screen bounds', () => {
      // Use extendedTracking to test screen bounds clamping (not trackpad bounds)
      const boundedHandler = new TrackpadHandler(mockWriter, { extendedTracking: true });
      boundedHandler.attach(element);
      boundedHandler.setScreenBounds(640, 480);

      // Move cursor to top-left corner
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointermove', 1, -1000, -1000));

      const pos = boundedHandler.getCursorPosition();
      expect(pos.x).toBe(0);
      expect(pos.y).toBe(0);

      // Move to bottom-right
      element.dispatchEvent(createPointerEvent('pointermove', 1, 2000, 2000));

      const pos2 = boundedHandler.getCursorPosition();
      expect(pos2.x).toBe(639);
      expect(pos2.y).toBe(479);

      boundedHandler.detach();
    });
  });

  describe('drag gesture', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should start drag after hold delay', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));

      // Wait for drag start delay
      vi.advanceTimersByTime(150);

      // Should have pressed mouse button
      const buttonDownCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === true
      );
      expect(buttonDownCalls.length).toBe(1);
      expect(handler.isDragActive()).toBe(true);
    });

    it('should release button immediately on drag end when sticky click disabled (default)', () => {
      // Sticky click is disabled by default
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      // End drag - should immediately release button
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Should NOT be in hold mode
      expect(handler.isDragActive()).toBe(false);
      expect(handler.isDragHoldActive()).toBe(false);

      // Button should be released immediately
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBe(1);
    });

    it('should enter hold mode on drag end when sticky click enabled', () => {
      handler.setStickyClickEnabled(true);
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      // End drag - should enter hold mode, not immediately release
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Should be in hold mode, not dragging
      expect(handler.isDragActive()).toBe(false);
      expect(handler.isDragHoldActive()).toBe(true);

      // Button should still be pressed (held for repositioning)
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBe(0);
    });

    it('should release button after hold timeout expires', () => {
      handler.setStickyClickEnabled(true);
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      // End drag - enters hold mode
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));
      expect(handler.isDragHoldActive()).toBe(true);

      // Advance past the hold timeout (800ms)
      vi.advanceTimersByTime(800);

      // Now button should be released
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBeGreaterThan(0);
      expect(handler.isDragHoldActive()).toBe(false);
    });

    it('should resume drag when finger returns during hold', () => {
      handler.setStickyClickEnabled(true);
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      // End drag - enters hold mode
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));
      expect(handler.isDragHoldActive()).toBe(true);

      // Finger returns before timeout
      vi.advanceTimersByTime(400); // Halfway through timeout
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 150, 150));

      // Should resume dragging
      expect(handler.isDragActive()).toBe(true);
      expect(handler.isDragHoldActive()).toBe(false);

      // Button should still be pressed (never released)
      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[0] === 0 && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBe(0);
    });

    it('should cancel drag-start if moved too much', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));

      // Move significantly before delay expires
      element.dispatchEvent(createPointerEvent('pointermove', 1, 150, 150));

      // Wait past delay
      vi.advanceTimersByTime(150);

      // Should NOT be in drag mode (moved too much, it's just cursor movement)
      expect(handler.isDragActive()).toBe(false);
    });
  });

  describe('two-finger scroll', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should trigger scroll callback on two-finger drag', () => {
      const scrollCallback = vi.fn();
      handler.setOnScroll(scrollCallback);

      // Two fingers down
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 150, 100));

      // Drag both fingers
      element.dispatchEvent(createPointerEvent('pointermove', 1, 100, 150));
      element.dispatchEvent(createPointerEvent('pointermove', 2, 150, 150));

      expect(scrollCallback).toHaveBeenCalled();
      expect(handler.isScrollActive()).toBe(true);
    });

    it('should exit scroll mode when fingers lifted', () => {
      const scrollCallback = vi.fn();
      handler.setOnScroll(scrollCallback);

      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerdown', 2, 150, 100));

      expect(handler.isScrollActive()).toBe(true);

      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 2, 150, 100));

      expect(handler.isScrollActive()).toBe(false);
    });
  });

  describe('haptic feedback', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should call haptic callback on tap after defer delay', () => {
      const hapticCallback = vi.fn();
      handler.setOnHaptic(hapticCallback);

      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Wait for TAP_DEFER_DELAY (250ms) + some buffer
      vi.advanceTimersByTime(300);

      expect(hapticCallback).toHaveBeenCalledWith('tap');
    });

    it('should call haptic callback on release after defer delay', () => {
      const hapticCallback = vi.fn();
      handler.setOnHaptic(hapticCallback);

      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Wait for TAP_DEFER_DELAY (250ms) + button release (50ms)
      vi.advanceTimersByTime(350);

      expect(hapticCallback).toHaveBeenCalledWith('release');
    });

    it('should not call haptic when disabled', () => {
      const noHapticHandler = new TrackpadHandler(mockWriter, { enableHaptics: false });
      noHapticHandler.attach(element);

      const hapticCallback = vi.fn();
      noHapticHandler.setOnHaptic(hapticCallback);

      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      element.dispatchEvent(createPointerEvent('pointerup', 1, 100, 100));

      // Wait for TAP_DEFER_DELAY + buffer
      vi.advanceTimersByTime(350);

      expect(hapticCallback).not.toHaveBeenCalled();

      noHapticHandler.detach();
    });
  });

  describe('pointer cancel', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should clean up on pointer cancel', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      expect(handler.isDragActive()).toBe(true);

      element.dispatchEvent(createPointerEvent('pointercancel', 1, 100, 100));

      expect(handler.isDragActive()).toBe(false);
      expect(handler.isTouching()).toBe(false);
    });

    it('should release button on cancel during drag', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      mockWriter.calls.length = 0;

      element.dispatchEvent(createPointerEvent('pointercancel', 1, 100, 100));

      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    beforeEach(() => {
      handler.attach(element);
    });

    it('should clear all state on reset', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      expect(handler.isDragActive()).toBe(true);

      handler.reset();

      expect(handler.isDragActive()).toBe(false);
      expect(handler.isTouching()).toBe(false);
      expect(handler.isScrollActive()).toBe(false);
    });

    it('should release buttons on reset', () => {
      element.dispatchEvent(createPointerEvent('pointerdown', 1, 100, 100));
      vi.advanceTimersByTime(150);

      mockWriter.calls.length = 0;

      handler.reset();

      const buttonUpCalls = mockWriter.calls.filter(
        c => c.method === 'writeMouseButton' && c.args[1] === false
      );
      expect(buttonUpCalls.length).toBeGreaterThan(0);
    });
  });
});
