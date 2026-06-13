/**
 * Basilisk II Core Exports
 *
 * Re-exports all Basilisk II specific components for the core adapter pattern.
 */

// Adapter
export { BasiliskAdapter, createBasiliskAdapter } from './BasiliskAdapter';

// Cursor parsing
export { parseMacCursor, isXorCursor } from './cursor-parser';

// Prefs generation
export {
  generatePrefs,
  generatePrefsFromConfig,
  DEFAULT_RAM_SIZE,
  DEFAULT_SCREEN,
} from './prefs-generator';
export type { PrefsOptions } from './prefs-generator';
