/**
 * Keymap Types
 *
 * Common types and utilities for keyboard mapping across different emulator cores.
 */

/**
 * Maps browser KeyboardEvent.code to native keycode.
 */
export type KeyMapper = (browserCode: string) => number;

/**
 * Sentinel value for unmapped keys.
 * We use -1 since most keycode systems use positive values.
 */
export const UNMAPPED_KEY = -1;

/**
 * Create a key mapper function from a code-to-keycode record.
 *
 * @param mapping - Record mapping KeyboardEvent.code values to native keycodes
 * @returns A function that maps browser codes to native keycodes
 */
export function createKeyMapper(mapping: Readonly<Record<string, number>>): KeyMapper {
  return (code: string): number => mapping[code] ?? UNMAPPED_KEY;
}

/**
 * Modifier key information.
 */
export interface ModifierState {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  capsLock: boolean;
}

/**
 * Extract modifier state from a keyboard event.
 */
export function getModifierState(event: KeyboardEvent): ModifierState {
  return {
    shift: event.shiftKey,
    control: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    capsLock: event.getModifierState('CapsLock'),
  };
}

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
 * Check if a key code is a modifier key.
 */
export function isModifierKey(code: string): boolean {
  return MODIFIER_KEY_CODES.has(code);
}
