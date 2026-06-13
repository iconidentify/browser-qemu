/**
 * Input event queue module.
 *
 * Provides priority-based event queuing with coalescing.
 */

export { InputEventQueue } from './InputEventQueue';
export {
  type QueuedInputEvent,
  type QueuedKeyEvent,
  type QueuedMouseMoveEvent,
  type QueuedMouseButtonEvent,
  type BatchWriteResult,
  type InputQueueStats,
  InputEventPriority,
  isKeyEvent,
  isMouseMoveEvent,
  isMouseButtonEvent,
} from './types';
