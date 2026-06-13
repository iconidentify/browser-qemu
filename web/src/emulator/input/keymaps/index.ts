/**
 * Keymap Exports
 *
 * Re-exports all keymap types and implementations for convenient importing.
 */

// Types
export type { KeyMapper, ModifierState } from './types';
export {
  UNMAPPED_KEY,
  createKeyMapper,
  getModifierState,
  isModifierKey,
  MODIFIER_KEY_CODES,
} from './types';

// Mac ADB keycodes
export {
  ADB_KEY_CODES,
  mapAdbKeyCode,
  ADB_MODIFIERS,
  getAdbModifierMask,
} from './adb';

// DOS scan codes
export {
  DOS_SCAN_CODES,
  mapDosScanCode,
  EXTENDED_KEYS,
  isExtendedKey,
  DOS_SHIFT_FLAGS,
} from './dos-scancode';
