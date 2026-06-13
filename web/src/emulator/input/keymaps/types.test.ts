/**
 * Keymap Types Tests
 */

import { describe, it, expect } from 'vitest';
import {
  UNMAPPED_KEY,
  createKeyMapper,
  getModifierState,
  isModifierKey,
  MODIFIER_KEY_CODES,
} from './types';

describe('keymap types', () => {
  describe('UNMAPPED_KEY', () => {
    it('should be -1', () => {
      expect(UNMAPPED_KEY).toBe(-1);
    });
  });

  describe('createKeyMapper', () => {
    it('should create a mapper that returns correct values', () => {
      const mapping = {
        'KeyA': 0x00,
        'KeyB': 0x01,
        'KeyC': 0x02,
      };
      const mapper = createKeyMapper(mapping);

      expect(mapper('KeyA')).toBe(0x00);
      expect(mapper('KeyB')).toBe(0x01);
      expect(mapper('KeyC')).toBe(0x02);
    });

    it('should return UNMAPPED_KEY for unknown keys', () => {
      const mapping = {
        'KeyA': 0x00,
      };
      const mapper = createKeyMapper(mapping);

      expect(mapper('KeyX')).toBe(UNMAPPED_KEY);
      expect(mapper('')).toBe(UNMAPPED_KEY);
      expect(mapper('Unknown')).toBe(UNMAPPED_KEY);
    });

    it('should handle empty mapping', () => {
      const mapper = createKeyMapper({});
      expect(mapper('KeyA')).toBe(UNMAPPED_KEY);
    });
  });

  describe('MODIFIER_KEY_CODES', () => {
    it('should contain all modifier keys', () => {
      expect(MODIFIER_KEY_CODES).toContain('ShiftLeft');
      expect(MODIFIER_KEY_CODES).toContain('ShiftRight');
      expect(MODIFIER_KEY_CODES).toContain('ControlLeft');
      expect(MODIFIER_KEY_CODES).toContain('ControlRight');
      expect(MODIFIER_KEY_CODES).toContain('AltLeft');
      expect(MODIFIER_KEY_CODES).toContain('AltRight');
      expect(MODIFIER_KEY_CODES).toContain('MetaLeft');
      expect(MODIFIER_KEY_CODES).toContain('MetaRight');
      expect(MODIFIER_KEY_CODES).toContain('CapsLock');
    });

    it('should not contain regular keys', () => {
      expect(MODIFIER_KEY_CODES).not.toContain('KeyA');
      expect(MODIFIER_KEY_CODES).not.toContain('Space');
      expect(MODIFIER_KEY_CODES).not.toContain('Enter');
    });
  });

  describe('isModifierKey', () => {
    it('should return true for modifier keys', () => {
      expect(isModifierKey('ShiftLeft')).toBe(true);
      expect(isModifierKey('ControlRight')).toBe(true);
      expect(isModifierKey('AltLeft')).toBe(true);
      expect(isModifierKey('MetaLeft')).toBe(true);
      expect(isModifierKey('CapsLock')).toBe(true);
    });

    it('should return false for non-modifier keys', () => {
      expect(isModifierKey('KeyA')).toBe(false);
      expect(isModifierKey('Space')).toBe(false);
      expect(isModifierKey('Enter')).toBe(false);
      expect(isModifierKey('ArrowUp')).toBe(false);
    });
  });

  describe('getModifierState', () => {
    // Create a mock keyboard event
    function createMockEvent(modifiers: {
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      capsLock?: boolean;
    }): KeyboardEvent {
      return {
        shiftKey: modifiers.shiftKey || false,
        ctrlKey: modifiers.ctrlKey || false,
        altKey: modifiers.altKey || false,
        metaKey: modifiers.metaKey || false,
        getModifierState: (key: string) => {
          if (key === 'CapsLock') return modifiers.capsLock || false;
          return false;
        },
      } as KeyboardEvent;
    }

    it('should return correct state for no modifiers', () => {
      const event = createMockEvent({});
      const state = getModifierState(event);

      expect(state.shift).toBe(false);
      expect(state.control).toBe(false);
      expect(state.alt).toBe(false);
      expect(state.meta).toBe(false);
      expect(state.capsLock).toBe(false);
    });

    it('should return correct state for shift', () => {
      const event = createMockEvent({ shiftKey: true });
      const state = getModifierState(event);

      expect(state.shift).toBe(true);
      expect(state.control).toBe(false);
    });

    it('should return correct state for control', () => {
      const event = createMockEvent({ ctrlKey: true });
      const state = getModifierState(event);

      expect(state.control).toBe(true);
      expect(state.alt).toBe(false);
    });

    it('should return correct state for alt', () => {
      const event = createMockEvent({ altKey: true });
      const state = getModifierState(event);

      expect(state.alt).toBe(true);
      expect(state.meta).toBe(false);
    });

    it('should return correct state for meta', () => {
      const event = createMockEvent({ metaKey: true });
      const state = getModifierState(event);

      expect(state.meta).toBe(true);
      expect(state.shift).toBe(false);
    });

    it('should return correct state for capsLock', () => {
      const event = createMockEvent({ capsLock: true });
      const state = getModifierState(event);

      expect(state.capsLock).toBe(true);
    });

    it('should return correct state for multiple modifiers', () => {
      const event = createMockEvent({
        shiftKey: true,
        ctrlKey: true,
        altKey: true,
        metaKey: true,
        capsLock: true,
      });
      const state = getModifierState(event);

      expect(state.shift).toBe(true);
      expect(state.control).toBe(true);
      expect(state.alt).toBe(true);
      expect(state.meta).toBe(true);
      expect(state.capsLock).toBe(true);
    });
  });
});
