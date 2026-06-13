/**
 * Input system types and interfaces.
 *
 * Provides TypeScript definitions for:
 * - Input buffer communication
 * - Keyboard and pointer handlers
 * - Gesture recognition
 * - Clipboard integration
 */

import type { ModifierMask } from './constants';

/**
 * Interface for writing to the SharedArrayBuffer input buffer.
 * Abstracts the Atomics operations for easier testing.
 */
export interface InputBufferWriter {
  /**
   * Write a mouse position update.
   * @param x - X coordinate relative to canvas
   * @param y - Y coordinate relative to canvas
   */
  writeMousePosition(x: number, y: number): void;

  /**
   * Write a mouse button state change.
   * @param button - Button number (0 = primary, 1 = secondary)
   * @param pressed - true if button is pressed
   */
  writeMouseButton(button: number, pressed: boolean): void;

  /**
   * Write a key event.
   * @param keyCode - ADB keycode
   * @param pressed - true if key is pressed, false if released
   */
  writeKeyEvent(keyCode: number, pressed: boolean): void;

  /**
   * Write the current modifier state.
   * @param modifiers - Modifier bitmask
   */
  writeModifiers(modifiers: ModifierMask): void;
}

/**
 * Point coordinates.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Pointer event types we care about.
 */
export type PointerEventType = 'down' | 'move' | 'up' | 'cancel';

/**
 * Recognized gesture types.
 */
export type GestureType = 'tap' | 'double-tap' | 'long-press' | 'drag-start' | 'drag-move' | 'drag-end';

/**
 * Gesture event emitted by the recognizer.
 */
export interface GestureEvent {
  /** Type of gesture recognized */
  type: GestureType;
  /** Position where the gesture occurred */
  position: Point;
  /** For drags, the starting position */
  startPosition?: Point;
  /** Original pointer event that triggered this gesture */
  originalEvent: PointerEvent;
}

/**
 * Configuration options for the pointer handler.
 */
export interface PointerHandlerConfig {
  /** Whether to enable gesture recognition (default: true) */
  enableGestures?: boolean;
  /** Whether to capture pointer during drag (default: true) */
  captureOnDrag?: boolean;
  /** Custom gesture thresholds */
  gestureThresholds?: Partial<GestureThresholdsConfig>;
}

/**
 * Configurable gesture thresholds.
 */
export interface GestureThresholdsConfig {
  tapMovement: number;
  longPressDelay: number;
  doubleTapTime: number;
  doubleTapDistance: number;
}

/**
 * Configuration options for the keyboard handler.
 */
export interface KeyboardHandlerConfig {
  /** Whether to prevent browser default for all keys (default: true) */
  preventDefaults?: boolean;
  /** Whether to apply macOS Command+key bug fix (default: auto-detected) */
  fixMacCommandKeyBug?: boolean;
  /** Whether to prevent Command+W from closing tab (default: true) */
  preventCommandW?: boolean;
}

/**
 * Configuration options for the clipboard handler.
 */
export interface ClipboardHandlerConfig {
  /** Maximum text length to accept (default: 65535) */
  maxLength?: number;
}

/**
 * Options for the InputManager.
 */
export interface InputManagerConfig {
  keyboard?: KeyboardHandlerConfig;
  pointer?: PointerHandlerConfig;
  clipboard?: ClipboardHandlerConfig;
  /**
   * Enable the queued input system.
   * Keys are queued to prevent drops when typing fast.
   * Mouse position is written directly for low latency.
   * Default: true
   */
  useQueuing?: boolean;
  /** Enable debug logging for the input queue (default: false) */
  debugQueue?: boolean;
}

/**
 * Viewport offset for two-finger pan gesture.
 */
export interface ViewportOffset {
  x: number;
  y: number;
}

/**
 * State returned by the useInputManager hook.
 */
export interface InputManagerState {
  /** Release all tracked keys (use when emulator loses focus) */
  releaseAllKeys: () => void;
  /** Set clipboard text for pasting into emulator */
  setClipboardText: (text: string) => Promise<void>;
  /** Get currently pressed key codes */
  getPressedKeys: () => Set<string>;
  /** Whether touch/gesture input is active */
  isTouchActive: boolean;
  /** Whether a virtual keyboard should be shown (mobile) */
  showVirtualKeyboardButton: boolean;
  /** Trigger virtual keyboard */
  triggerVirtualKeyboard: () => void;
  /** Whether to show the touch hint tooltip */
  showTouchHint: boolean;
  /** Dismiss the touch hint tooltip */
  dismissTouchHint: () => void;
  /** Current viewport offset from two-finger pan (for mobile) */
  viewportOffset: ViewportOffset;
  /** Reset viewport offset to center */
  resetViewportOffset: () => void;
}

/**
 * Lifecycle interface for input handlers.
 */
export interface InputHandler {
  /** Attach event listeners to the element */
  attach(element: HTMLElement | Window): void;
  /** Remove event listeners and clean up */
  detach(): void;
  /** Clean up any lingering state (e.g., release stuck keys) */
  reset(): void;
}
