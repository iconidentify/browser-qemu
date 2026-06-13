/**
 * BufferLockManager - 4-state cyclical lock protocol for SharedArrayBuffer.
 *
 * Implements a non-blocking lock protocol for coordinating between the
 * UI thread and the emulator worker thread.
 *
 * Lock State Machine:
 *   READY_FOR_UI (0) -> UI_LOCKED (1) -> READY_FOR_EMULATOR (2) -> EMULATOR_LOCKED (3) -> READY_FOR_UI (0)
 *
 * Protocol:
 * 1. UI thread: tryAcquire() attempts to transition 0 -> 1
 * 2. UI thread: writes input data to buffer
 * 3. UI thread: release() transitions 1 -> 2 and notifies worker
 * 4. Worker thread: waits for state 2, transitions 2 -> 3
 * 5. Worker thread: reads input data
 * 6. Worker thread: transitions 3 -> 0
 *
 * This ensures no race conditions - each side only writes when it owns the lock.
 */

import { InputBufferAddresses } from '../constants';

/**
 * Lock states for the buffer protocol.
 */
export enum LockState {
  /** UI thread can acquire the lock */
  READY_FOR_UI = 0,
  /** UI thread has the lock, writing data */
  UI_LOCKED = 1,
  /** UI done, worker can acquire */
  READY_FOR_EMULATOR = 2,
  /** Worker has the lock, reading data */
  EMULATOR_LOCKED = 3,
}

/**
 * Configuration for the lock manager.
 */
export interface BufferLockManagerConfig {
  /** The SharedArrayBuffer for input data */
  buffer: Int32Array;
  /** Optional: Custom lock address (defaults to globalLockAddr) */
  lockAddress?: number;
}

/**
 * Manages the 4-state lock protocol for SharedArrayBuffer communication.
 */
export class BufferLockManager {
  private readonly buffer: Int32Array;
  private readonly lockAddr: number;

  constructor(config: BufferLockManagerConfig) {
    this.buffer = config.buffer;
    this.lockAddr = config.lockAddress ?? InputBufferAddresses.globalLockAddr;
  }

  /**
   * Attempt to acquire the lock for the UI thread.
   * Non-blocking - returns immediately.
   *
   * @returns true if lock acquired, false if not available
   */
  tryAcquire(): boolean {
    // Atomically try to change READY_FOR_UI (0) -> UI_LOCKED (1)
    const result = Atomics.compareExchange(
      this.buffer,
      this.lockAddr,
      LockState.READY_FOR_UI,
      LockState.UI_LOCKED
    );
    return result === LockState.READY_FOR_UI;
  }

  /**
   * Release the lock and signal the worker.
   * Only call this after successfully acquiring the lock and writing data.
   */
  release(): void {
    // Transition UI_LOCKED (1) -> READY_FOR_EMULATOR (2)
    Atomics.store(this.buffer, this.lockAddr, LockState.READY_FOR_EMULATOR);
    // Wake up the worker if it's waiting
    Atomics.notify(this.buffer, this.lockAddr, 1);
  }

  /**
   * Get the current lock state (for debugging).
   */
  getState(): LockState {
    return Atomics.load(this.buffer, this.lockAddr) as LockState;
  }

  /**
   * Check if the lock is in a state where the UI can write.
   * Does not attempt to acquire - just checks.
   */
  isAvailable(): boolean {
    return this.getState() === LockState.READY_FOR_UI;
  }

  /**
   * Force reset the lock to READY_FOR_UI state.
   * Use only during initialization or error recovery.
   */
  forceReset(): void {
    Atomics.store(this.buffer, this.lockAddr, LockState.READY_FOR_UI);
  }
}

/**
 * Create a mock lock manager for testing (no SharedArrayBuffer needed).
 * Always succeeds in acquiring the lock.
 */
export class MockBufferLockManager {
  private locked = false;

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    this.locked = false;
  }

  getState(): LockState {
    return this.locked ? LockState.UI_LOCKED : LockState.READY_FOR_UI;
  }

  isAvailable(): boolean {
    return !this.locked;
  }

  forceReset(): void {
    this.locked = false;
  }
}

/**
 * Interface for lock manager (for type compatibility).
 */
export interface IBufferLockManager {
  tryAcquire(): boolean;
  release(): void;
  getState(): LockState;
  isAvailable(): boolean;
  forceReset(): void;
}
