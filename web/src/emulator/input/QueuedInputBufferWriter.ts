/**
 * QueuedInputBufferWriter - Hybrid input system with queuing for keys.
 *
 * Combines the event queue and buffer writer into a single interface
 * that matches the existing InputBufferWriter contract.
 *
 * Key features:
 * - Key events are QUEUED (prevents dropped keys when typing fast)
 * - Mouse position is written DIRECTLY (latency-critical, only latest matters)
 * - Mouse buttons are queued (order matters: down before up)
 * - Modifiers are written directly (like mouse position, only latest matters)
 */

import type { InputBufferWriter } from './types';
import { type ModifierMask, InputBufferAddresses, LockStates } from './constants';
import { InputEventQueue, type InputQueueStats } from './queue';
import type { IBufferLockManager } from './lock';
import { SharedMemoryBufferWriter } from './buffer';

/**
 * Configuration for the queued writer.
 */
export interface QueuedInputBufferWriterConfig {
  /** The SharedArrayBuffer view for input data */
  buffer: Int32Array;
  /** Optional: Use a custom lock manager (for testing) */
  lockManager?: IBufferLockManager;
  /** Optional: Enable debug logging */
  debug?: boolean;
}

/**
 * Implements InputBufferWriter with queuing and lock protocol.
 *
 * Uses a 4-state cyclical lock protocol to ensure NO key events are ever lost:
 * 1. UI thread: acquires lock (0->1), writes event, releases (1->2)
 * 2. Worker: acquires lock (2->3), reads event, releases (3->0)
 *
 * Mouse position bypasses the lock (always just the latest value matters).
 */
export class QueuedInputBufferWriter implements InputBufferWriter {
  private readonly queue: InputEventQueue;
  private readonly writer: SharedMemoryBufferWriter;
  private readonly buffer: Int32Array;
  private readonly debug: boolean;

  private flushScheduled = false;
  private flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lockAcquireAttempts = 0;

  constructor(config: QueuedInputBufferWriterConfig) {
    this.queue = new InputEventQueue();
    this.writer = new SharedMemoryBufferWriter({ buffer: config.buffer });
    this.buffer = config.buffer;
    this.debug = config.debug ?? false;
    void config.lockManager; // Not used, we implement lock directly
  }

  /**
   * Write mouse position directly (not queued).
   * Mouse position is latency-critical and only the latest value matters,
   * so we write directly instead of queuing.
   * Note: Does not use lock protocol - just updates the latest position.
   * We still notify to wake the worker if it's sleeping in Atomics.wait().
   */
  writeMousePosition(x: number, y: number): void {
    if (this.disposed) return;
    this.writer.writeMousePositionDirect(Math.round(x), Math.round(y));
    // Wake the worker if it's sleeping - it will check mousePositionFlagAddr
    Atomics.notify(this.buffer, InputBufferAddresses.globalLockAddr);
  }

  /**
   * Queue a mouse button state change.
   */
  writeMouseButton(button: number, pressed: boolean): void {
    if (this.disposed) return;
    this.queue.queueMouseButton(button, pressed);
    this.scheduleFlush();
  }

  /**
   * Queue a key event.
   */
  writeKeyEvent(keyCode: number, pressed: boolean): void {
    if (this.disposed) return;
    this.queue.queueKeyEvent(keyCode, pressed);
    this.scheduleFlush();
  }

  /**
   * Write modifier state directly.
   * This doesn't go through the queue - modifiers are always up-to-date.
   */
  writeModifiers(modifiers: ModifierMask): void {
    if (this.disposed) return;
    // Modifiers are written directly as they're always the "current" state
    // They don't need to be queued because we care about the latest value only
    this.writer.writeModifiers(modifiers);
  }

  /**
   * Schedule a flush if one isn't already pending.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    // Use setTimeout(..., 0) for non-blocking flush
    this.flushTimeoutId = setTimeout(() => this.flush(), 0);
  }

  /**
   * Try to acquire the input lock for the UI thread.
   * Uses Atomics.compareExchange to transition 0 -> 1.
   * @returns true if lock acquired, false if not available
   */
  private tryAcquireLock(): boolean {
    const prevState = Atomics.compareExchange(
      this.buffer,
      InputBufferAddresses.globalLockAddr,
      LockStates.READY_FOR_UI_THREAD,
      LockStates.UI_THREAD_LOCK
    );
    return prevState === LockStates.READY_FOR_UI_THREAD;
  }

  /**
   * Release the input lock and signal the worker.
   * Transitions 1 -> 2 and notifies any waiting workers.
   */
  private releaseLock(): void {
    Atomics.store(
      this.buffer,
      InputBufferAddresses.globalLockAddr,
      LockStates.READY_FOR_EMUL_THREAD
    );
    // Wake the worker to process the input
    Atomics.notify(this.buffer, InputBufferAddresses.globalLockAddr);
  }

  /**
   * Attempt to flush queued events to the buffer.
   * Uses the 4-state lock protocol to ensure no events are ever lost.
   */
  private flush(): void {
    this.flushScheduled = false;
    this.flushTimeoutId = null;

    if (this.disposed || !this.queue.hasEvents()) {
      this.lockAcquireAttempts = 0;
      return;
    }

    // Try to acquire the lock
    if (!this.tryAcquireLock()) {
      // Lock not available - worker still processing previous input
      this.lockAcquireAttempts++;

      // Log occasional retries for debugging (not every attempt)
      if (this.debug && this.lockAcquireAttempts % 10 === 0) {
        console.log(`[QueuedInputBufferWriter] Lock busy, attempt ${this.lockAcquireAttempts}`);
      }

      // Retry shortly - events stay in queue until lock available
      this.scheduleFlush();
      return;
    }

    // Lock acquired! Reset attempt counter
    this.lockAcquireAttempts = 0;

    // Get the next batch of events
    const batch = this.queue.getNextBatch();

    if (batch.length === 0) {
      // No events to write, release lock immediately
      this.releaseLock();
      return;
    }

    // Write the batch while holding the lock
    const result = this.writer.writeBatch(batch);
    this.queue.recordSent(result.written);

    // Release lock and notify worker
    this.releaseLock();

    // Requeue any events that couldn't be written (e.g., extra key events)
    if (result.remaining.length > 0) {
      this.queue.requeueEvents(result.remaining);
    }

    // Log first few flushes to help debug
    const stats = this.queue.getStats();
    if (stats.eventsSent <= 5 || this.debug) {
      const sizes = this.queue.getQueueSizes();
      console.log(
        `[QueuedInputBufferWriter] Wrote ${result.written} events (total sent: ${stats.eventsSent}), ` +
        `remaining: ${result.remaining.length}, queued keys: ${sizes.keys}`
      );
    }

    // If there are more events, schedule another flush
    if (this.queue.hasEvents()) {
      this.scheduleFlush();
    }
  }

  /**
   * Force an immediate flush attempt.
   * Useful for tests or when you need events processed now.
   */
  flushNow(): void {
    if (this.flushTimeoutId !== null) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
      this.flushScheduled = false;
    }
    this.flush();
  }

  /**
   * Get the underlying queue (for testing/debugging).
   */
  getQueue(): InputEventQueue {
    return this.queue;
  }

  /**
   * Get queue statistics.
   */
  getStats(): InputQueueStats {
    return this.queue.getStats();
  }

  /**
   * Check if there are pending events.
   */
  hasPendingEvents(): boolean {
    return this.queue.hasEvents();
  }

  /**
   * Clear all queued events.
   */
  clear(): void {
    this.queue.clear();
  }

  /**
   * Dispose of the writer and cancel any pending flushes.
   */
  dispose(): void {
    this.disposed = true;
    if (this.flushTimeoutId !== null) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
    this.queue.clear();
  }
}

/**
 * Factory function to create a queued buffer writer.
 * This replaces the old createAtomicsBufferWriter when queuing is desired.
 */
export function createQueuedBufferWriter(
  buffer: Int32Array,
  options?: { debug?: boolean }
): QueuedInputBufferWriter {
  return new QueuedInputBufferWriter({
    buffer,
    debug: options?.debug,
  });
}
