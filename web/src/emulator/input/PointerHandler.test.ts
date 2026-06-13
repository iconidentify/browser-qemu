/**
 * Tests for PointerHandler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PointerHandler } from './PointerHandler';
import { Modifiers } from './constants';
import type { InputBufferWriter } from './types';

// Create a mock buffer writer
function createMockBufferWriter(): InputBufferWriter & {
  calls: { method: string; args: any[] }[];
  clear: () => void;
} {
  const calls: { method: string; args: any[] }[] = [];
  return {
    calls,
    clear: () => { calls.length = 0; },
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

// Create a mock element with getBoundingClientRect
function createMockElement(): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  // Mock setPointerCapture and releasePointerCapture
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn().mockReturnValue(false);
  return element;
}

// Create a mock PointerEvent
function createPointerEvent(
  type: string,
  options: {
    pointerId?: number;
    pointerType?: 'mouse' | 'touch' | 'pen';
    clientX?: number;
    clientY?: number;
    button?: number;
  } = {}
): PointerEvent {
  const event = new (window as any).PointerEvent(type, {
    pointerId: options.pointerId ?? 1,
    pointerType: options.pointerType ?? 'mouse',
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    button: options.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  return event;
}

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
(globalThis as any).PointerEvent = MockPointerEvent;

describe('PointerHandler', () => {
  let mockWriter: ReturnType<typeof createMockBufferWriter>;
  let handler: PointerHandler;
  let element: HTMLElement;

  beforeEach(() => {
    mockWriter = createMockBufferWriter();
    handler = new PointerHandler(mockWriter);
    element = createMockElement();
    handler.attach(element);
    vi.useFakeTimers();
  });

  afterEach(() => {
    handler.detach();
    vi.useRealTimers();
  });

  describe('mouse events', () => {
    it('should write mouse position on move', () => {
      const event = createPointerEvent('pointermove', {
        pointerType: 'mouse',
        clientX: 100,
        clientY: 200,
      });

      element.dispatchEvent(event);

      const positionCalls = mockWriter.calls.filter(c => c.method === 'writeMousePosition');
      expect(positionCalls.length).toBe(1);
      expect(positionCalls[0].args).toEqual([100, 200]);
    });

    it('should write mouse button down on primary click', () => {
      const event = createPointerEvent('pointerdown', {
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
        button: 0,
      });

      element.dispatchEvent(event);

      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === true)).toBe(true);
    });

    it('should write mouse button up on primary release', () => {
      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'mouse',
        button: 0,
      });
      const upEvent = createPointerEvent('pointerup', {
        pointerType: 'mouse',
        button: 0,
      });

      element.dispatchEvent(downEvent);
      mockWriter.clear();
      element.dispatchEvent(upEvent);

      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === false)).toBe(true);
    });

    it('should handle secondary (right) click', () => {
      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'mouse',
        button: 2,
      });

      element.dispatchEvent(downEvent);

      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 1 && c.args[1] === true)).toBe(true);
    });
  });

  describe('touch gestures', () => {
    it('should recognize tap and emit click after defer delay', () => {
      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'touch',
        clientX: 100,
        clientY: 100,
      });
      const upEvent = createPointerEvent('pointerup', {
        pointerType: 'touch',
        clientX: 100,
        clientY: 100,
      });

      element.dispatchEvent(downEvent);
      element.dispatchEvent(upEvent);

      // Tap is deferred by 250ms to allow double-tap detection
      let buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === true)).toBe(false);

      // After defer delay, tap should be emitted
      vi.advanceTimersByTime(250);

      // Should write mouse position and button down
      const positionCalls = mockWriter.calls.filter(c => c.method === 'writeMousePosition');
      buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');

      expect(positionCalls.some(c => c.args[0] === 100 && c.args[1] === 100)).toBe(true);
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === true)).toBe(true);
    });

    it('should NOT emit Ctrl+Click on long-press (disabled for mobile UX)', () => {
      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'touch',
        clientX: 100,
        clientY: 100,
      });

      element.dispatchEvent(downEvent);

      // Wait for long-press
      vi.advanceTimersByTime(600);

      // Should NOT write Ctrl modifier (long-press right-click disabled)
      const modifierCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      expect(modifierCalls.some(c => c.args[0] === Modifiers.CTRL)).toBe(false);
    });

    it('should recognize drag and emit mouse events', () => {
      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'touch',
        clientX: 100,
        clientY: 100,
      });
      const moveEvent = createPointerEvent('pointermove', {
        pointerType: 'touch',
        clientX: 200,
        clientY: 100,
      });
      const upEvent = createPointerEvent('pointerup', {
        pointerType: 'touch',
        clientX: 200,
        clientY: 100,
      });

      element.dispatchEvent(downEvent);
      element.dispatchEvent(moveEvent);
      element.dispatchEvent(upEvent);

      // Should have button down for drag
      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === true)).toBe(true);
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === false)).toBe(true);
    });
  });

  describe('pointer capture', () => {
    it('should capture pointer on mouse down', () => {
      const event = createPointerEvent('pointerdown', {
        pointerType: 'mouse',
        pointerId: 5,
      });

      element.dispatchEvent(event);

      expect(element.setPointerCapture).toHaveBeenCalledWith(5);
    });
  });

  describe('context menu', () => {
    it('should prevent context menu', () => {
      const event = new Event('contextmenu', { cancelable: true });
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      element.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('should release all buttons on reset', () => {
      handler.reset();

      const buttonCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton');
      expect(buttonCalls.some(c => c.args[0] === 0 && c.args[1] === false)).toBe(true);
      expect(buttonCalls.some(c => c.args[0] === 1 && c.args[1] === false)).toBe(true);
    });
  });

  describe('attach/detach', () => {
    it('should not process events after detach', () => {
      handler.detach();
      mockWriter.clear();

      const event = createPointerEvent('pointermove', {
        pointerType: 'mouse',
        clientX: 100,
        clientY: 100,
      });
      element.dispatchEvent(event);

      expect(mockWriter.calls.length).toBe(0);
    });

    it('should throw if attached to window', () => {
      const newHandler = new PointerHandler(mockWriter);
      expect(() => newHandler.attach(window)).toThrow();
    });
  });

  describe('isTouchActive', () => {
    it('should return true during touch', () => {
      expect(handler.isTouchActive()).toBe(false);

      const downEvent = createPointerEvent('pointerdown', {
        pointerType: 'touch',
      });
      element.dispatchEvent(downEvent);

      expect(handler.isTouchActive()).toBe(true);
    });
  });

  describe('double-tap', () => {
    it('should recognize double-tap', () => {
      // First tap
      element.dispatchEvent(createPointerEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 }));
      element.dispatchEvent(createPointerEvent('pointerup', { pointerType: 'touch', clientX: 100, clientY: 100 }));

      // Advance timers to process the first tap's button release
      vi.advanceTimersByTime(60);
      mockWriter.clear();

      vi.advanceTimersByTime(40); // Total 100ms between taps

      // Second tap
      element.dispatchEvent(createPointerEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 }));
      element.dispatchEvent(createPointerEvent('pointerup', { pointerType: 'touch', clientX: 100, clientY: 100 }));

      // Advance timers to let double-click sequence complete
      vi.advanceTimersByTime(200);

      // Should emit multiple button presses for double-click
      const buttonDownCalls = mockWriter.calls.filter(c => c.method === 'writeMouseButton' && c.args[1] === true);
      expect(buttonDownCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pinch-to-zoom', () => {
    it('should call onZoom callback when pinching', () => {
      const zoomCallback = vi.fn();
      const zoomHandler = new PointerHandler(mockWriter, {}, undefined, zoomCallback);
      zoomHandler.attach(element);

      // First finger down
      element.dispatchEvent(createPointerEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      }));

      // Second finger down (enters pan mode)
      element.dispatchEvent(createPointerEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 200,
        clientY: 100,
      }));

      // Move fingers apart (zoom in)
      element.dispatchEvent(createPointerEvent('pointermove', {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 50,
        clientY: 100,
      }));
      element.dispatchEvent(createPointerEvent('pointermove', {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 250,
        clientY: 100,
      }));

      // Should call zoom callback with scale > 1
      expect(zoomCallback).toHaveBeenCalled();
      const scale = zoomCallback.mock.calls[zoomCallback.mock.calls.length - 1][0];
      expect(scale).toBeGreaterThan(1);

      zoomHandler.detach();
    });

    it('should call onZoom with scale < 1 when pinching in', () => {
      const zoomCallback = vi.fn();
      const zoomHandler = new PointerHandler(mockWriter, {}, undefined, zoomCallback);
      zoomHandler.attach(element);

      // Two fingers down, 200px apart
      element.dispatchEvent(createPointerEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 100,
        clientY: 100,
      }));
      element.dispatchEvent(createPointerEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 300,
        clientY: 100,
      }));

      // Move fingers closer (zoom out)
      element.dispatchEvent(createPointerEvent('pointermove', {
        pointerType: 'touch',
        pointerId: 1,
        clientX: 150,
        clientY: 100,
      }));
      element.dispatchEvent(createPointerEvent('pointermove', {
        pointerType: 'touch',
        pointerId: 2,
        clientX: 250,
        clientY: 100,
      }));

      // Should call zoom callback with scale < 1
      expect(zoomCallback).toHaveBeenCalled();
      const scale = zoomCallback.mock.calls[zoomCallback.mock.calls.length - 1][0];
      expect(scale).toBeLessThan(1);

      zoomHandler.detach();
    });
  });
});
