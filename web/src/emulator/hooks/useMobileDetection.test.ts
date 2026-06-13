/**
 * Tests for useMobileDetection hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useMobileDetection,
  detectMobileMode,
  saveModeOverride,
  clearModeOverride,
  MOBILE_RESOLUTION,
  DESKTOP_RESOLUTION,
} from './useMobileDetection';

describe('useMobileDetection', () => {
  let originalMatchMedia: typeof window.matchMedia;
  let originalMaxTouchPoints: number;
  let originalInnerWidth: number;
  let originalLocation: Location;
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    // Save originals
    originalMatchMedia = window.matchMedia;
    originalMaxTouchPoints = navigator.maxTouchPoints;
    originalInnerWidth = window.innerWidth;
    originalLocation = window.location;

    // Mock localStorage
    mockLocalStorage = {};
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          mockLocalStorage[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete mockLocalStorage[key];
        }),
        clear: vi.fn(() => {
          mockLocalStorage = {};
        }),
      },
      writable: true,
    });

    // Default to desktop mode - ensure no touch capability
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: 0,
      configurable: true,
    });

    // Remove ontouchstart if present (jsdom may have it)
    if ('ontouchstart' in window) {
      delete (window as { ontouchstart?: unknown }).ontouchstart;
    }

    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      configurable: true,
    });

    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockReturnValue({ matches: false }),
      configurable: true,
    });

    // Mock location for URL params
    delete (window as { location?: Location }).location;
    (window as { location: Partial<Location> }).location = {
      search: '',
      href: 'http://localhost/',
    } as Location;
  });

  afterEach(() => {
    // Restore originals
    Object.defineProperty(window, 'matchMedia', {
      value: originalMatchMedia,
      configurable: true,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: originalMaxTouchPoints,
      configurable: true,
    });
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      configurable: true,
    });
    window.location = originalLocation;

    vi.restoreAllMocks();
  });

  describe('detectMobileMode', () => {
    describe('desktop detection', () => {
      it('should detect desktop when no touch capability', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 0,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1920,
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(false);
        expect(result.isTouch).toBe(false);
        expect(result.preferredResolution).toEqual(DESKTOP_RESOLUTION);
        expect(result.override).toBeNull();
        expect(result.isOverridden).toBe(false);
      });

      it('should detect desktop with touch but wide viewport and hover available', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 10,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1920, // Wide viewport
          configurable: true,
        });
        Object.defineProperty(window, 'matchMedia', {
          value: vi.fn().mockReturnValue({ matches: false }), // Has hover
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(false);
        expect(result.isTouch).toBe(true);
        expect(result.preferredResolution).toEqual(DESKTOP_RESOLUTION);
      });
    });

    describe('mobile detection', () => {
      it('should detect mobile with touch and narrow viewport', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 375, // iPhone SE width
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true);
        expect(result.isTouch).toBe(true);
        expect(result.preferredResolution).toEqual(MOBILE_RESOLUTION);
      });

      it('should detect mobile with touch-primary device (hover: none)', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1200, // Tablet landscape - wider than threshold
          configurable: true,
        });
        Object.defineProperty(window, 'matchMedia', {
          value: vi.fn().mockReturnValue({ matches: true }), // Touch primary
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true);
        expect(result.isTouch).toBe(true);
        expect(result.preferredResolution).toEqual(MOBILE_RESOLUTION);
      });

      it('should detect mobile at viewport threshold', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1024, // Exactly at threshold
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true);
      });

      it('should not detect mobile just above threshold', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1025, // Just above threshold
          configurable: true,
        });
        Object.defineProperty(window, 'matchMedia', {
          value: vi.fn().mockReturnValue({ matches: false }), // Has hover
          configurable: true,
        });

        const result = detectMobileMode();

        expect(result.isMobile).toBe(false);
      });
    });

    describe('URL parameter override', () => {
      it('should force laptop mode with ?mode=laptop', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 0, // No touch
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1920, // Desktop width
          configurable: true,
        });
        (window as { location: Partial<Location> }).location = {
          search: '?mode=laptop',
          href: 'http://localhost/?mode=laptop',
        } as Location;

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true);
        expect(result.override).toBe('laptop');
        expect(result.isOverridden).toBe(true);
        expect(result.preferredResolution).toEqual(MOBILE_RESOLUTION);
      });

      it('should force desktop mode with ?mode=desktop', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5, // Has touch
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 375, // Mobile width
          configurable: true,
        });
        (window as { location: Partial<Location> }).location = {
          search: '?mode=desktop',
          href: 'http://localhost/?mode=desktop',
        } as Location;

        const result = detectMobileMode();

        expect(result.isMobile).toBe(false);
        expect(result.override).toBe('desktop');
        expect(result.isOverridden).toBe(true);
        expect(result.preferredResolution).toEqual(DESKTOP_RESOLUTION);
      });

      it('should ignore invalid mode parameter', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 375,
          configurable: true,
        });
        (window as { location: Partial<Location> }).location = {
          search: '?mode=invalid',
          href: 'http://localhost/?mode=invalid',
        } as Location;

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true); // Auto-detected as mobile
        expect(result.override).toBeNull();
        expect(result.isOverridden).toBe(false);
      });
    });

    describe('localStorage override', () => {
      it('should force laptop mode from localStorage', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 0,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 1920,
          configurable: true,
        });
        mockLocalStorage['emulator-mode-override'] = 'laptop';

        const result = detectMobileMode();

        expect(result.isMobile).toBe(true);
        expect(result.override).toBe('laptop');
        expect(result.isOverridden).toBe(true);
      });

      it('should force desktop mode from localStorage', () => {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: 5,
          configurable: true,
        });
        Object.defineProperty(window, 'innerWidth', {
          value: 375,
          configurable: true,
        });
        mockLocalStorage['emulator-mode-override'] = 'desktop';

        const result = detectMobileMode();

        expect(result.isMobile).toBe(false);
        expect(result.override).toBe('desktop');
        expect(result.isOverridden).toBe(true);
      });

      it('should prefer URL param over localStorage', () => {
        mockLocalStorage['emulator-mode-override'] = 'desktop';
        (window as { location: Partial<Location> }).location = {
          search: '?mode=laptop',
          href: 'http://localhost/?mode=laptop',
        } as Location;

        const result = detectMobileMode();

        expect(result.override).toBe('laptop'); // URL wins
        expect(result.isMobile).toBe(true);
      });
    });
  });

  describe('saveModeOverride', () => {
    it('should save mode to localStorage', () => {
      saveModeOverride('laptop');

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'emulator-mode-override',
        'laptop'
      );
    });

    it('should remove from localStorage when null', () => {
      saveModeOverride(null);

      expect(localStorage.removeItem).toHaveBeenCalledWith(
        'emulator-mode-override'
      );
    });
  });

  describe('clearModeOverride', () => {
    it('should clear mode from localStorage', () => {
      clearModeOverride();

      expect(localStorage.removeItem).toHaveBeenCalledWith(
        'emulator-mode-override'
      );
    });
  });

  describe('useMobileDetection hook', () => {
    it('should return detection result', () => {
      const { result } = renderHook(() => useMobileDetection());

      expect(result.current).toHaveProperty('isMobile');
      expect(result.current).toHaveProperty('isTouch');
      expect(result.current).toHaveProperty('preferredResolution');
      expect(result.current).toHaveProperty('override');
      expect(result.current).toHaveProperty('isOverridden');
    });

    it('should cache result across re-renders', () => {
      const { result, rerender } = renderHook(() => useMobileDetection());

      const firstResult = result.current;
      rerender();
      const secondResult = result.current;

      // Should be the same object reference (memoized)
      expect(firstResult).toBe(secondResult);
    });

    it('should return desktop resolution on desktop', () => {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });

      const { result } = renderHook(() => useMobileDetection());

      expect(result.current.isMobile).toBe(false);
      expect(result.current.preferredResolution).toEqual(DESKTOP_RESOLUTION);
    });

    it('should return mobile resolution on mobile', () => {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', {
        value: 375,
        configurable: true,
      });

      const { result } = renderHook(() => useMobileDetection());

      expect(result.current.isMobile).toBe(true);
      expect(result.current.preferredResolution).toEqual(MOBILE_RESOLUTION);
    });
  });

  describe('edge cases', () => {
    it('should handle missing matchMedia', () => {
      Object.defineProperty(window, 'matchMedia', {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 5,
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', {
        value: 375,
        configurable: true,
      });

      const result = detectMobileMode();

      // Should still detect mobile via narrow viewport fallback
      expect(result.isMobile).toBe(true);
    });

    it('should handle ontouchstart detection', () => {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });
      Object.defineProperty(window, 'ontouchstart', {
        value: () => {},
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', {
        value: 375,
        configurable: true,
      });

      const result = detectMobileMode();

      expect(result.isTouch).toBe(true);
      expect(result.isMobile).toBe(true);

      // Clean up
      delete (window as { ontouchstart?: () => void }).ontouchstart;
    });

    it('should handle msMaxTouchPoints (legacy IE)', () => {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      });
      Object.defineProperty(navigator, 'msMaxTouchPoints', {
        value: 5,
        configurable: true,
      });
      Object.defineProperty(window, 'innerWidth', {
        value: 375,
        configurable: true,
      });

      const result = detectMobileMode();

      expect(result.isTouch).toBe(true);
      expect(result.isMobile).toBe(true);

      // Clean up
      delete (navigator as { msMaxTouchPoints?: number }).msMaxTouchPoints;
    });
  });
});
