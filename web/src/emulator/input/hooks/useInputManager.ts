/**
 * useInputManager - React hook for managing emulator input
 *
 * Provides a clean React interface for:
 * - Attaching/detaching input handlers to a canvas element
 * - Keyboard, pointer, and clipboard integration
 * - Virtual keyboard support for mobile devices
 * - Automatic cleanup on unmount
 */

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { InputManager } from '../InputManager';
import type { InputManagerConfig, InputManagerState, ViewportOffset } from '../types';

/** Default viewport offset (centered) */
const DEFAULT_VIEWPORT_OFFSET: ViewportOffset = { x: 0, y: 0 };

export interface UseInputManagerOptions extends InputManagerConfig {
  /** Whether input handling is enabled (default: true) */
  enabled?: boolean;
  /** Callback when clipboard text is pasted */
  onClipboardText?: (text: string) => void;
  /** Native canvas width for coordinate scaling */
  canvasWidth?: number;
  /** Native canvas height for coordinate scaling */
  canvasHeight?: number;
  /** Enable glide mode - single finger pans, no clicks on canvas */
  glideMode?: boolean;
  /** Called when panning in glide mode */
  onGlidePan?: (deltaX: number, deltaY: number) => void;
}

/**
 * React hook for managing emulator input handling.
 *
 * @param canvasRef - Ref to the canvas element to attach input handlers to
 * @param inputBuffer - SharedArrayBuffer for communicating input to emulator
 * @param options - Configuration options
 * @returns Input manager state and methods
 */
export function useInputManager(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  inputBuffer: Int32Array | null,
  options: UseInputManagerOptions = {}
): InputManagerState {
  const { enabled = true, onClipboardText, canvasWidth, canvasHeight, glideMode = false, onGlidePan, ...config } = options;

  // Track the InputManager instance
  const managerRef = useRef<InputManager | null>(null);

  // Track touch state for UI
  const [isTouchActive] = useState(false);
  const [showVirtualKeyboardButton, setShowVirtualKeyboardButton] = useState(false);

  // Track viewport offset for two-finger pan
  const [viewportOffset, setViewportOffset] = useState<ViewportOffset>(DEFAULT_VIEWPORT_OFFSET);

  // Pan callback - only route to onGlidePan in glide mode, ignore in fit mode
  const handlePan = useCallback((deltaX: number, deltaY: number) => {
    if (glideMode && onGlidePan) {
      onGlidePan(deltaX, deltaY);
    }
    // In fit mode, ignore pan gestures - don't accumulate viewportOffset
  }, [glideMode, onGlidePan]);

  // Create and attach the InputManager
  useEffect(() => {
    // Clean up any existing manager
    if (managerRef.current) {
      managerRef.current.detach();
      managerRef.current = null;
    }

    // Don't create if disabled or missing dependencies
    if (!enabled || !inputBuffer || !canvasRef.current) {
      return;
    }

    // Create new InputManager with pan callback
    const manager = new InputManager(inputBuffer, config, onClipboardText, handlePan);
    managerRef.current = manager;

    // Attach to canvas
    manager.attach(canvasRef.current);

    // Set canvas dimensions for coordinate scaling
    if (canvasWidth && canvasHeight) {
      manager.setCanvasDimensions(canvasWidth, canvasHeight);
    }

    // Update state
    setShowVirtualKeyboardButton(manager.shouldShowVirtualKeyboardButton());

    // Cleanup on unmount
    return () => {
      manager.detach();
      managerRef.current = null;
    };
    // Intentionally only depend on enabled and inputBuffer to avoid recreating
    // the manager on every render. Config changes require remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, inputBuffer, canvasRef.current, handlePan]);

  // Update canvas dimensions when they change (for coordinate scaling)
  useEffect(() => {
    if (managerRef.current && canvasWidth && canvasHeight) {
      managerRef.current.setCanvasDimensions(canvasWidth, canvasHeight);
    }
  }, [canvasWidth, canvasHeight]);

  // Update glide mode when it changes
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.setGlideMode(glideMode);
    }
  }, [glideMode]);

  // Release all keys callback
  const releaseAllKeys = useCallback(() => {
    managerRef.current?.releaseAllKeys();
  }, []);

  // Set clipboard text callback (for programmatic paste)
  const setClipboardText = useCallback(async (text: string): Promise<void> => {
    // Write to the system clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    }
  }, []);

  // Get pressed keys callback
  const getPressedKeys = useCallback((): Set<string> => {
    return managerRef.current?.getPressedKeys() ?? new Set();
  }, []);

  // Trigger virtual keyboard callback
  const triggerVirtualKeyboard = useCallback(() => {
    managerRef.current?.triggerVirtualKeyboard();
  }, []);

  // Reset viewport offset to center
  const resetViewportOffset = useCallback(() => {
    setViewportOffset(DEFAULT_VIEWPORT_OFFSET);
  }, []);

  // Touch hint disabled for now (feature planned for future)
  const showTouchHint = false;
  const dismissTouchHint = useCallback(() => {}, []);

  return {
    releaseAllKeys,
    setClipboardText,
    getPressedKeys,
    isTouchActive,
    showVirtualKeyboardButton,
    triggerVirtualKeyboard,
    showTouchHint,
    dismissTouchHint,
    viewportOffset,
    resetViewportOffset,
  };
}
