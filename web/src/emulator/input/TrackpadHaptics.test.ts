/**
 * Tests for TrackpadHaptics
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrackpadHaptics, createHapticCallback } from './TrackpadHaptics';

describe('TrackpadHaptics', () => {
  let haptics: TrackpadHaptics;
  let element: HTMLElement;
  let mockMatchMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    haptics = new TrackpadHaptics();
    element = document.createElement('div');
    haptics.setElement(element);

    // Mock matchMedia
    mockMatchMedia = vi.fn().mockReturnValue({ matches: false });
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      configurable: true,
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    haptics.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create with default options', () => {
      const h = new TrackpadHaptics();
      const opts = h.getOptions();
      expect(opts.sound).toBe(true);
      expect(opts.visual).toBe(true);
      expect(opts.volume).toBe(0.15);
      h.dispose();
    });

    it('should accept custom options', () => {
      const h = new TrackpadHaptics({ sound: false, volume: 0.5 });
      const opts = h.getOptions();
      expect(opts.sound).toBe(false);
      expect(opts.visual).toBe(true);
      expect(opts.volume).toBe(0.5);
      h.dispose();
    });

    it('should update options', () => {
      haptics.setOptions({ sound: false });
      expect(haptics.getOptions().sound).toBe(false);
      expect(haptics.getOptions().visual).toBe(true); // Unchanged
    });
  });

  describe('press/release state', () => {
    it('should track pressed state', () => {
      expect(haptics.isPressedState()).toBe(false);
      haptics.triggerPress();
      expect(haptics.isPressedState()).toBe(true);
      haptics.triggerRelease();
      expect(haptics.isPressedState()).toBe(false);
    });

    it('should not double-press', () => {
      haptics.triggerPress();
      expect(haptics.isPressedState()).toBe(true);
      haptics.triggerPress(); // Should be ignored
      expect(haptics.isPressedState()).toBe(true);
    });

    it('should not release if not pressed', () => {
      expect(haptics.isPressedState()).toBe(false);
      haptics.triggerRelease(); // Should be ignored
      expect(haptics.isPressedState()).toBe(false);
    });
  });

  describe('visual feedback', () => {
    it('should apply press animation', () => {
      haptics.triggerPress();

      expect(element.style.transform).toBe('scale(0.995) translateY(1px)');
      expect(element.style.boxShadow).toContain('inset');
    });

    it('should apply release animation', () => {
      haptics.triggerPress();
      haptics.triggerRelease();

      expect(element.style.transform).toBe('');
    });

    it('should clear transition after animation', () => {
      haptics.triggerPress();
      haptics.triggerRelease();

      vi.advanceTimersByTime(150);

      expect(element.style.transition).toBe('');
    });

    it('should not apply visual when disabled', () => {
      haptics.setOptions({ visual: false });
      haptics.triggerPress();

      expect(element.style.transform).toBe('');
    });

    it('should respect prefers-reduced-motion', () => {
      mockMatchMedia.mockReturnValue({ matches: true });

      haptics.triggerPress();

      expect(element.style.transform).toBe('');
    });

    it('should not apply animation without element', () => {
      haptics.setElement(null);
      haptics.triggerPress(); // Should not throw

      expect(haptics.isPressedState()).toBe(true);
    });
  });

  describe('tap gesture', () => {
    it('should trigger press and release', () => {
      haptics.triggerTap();

      expect(haptics.isPressedState()).toBe(true);
      expect(element.style.transform).toBe('scale(0.995) translateY(1px)');

      vi.advanceTimersByTime(60);

      expect(haptics.isPressedState()).toBe(false);
      expect(element.style.transform).toBe('');
    });
  });

  describe('reset', () => {
    it('should reset state', () => {
      haptics.triggerPress();
      haptics.reset();

      expect(haptics.isPressedState()).toBe(false);
      expect(element.style.transform).toBe('');
      expect(element.style.boxShadow).toBe('');
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      haptics.triggerPress();
      haptics.dispose();

      expect(haptics.isPressedState()).toBe(false);
    });

    it('should handle multiple dispose calls', () => {
      haptics.dispose();
      haptics.dispose(); // Should not throw
    });
  });

  describe('audio feedback', () => {
    it('should initialize audio context on press', () => {
      // AudioContext is mocked in test setup
      haptics.triggerPress();
      // Should not throw
      expect(haptics.isPressedState()).toBe(true);
    });

    it('should not play sound when disabled', () => {
      haptics.setOptions({ sound: false });
      haptics.triggerPress();
      // Just verify it doesn't throw
      expect(haptics.isPressedState()).toBe(true);
    });
  });

  describe('createHapticCallback', () => {
    it('should create callback that triggers press on tap', () => {
      const callback = createHapticCallback(haptics);

      callback('tap');
      expect(haptics.isPressedState()).toBe(true);
    });

    it('should create callback that triggers release', () => {
      const callback = createHapticCallback(haptics);

      callback('tap');
      callback('release');
      expect(haptics.isPressedState()).toBe(false);
    });
  });
});
