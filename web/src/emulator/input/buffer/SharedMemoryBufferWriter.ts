/**
 * SharedMemoryBufferWriter - Atomic batch writer for SharedArrayBuffer.
 *
 * Writes batches of input events to the shared memory buffer using Atomics.
 * Designed to work with the lock protocol - caller must hold the lock.
 *
 * Important limitation: The emulator can only process ONE key event per sync.
 * This writer enforces that limit and returns remaining events for retry.
 */

import { InputBufferAddresses } from '../constants';
import {
  type QueuedInputEvent,
  type BatchWriteResult,
  isKeyEvent,
  isMouseMoveEvent,
  isMouseButtonEvent,
} from '../queue/types';

/**
 * Configuration for the buffer writer.
 */
export interface SharedMemoryBufferWriterConfig {
  /** The SharedArrayBuffer view for input data */
  buffer: Int32Array;
}

/**
 * Writes input events to SharedArrayBuffer using Atomics.
 */
export class SharedMemoryBufferWriter {
  private readonly buffer: Int32Array;

  constructor(config: SharedMemoryBufferWriterConfig) {
    this.buffer = config.buffer;
  }

  /**
   * Write a batch of events to the buffer.
   *
   * Caller MUST hold the lock before calling this.
   *
   * @param events - Events to write
   * @returns Result with count written and remaining events
   */
  writeBatch(events: QueuedInputEvent[]): BatchWriteResult {
    const remaining: QueuedInputEvent[] = [];
    let written = 0;
    let hasWrittenKey = false;

    for (const event of events) {
      if (isMouseMoveEvent(event)) {
        // Mouse position - always write, overwrites previous
        this.writeMousePosition(event.x, event.y);
        written++;
      } else if (isMouseButtonEvent(event)) {
        // Mouse button - write to button state addresses
        this.writeMouseButton(event.button, event.pressed);
        written++;
      } else if (isKeyEvent(event)) {
        // Key event - only ONE per batch
        if (hasWrittenKey) {
          remaining.push(event);
        } else {
          this.writeKeyEvent(event.keyCode, event.type === 'keydown', event.modifiers);
          hasWrittenKey = true;
          written++;
        }
      }
    }

    return { written, remaining };
  }

  /**
   * Write mouse position to buffer.
   */
  private writeMousePosition(x: number, y: number): void {
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionXAddr, x);
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionYAddr, y);
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionFlagAddr, 1);
  }

  /**
   * Write mouse button state to buffer.
   */
  private writeMouseButton(button: number, pressed: boolean): void {
    const addr = button === 0
      ? InputBufferAddresses.mouseButtonStateAddr
      : InputBufferAddresses.mouseButton2StateAddr;
    Atomics.store(this.buffer, addr, pressed ? 1 : 0);
  }

  /**
   * Write a key event to buffer.
   */
  private writeKeyEvent(keyCode: number, pressed: boolean, modifiers: number): void {
    Atomics.store(this.buffer, InputBufferAddresses.keyCodeAddr, keyCode);
    Atomics.store(this.buffer, InputBufferAddresses.keyStateAddr, pressed ? 1 : 0);
    Atomics.store(this.buffer, InputBufferAddresses.keyModifiersAddr, modifiers);
    // Set flag last - signals to worker that there's a new key event
    Atomics.store(this.buffer, InputBufferAddresses.keyEventFlagAddr, 1);
  }

  /**
   * Write modifiers directly (for modifier-only updates).
   */
  writeModifiers(modifiers: number): void {
    Atomics.store(this.buffer, InputBufferAddresses.keyModifiersAddr, modifiers);
  }

  /**
   * Write mouse position directly to the buffer (bypasses batching).
   *
   * Use this for real-time mouse input where latency is critical.
   * Mouse position is state (only latest matters), not an event stream,
   * so direct writes are more appropriate than queuing.
   */
  writeMousePositionDirect(x: number, y: number): void {
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionXAddr, x);
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionYAddr, y);
    Atomics.store(this.buffer, InputBufferAddresses.mousePositionFlagAddr, 1);
  }
}
