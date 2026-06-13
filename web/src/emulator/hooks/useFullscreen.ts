/**
 * useFullscreen - React hook for fullscreen mode with keyboard capture
 *
 * Features:
 * - Fullscreen API for immersive experience
 * - Keyboard Lock API to capture system keys (Cmd+W, Cmd+Tab, etc.)
 * - Automatic cleanup on exit
 * - Browser compatibility detection
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { logger } from '../logger';

export interface UseFullscreenOptions {
  /** Element to make fullscreen (default: document.documentElement) */
  elementRef?: React.RefObject<HTMLElement | null>;
  /** Whether to lock keyboard in fullscreen (default: true) */
  lockKeyboard?: boolean;
  /** Keys to lock (default: all keys) */
  keysToLock?: string[];
  /** Callback when fullscreen changes */
  onFullscreenChange?: (isFullscreen: boolean) => void;
}

export interface UseFullscreenReturn {
  /** Whether currently in fullscreen */
  isFullscreen: boolean;
  /** Whether keyboard lock is active */
  isKeyboardLocked: boolean;
  /** Whether keyboard lock is supported */
  isKeyboardLockSupported: boolean;
  /** Enter fullscreen mode */
  enterFullscreen: () => Promise<void>;
  /** Exit fullscreen mode */
  exitFullscreen: () => Promise<void>;
  /** Toggle fullscreen mode */
  toggleFullscreen: () => Promise<void>;
  /** Lock keyboard (capture system keys) - only works in fullscreen */
  lockKeyboard: () => Promise<void>;
  /** Unlock keyboard */
  unlockKeyboard: () => void;
}

/**
 * Check if Keyboard Lock API is supported
 */
function isKeyboardLockSupported(): boolean {
  return typeof navigator !== 'undefined' &&
         'keyboard' in navigator &&
         typeof (navigator as any).keyboard?.lock === 'function';
}

/**
 * Check if Fullscreen API is supported
 */
function isFullscreenSupported(): boolean {
  return typeof document !== 'undefined' &&
         (document.fullscreenEnabled ||
          (document as any).webkitFullscreenEnabled ||
          (document as any).mozFullScreenEnabled ||
          (document as any).msFullscreenEnabled);
}

/**
 * Get the current fullscreen element
 */
function getFullscreenElement(): Element | null {
  return document.fullscreenElement ||
         (document as any).webkitFullscreenElement ||
         (document as any).mozFullScreenElement ||
         (document as any).msFullscreenElement ||
         null;
}

export function useFullscreen(options: UseFullscreenOptions = {}): UseFullscreenReturn {
  const {
    elementRef,
    lockKeyboard = true,
    keysToLock,
    onFullscreenChange,
  } = options;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isKeyboardLocked, setIsKeyboardLocked] = useState(false);
  const keyboardLockSupported = useRef(isKeyboardLockSupported());

  // Unlock keyboard
  const unlockKeyboard = useCallback(() => {
    if (!keyboardLockSupported.current) return;

    try {
      const keyboard = (navigator as any).keyboard;
      keyboard.unlock();
      setIsKeyboardLocked(false);
    } catch (err) {
      logger.warn('[useFullscreen] Keyboard unlock failed:', err);
    }
  }, []);

  // Lock keyboard (public API - can be called manually)
  const doLockKeyboard = useCallback(async () => {
    if (!keyboardLockSupported.current) return;

    try {
      const keyboard = (navigator as any).keyboard;
      if (keysToLock && keysToLock.length > 0) {
        await keyboard.lock(keysToLock);
      } else {
        // Lock all keys
        await keyboard.lock();
      }
      setIsKeyboardLocked(true);
    } catch (err) {
      // Keyboard lock failed (user denied or not supported)
      logger.warn('[useFullscreen] Keyboard lock failed:', err);
      setIsKeyboardLocked(false);
    }
  }, [keysToLock]);

  // Auto-lock keyboard when entering fullscreen (if enabled)
  const lockKeyboardIfEnabled = useCallback(async () => {
    if (!lockKeyboard) return;
    await doLockKeyboard();
  }, [lockKeyboard, doLockKeyboard]);

  // Enter fullscreen
  const enterFullscreen = useCallback(async () => {
    if (!isFullscreenSupported()) {
      logger.warn('[useFullscreen] Fullscreen not supported');
      return;
    }

    const element = elementRef?.current || document.documentElement;

    try {
      if (element.requestFullscreen) {
        await element.requestFullscreen();
      } else if ((element as any).webkitRequestFullscreen) {
        await (element as any).webkitRequestFullscreen();
      } else if ((element as any).mozRequestFullScreen) {
        await (element as any).mozRequestFullScreen();
      } else if ((element as any).msRequestFullscreen) {
        await (element as any).msRequestFullscreen();
      }

      // Lock keyboard after entering fullscreen (if auto-lock enabled)
      await lockKeyboardIfEnabled();
    } catch (err) {
      logger.error('[useFullscreen] Failed to enter fullscreen:', err);
    }
  }, [elementRef, lockKeyboardIfEnabled]);

  // Exit fullscreen
  const exitFullscreen = useCallback(async () => {
    try {
      // Unlock keyboard first
      unlockKeyboard();

      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      } else if ((document as any).mozCancelFullScreen) {
        await (document as any).mozCancelFullScreen();
      } else if ((document as any).msExitFullscreen) {
        await (document as any).msExitFullscreen();
      }
    } catch (err) {
      logger.error('[useFullscreen] Failed to exit fullscreen:', err);
    }
  }, [unlockKeyboard]);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenActive = !!getFullscreenElement();
      setIsFullscreen(fullscreenActive);

      if (!fullscreenActive) {
        // Exited fullscreen (user pressed Escape or browser exited)
        unlockKeyboard();
      }

      onFullscreenChange?.(fullscreenActive);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, [onFullscreenChange, unlockKeyboard]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isFullscreen) {
        unlockKeyboard();
      }
    };
  }, [isFullscreen, unlockKeyboard]);

  return {
    isFullscreen,
    isKeyboardLocked,
    isKeyboardLockSupported: keyboardLockSupported.current,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
    lockKeyboard: doLockKeyboard,
    unlockKeyboard,
  };
}
