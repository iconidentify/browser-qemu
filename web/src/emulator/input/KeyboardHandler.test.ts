/**
 * Tests for KeyboardHandler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardHandler, createAtomicsBufferWriter, isMacOS } from './KeyboardHandler';
import { Modifiers, mapKeyCode, InputBufferAddresses } from './constants';
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

// Track Caps Lock state for test simulation
let testCapsLockState = false;

// Create a mock keyboard event with getModifierState support
function createKeyboardEvent(
  type: 'keydown' | 'keyup',
  code: string,
  options: Partial<KeyboardEventInit> & { capsLock?: boolean } = {}
): KeyboardEvent {
  const { capsLock, ...eventOptions } = options;

  // Simulate Caps Lock toggle behavior
  if (code === 'CapsLock' && type === 'keydown') {
    testCapsLockState = !testCapsLockState;
  }

  const event = new KeyboardEvent(type, {
    code,
    key: code,
    bubbles: true,
    cancelable: true,
    ...eventOptions,
  });

  // Mock getModifierState to return the correct Caps Lock state
  const capsLockValue = capsLock ?? testCapsLockState;
  Object.defineProperty(event, 'getModifierState', {
    value: (modifier: string) => {
      if (modifier === 'CapsLock') return capsLockValue;
      if (modifier === 'Shift') return eventOptions.shiftKey ?? false;
      if (modifier === 'Control') return eventOptions.ctrlKey ?? false;
      if (modifier === 'Alt') return eventOptions.altKey ?? false;
      if (modifier === 'Meta') return eventOptions.metaKey ?? false;
      return false;
    },
    writable: false,
    configurable: true,
  });

  return event;
}

// Helper to dispatch keyboard events
function dispatchKeyEvent(
  type: 'keydown' | 'keyup',
  code: string,
  options: Partial<KeyboardEventInit> & { capsLock?: boolean } = {}
): void {
  const event = createKeyboardEvent(type, code, options);
  // Dispatch on window - keydown/keyup events are typically global
  window.dispatchEvent(event);
}

describe('KeyboardHandler', () => {
  let mockWriter: ReturnType<typeof createMockBufferWriter>;
  let handler: KeyboardHandler;

  beforeEach(() => {
    mockWriter = createMockBufferWriter();
    handler = new KeyboardHandler(mockWriter);
    handler.attach(window);
    // Reset test Caps Lock state
    testCapsLockState = false;
  });

  afterEach(() => {
    handler.detach();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('key events', () => {
    it('should write key down event to buffer', () => {
      dispatchKeyEvent('keydown', 'KeyA');

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(1);
      expect(keyEvents[0].args).toEqual([mapKeyCode('KeyA'), true]);
    });

    it('should write key up event to buffer', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      mockWriter.clear();
      dispatchKeyEvent('keyup', 'KeyA');

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(1);
      expect(keyEvents[0].args).toEqual([mapKeyCode('KeyA'), false]);
    });

    it('should track pressed keys', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      dispatchKeyEvent('keydown', 'KeyB');

      const pressed = handler.getPressedKeys();
      expect(pressed.has('KeyA')).toBe(true);
      expect(pressed.has('KeyB')).toBe(true);
    });

    it('should remove keys from tracking on keyup', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      dispatchKeyEvent('keyup', 'KeyA');

      const pressed = handler.getPressedKeys();
      expect(pressed.has('KeyA')).toBe(false);
    });

    it('should ignore unmapped keys', () => {
      dispatchKeyEvent('keydown', 'UnknownKey');

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(0);
    });
  });

  describe('modifier tracking', () => {
    it('should update modifiers on shift key', () => {
      dispatchKeyEvent('keydown', 'ShiftLeft', { shiftKey: true });

      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0] & Modifiers.SHIFT).toBe(Modifiers.SHIFT);
    });

    it('should update modifiers on ctrl key', () => {
      dispatchKeyEvent('keydown', 'ControlLeft', { ctrlKey: true });

      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0] & Modifiers.CTRL).toBe(Modifiers.CTRL);
    });

    it('should update modifiers on alt key', () => {
      dispatchKeyEvent('keydown', 'AltLeft', { altKey: true });

      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0] & Modifiers.ALT).toBe(Modifiers.ALT);
    });

    it('should update modifiers on meta key', () => {
      dispatchKeyEvent('keydown', 'MetaLeft', { metaKey: true });

      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0] & Modifiers.CMD).toBe(Modifiers.CMD);
    });

    it('should combine multiple modifiers', () => {
      dispatchKeyEvent('keydown', 'KeyA', {
        shiftKey: true,
        ctrlKey: true,
        metaKey: true,
      });

      const expected = Modifiers.SHIFT | Modifiers.CTRL | Modifiers.CMD;
      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0]).toBe(expected);
    });

    it('should return correct modifier state', () => {
      dispatchKeyEvent('keydown', 'ShiftLeft', { shiftKey: true });
      expect(handler.getModifierState() & Modifiers.SHIFT).toBe(Modifiers.SHIFT);
    });
  });

  describe('Caps Lock handling', () => {
    it('should toggle caps lock state on keydown', () => {
      expect(handler.getCapsLockState()).toBe(false);

      dispatchKeyEvent('keydown', 'CapsLock');
      expect(handler.getCapsLockState()).toBe(true);

      dispatchKeyEvent('keydown', 'CapsLock');
      expect(handler.getCapsLockState()).toBe(false);
    });

    it('should send key down then key up for caps lock', () => {
      vi.useFakeTimers();

      dispatchKeyEvent('keydown', 'CapsLock');

      // Key down should be sent immediately
      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents[0].args).toEqual([mapKeyCode('CapsLock'), true]);

      // Key up should be sent after timeout
      vi.advanceTimersByTime(50);

      const allKeyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(allKeyEvents[1].args).toEqual([mapKeyCode('CapsLock'), false]);
    });

    it('should include CAPS modifier when caps lock is on', () => {
      dispatchKeyEvent('keydown', 'CapsLock');
      mockWriter.clear();
      dispatchKeyEvent('keydown', 'KeyA');

      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0] & Modifiers.CAPS).toBe(Modifiers.CAPS);
    });
  });

  describe('macOS Command+Key bug fix', () => {
    it('should release non-modifier keys when Meta is released', () => {
      // Create handler with macOS bug fix enabled
      handler.detach();
      handler = new KeyboardHandler(mockWriter, { fixMacCommandKeyBug: true });
      handler.attach(window);

      // Press Command+S
      dispatchKeyEvent('keydown', 'MetaLeft', { metaKey: true });
      dispatchKeyEvent('keydown', 'KeyS', { metaKey: true });

      mockWriter.clear();

      // Release Command (but KeyS keyup never fires - this is the bug)
      dispatchKeyEvent('keyup', 'MetaLeft');

      // The handler should synthesize keyup for KeyS
      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.some(e => e.args[0] === mapKeyCode('KeyS') && e.args[1] === false)).toBe(true);
    });

    it('should not release modifier keys when Meta is released', () => {
      handler.detach();
      handler = new KeyboardHandler(mockWriter, { fixMacCommandKeyBug: true });
      handler.attach(window);

      // Press Command+Shift
      dispatchKeyEvent('keydown', 'MetaLeft', { metaKey: true });
      dispatchKeyEvent('keydown', 'ShiftLeft', { metaKey: true, shiftKey: true });

      mockWriter.clear();

      // Release Command
      dispatchKeyEvent('keyup', 'MetaLeft', { shiftKey: true });

      // Shift should still be tracked as pressed
      expect(handler.getPressedKeys().has('ShiftLeft')).toBe(true);
    });
  });

  describe('hasMetaKeyPressed', () => {
    it('should return true when MetaLeft is pressed', () => {
      dispatchKeyEvent('keydown', 'MetaLeft', { metaKey: true });
      expect(handler.hasMetaKeyPressed()).toBe(true);
    });

    it('should return true when MetaRight is pressed', () => {
      dispatchKeyEvent('keydown', 'MetaRight', { metaKey: true });
      expect(handler.hasMetaKeyPressed()).toBe(true);
    });

    it('should return false when no Meta key is pressed', () => {
      expect(handler.hasMetaKeyPressed()).toBe(false);
    });
  });

  describe('releaseAllKeys', () => {
    it('should send keyup for all pressed keys', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      dispatchKeyEvent('keydown', 'KeyB');
      dispatchKeyEvent('keydown', 'KeyC');

      mockWriter.clear();
      handler.releaseAllKeys();

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(3);
      expect(keyEvents.every(e => e.args[1] === false)).toBe(true);
    });

    it('should clear pressed keys set', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      handler.releaseAllKeys();

      expect(handler.getPressedKeys().size).toBe(0);
    });
  });

  describe('reset', () => {
    it('should release all keys', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      mockWriter.clear();

      handler.reset();

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(1);
      expect(keyEvents[0].args[1]).toBe(false);
    });

    it('should clear caps lock state on reset', () => {
      // New behavior: Caps Lock is cleared on reset/blur to prevent stuck state.
      // The next keydown will sync with the host OS via getModifierState().
      dispatchKeyEvent('keydown', 'CapsLock');
      expect(handler.getCapsLockState()).toBe(true);

      handler.reset();

      expect(handler.getCapsLockState()).toBe(false);
      const modCalls = mockWriter.calls.filter(c => c.method === 'writeModifiers');
      const lastMod = modCalls[modCalls.length - 1];
      expect(lastMod.args[0]).toBe(0); // All modifiers cleared
    });
  });

  describe('blur handling', () => {
    it('should release all keys on blur', () => {
      dispatchKeyEvent('keydown', 'KeyA');
      dispatchKeyEvent('keydown', 'KeyB');

      mockWriter.clear();
      window.dispatchEvent(new Event('blur'));

      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(2);
    });
  });

  describe('attach/detach', () => {
    it('should not process events after detach', () => {
      handler.detach();
      mockWriter.clear();

      dispatchKeyEvent('keydown', 'KeyA');

      expect(mockWriter.calls.length).toBe(0);
    });

    it('should only attach once', () => {
      handler.attach(window);
      handler.attach(window);

      dispatchKeyEvent('keydown', 'KeyA');

      // Should only get one key event, not duplicates
      const keyEvents = mockWriter.calls.filter(c => c.method === 'writeKeyEvent');
      expect(keyEvents.length).toBe(1);
    });
  });

  describe('event prevention', () => {
    it('should prevent default when configured', () => {
      const event = createKeyboardEvent('keydown', 'KeyA');
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      window.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('should not prevent default when disabled', () => {
      handler.detach();
      handler = new KeyboardHandler(mockWriter, { preventDefaults: false });
      handler.attach(window);

      const event = createKeyboardEvent('keydown', 'KeyA');
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

      window.dispatchEvent(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });
});

describe('createAtomicsBufferWriter', () => {
  it('should write mouse position using Atomics', () => {
    const buffer = new Int32Array(new SharedArrayBuffer(80));
    const writer = createAtomicsBufferWriter(buffer);

    writer.writeMousePosition(100, 200);

    expect(Atomics.load(buffer, InputBufferAddresses.mousePositionXAddr)).toBe(100);
    expect(Atomics.load(buffer, InputBufferAddresses.mousePositionYAddr)).toBe(200);
    expect(Atomics.load(buffer, InputBufferAddresses.mousePositionFlagAddr)).toBe(1);
  });

  it('should write primary mouse button', () => {
    const buffer = new Int32Array(new SharedArrayBuffer(80));
    const writer = createAtomicsBufferWriter(buffer);

    writer.writeMouseButton(0, true);
    expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr)).toBe(1);

    writer.writeMouseButton(0, false);
    expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr)).toBe(0);
  });

  it('should write secondary mouse button', () => {
    const buffer = new Int32Array(new SharedArrayBuffer(80));
    const writer = createAtomicsBufferWriter(buffer);

    writer.writeMouseButton(1, true);
    expect(Atomics.load(buffer, InputBufferAddresses.mouseButton2StateAddr)).toBe(1);
  });

  it('should write key event', () => {
    const buffer = new Int32Array(new SharedArrayBuffer(80));
    const writer = createAtomicsBufferWriter(buffer);

    writer.writeKeyEvent(0x00, true);

    expect(Atomics.load(buffer, InputBufferAddresses.keyCodeAddr)).toBe(0x00);
    expect(Atomics.load(buffer, InputBufferAddresses.keyStateAddr)).toBe(1);
    expect(Atomics.load(buffer, InputBufferAddresses.keyEventFlagAddr)).toBe(1);
  });

  it('should write modifiers', () => {
    const buffer = new Int32Array(new SharedArrayBuffer(80));
    const writer = createAtomicsBufferWriter(buffer);

    const mods = Modifiers.SHIFT | Modifiers.CMD;
    writer.writeModifiers(mods);

    expect(Atomics.load(buffer, InputBufferAddresses.keyModifiersAddr)).toBe(mods);
  });
});

describe('isMacOS', () => {
  it('should return boolean', () => {
    expect(typeof isMacOS()).toBe('boolean');
  });
});
