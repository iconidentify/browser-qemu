/**
 * Input event queue types.
 *
 * Defines strongly-typed events for the input queue system.
 * Uses discriminated unions for type-safe event handling.
 */

/**
 * Event priority levels.
 * Higher values = higher priority in the queue.
 */
export enum InputEventPriority {
  /** Mouse movement - can be coalesced (only latest matters) */
  NORMAL = 1,
  /** Mouse buttons - important but can wait */
  HIGH = 2,
  /** Key events - never drop, must be processed in order */
  CRITICAL = 3,
}

/**
 * Base interface for all queued input events.
 */
interface BaseQueuedEvent {
  /** Priority determines processing order */
  priority: InputEventPriority;
  /** Timestamp when the event was queued (performance.now()) */
  timestamp: number;
}

/**
 * Queued key press/release event.
 */
export interface QueuedKeyEvent extends BaseQueuedEvent {
  type: 'keydown' | 'keyup';
  /** ADB keycode */
  keyCode: number;
  /** Modifier bitmask at time of event */
  modifiers: number;
  priority: InputEventPriority.CRITICAL;
}

/**
 * Queued mouse position event.
 * These are coalesced - only the latest position matters.
 */
export interface QueuedMouseMoveEvent extends BaseQueuedEvent {
  type: 'mousemove';
  /** X coordinate in emulator screen space */
  x: number;
  /** Y coordinate in emulator screen space */
  y: number;
  priority: InputEventPriority.NORMAL;
}

/**
 * Queued mouse button event.
 */
export interface QueuedMouseButtonEvent extends BaseQueuedEvent {
  type: 'mousedown' | 'mouseup';
  /** Button number (0 = primary, 1 = secondary) */
  button: number;
  /** Whether button is pressed (for mousedown) or released (for mouseup) */
  pressed: boolean;
  priority: InputEventPriority.HIGH;
}

/**
 * Union type of all queued input events.
 */
export type QueuedInputEvent =
  | QueuedKeyEvent
  | QueuedMouseMoveEvent
  | QueuedMouseButtonEvent;

/**
 * Type guard for key events.
 */
export function isKeyEvent(event: QueuedInputEvent): event is QueuedKeyEvent {
  return event.type === 'keydown' || event.type === 'keyup';
}

/**
 * Type guard for mouse move events.
 */
export function isMouseMoveEvent(event: QueuedInputEvent): event is QueuedMouseMoveEvent {
  return event.type === 'mousemove';
}

/**
 * Type guard for mouse button events.
 */
export function isMouseButtonEvent(event: QueuedInputEvent): event is QueuedMouseButtonEvent {
  return event.type === 'mousedown' || event.type === 'mouseup';
}

/**
 * Result of writing a batch of events to the buffer.
 */
export interface BatchWriteResult {
  /** Number of events successfully written */
  written: number;
  /** Events that couldn't be written (need retry) */
  remaining: QueuedInputEvent[];
}

/**
 * Statistics for monitoring queue performance.
 */
export interface InputQueueStats {
  /** Total events queued since creation */
  eventsQueued: number;
  /** Total events sent to emulator */
  eventsSent: number;
  /** Events dropped due to queue overflow (should be 0 for keys) */
  eventsDropped: number;
  /** Mouse moves coalesced (not actually dropped, just merged) */
  movesCoalesced: number;
  /** Lock acquisition attempts */
  lockAttempts: number;
  /** Successful lock acquisitions */
  lockAcquired: number;
  /** Times we had to retry due to lock contention */
  lockRetries: number;
}
