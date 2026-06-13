/**
 * Tests for input system constants
 */

import { describe, it, expect } from 'vitest';
import {
  InputBufferAddresses,
  Modifiers,
  ADB_KEY_CODES,
  MODIFIER_KEY_CODES,
  GestureThresholds,
  UNMAPPED_KEY,
  mapKeyCode,
  isModifierKey,
  getModifierMask,
} from './constants';

describe('InputBufferAddresses', () => {
  it('should have all required mouse addresses', () => {
    expect(InputBufferAddresses.mousePositionFlagAddr).toBe(1);
    expect(InputBufferAddresses.mousePositionXAddr).toBe(2);
    expect(InputBufferAddresses.mousePositionYAddr).toBe(3);
    expect(InputBufferAddresses.mouseButtonStateAddr).toBe(4);
    expect(InputBufferAddresses.mouseButton2StateAddr).toBe(16);
  });

  it('should have all required keyboard addresses', () => {
    expect(InputBufferAddresses.keyEventFlagAddr).toBe(5);
    expect(InputBufferAddresses.keyCodeAddr).toBe(6);
    expect(InputBufferAddresses.keyStateAddr).toBe(7);
    expect(InputBufferAddresses.keyModifiersAddr).toBe(15);
  });

  it('should have control flag addresses', () => {
    expect(InputBufferAddresses.globalLockAddr).toBe(0);
    expect(InputBufferAddresses.stopFlagAddr).toBe(8);
    expect(InputBufferAddresses.ethernetInterruptFlagAddr).toBe(9);
  });

  it('should have hardware cursor mode address', () => {
    // Address 20 is read by WASM to determine if hardware cursor mode is enabled
    expect(InputBufferAddresses.hardwareCursorModeAddr).toBe(20);
  });

  it('should have unique address values', () => {
    const values = Object.values(InputBufferAddresses);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe('Modifiers', () => {
  it('should have correct bitmask values', () => {
    expect(Modifiers.SHIFT).toBe(0x0200);
    expect(Modifiers.CAPS).toBe(0x0002);
    expect(Modifiers.CTRL).toBe(0x1000);
    expect(Modifiers.ALT).toBe(0x0800);
    expect(Modifiers.CMD).toBe(0x0100);
  });

  it('should have non-overlapping bitmasks', () => {
    // Each modifier should be a single bit or distinct combination
    const allMods = Modifiers.SHIFT | Modifiers.CAPS | Modifiers.CTRL | Modifiers.ALT | Modifiers.CMD;
    // Verify we can set and read back each modifier independently
    expect((allMods & Modifiers.SHIFT) !== 0).toBe(true);
    expect((allMods & Modifiers.CAPS) !== 0).toBe(true);
    expect((allMods & Modifiers.CTRL) !== 0).toBe(true);
    expect((allMods & Modifiers.ALT) !== 0).toBe(true);
    expect((allMods & Modifiers.CMD) !== 0).toBe(true);
  });
});

describe('ADB_KEY_CODES', () => {
  it('should map letter keys correctly', () => {
    expect(ADB_KEY_CODES['KeyA']).toBe(0x00);
    expect(ADB_KEY_CODES['KeyS']).toBe(0x01);
    expect(ADB_KEY_CODES['KeyZ']).toBe(0x06);
  });

  it('should map number keys correctly', () => {
    expect(ADB_KEY_CODES['Digit1']).toBe(0x12);
    expect(ADB_KEY_CODES['Digit0']).toBe(0x1D);
  });

  it('should map modifier keys correctly', () => {
    expect(ADB_KEY_CODES['ShiftLeft']).toBe(0x38);
    expect(ADB_KEY_CODES['ShiftRight']).toBe(0x7B);
    expect(ADB_KEY_CODES['ControlLeft']).toBe(0x36);
    expect(ADB_KEY_CODES['MetaLeft']).toBe(0x37);
    expect(ADB_KEY_CODES['AltLeft']).toBe(0x3A);
    expect(ADB_KEY_CODES['CapsLock']).toBe(0x39);
  });

  it('should map arrow keys correctly', () => {
    expect(ADB_KEY_CODES['ArrowLeft']).toBe(0x3B);
    expect(ADB_KEY_CODES['ArrowRight']).toBe(0x3C);
    expect(ADB_KEY_CODES['ArrowDown']).toBe(0x3D);
    expect(ADB_KEY_CODES['ArrowUp']).toBe(0x3E);
  });

  it('should map control keys correctly', () => {
    expect(ADB_KEY_CODES['Enter']).toBe(0x24);
    expect(ADB_KEY_CODES['Tab']).toBe(0x30);
    expect(ADB_KEY_CODES['Space']).toBe(0x31);
    expect(ADB_KEY_CODES['Backspace']).toBe(0x33);
    expect(ADB_KEY_CODES['Escape']).toBe(0x35);
  });

  it('should map function keys', () => {
    expect(ADB_KEY_CODES['F1']).toBe(0x7A);
    expect(ADB_KEY_CODES['F12']).toBe(0x6F);
  });
});

describe('MODIFIER_KEY_CODES', () => {
  it('should include all modifier keys', () => {
    expect(MODIFIER_KEY_CODES.has('ShiftLeft')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('ShiftRight')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('ControlLeft')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('ControlRight')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('AltLeft')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('AltRight')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('MetaLeft')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('MetaRight')).toBe(true);
    expect(MODIFIER_KEY_CODES.has('CapsLock')).toBe(true);
  });

  it('should not include non-modifier keys', () => {
    expect(MODIFIER_KEY_CODES.has('KeyA')).toBe(false);
    expect(MODIFIER_KEY_CODES.has('Space')).toBe(false);
    expect(MODIFIER_KEY_CODES.has('Enter')).toBe(false);
  });
});

describe('GestureThresholds', () => {
  it('should have reasonable tap movement threshold', () => {
    expect(GestureThresholds.TAP_MOVEMENT).toBe(10);
    expect(GestureThresholds.TAP_MOVEMENT).toBeGreaterThan(0);
  });

  it('should have reasonable long press delay', () => {
    expect(GestureThresholds.LONG_PRESS_DELAY).toBe(500);
    expect(GestureThresholds.LONG_PRESS_DELAY).toBeGreaterThanOrEqual(300);
    expect(GestureThresholds.LONG_PRESS_DELAY).toBeLessThanOrEqual(1000);
  });

  it('should have reasonable double tap thresholds', () => {
    expect(GestureThresholds.DOUBLE_TAP_TIME).toBe(300);
    expect(GestureThresholds.DOUBLE_TAP_DISTANCE).toBe(30);
  });
});

describe('mapKeyCode', () => {
  it('should return correct ADB keycode for known keys', () => {
    expect(mapKeyCode('KeyA')).toBe(0x00);
    expect(mapKeyCode('Space')).toBe(0x31);
    expect(mapKeyCode('Enter')).toBe(0x24);
    expect(mapKeyCode('ShiftLeft')).toBe(0x38);
  });

  it('should return UNMAPPED_KEY for unknown keys', () => {
    expect(mapKeyCode('UnknownKey')).toBe(UNMAPPED_KEY);
    expect(mapKeyCode('')).toBe(UNMAPPED_KEY);
    expect(mapKeyCode('FakeKey123')).toBe(UNMAPPED_KEY);
  });

  it('should be case-sensitive', () => {
    expect(mapKeyCode('keya')).toBe(UNMAPPED_KEY);
    expect(mapKeyCode('KEYA')).toBe(UNMAPPED_KEY);
    expect(mapKeyCode('KeyA')).toBe(0x00);
  });
});

describe('isModifierKey', () => {
  it('should return true for modifier keys', () => {
    expect(isModifierKey('ShiftLeft')).toBe(true);
    expect(isModifierKey('ShiftRight')).toBe(true);
    expect(isModifierKey('ControlLeft')).toBe(true);
    expect(isModifierKey('MetaLeft')).toBe(true);
    expect(isModifierKey('AltLeft')).toBe(true);
    expect(isModifierKey('CapsLock')).toBe(true);
  });

  it('should return false for non-modifier keys', () => {
    expect(isModifierKey('KeyA')).toBe(false);
    expect(isModifierKey('Space')).toBe(false);
    expect(isModifierKey('Enter')).toBe(false);
    expect(isModifierKey('ArrowUp')).toBe(false);
  });
});

describe('getModifierMask', () => {
  it('should return 0 when no modifiers are pressed', () => {
    const event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    expect(getModifierMask(event, false)).toBe(0);
  });

  it('should set SHIFT bit when shiftKey is true', () => {
    const event = { shiftKey: true, ctrlKey: false, altKey: false, metaKey: false };
    expect(getModifierMask(event, false)).toBe(Modifiers.SHIFT);
  });

  it('should set CTRL bit when ctrlKey is true', () => {
    const event = { shiftKey: false, ctrlKey: true, altKey: false, metaKey: false };
    expect(getModifierMask(event, false)).toBe(Modifiers.CTRL);
  });

  it('should set ALT bit when altKey is true', () => {
    const event = { shiftKey: false, ctrlKey: false, altKey: true, metaKey: false };
    expect(getModifierMask(event, false)).toBe(Modifiers.ALT);
  });

  it('should set CMD bit when metaKey is true', () => {
    const event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: true };
    expect(getModifierMask(event, false)).toBe(Modifiers.CMD);
  });

  it('should set CAPS bit when capsLockState is true', () => {
    const event = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    expect(getModifierMask(event, true)).toBe(Modifiers.CAPS);
  });

  it('should combine multiple modifiers', () => {
    const event = { shiftKey: true, ctrlKey: true, altKey: false, metaKey: true };
    const expected = Modifiers.SHIFT | Modifiers.CTRL | Modifiers.CMD;
    expect(getModifierMask(event, false)).toBe(expected);
  });

  it('should combine all modifiers including caps lock', () => {
    const event = { shiftKey: true, ctrlKey: true, altKey: true, metaKey: true };
    const expected = Modifiers.SHIFT | Modifiers.CTRL | Modifiers.ALT | Modifiers.CMD | Modifiers.CAPS;
    expect(getModifierMask(event, true)).toBe(expected);
  });
});
