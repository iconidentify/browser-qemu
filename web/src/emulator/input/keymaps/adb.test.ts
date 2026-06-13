/**
 * ADB Keycode Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ADB_KEY_CODES,
  mapAdbKeyCode,
  ADB_MODIFIERS,
  getAdbModifierMask,
  UNMAPPED_KEY,
} from './adb';

describe('adb keymaps', () => {
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

    it('should map function keys correctly', () => {
      expect(ADB_KEY_CODES['F1']).toBe(0x7A);
      expect(ADB_KEY_CODES['F12']).toBe(0x6F);
    });

    it('should map modifier keys correctly', () => {
      expect(ADB_KEY_CODES['ShiftLeft']).toBe(0x38);
      expect(ADB_KEY_CODES['ShiftRight']).toBe(0x7B);
      expect(ADB_KEY_CODES['ControlLeft']).toBe(0x36);
      expect(ADB_KEY_CODES['AltLeft']).toBe(0x3A);
      expect(ADB_KEY_CODES['MetaLeft']).toBe(0x37); // Command key
    });

    it('should map arrow keys correctly', () => {
      expect(ADB_KEY_CODES['ArrowUp']).toBe(0x3E);
      expect(ADB_KEY_CODES['ArrowDown']).toBe(0x3D);
      expect(ADB_KEY_CODES['ArrowLeft']).toBe(0x3B);
      expect(ADB_KEY_CODES['ArrowRight']).toBe(0x3C);
    });

    it('should map special keys correctly', () => {
      expect(ADB_KEY_CODES['Enter']).toBe(0x24);
      expect(ADB_KEY_CODES['Tab']).toBe(0x30);
      expect(ADB_KEY_CODES['Space']).toBe(0x31);
      expect(ADB_KEY_CODES['Backspace']).toBe(0x33);
      expect(ADB_KEY_CODES['Escape']).toBe(0x35);
    });

    it('should map numpad keys correctly', () => {
      expect(ADB_KEY_CODES['Numpad0']).toBe(0x52);
      expect(ADB_KEY_CODES['NumpadEnter']).toBe(0x4C);
      expect(ADB_KEY_CODES['NumpadAdd']).toBe(0x45);
    });
  });

  describe('mapAdbKeyCode', () => {
    it('should return correct keycode for known keys', () => {
      expect(mapAdbKeyCode('KeyA')).toBe(0x00);
      expect(mapAdbKeyCode('Space')).toBe(0x31);
      expect(mapAdbKeyCode('Enter')).toBe(0x24);
    });

    it('should return UNMAPPED_KEY for unknown keys', () => {
      expect(mapAdbKeyCode('UnknownKey')).toBe(UNMAPPED_KEY);
      expect(mapAdbKeyCode('')).toBe(UNMAPPED_KEY);
      expect(mapAdbKeyCode('RandomString')).toBe(UNMAPPED_KEY);
    });
  });

  describe('ADB_MODIFIERS', () => {
    it('should have correct modifier bit values', () => {
      expect(ADB_MODIFIERS.SHIFT).toBe(0x0200);
      expect(ADB_MODIFIERS.CAPS).toBe(0x0002);
      expect(ADB_MODIFIERS.CTRL).toBe(0x1000);
      expect(ADB_MODIFIERS.ALT).toBe(0x0800);
      expect(ADB_MODIFIERS.CMD).toBe(0x0100);
    });

    it('should have non-overlapping bit values', () => {
      const values = Object.values(ADB_MODIFIERS);
      for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
          expect(values[i] & values[j]).toBe(0);
        }
      }
    });
  });

  describe('getAdbModifierMask', () => {
    // Create a mock keyboard event
    function createMockEvent(modifiers: {
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
    }): KeyboardEvent {
      return {
        shiftKey: modifiers.shiftKey || false,
        ctrlKey: modifiers.ctrlKey || false,
        altKey: modifiers.altKey || false,
        metaKey: modifiers.metaKey || false,
      } as KeyboardEvent;
    }

    it('should return 0 for no modifiers', () => {
      const event = createMockEvent({});
      expect(getAdbModifierMask(event, false)).toBe(0);
    });

    it('should include SHIFT when shiftKey is true', () => {
      const event = createMockEvent({ shiftKey: true });
      const mask = getAdbModifierMask(event, false);
      expect(mask & ADB_MODIFIERS.SHIFT).toBe(ADB_MODIFIERS.SHIFT);
    });

    it('should include CTRL when ctrlKey is true', () => {
      const event = createMockEvent({ ctrlKey: true });
      const mask = getAdbModifierMask(event, false);
      expect(mask & ADB_MODIFIERS.CTRL).toBe(ADB_MODIFIERS.CTRL);
    });

    it('should include ALT when altKey is true', () => {
      const event = createMockEvent({ altKey: true });
      const mask = getAdbModifierMask(event, false);
      expect(mask & ADB_MODIFIERS.ALT).toBe(ADB_MODIFIERS.ALT);
    });

    it('should include CMD when metaKey is true', () => {
      const event = createMockEvent({ metaKey: true });
      const mask = getAdbModifierMask(event, false);
      expect(mask & ADB_MODIFIERS.CMD).toBe(ADB_MODIFIERS.CMD);
    });

    it('should include CAPS when capsLockState is true', () => {
      const event = createMockEvent({});
      const mask = getAdbModifierMask(event, true);
      expect(mask & ADB_MODIFIERS.CAPS).toBe(ADB_MODIFIERS.CAPS);
    });

    it('should combine multiple modifiers', () => {
      const event = createMockEvent({
        shiftKey: true,
        ctrlKey: true,
        metaKey: true,
      });
      const mask = getAdbModifierMask(event, true);

      expect(mask & ADB_MODIFIERS.SHIFT).toBe(ADB_MODIFIERS.SHIFT);
      expect(mask & ADB_MODIFIERS.CTRL).toBe(ADB_MODIFIERS.CTRL);
      expect(mask & ADB_MODIFIERS.CMD).toBe(ADB_MODIFIERS.CMD);
      expect(mask & ADB_MODIFIERS.CAPS).toBe(ADB_MODIFIERS.CAPS);
      expect(mask & ADB_MODIFIERS.ALT).toBe(0); // ALT not pressed
    });
  });
});
