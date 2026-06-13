/**
 * useMobileDetection - React hook for detecting mobile/laptop mode
 *
 * Determines whether the app should use mobile laptop mode or desktop mode.
 * Uses multiple detection methods for reliability across different devices
 * and browser emulators.
 *
 * Features:
 * - Touch capability detection
 * - Media query for touch-primary devices
 * - Viewport width fallback
 * - URL parameter override (?mode=laptop or ?mode=desktop)
 * - localStorage settings override
 * - Caches result to prevent layout thrashing
 */

import { useMemo } from 'react';

/** Resolution configuration for different modes */
export const MOBILE_RESOLUTION = { width: 640, height: 480 } as const;
export const DESKTOP_RESOLUTION = { width: 800, height: 600 } as const;

/** localStorage key for mode override */
const MODE_OVERRIDE_STORAGE_KEY = 'emulator-mode-override';

/** Viewport width threshold for mobile detection */
const MOBILE_VIEWPORT_THRESHOLD = 1024;

export type ModeOverride = 'laptop' | 'desktop' | null;

export interface MobileDetectionResult {
  /** Whether the app should use mobile/laptop mode */
  isMobile: boolean;
  /** Whether the device has touch capability */
  isTouch: boolean;
  /** The preferred emulator resolution based on mode */
  preferredResolution: typeof MOBILE_RESOLUTION | typeof DESKTOP_RESOLUTION;
  /** Current mode override (from URL param or settings) */
  override: ModeOverride;
  /** Whether the detection was overridden by user settings */
  isOverridden: boolean;
}

/**
 * Check if the device has touch capability.
 */
function hasTouchCapability(): boolean {
  if (typeof window === 'undefined') return false;

  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    ((navigator as unknown as { msMaxTouchPoints?: number }).msMaxTouchPoints ?? 0) > 0
  );
}

/**
 * Check if the device is primarily touch-based (no hover).
 */
function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  const result = window.matchMedia('(hover: none) and (pointer: coarse)');
  return result?.matches ?? false;
}

/**
 * Check if viewport is narrow (mobile-sized).
 */
function isNarrowViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= MOBILE_VIEWPORT_THRESHOLD;
}

/**
 * Get mode override from URL parameters.
 * Supports ?mode=laptop or ?mode=desktop
 */
function getModeFromUrl(): ModeOverride {
  if (typeof window === 'undefined') return null;

  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    if (mode === 'laptop' || mode === 'desktop') {
      return mode;
    }
  } catch {
    // URL parsing failed
  }

  return null;
}

/**
 * Get mode override from localStorage.
 */
function getModeFromStorage(): ModeOverride {
  if (typeof localStorage === 'undefined') return null;

  try {
    const stored = localStorage.getItem(MODE_OVERRIDE_STORAGE_KEY);
    if (stored === 'laptop' || stored === 'desktop') {
      return stored;
    }
  } catch {
    // localStorage not available
  }

  return null;
}

/**
 * Save mode override to localStorage.
 */
export function saveModeOverride(mode: ModeOverride): void {
  if (typeof localStorage === 'undefined') return;

  try {
    if (mode === null) {
      localStorage.removeItem(MODE_OVERRIDE_STORAGE_KEY);
    } else {
      localStorage.setItem(MODE_OVERRIDE_STORAGE_KEY, mode);
    }
  } catch {
    // localStorage not available
  }
}

/**
 * Clear mode override from localStorage.
 */
export function clearModeOverride(): void {
  saveModeOverride(null);
}

/**
 * Detect whether the app should use mobile/laptop mode.
 * This is the core detection logic, extracted for testing.
 */
export function detectMobileMode(): MobileDetectionResult {
  const hasTouch = hasTouchCapability();
  const touchPrimary = isTouchPrimary();
  const narrowViewport = isNarrowViewport();

  // Check for overrides (URL takes precedence over storage)
  const urlOverride = getModeFromUrl();
  const storageOverride = getModeFromStorage();
  const override = urlOverride ?? storageOverride;

  // Determine if mobile based on device characteristics
  // Mobile = touch capability + (narrow viewport OR touch-primary)
  const autoDetectedMobile = hasTouch && (narrowViewport || touchPrimary);

  // Apply override if present
  let isMobile: boolean;
  let isOverridden = false;

  if (override === 'laptop') {
    isMobile = true;
    isOverridden = true;
  } else if (override === 'desktop') {
    isMobile = false;
    isOverridden = true;
  } else {
    isMobile = autoDetectedMobile;
  }

  return {
    isMobile,
    isTouch: hasTouch,
    preferredResolution: isMobile ? MOBILE_RESOLUTION : DESKTOP_RESOLUTION,
    override,
    isOverridden,
  };
}

/**
 * React hook for mobile/laptop mode detection.
 *
 * The result is memoized on mount to prevent layout thrashing.
 * Changes to viewport size or touch capability during the session
 * will NOT cause mode switching.
 *
 * To force re-detection, the component must be remounted or
 * a URL/localStorage override must be applied.
 *
 * @returns Detection result with mode, resolution, and override info
 */
export function useMobileDetection(): MobileDetectionResult {
  // Memoize on mount - intentionally no dependencies to cache result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => detectMobileMode(), []);

  return result;
}
