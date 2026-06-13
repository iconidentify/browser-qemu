/**
 * TrackpadHaptics - Simulated haptic feedback for the trackpad
 *
 * Since true haptic feedback (Taptic Engine) isn't available in Safari,
 * we simulate the feel through:
 * 1. Short click sounds via Web Audio API
 * 2. Visual micro-compression animations
 *
 * This creates a surprisingly convincing tactile feedback experience
 * when combined with precise timing.
 */

/** Haptic feedback options */
export interface HapticOptions {
  /** Enable click sound (default: true) */
  sound: boolean;
  /** Enable visual compression animation (default: true) */
  visual: boolean;
  /** Sound volume (0.0 - 1.0, default: 0.15) */
  volume: number;
}

/** Default haptic options */
const DEFAULT_OPTIONS: HapticOptions = {
  sound: true,
  visual: true,
  volume: 0.15,
};

/**
 * Check if user prefers reduced motion.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * TrackpadHaptics provides simulated haptic feedback through
 * audio and visual cues.
 */
export class TrackpadHaptics {
  private audioContext: AudioContext | null = null;
  private options: HapticOptions;
  private element: HTMLElement | null = null;
  private isPressed = false;

  // Audio settings
  private readonly CLICK_FREQUENCY = 1200; // Hz
  private readonly CLICK_DURATION = 0.012; // 12ms
  private readonly RELEASE_FREQUENCY = 800; // Hz - slightly lower for release
  private readonly RELEASE_DURATION = 0.008; // 8ms

  constructor(options: Partial<HapticOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Set the element to apply visual feedback to.
   */
  setElement(element: HTMLElement | null): void {
    this.element = element;
  }

  /**
   * Update haptic options.
   */
  setOptions(options: Partial<HapticOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options.
   */
  getOptions(): HapticOptions {
    return { ...this.options };
  }

  /**
   * Initialize audio context (must be called from a user gesture).
   */
  initAudio(): void {
    if (this.audioContext) return;

    try {
      this.audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch (e) {
      console.warn('Failed to create AudioContext for haptic feedback:', e);
    }
  }

  /**
   * Resume audio context if suspended (Safari requires this after page load).
   */
  async resumeAudio(): Promise<void> {
    if (this.audioContext?.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (e) {
        console.warn('Failed to resume AudioContext:', e);
      }
    }
  }

  /**
   * Play a short click sound.
   */
  private playClickSound(isRelease: boolean): void {
    if (!this.options.sound || !this.audioContext) return;

    try {
      const frequency = isRelease ? this.RELEASE_FREQUENCY : this.CLICK_FREQUENCY;
      const duration = isRelease ? this.RELEASE_DURATION : this.CLICK_DURATION;

      // Create oscillator for the click
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);

      // Quick attack, quick decay envelope
      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      gainNode.gain.linearRampToValueAtTime(
        this.options.volume,
        this.audioContext.currentTime + 0.001 // 1ms attack
      );
      gainNode.gain.exponentialRampToValueAtTime(
        0.001,
        this.audioContext.currentTime + duration
      );

      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + duration);
    } catch (e) {
      // Silently fail - audio feedback is optional
    }
  }

  /**
   * Apply visual press animation.
   */
  private applyPressAnimation(): void {
    if (!this.options.visual || !this.element || prefersReducedMotion()) return;

    // Micro-compression effect
    this.element.style.transform = 'scale(0.995) translateY(1px)';
    this.element.style.boxShadow = 'inset 0 3px 6px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.1)';
    this.element.style.transition = 'transform 40ms ease-out, box-shadow 40ms ease-out';
  }

  /**
   * Apply visual release animation.
   */
  private applyReleaseAnimation(): void {
    if (!this.options.visual || !this.element || prefersReducedMotion()) return;

    // Return to normal with spring-like effect
    this.element.style.transform = '';
    this.element.style.boxShadow = '';
    this.element.style.transition = 'transform 80ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 80ms ease-out';

    // Clear transition after animation completes
    setTimeout(() => {
      if (this.element) {
        this.element.style.transition = '';
      }
    }, 100);
  }

  /**
   * Trigger haptic feedback for a press/tap.
   */
  triggerPress(): void {
    if (this.isPressed) return;
    this.isPressed = true;

    // Ensure audio is initialized and resumed
    this.initAudio();
    this.resumeAudio();

    this.playClickSound(false);
    this.applyPressAnimation();
  }

  /**
   * Trigger haptic feedback for a release.
   */
  triggerRelease(): void {
    if (!this.isPressed) return;
    this.isPressed = false;

    this.playClickSound(true);
    this.applyReleaseAnimation();
  }

  /**
   * Trigger a complete tap (press + release).
   */
  triggerTap(): void {
    this.triggerPress();
    // Schedule release after a short delay
    setTimeout(() => this.triggerRelease(), 50);
  }

  /**
   * Check if currently in pressed state.
   */
  isPressedState(): boolean {
    return this.isPressed;
  }

  /**
   * Reset state without animation.
   */
  reset(): void {
    this.isPressed = false;
    if (this.element) {
      this.element.style.transform = '';
      this.element.style.boxShadow = '';
      this.element.style.transition = '';
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.reset();
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.element = null;
  }
}

/**
 * Create a haptic feedback handler callback for use with TrackpadHandler.
 */
export function createHapticCallback(
  haptics: TrackpadHaptics
): (type: 'tap' | 'release') => void {
  return (type: 'tap' | 'release') => {
    if (type === 'tap') {
      haptics.triggerPress();
    } else {
      haptics.triggerRelease();
    }
  };
}
