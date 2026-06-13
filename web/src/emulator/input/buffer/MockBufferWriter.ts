/**
 * MockBufferWriter - Test double for SharedMemoryBufferWriter.
 *
 * Records all written events for verification in tests.
 * Does not require SharedArrayBuffer or Atomics.
 */

import {
  type QueuedInputEvent,
  type BatchWriteResult,
  isKeyEvent,
  isMouseMoveEvent,
  isMouseButtonEvent,
} from '../queue/types';

/**
 * Recorded mouse position write.
 */
export interface RecordedMouseMove {
  type: 'mousemove';
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Recorded mouse button write.
 */
export interface RecordedMouseButton {
  type: 'mousebutton';
  button: number;
  pressed: boolean;
  timestamp: number;
}

/**
 * Recorded key event write.
 */
export interface RecordedKeyEvent {
  type: 'key';
  keyCode: number;
  pressed: boolean;
  modifiers: number;
  timestamp: number;
}

/**
 * Union of all recorded write types.
 */
export type RecordedWrite = RecordedMouseMove | RecordedMouseButton | RecordedKeyEvent;

/**
 * Mock implementation of the buffer writer for testing.
 */
export class MockBufferWriter {
  /** All recorded writes in order */
  private writes: RecordedWrite[] = [];

  /** Current mouse position state */
  private mousePosition: { x: number; y: number } | null = null;

  /** Current button states */
  private buttonStates: Map<number, boolean> = new Map();

  /** Current key states (for tracking what's pressed) */
  private keyStates: Map<number, boolean> = new Map();

  /** Current modifier state */
  private modifiers = 0;

  /**
   * Write a batch of events.
   * Enforces the one-key-per-batch limit like the real writer.
   */
  writeBatch(events: QueuedInputEvent[]): BatchWriteResult {
    const remaining: QueuedInputEvent[] = [];
    let written = 0;
    let hasWrittenKey = false;

    for (const event of events) {
      if (isMouseMoveEvent(event)) {
        this.mousePosition = { x: event.x, y: event.y };
        this.writes.push({
          type: 'mousemove',
          x: event.x,
          y: event.y,
          timestamp: performance.now(),
        });
        written++;
      } else if (isMouseButtonEvent(event)) {
        this.buttonStates.set(event.button, event.pressed);
        this.writes.push({
          type: 'mousebutton',
          button: event.button,
          pressed: event.pressed,
          timestamp: performance.now(),
        });
        written++;
      } else if (isKeyEvent(event)) {
        if (hasWrittenKey) {
          remaining.push(event);
        } else {
          const pressed = event.type === 'keydown';
          this.keyStates.set(event.keyCode, pressed);
          this.modifiers = event.modifiers;
          this.writes.push({
            type: 'key',
            keyCode: event.keyCode,
            pressed,
            modifiers: event.modifiers,
            timestamp: performance.now(),
          });
          hasWrittenKey = true;
          written++;
        }
      }
    }

    return { written, remaining };
  }

  /**
   * Write modifiers directly.
   */
  writeModifiers(modifiers: number): void {
    this.modifiers = modifiers;
  }

  /**
   * Get all recorded writes.
   */
  getWrites(): readonly RecordedWrite[] {
    return [...this.writes];
  }

  /**
   * Get only key events.
   */
  getKeyWrites(): RecordedKeyEvent[] {
    return this.writes.filter((w): w is RecordedKeyEvent => w.type === 'key');
  }

  /**
   * Get only mouse move events.
   */
  getMouseMoveWrites(): RecordedMouseMove[] {
    return this.writes.filter((w): w is RecordedMouseMove => w.type === 'mousemove');
  }

  /**
   * Get only mouse button events.
   */
  getMouseButtonWrites(): RecordedMouseButton[] {
    return this.writes.filter((w): w is RecordedMouseButton => w.type === 'mousebutton');
  }

  /**
   * Get current mouse position.
   */
  getMousePosition(): { x: number; y: number } | null {
    return this.mousePosition;
  }

  /**
   * Get current button state.
   */
  getButtonState(button: number): boolean {
    return this.buttonStates.get(button) ?? false;
  }

  /**
   * Get current key state.
   */
  getKeyState(keyCode: number): boolean {
    return this.keyStates.get(keyCode) ?? false;
  }

  /**
   * Get current modifier state.
   */
  getModifiers(): number {
    return this.modifiers;
  }

  /**
   * Get write count.
   */
  getWriteCount(): number {
    return this.writes.length;
  }

  /**
   * Clear all recorded data.
   */
  clear(): void {
    this.writes = [];
    this.mousePosition = null;
    this.buttonStates.clear();
    this.keyStates.clear();
    this.modifiers = 0;
  }
}
