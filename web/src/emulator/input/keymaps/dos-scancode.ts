/**
 * IBM PC Scan Codes (Set 1)
 *
 * Maps browser KeyboardEvent.code values to IBM PC scan codes.
 * Used by DOSBox, DOSBox-X, QEMU.
 *
 * Reference: IBM Technical Reference Manual, Keyboard Scan Codes
 *
 * Note: Extended keys (arrow keys, numpad enter, etc.) use the E0 prefix
 * in the actual scan code protocol. This mapping provides the base scan
 * codes; the worker should handle E0 prefix logic internally.
 */

import { createKeyMapper, UNMAPPED_KEY } from './types';

/**
 * IBM PC scan code mapping table (Set 1).
 */
export const DOS_SCAN_CODES: Readonly<Record<string, number>> = {
  // Row 1: Escape and function keys
  'Escape': 0x01,
  'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
  'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
  'F9': 0x43, 'F10': 0x44, 'F11': 0x57, 'F12': 0x58,

  // Row 2: Number row
  'Backquote': 0x29,
  'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04, 'Digit4': 0x05,
  'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08, 'Digit8': 0x09,
  'Digit9': 0x0A, 'Digit0': 0x0B,
  'Minus': 0x0C, 'Equal': 0x0D, 'Backspace': 0x0E,

  // Row 3: QWERTY top row
  'Tab': 0x0F,
  'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
  'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
  'KeyO': 0x18, 'KeyP': 0x19,
  'BracketLeft': 0x1A, 'BracketRight': 0x1B, 'Backslash': 0x2B,

  // Row 4: Home row
  'CapsLock': 0x3A,
  'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
  'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
  'KeyL': 0x26,
  'Semicolon': 0x27, 'Quote': 0x28, 'Enter': 0x1C,

  // Row 5: Bottom row
  'ShiftLeft': 0x2A,
  'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
  'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32,
  'Comma': 0x33, 'Period': 0x34, 'Slash': 0x35,
  'ShiftRight': 0x36,

  // Row 6: Bottom modifiers
  'ControlLeft': 0x1D,
  'MetaLeft': 0x5B,       // Windows key (extended)
  'AltLeft': 0x38,
  'Space': 0x39,
  'AltRight': 0x38,       // Same as left, distinguished by E0 prefix
  'MetaRight': 0x5C,      // Windows key (extended)
  'ContextMenu': 0x5D,    // Menu key (extended)
  'ControlRight': 0x1D,   // Same as left, distinguished by E0 prefix

  // Numpad
  'NumLock': 0x45,
  'NumpadDivide': 0x35,   // E0 prefix
  'NumpadMultiply': 0x37,
  'NumpadSubtract': 0x4A,
  'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
  'NumpadAdd': 0x4E,
  'Numpad4': 0x4B, 'Numpad5': 0x4C, 'Numpad6': 0x4D,
  'Numpad1': 0x4F, 'Numpad2': 0x50, 'Numpad3': 0x51,
  'NumpadEnter': 0x1C,    // E0 prefix
  'Numpad0': 0x52, 'NumpadDecimal': 0x53,

  // Navigation cluster (all use E0 prefix)
  'Insert': 0x52,
  'Delete': 0x53,
  'Home': 0x47,
  'End': 0x4F,
  'PageUp': 0x49,
  'PageDown': 0x51,

  // Arrow keys (all use E0 prefix)
  'ArrowUp': 0x48,
  'ArrowDown': 0x50,
  'ArrowLeft': 0x4B,
  'ArrowRight': 0x4D,

  // Lock keys
  'ScrollLock': 0x46,
  'Pause': 0x45,          // Special handling: E1 1D 45 / E1 9D C5

  // Print Screen requires special handling (E0 2A E0 37)
  'PrintScreen': 0x37,
};

/**
 * Map a browser key code to DOS scan code.
 */
export const mapDosScanCode = createKeyMapper(DOS_SCAN_CODES);

/**
 * Keys that require the E0 prefix in the scan code protocol.
 */
export const EXTENDED_KEYS = new Set([
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'NumpadDivide', 'NumpadEnter',
  'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu',
  'PrintScreen',
]);

/**
 * Check if a key requires the E0 extended prefix.
 */
export function isExtendedKey(code: string): boolean {
  return EXTENDED_KEYS.has(code);
}

/**
 * DOS keyboard shift flags.
 */
export const DOS_SHIFT_FLAGS = {
  RIGHT_SHIFT: 0x01,
  LEFT_SHIFT: 0x02,
  CTRL: 0x04,
  ALT: 0x08,
  SCROLL_LOCK: 0x10,
  NUM_LOCK: 0x20,
  CAPS_LOCK: 0x40,
  INSERT: 0x80,
} as const;

// Re-export UNMAPPED_KEY for convenience
export { UNMAPPED_KEY };
