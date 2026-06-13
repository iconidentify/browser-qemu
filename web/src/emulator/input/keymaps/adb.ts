/**
 * Mac ADB Keycodes
 *
 * Maps browser KeyboardEvent.code values to Mac ADB keycodes (0x00-0x7F).
 * Used by BasiliskII, SheepShaver, Mini vMac.
 *
 * Reference: Inside Macintosh: Devices, Chapter 5
 */

import { createKeyMapper, UNMAPPED_KEY } from './types';

/**
 * Mac ADB keycode mapping table.
 */
export const ADB_KEY_CODES: Readonly<Record<string, number>> = {
  // Letters (QWERTY layout)
  'KeyA': 0x00, 'KeyS': 0x01, 'KeyD': 0x02, 'KeyF': 0x03,
  'KeyH': 0x04, 'KeyG': 0x05, 'KeyZ': 0x06, 'KeyX': 0x07,
  'KeyC': 0x08, 'KeyV': 0x09, 'KeyB': 0x0B, 'KeyQ': 0x0C,
  'KeyW': 0x0D, 'KeyE': 0x0E, 'KeyR': 0x0F, 'KeyY': 0x10,
  'KeyT': 0x11, 'KeyO': 0x1F, 'KeyU': 0x20, 'KeyI': 0x22,
  'KeyP': 0x23, 'KeyL': 0x25, 'KeyJ': 0x26, 'KeyK': 0x28,
  'KeyN': 0x2D, 'KeyM': 0x2E,

  // Numbers row
  'Digit1': 0x12, 'Digit2': 0x13, 'Digit3': 0x14, 'Digit4': 0x15,
  'Digit5': 0x17, 'Digit6': 0x16, 'Digit7': 0x1A, 'Digit8': 0x1C,
  'Digit9': 0x19, 'Digit0': 0x1D,

  // Punctuation and special characters
  'Equal': 0x18,
  'Minus': 0x1B,
  'BracketRight': 0x1E,
  'BracketLeft': 0x21,
  'Quote': 0x27,
  'Semicolon': 0x29,
  'Backslash': 0x2A,
  'Comma': 0x2B,
  'Slash': 0x2C,
  'Period': 0x2F,
  'Backquote': 0x32,

  // Control keys
  'Enter': 0x24,
  'Tab': 0x30,
  'Space': 0x31,
  'Backspace': 0x33,
  'Escape': 0x35,

  // Modifier keys (left side)
  'ControlLeft': 0x36,
  'MetaLeft': 0x37,      // Command
  'ShiftLeft': 0x38,
  'CapsLock': 0x39,
  'AltLeft': 0x3A,       // Option

  // Modifier keys (right side - extended ADB keycodes)
  'ShiftRight': 0x7B,
  'AltRight': 0x7C,
  'ControlRight': 0x7D,

  // Arrow keys
  'ArrowLeft': 0x3B,
  'ArrowRight': 0x3C,
  'ArrowDown': 0x3D,
  'ArrowUp': 0x3E,

  // Function keys
  'F1': 0x7A,
  'F2': 0x78,
  'F3': 0x63,
  'F4': 0x76,
  'F5': 0x60,
  'F6': 0x61,
  'F7': 0x62,
  'F8': 0x64,
  'F9': 0x65,
  'F10': 0x6D,
  'F11': 0x67,
  'F12': 0x6F,

  // Numpad
  'NumpadDecimal': 0x41,
  'NumpadMultiply': 0x43,
  'NumpadAdd': 0x45,
  'NumLock': 0x47,       // Clear on Mac keyboards
  'NumpadDivide': 0x4B,
  'NumpadEnter': 0x4C,
  'NumpadSubtract': 0x4E,
  'NumpadEqual': 0x51,
  'Numpad0': 0x52,
  'Numpad1': 0x53,
  'Numpad2': 0x54,
  'Numpad3': 0x55,
  'Numpad4': 0x56,
  'Numpad5': 0x57,
  'Numpad6': 0x58,
  'Numpad7': 0x59,
  'Numpad8': 0x5B,
  'Numpad9': 0x5C,

  // Navigation cluster
  'Delete': 0x75,        // Forward delete
  'Home': 0x73,
  'End': 0x77,
  'PageUp': 0x74,
  'PageDown': 0x79,
  'Help': 0x72,          // Insert on PC keyboards
};

/**
 * Map a browser key code to ADB keycode.
 */
export const mapAdbKeyCode = createKeyMapper(ADB_KEY_CODES);

/**
 * Mac ADB modifier key bitmask values.
 */
export const ADB_MODIFIERS = {
  SHIFT: 0x0200,
  CAPS: 0x0002,   // alphaLock (Caps Lock)
  CTRL: 0x1000,
  ALT: 0x0800,    // Option key on Mac
  CMD: 0x0100,    // Command/Apple key
} as const;

/**
 * Calculate ADB modifier bitmask from keyboard event.
 */
export function getAdbModifierMask(event: KeyboardEvent, capsLockState: boolean): number {
  let mods = 0;
  if (event.shiftKey) mods |= ADB_MODIFIERS.SHIFT;
  if (event.ctrlKey) mods |= ADB_MODIFIERS.CTRL;
  if (event.altKey) mods |= ADB_MODIFIERS.ALT;
  if (event.metaKey) mods |= ADB_MODIFIERS.CMD;
  if (capsLockState) mods |= ADB_MODIFIERS.CAPS;
  return mods;
}

// Re-export UNMAPPED_KEY for convenience
export { UNMAPPED_KEY };
