/**
 * InputEventQueue - Priority queue for input events.
 *
 * Manages input events with priority-based ordering.
 *
 * Design principles:
 * - Key events are NEVER dropped - they queue up and wait
 * - Mouse buttons queue normally but at lower priority than keys
 * - Mouse position is NOT queued (written directly for low latency)
 * - Events are processed in priority order, then FIFO within same priority
 */

import {
  type QueuedInputEvent,
  type QueuedKeyEvent,
  type QueuedMouseButtonEvent,
  type InputQueueStats,
  InputEventPriority,
} from './types';

/**
 * Maximum queue size for non-key events.
 * Key events have no limit - they are never dropped.
 */
const MAX_BUTTON_QUEUE_SIZE = 100;

/**
 * Input event queue with priority ordering and coalescing.
 */
export class InputEventQueue {
  /** Key events - FIFO, never dropped */
  private keyQueue: QueuedKeyEvent[] = [];

  /** Mouse button events - FIFO with size limit */
  private buttonQueue: QueuedMouseButtonEvent[] = [];

  /** Statistics for monitoring */
  private stats: InputQueueStats = {
    eventsQueued: 0,
    eventsSent: 0,
    eventsDropped: 0,
    movesCoalesced: 0,
    lockAttempts: 0,
    lockAcquired: 0,
    lockRetries: 0,
  };

  /**
   * Queue a key event. Keys are never dropped.
   */
  queueKeyEvent(keyCode: number, pressed: boolean, modifiers: number = 0): void {
    const event: QueuedKeyEvent = {
      type: pressed ? 'keydown' : 'keyup',
      keyCode,
      modifiers,
      priority: InputEventPriority.CRITICAL,
      timestamp: performance.now(),
    };
    this.keyQueue.push(event);
    this.stats.eventsQueued++;
  }

  /**
   * Queue a mouse button event.
   */
  queueMouseButton(button: number, pressed: boolean): void {
    // Drop oldest button events if queue is too long
    if (this.buttonQueue.length >= MAX_BUTTON_QUEUE_SIZE) {
      this.buttonQueue.shift();
      this.stats.eventsDropped++;
    }

    const event: QueuedMouseButtonEvent = {
      type: pressed ? 'mousedown' : 'mouseup',
      button,
      pressed,
      priority: InputEventPriority.HIGH,
      timestamp: performance.now(),
    };
    this.buttonQueue.push(event);
    this.stats.eventsQueued++;
  }

  /**
   * Get the next batch of events to send to the emulator.
   *
   * Batch rules (matching emulator limitations):
   * - At most ONE key event per batch
   * - Mouse button events included (worker handles these separately)
   * - Mouse position is NOT queued (written directly elsewhere)
   *
   * @returns Array of events to write, in order
   */
  getNextBatch(): QueuedInputEvent[] {
    const batch: QueuedInputEvent[] = [];

    // Include ONE key event (emulator limitation)
    if (this.keyQueue.length > 0) {
      batch.push(this.keyQueue.shift()!);
    }

    // Include button events (they're written separately from keys)
    while (this.buttonQueue.length > 0) {
      batch.push(this.buttonQueue.shift()!);
    }

    return batch;
  }

  /**
   * Check if there are any events waiting to be sent.
   */
  hasEvents(): boolean {
    return this.keyQueue.length > 0 || this.buttonQueue.length > 0;
  }

  /**
   * Check if there are key events waiting.
   * Used to prioritize flush scheduling.
   */
  hasKeyEvents(): boolean {
    return this.keyQueue.length > 0;
  }

  /**
   * Get queue sizes for debugging.
   */
  getQueueSizes(): { keys: number; buttons: number } {
    return {
      keys: this.keyQueue.length,
      buttons: this.buttonQueue.length,
    };
  }

  /**
   * Put events back at the front of the queue (for retry).
   * This handles the case where we got events but couldn't write them.
   */
  requeueEvents(events: QueuedInputEvent[]): void {
    // Process in reverse to maintain order when unshifting
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      switch (event.type) {
        case 'keydown':
        case 'keyup':
          this.keyQueue.unshift(event as QueuedKeyEvent);
          break;
        case 'mousedown':
        case 'mouseup':
          this.buttonQueue.unshift(event as QueuedMouseButtonEvent);
          break;
      }
    }
  }

  /**
   * Record that events were successfully sent.
   */
  recordSent(count: number): void {
    this.stats.eventsSent += count;
  }

  /**
   * Record lock acquisition attempt.
   */
  recordLockAttempt(acquired: boolean): void {
    this.stats.lockAttempts++;
    if (acquired) {
      this.stats.lockAcquired++;
    } else {
      this.stats.lockRetries++;
    }
  }

  /**
   * Get current statistics.
   */
  getStats(): Readonly<InputQueueStats> {
    return { ...this.stats };
  }

  /**
   * Reset statistics (for debugging).
   */
  resetStats(): void {
    this.stats = {
      eventsQueued: 0,
      eventsSent: 0,
      eventsDropped: 0,
      movesCoalesced: 0,
      lockAttempts: 0,
      lockAcquired: 0,
      lockRetries: 0,
    };
  }

  /**
   * Clear all queued events.
   * Use when resetting state (e.g., emulator restart).
   */
  clear(): void {
    this.keyQueue = [];
    this.buttonQueue = [];
  }
}
