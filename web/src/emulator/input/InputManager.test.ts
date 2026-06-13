/**
 * Tests for InputManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputManager } from './InputManager';

// Create a mock SharedArrayBuffer-like Int32Array
// Buffer must be large enough to hold all InputBufferAddresses (max index 19)
function createMockBuffer(): Int32Array {
  return new Int32Array(new SharedArrayBuffer(80));
}

// Create a mock element
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
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn().mockReturnValue(false);
  return element;
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

describe('InputManager', () => {
  let buffer: Int32Array;
  let manager: InputManager;
  let element: HTMLElement;

  beforeEach(() => {
    buffer = createMockBuffer();
    element = createMockElement();
    manager = new InputManager(buffer);
  });

  afterEach(() => {
    manager.detach();
    vi.restoreAllMocks();
  });

  describe('attach/detach', () => {
    it('should attach to an element', () => {
      manager.attach(element);

      // Should not throw
      expect(() => manager.attach(element)).not.toThrow();
    });

    it('should throw when attaching to window', () => {
      expect(() => manager.attach(window)).toThrow(
        'InputManager must be attached to an element, not window'
      );
    });

    it('should detach cleanly', () => {
      manager.attach(element);
      manager.detach();

      // Should be able to attach again
      expect(() => manager.attach(element)).not.toThrow();
    });

    it('should only attach once', () => {
      manager.attach(element);
      manager.attach(element); // Should be no-op

      // Detach should work
      manager.detach();
    });
  });

  describe('keyboard handler integration', () => {
    it('should release all keys', () => {
      manager.attach(element);

      // Should not throw
      expect(() => manager.releaseAllKeys()).not.toThrow();
    });

    it('should get pressed keys', () => {
      manager.attach(element);

      const keys = manager.getPressedKeys();
      expect(keys).toBeInstanceOf(Set);
      expect(keys.size).toBe(0);
    });

    it('should provide access to keyboard handler', () => {
      manager.attach(element);

      const handler = manager.getKeyboardHandler();
      expect(handler).toBeDefined();
      expect(typeof handler.releaseAllKeys).toBe('function');
    });
  });

  describe('pointer handler integration', () => {
    it('should check touch active state', () => {
      manager.attach(element);

      expect(manager.isTouchActive()).toBe(false);
    });

    it('should provide access to pointer handler', () => {
      manager.attach(element);

      const handler = manager.getPointerHandler();
      expect(handler).toBeDefined();
      expect(typeof handler.isTouchActive).toBe('function');
    });
  });

  describe('clipboard handler integration', () => {
    it('should get clipboard text', () => {
      manager.attach(element);

      expect(manager.getClipboardText()).toBe('');
    });

    it('should clear clipboard text', () => {
      manager.attach(element);

      // Should not throw
      expect(() => manager.clearClipboardText()).not.toThrow();
    });

    it('should provide access to clipboard handler', () => {
      manager.attach(element);

      const handler = manager.getClipboardHandler();
      expect(handler).toBeDefined();
      expect(typeof handler.getClipboardText).toBe('function');
    });

    it('should call clipboard callback when text is pasted', () => {
      const callback = vi.fn();
      manager = new InputManager(buffer, {}, callback);
      manager.attach(element);

      // Simulate a paste event
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', 'Test paste');
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dataTransfer,
        bubbles: true,
      });
      document.dispatchEvent(pasteEvent);

      expect(callback).toHaveBeenCalledWith('Test paste');
    });
  });

  describe('virtual keyboard', () => {
    it('should report virtual keyboard button state', () => {
      // Mock touch device
      const matchMediaMock = vi.fn().mockReturnValue({ matches: true });
      Object.defineProperty(window, 'matchMedia', {
        value: matchMediaMock,
        configurable: true,
      });

      // Create new manager to pick up the mock
      const touchManager = new InputManager(buffer);
      touchManager.attach(element);

      expect(touchManager.shouldShowVirtualKeyboardButton()).toBe(true);

      touchManager.detach();
    });

    it('should trigger virtual keyboard', () => {
      manager.attach(element);

      // Should not throw even if no virtual keyboard input exists
      expect(() => manager.triggerVirtualKeyboard()).not.toThrow();
    });
  });

  describe('reset', () => {
    it('should reset all handlers', () => {
      manager.attach(element);

      // Should not throw
      expect(() => manager.reset()).not.toThrow();
    });
  });

  describe('configuration', () => {
    it('should accept keyboard config', () => {
      manager = new InputManager(buffer, {
        keyboard: {
          preventDefaults: false,
          preventCommandW: false,
        },
      });
      manager.attach(element);

      // Should not throw
      expect(() => manager.detach()).not.toThrow();
    });

    it('should accept pointer config', () => {
      manager = new InputManager(buffer, {
        pointer: {
          enableGestures: false,
          captureOnDrag: false,
        },
      });
      manager.attach(element);

      expect(() => manager.detach()).not.toThrow();
    });

    it('should accept clipboard config', () => {
      manager = new InputManager(buffer, {
        clipboard: {
          maxLength: 1000,
        },
      });
      manager.attach(element);

      expect(() => manager.detach()).not.toThrow();
    });
  });
});
