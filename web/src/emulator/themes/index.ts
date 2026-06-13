/**
 * Theme System Index
 *
 * Central export point for the Mac theme system.
 */

import type { MacTheme, ThemeId } from './types';

// Theme definitions
import { performa630Theme } from './definitions/performa630';
import { classicTheme } from './definitions/classic';
import { iiciTheme } from './definitions/iici';
import { quadra700Theme } from './definitions/quadra700';
import { powerbook140Theme } from './definitions/powerbook140';
import { darkTheme } from './definitions/dark';
import { c89SummerTheme } from './definitions/c89summer';

// All available themes
export const themes: MacTheme[] = [
  performa630Theme,
  classicTheme,
  iiciTheme,
  quadra700Theme,
  powerbook140Theme,
  darkTheme,
  c89SummerTheme,
];

// Default theme (C89 Summer)
export const DEFAULT_THEME_ID: ThemeId = 'c89summer';

// Get theme by ID
export function getThemeById(id: ThemeId): MacTheme | undefined {
  return themes.find(t => t.id === id);
}

// Get theme or fallback to default
export function getThemeOrDefault(id: ThemeId): MacTheme {
  return getThemeById(id) || themes[0];
}

// Export types
export type { MacTheme, ThemeId, ThemeColors, ThemeLEDs, NetworkActivityState, ConnectionStatus } from './types';

// Export context and hooks
export { ThemeProvider, useTheme, useCurrentTheme } from './ThemeContext';
export { useThemeStyles, getCSSVar } from './useThemeStyles';

// Export individual themes for direct access
export {
  performa630Theme,
  classicTheme,
  iiciTheme,
  quadra700Theme,
  powerbook140Theme,
  darkTheme,
  c89SummerTheme,
};
