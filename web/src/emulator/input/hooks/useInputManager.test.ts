/**
 * Tests for useInputManager hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInputManager } from './useInputManager';

// Create a mock SharedArrayBuffer-like Int32Array
// Buffer must be large enough to hold all InputBufferAddresses (max index 19)
function createMockBuffer(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(80));
}

// Create a mock canvas element
function createMockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  canvas.getBoundingClientRect = () => ({
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
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn().mockReturnValue(false);
  return canvas;
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

// Polyfill DataTransfer for jsdom
class MockDataTransfer {
  private data = new Map<string, string>();

  setData(format: string, data: string): void {
    this.data.set(format, data);
  }

  getData(format: string): string {
    return this.data.get(format) ?? '';
  }
}

if (typeof DataTransfer === 'undefined') {
  (globalThis as any).DataTransfer = MockDataTransfer;
}

// Polyfill ClipboardEvent for jsdom
class MockClipboardEvent extends Event {
  clipboardData: MockDataTransfer | null;

  constructor(type: string, init?: { clipboardData?: MockDataTransfer; bubbles?: boolean }) {
    super(type, { bubbles: init?.bubbles ?? true, cancelable: true });
    this.clipboardData = init?.clipboardData ?? null;
  }
}

if (typeof ClipboardEvent === 'undefined') {
  (globalThis as any).ClipboardEvent = MockClipboardEvent;
}

describe('useInputManager', () => {
  let buffer: Int32Array;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    buffer = createMockBuffer();
    canvas = createMockCanvas();
    document.body.appendChild(canvas);
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.removeChild(canvas);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should return input manager state', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      expect(result.current.releaseAllKeys).toBeDefined();
      expect(result.current.setClipboardText).toBeDefined();
      expect(result.current.getPressedKeys).toBeDefined();
      expect(result.current.triggerVirtualKeyboard).toBeDefined();
      expect(typeof result.current.isTouchActive).toBe('boolean');
      expect(typeof result.current.showVirtualKeyboardButton).toBe('boolean');
    });

    it('should not attach when disabled', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() =>
        useInputManager(canvasRef, buffer, { enabled: false })
      );

      // Should still return valid state
      expect(result.current.getPressedKeys()).toEqual(new Set());
    });

    it('should not attach when buffer is null', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, null));

      // Should still return valid state
      expect(result.current.getPressedKeys()).toEqual(new Set());
    });

    it('should not attach when canvas ref is null', () => {
      const canvasRef = { current: null };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      // Should still return valid state
      expect(result.current.getPressedKeys()).toEqual(new Set());
    });
  });

  describe('releaseAllKeys', () => {
    it('should call releaseAllKeys without error', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      act(() => {
        result.current.releaseAllKeys();
      });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('setClipboardText', () => {
    it('should write to system clipboard', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
      });

      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      await act(async () => {
        await result.current.setClipboardText('Hello World');
      });

      expect(writeTextMock).toHaveBeenCalledWith('Hello World');
    });
  });

  describe('getPressedKeys', () => {
    it('should return empty set initially', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      expect(result.current.getPressedKeys()).toEqual(new Set());
    });

    it('should return empty set when manager is not attached', () => {
      const canvasRef = { current: null };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      expect(result.current.getPressedKeys()).toEqual(new Set());
    });
  });

  describe('isTouchActive', () => {
    it('should be false initially', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      expect(result.current.isTouchActive).toBe(false);
    });
  });

  describe('showVirtualKeyboardButton', () => {
    it('should be false on non-touch devices', () => {
      // Mock matchMedia to return false for touch query
      const matchMediaMock = vi.fn().mockReturnValue({ matches: false });
      Object.defineProperty(window, 'matchMedia', {
        value: matchMediaMock,
        configurable: true,
      });

      // Mock navigator to have no touch points
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });

      // Mock window to have desktop-sized viewport
      Object.defineProperty(window, 'innerWidth', {
        value: 1920,
        configurable: true,
      });

      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      expect(result.current.showVirtualKeyboardButton).toBe(false);
    });
  });

  describe('triggerVirtualKeyboard', () => {
    it('should not throw when called', () => {
      const canvasRef = { current: canvas };
      const { result } = renderHook(() => useInputManager(canvasRef, buffer));

      act(() => {
        result.current.triggerVirtualKeyboard();
      });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should detach on unmount', () => {
      const canvasRef = { current: canvas };
      const { unmount } = renderHook(() => useInputManager(canvasRef, buffer));

      // Should not throw
      unmount();
    });

    it('should detach when disabled changes', () => {
      const canvasRef = { current: canvas };
      const { rerender } = renderHook(
        ({ enabled }) => useInputManager(canvasRef, buffer, { enabled }),
        { initialProps: { enabled: true } }
      );

      // Disable
      rerender({ enabled: false });

      // Re-enable
      rerender({ enabled: true });

      // Should not throw
      expect(true).toBe(true);
    });

    it('should clean up interval on unmount', () => {
      const canvasRef = { current: canvas };
      const { unmount } = renderHook(() => useInputManager(canvasRef, buffer));

      // Advance timers to trigger the interval
      act(() => {
        vi.advanceTimersByTime(200);
      });

      unmount();

      // Should not throw after unmount
      act(() => {
        vi.advanceTimersByTime(200);
      });
    });
  });

  describe('clipboard callback', () => {
    it('should call onClipboardText when text is pasted', () => {
      const onClipboardText = vi.fn();
      const canvasRef = { current: canvas };

      renderHook(() =>
        useInputManager(canvasRef, buffer, { onClipboardText })
      );

      // Simulate a paste event
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'Pasted text');
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
      });
      document.dispatchEvent(pasteEvent);

      expect(onClipboardText).toHaveBeenCalledWith('Pasted text');
    });
  });
});
