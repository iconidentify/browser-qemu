/**
 * Input system public exports.
 *
 * This module provides unified input handling for the Mac emulator:
 * - Keyboard input with ADB keycode mapping
 * - Pointer/touch input with gesture recognition
 * - Clipboard integration
 * - Queued input with lock protocol (prevents dropped keys)
 */

// Constants and utilities
export {
  InputBufferAddresses,
  LockStates,
  Modifiers,
  ADB_KEY_CODES,
  MODIFIER_KEY_CODES,
  GestureThresholds,
  UNMAPPED_KEY,
  mapKeyCode,
  isModifierKey,
  getModifierMask,
} from './constants';

export type {
  InputBufferAddress,
  ModifierMask,
} from './constants';

// Types
export type {
  InputBufferWriter,
  Point,
  PointerEventType,
  GestureType,
  GestureEvent,
  PointerHandlerConfig,
  GestureThresholdsConfig,
  KeyboardHandlerConfig,
  ClipboardHandlerConfig,
  InputManagerConfig,
  InputManagerState,
  InputHandler,
} from './types';

// Handlers
export { KeyboardHandler, createAtomicsBufferWriter, isMacOS } from './KeyboardHandler';
export { PointerHandler, type PanCallback, type ZoomCallback } from './PointerHandler';
export { GestureRecognizer, type GestureCallback } from './GestureRecognizer';
export { ClipboardHandler, type ClipboardTextCallback } from './ClipboardHandler';

// Queued input system
export { QueuedInputBufferWriter, createQueuedBufferWriter } from './QueuedInputBufferWriter';
export {
  InputEventQueue,
  InputEventPriority,
  type QueuedInputEvent,
  type QueuedKeyEvent,
  type QueuedMouseMoveEvent,
  type QueuedMouseButtonEvent,
  type BatchWriteResult,
  type InputQueueStats,
} from './queue';
export {
  BufferLockManager,
  MockBufferLockManager,
  LockState,
  type BufferLockManagerConfig,
  type IBufferLockManager,
} from './lock';
export {
  SharedMemoryBufferWriter,
  MockBufferWriter,
  type SharedMemoryBufferWriterConfig,
} from './buffer';

// Manager
export { InputManager } from './InputManager';

// React hook
export { useInputManager, type UseInputManagerOptions } from './hooks/useInputManager';
