/**
 * DOS Scancode Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DOS_SCAN_CODES,
  mapDosScanCode,
  EXTENDED_KEYS,
  isExtendedKey,
  DOS_SHIFT_FLAGS,
  UNMAPPED_KEY,
} from './dos-scancode';

describe('dos-scancode', () => {
  describe('DOS_SCAN_CODES', () => {
    it('should map escape and function keys correctly', () => {
      expect(DOS_SCAN_CODES['Escape']).toBe(0x01);
      expect(DOS_SCAN_CODES['F1']).toBe(0x3B);
      expect(DOS_SCAN_CODES['F10']).toBe(0x44);
      expect(DOS_SCAN_CODES['F11']).toBe(0x57);
      expect(DOS_SCAN_CODES['F12']).toBe(0x58);
    });

    it('should map number row correctly', () => {
      expect(DOS_SCAN_CODES['Backquote']).toBe(0x29);
      expect(DOS_SCAN_CODES['Digit1']).toBe(0x02);
      expect(DOS_SCAN_CODES['Digit0']).toBe(0x0B);
      expect(DOS_SCAN_CODES['Minus']).toBe(0x0C);
      expect(DOS_SCAN_CODES['Equal']).toBe(0x0D);
      expect(DOS_SCAN_CODES['Backspace']).toBe(0x0E);
    });

    it('should map QWERTY row correctly', () => {
      expect(DOS_SCAN_CODES['Tab']).toBe(0x0F);
      expect(DOS_SCAN_CODES['KeyQ']).toBe(0x10);
      expect(DOS_SCAN_CODES['KeyW']).toBe(0x11);
      expect(DOS_SCAN_CODES['KeyP']).toBe(0x19);
      expect(DOS_SCAN_CODES['BracketLeft']).toBe(0x1A);
      expect(DOS_SCAN_CODES['BracketRight']).toBe(0x1B);
      expect(DOS_SCAN_CODES['Backslash']).toBe(0x2B);
    });

    it('should map home row correctly', () => {
      expect(DOS_SCAN_CODES['CapsLock']).toBe(0x3A);
      expect(DOS_SCAN_CODES['KeyA']).toBe(0x1E);
      expect(DOS_SCAN_CODES['KeyL']).toBe(0x26);
      expect(DOS_SCAN_CODES['Semicolon']).toBe(0x27);
      expect(DOS_SCAN_CODES['Quote']).toBe(0x28);
      expect(DOS_SCAN_CODES['Enter']).toBe(0x1C);
    });

    it('should map bottom row correctly', () => {
      expect(DOS_SCAN_CODES['ShiftLeft']).toBe(0x2A);
      expect(DOS_SCAN_CODES['KeyZ']).toBe(0x2C);
      expect(DOS_SCAN_CODES['KeyM']).toBe(0x32);
      expect(DOS_SCAN_CODES['Comma']).toBe(0x33);
      expect(DOS_SCAN_CODES['Period']).toBe(0x34);
      expect(DOS_SCAN_CODES['Slash']).toBe(0x35);
      expect(DOS_SCAN_CODES['ShiftRight']).toBe(0x36);
    });

    it('should map modifier keys correctly', () => {
      expect(DOS_SCAN_CODES['ControlLeft']).toBe(0x1D);
      expect(DOS_SCAN_CODES['AltLeft']).toBe(0x38);
      expect(DOS_SCAN_CODES['Space']).toBe(0x39);
      expect(DOS_SCAN_CODES['AltRight']).toBe(0x38);
      expect(DOS_SCAN_CODES['ControlRight']).toBe(0x1D);
    });

    it('should map numpad correctly', () => {
      expect(DOS_SCAN_CODES['NumLock']).toBe(0x45);
      expect(DOS_SCAN_CODES['NumpadDivide']).toBe(0x35);
      expect(DOS_SCAN_CODES['NumpadMultiply']).toBe(0x37);
      expect(DOS_SCAN_CODES['NumpadSubtract']).toBe(0x4A);
      expect(DOS_SCAN_CODES['Numpad7']).toBe(0x47);
      expect(DOS_SCAN_CODES['Numpad0']).toBe(0x52);
      expect(DOS_SCAN_CODES['NumpadEnter']).toBe(0x1C);
    });

    it('should map navigation cluster correctly', () => {
      expect(DOS_SCAN_CODES['Insert']).toBe(0x52);
      expect(DOS_SCAN_CODES['Delete']).toBe(0x53);
      expect(DOS_SCAN_CODES['Home']).toBe(0x47);
      expect(DOS_SCAN_CODES['End']).toBe(0x4F);
      expect(DOS_SCAN_CODES['PageUp']).toBe(0x49);
      expect(DOS_SCAN_CODES['PageDown']).toBe(0x51);
    });

    it('should map arrow keys correctly', () => {
      expect(DOS_SCAN_CODES['ArrowUp']).toBe(0x48);
      expect(DOS_SCAN_CODES['ArrowDown']).toBe(0x50);
      expect(DOS_SCAN_CODES['ArrowLeft']).toBe(0x4B);
      expect(DOS_SCAN_CODES['ArrowRight']).toBe(0x4D);
    });
  });

  describe('mapDosScanCode', () => {
    it('should return correct scancode for known keys', () => {
      expect(mapDosScanCode('Escape')).toBe(0x01);
      expect(mapDosScanCode('KeyA')).toBe(0x1E);
      expect(mapDosScanCode('Space')).toBe(0x39);
    });

    it('should return UNMAPPED_KEY for unknown keys', () => {
      expect(mapDosScanCode('UnknownKey')).toBe(UNMAPPED_KEY);
      expect(mapDosScanCode('')).toBe(UNMAPPED_KEY);
    });
  });

  describe('EXTENDED_KEYS', () => {
    it('should include navigation cluster keys', () => {
      expect(EXTENDED_KEYS.has('Insert')).toBe(true);
      expect(EXTENDED_KEYS.has('Delete')).toBe(true);
      expect(EXTENDED_KEYS.has('Home')).toBe(true);
      expect(EXTENDED_KEYS.has('End')).toBe(true);
      expect(EXTENDED_KEYS.has('PageUp')).toBe(true);
      expect(EXTENDED_KEYS.has('PageDown')).toBe(true);
    });

    it('should include arrow keys', () => {
      expect(EXTENDED_KEYS.has('ArrowUp')).toBe(true);
      expect(EXTENDED_KEYS.has('ArrowDown')).toBe(true);
      expect(EXTENDED_KEYS.has('ArrowLeft')).toBe(true);
      expect(EXTENDED_KEYS.has('ArrowRight')).toBe(true);
    });

    it('should include numpad special keys', () => {
      expect(EXTENDED_KEYS.has('NumpadDivide')).toBe(true);
      expect(EXTENDED_KEYS.has('NumpadEnter')).toBe(true);
    });

    it('should include right-side modifiers', () => {
      expect(EXTENDED_KEYS.has('ControlRight')).toBe(true);
      expect(EXTENDED_KEYS.has('AltRight')).toBe(true);
      expect(EXTENDED_KEYS.has('MetaLeft')).toBe(true);
      expect(EXTENDED_KEYS.has('MetaRight')).toBe(true);
      expect(EXTENDED_KEYS.has('ContextMenu')).toBe(true);
    });

    it('should include PrintScreen', () => {
      expect(EXTENDED_KEYS.has('PrintScreen')).toBe(true);
    });

    it('should not include regular keys', () => {
      expect(EXTENDED_KEYS.has('KeyA')).toBe(false);
      expect(EXTENDED_KEYS.has('Space')).toBe(false);
      expect(EXTENDED_KEYS.has('Enter')).toBe(false);
      expect(EXTENDED_KEYS.has('ShiftLeft')).toBe(false);
    });
  });

  describe('isExtendedKey', () => {
    it('should return true for extended keys', () => {
      expect(isExtendedKey('ArrowUp')).toBe(true);
      expect(isExtendedKey('Insert')).toBe(true);
      expect(isExtendedKey('NumpadEnter')).toBe(true);
    });

    it('should return false for non-extended keys', () => {
      expect(isExtendedKey('KeyA')).toBe(false);
      expect(isExtendedKey('Enter')).toBe(false);
      expect(isExtendedKey('Numpad5')).toBe(false);
    });
  });

  describe('DOS_SHIFT_FLAGS', () => {
    it('should have correct flag values', () => {
      expect(DOS_SHIFT_FLAGS.RIGHT_SHIFT).toBe(0x01);
      expect(DOS_SHIFT_FLAGS.LEFT_SHIFT).toBe(0x02);
      expect(DOS_SHIFT_FLAGS.CTRL).toBe(0x04);
      expect(DOS_SHIFT_FLAGS.ALT).toBe(0x08);
      expect(DOS_SHIFT_FLAGS.SCROLL_LOCK).toBe(0x10);
      expect(DOS_SHIFT_FLAGS.NUM_LOCK).toBe(0x20);
      expect(DOS_SHIFT_FLAGS.CAPS_LOCK).toBe(0x40);
      expect(DOS_SHIFT_FLAGS.INSERT).toBe(0x80);
    });

    it('should have non-overlapping bit values', () => {
      const values = Object.values(DOS_SHIFT_FLAGS);
      for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
          expect(values[i] & values[j]).toBe(0);
        }
      }
    });
  });
});
