/**
 * Input system constants - shared between EmulatorCanvas and basilisk-worker
 *
 * This module provides:
 * - SharedArrayBuffer address offsets for input communication
 * - ADB keycode mappings for Mac keyboard emulation
 * - Modifier key bitmask values
 */

/**
 * Lock states for the 4-state cyclical lock protocol.
 * This ensures no input events are ever lost due to race conditions.
 *
 * Protocol:
 * 1. UI thread: acquires lock (0->1), writes event, releases (1->2)
 * 2. Worker: acquires lock (2->3), reads event, releases (3->0)
 */
export const LockStates = {
  READY_FOR_UI_THREAD: 0,   // Worker done, UI can write
  UI_THREAD_LOCK: 1,        // UI has lock, writing
  READY_FOR_EMUL_THREAD: 2, // UI done, worker can read
  EMUL_THREAD_LOCK: 3,      // Worker has lock, reading
} as const;

/**
 * SharedArrayBuffer addresses for input communication.
 * These offsets must match the BasiliskII WASM expectations.
 */
export const InputBufferAddresses = {
  globalLockAddr: 0,

  // Mouse position and state
  mousePositionFlagAddr: 1,
  mousePositionXAddr: 2,
  mousePositionYAddr: 3,
  mouseButtonStateAddr: 4,
  mouseButton2StateAddr: 16,
  mouseDeltaXAddr: 13,
  mouseDeltaYAddr: 14,

  // Keyboard state
  keyEventFlagAddr: 5,
  keyCodeAddr: 6,
  keyStateAddr: 7,
  keyModifiersAddr: 15,

  // Control flags
  stopFlagAddr: 8,
  ethernetInterruptFlagAddr: 9,
  audioContextRunningFlagAddr: 10,

  // Speed control
  speedFlagAddr: 11,
  speedAddr: 12,

  // Mouse delta mode
  useMouseDeltasFlagAddr: 17,
  useMouseDeltasAddr: 18,

  // Pause state
  pausedAddr: 19,

  // Hardware cursor mode (1 = hide VM cursor, use CSS cursor)
  hardwareCursorModeAddr: 20,
} as const;

export type InputBufferAddress = (typeof InputBufferAddresses)[keyof typeof InputBufferAddresses];

/**
 * Modifier key bitmask values.
 * These match the Mac ADB modifier format used by BasiliskII.
 */
export const Modifiers = {
  SHIFT: 0x0200,
  CAPS: 0x0002,   // alphaLock (Caps Lock)
  CTRL: 0x1000,
  ALT: 0x0800,    // Option key on Mac
  CMD: 0x0100,    // Command/Apple key
} as const;

export type ModifierMask = number;

/**
 * Mac ADB keycodes.
 * Maps browser KeyboardEvent.code values to Mac ADB keycodes.
 *
 * Important: These are ADB keycodes, NOT macOS virtual keycodes.
 * The ADB (Apple Desktop Bus) format was used by classic Macs.
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
  'Equal': 0x18,         // =
  'Minus': 0x1B,         // -
  'BracketRight': 0x1E,  // ]
  'BracketLeft': 0x21,   // [
  'Quote': 0x27,         // '
  'Semicolon': 0x29,     // ;
  'Backslash': 0x2A,     // \
  'Comma': 0x2B,         // ,
  'Slash': 0x2C,         // /
  'Period': 0x2F,        // .
  'Backquote': 0x32,     // `

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
} as const;

/**
 * Set of modifier key codes for quick lookup.
 */
export const MODIFIER_KEY_CODES = new Set([
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
  'CapsLock',
]);

/**
 * Sentinel value indicating an unmapped key.
 * We use -1 since ADB keycodes are 0-127.
 */
export const UNMAPPED_KEY = -1;

/**
 * Maps a browser KeyboardEvent.code to a Mac ADB keycode.
 *
 * @param code - The KeyboardEvent.code value (e.g., 'KeyA', 'Space')
 * @returns The corresponding ADB keycode, or UNMAPPED_KEY (-1) if not mapped
 */
export function mapKeyCode(code: string): number {
  return ADB_KEY_CODES[code] ?? UNMAPPED_KEY;
}

/**
 * Checks if a key code is a modifier key.
 *
 * @param code - The KeyboardEvent.code value
 * @returns true if the code represents a modifier key
 */
export function isModifierKey(code: string): boolean {
  return MODIFIER_KEY_CODES.has(code);
}

/**
 * Calculates the modifier bitmask from a KeyboardEvent.
 *
 * @param e - The keyboard event
 * @param capsLockState - Current caps lock toggle state
 * @returns The modifier bitmask
 */
export function getModifierMask(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, capsLockState: boolean): ModifierMask {
  let mods = 0;
  if (e.shiftKey) mods |= Modifiers.SHIFT;
  if (e.ctrlKey) mods |= Modifiers.CTRL;
  if (e.altKey) mods |= Modifiers.ALT;
  if (e.metaKey) mods |= Modifiers.CMD;
  if (capsLockState) mods |= Modifiers.CAPS;
  return mods;
}

/**
 * Gesture recognition thresholds for touch input.
 */
export const GestureThresholds = {
  /** Maximum movement in pixels for a tap to register */
  TAP_MOVEMENT: 10,
  /** Time in ms to hold for a long-press (right-click) */
  LONG_PRESS_DELAY: 500,
  /** Maximum time in ms between taps for double-tap */
  DOUBLE_TAP_TIME: 300,
  /** Maximum distance in px between taps for double-tap */
  DOUBLE_TAP_DISTANCE: 30,
} as const;

/**
 * Trackpad-specific gesture thresholds.
 * These are tuned for relative movement (like a real trackpad).
 */
export const TrackpadThresholds = {
  /** Maximum movement in pixels for a tap to register */
  TAP_MOVEMENT: 8,
  /** Maximum time in ms for a tap gesture */
  TAP_DURATION: 300,
  /** Time in ms before a tap becomes a drag-start */
  DRAG_START_DELAY: 100,
  /** Maximum time in ms between taps for double-tap */
  DOUBLE_TAP_TIME: 250,
  /** Maximum distance in px between taps for double-tap */
  DOUBLE_TAP_DISTANCE: 25,
  /** Minimum movement in px to trigger scroll */
  SCROLL_THRESHOLD: 5,
  /** Default cursor speed multiplier */
  SENSITIVITY: 1.5,
  /** Time in ms to wait for second finger (for two-finger tap) */
  TWO_FINGER_TAP_WINDOW: 100,
  /** Time in ms to maintain click after finger lift during drag */
  DRAG_HOLD_TIMEOUT: 800,
} as const;

/**
 * Maps characters to their corresponding DOM key codes for virtual keyboard support.
 * Each entry contains the key code and whether Shift modifier is required.
 */
export const CHAR_TO_KEY_CODE: Readonly<Record<string, { code: string; shift: boolean }>> = {
  // Letters (lowercase)
  'a': { code: 'KeyA', shift: false }, 'b': { code: 'KeyB', shift: false },
  'c': { code: 'KeyC', shift: false }, 'd': { code: 'KeyD', shift: false },
  'e': { code: 'KeyE', shift: false }, 'f': { code: 'KeyF', shift: false },
  'g': { code: 'KeyG', shift: false }, 'h': { code: 'KeyH', shift: false },
  'i': { code: 'KeyI', shift: false }, 'j': { code: 'KeyJ', shift: false },
  'k': { code: 'KeyK', shift: false }, 'l': { code: 'KeyL', shift: false },
  'm': { code: 'KeyM', shift: false }, 'n': { code: 'KeyN', shift: false },
  'o': { code: 'KeyO', shift: false }, 'p': { code: 'KeyP', shift: false },
  'q': { code: 'KeyQ', shift: false }, 'r': { code: 'KeyR', shift: false },
  's': { code: 'KeyS', shift: false }, 't': { code: 'KeyT', shift: false },
  'u': { code: 'KeyU', shift: false }, 'v': { code: 'KeyV', shift: false },
  'w': { code: 'KeyW', shift: false }, 'x': { code: 'KeyX', shift: false },
  'y': { code: 'KeyY', shift: false }, 'z': { code: 'KeyZ', shift: false },

  // Letters (uppercase - need shift)
  'A': { code: 'KeyA', shift: true }, 'B': { code: 'KeyB', shift: true },
  'C': { code: 'KeyC', shift: true }, 'D': { code: 'KeyD', shift: true },
  'E': { code: 'KeyE', shift: true }, 'F': { code: 'KeyF', shift: true },
  'G': { code: 'KeyG', shift: true }, 'H': { code: 'KeyH', shift: true },
  'I': { code: 'KeyI', shift: true }, 'J': { code: 'KeyJ', shift: true },
  'K': { code: 'KeyK', shift: true }, 'L': { code: 'KeyL', shift: true },
  'M': { code: 'KeyM', shift: true }, 'N': { code: 'KeyN', shift: true },
  'O': { code: 'KeyO', shift: true }, 'P': { code: 'KeyP', shift: true },
  'Q': { code: 'KeyQ', shift: true }, 'R': { code: 'KeyR', shift: true },
  'S': { code: 'KeyS', shift: true }, 'T': { code: 'KeyT', shift: true },
  'U': { code: 'KeyU', shift: true }, 'V': { code: 'KeyV', shift: true },
  'W': { code: 'KeyW', shift: true }, 'X': { code: 'KeyX', shift: true },
  'Y': { code: 'KeyY', shift: true }, 'Z': { code: 'KeyZ', shift: true },

  // Numbers (no shift)
  '0': { code: 'Digit0', shift: false }, '1': { code: 'Digit1', shift: false },
  '2': { code: 'Digit2', shift: false }, '3': { code: 'Digit3', shift: false },
  '4': { code: 'Digit4', shift: false }, '5': { code: 'Digit5', shift: false },
  '6': { code: 'Digit6', shift: false }, '7': { code: 'Digit7', shift: false },
  '8': { code: 'Digit8', shift: false }, '9': { code: 'Digit9', shift: false },

  // Shift+number symbols
  '!': { code: 'Digit1', shift: true }, '@': { code: 'Digit2', shift: true },
  '#': { code: 'Digit3', shift: true }, '$': { code: 'Digit4', shift: true },
  '%': { code: 'Digit5', shift: true }, '^': { code: 'Digit6', shift: true },
  '&': { code: 'Digit7', shift: true }, '*': { code: 'Digit8', shift: true },
  '(': { code: 'Digit9', shift: true }, ')': { code: 'Digit0', shift: true },

  // Punctuation (no shift)
  '-': { code: 'Minus', shift: false }, '=': { code: 'Equal', shift: false },
  '[': { code: 'BracketLeft', shift: false }, ']': { code: 'BracketRight', shift: false },
  '\\': { code: 'Backslash', shift: false }, ';': { code: 'Semicolon', shift: false },
  "'": { code: 'Quote', shift: false }, '`': { code: 'Backquote', shift: false },
  ',': { code: 'Comma', shift: false }, '.': { code: 'Period', shift: false },
  '/': { code: 'Slash', shift: false },

  // Punctuation (with shift)
  '_': { code: 'Minus', shift: true }, '+': { code: 'Equal', shift: true },
  '{': { code: 'BracketLeft', shift: true }, '}': { code: 'BracketRight', shift: true },
  '|': { code: 'Backslash', shift: true }, ':': { code: 'Semicolon', shift: true },
  '"': { code: 'Quote', shift: true }, '~': { code: 'Backquote', shift: true },
  '<': { code: 'Comma', shift: true }, '>': { code: 'Period', shift: true },
  '?': { code: 'Slash', shift: true },

  // Whitespace and control
  ' ': { code: 'Space', shift: false },
  '\t': { code: 'Tab', shift: false },
  '\n': { code: 'Enter', shift: false },
  '\r': { code: 'Enter', shift: false },
};

/**
 * Maps a character to its DOM key code and shift state.
 *
 * @param char - A single character
 * @returns Object with code and shift properties, or null if unmapped
 */
export function mapCharToKeyCode(char: string): { code: string; shift: boolean } | null {
  return CHAR_TO_KEY_CODE[char] ?? null;
}
