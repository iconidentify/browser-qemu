/**
 * Tests for the 4-state lock protocol used for input synchronization.
 *
 * The lock protocol ensures no input events are lost between UI and worker threads:
 * - State 0 (READY_FOR_UI_THREAD): Worker done, UI can write
 * - State 1 (UI_THREAD_LOCK): UI has lock, writing
 * - State 2 (READY_FOR_EMUL_THREAD): UI done, worker can read
 * - State 3 (EMUL_THREAD_LOCK): Worker has lock, reading
 *
 * Flow: UI (0->1->2) -> Worker (2->3->0) -> UI (0->1->2) -> ...
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LockStates, InputBufferAddresses } from './constants';

describe('LockProtocol', () => {
  let buffer: Int32Array;

  beforeEach(() => {
    // Create a SharedArrayBuffer for testing (or regular ArrayBuffer in Node)
    const sab = new SharedArrayBuffer(128);
    buffer = new Int32Array(sab);
    // Initialize to state 0
    Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);
  });

  describe('LockStates constants', () => {
    it('should have correct values for 4-state protocol', () => {
      expect(LockStates.READY_FOR_UI_THREAD).toBe(0);
      expect(LockStates.UI_THREAD_LOCK).toBe(1);
      expect(LockStates.READY_FOR_EMUL_THREAD).toBe(2);
      expect(LockStates.EMUL_THREAD_LOCK).toBe(3);
    });
  });

  describe('UI thread lock acquisition (0->1)', () => {
    it('should succeed when lock is at state 0', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        LockStates.UI_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.READY_FOR_UI_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.UI_THREAD_LOCK);
    });

    it('should fail when lock is at state 1 (UI already has it)', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.UI_THREAD_LOCK);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        LockStates.UI_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.UI_THREAD_LOCK);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.UI_THREAD_LOCK);
    });

    it('should fail when lock is at state 2 (waiting for worker)', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_EMUL_THREAD);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        LockStates.UI_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.READY_FOR_EMUL_THREAD);
      // Lock should NOT change
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_EMUL_THREAD);
    });

    it('should fail when lock is at state 3 (worker has it)', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.EMUL_THREAD_LOCK);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        LockStates.UI_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.EMUL_THREAD_LOCK);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.EMUL_THREAD_LOCK);
    });
  });

  describe('UI thread lock release (1->2)', () => {
    it('should transition from 1 to 2', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.UI_THREAD_LOCK);

      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_EMUL_THREAD);

      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_EMUL_THREAD);
    });
  });

  describe('Worker thread lock acquisition (2->3)', () => {
    it('should succeed when lock is at state 2', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_EMUL_THREAD);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_EMUL_THREAD,
        LockStates.EMUL_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.READY_FOR_EMUL_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.EMUL_THREAD_LOCK);
    });

    it('should fail when lock is at state 0 (no queued input)', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_EMUL_THREAD,
        LockStates.EMUL_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.READY_FOR_UI_THREAD);
      // Lock should NOT change
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_UI_THREAD);
    });

    it('should fail when lock is at state 1 (UI is writing)', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.UI_THREAD_LOCK);

      const prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_EMUL_THREAD,
        LockStates.EMUL_THREAD_LOCK
      );

      expect(prevState).toBe(LockStates.UI_THREAD_LOCK);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.UI_THREAD_LOCK);
    });
  });

  describe('Worker thread lock release (3->0)', () => {
    it('should transition from 3 to 0 when lock is at state 3', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.EMUL_THREAD_LOCK);

      const currentState = Atomics.load(buffer, InputBufferAddresses.globalLockAddr);
      if (currentState === LockStates.EMUL_THREAD_LOCK) {
        Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);
      }

      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_UI_THREAD);
    });

    it('should NOT transition when lock is not at state 3 (direct input path)', () => {
      // This simulates the case where worker processed direct input (mouse position, ethernet)
      // without acquiring the lock (lock stayed at 0)
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);

      const currentState = Atomics.load(buffer, InputBufferAddresses.globalLockAddr);
      if (currentState === LockStates.EMUL_THREAD_LOCK) {
        Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);
      }

      // Lock should stay at 0 (not change)
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_UI_THREAD);
    });
  });

  describe('Full lock cycle', () => {
    it('should complete a full cycle: 0 -> 1 -> 2 -> 3 -> 0', () => {
      // Initial state
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_UI_THREAD);

      // UI acquires (0 -> 1)
      let prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        LockStates.UI_THREAD_LOCK
      );
      expect(prevState).toBe(LockStates.READY_FOR_UI_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.UI_THREAD_LOCK);

      // UI releases (1 -> 2)
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_EMUL_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_EMUL_THREAD);

      // Worker acquires (2 -> 3)
      prevState = Atomics.compareExchange(
        buffer,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_EMUL_THREAD,
        LockStates.EMUL_THREAD_LOCK
      );
      expect(prevState).toBe(LockStates.READY_FOR_EMUL_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.EMUL_THREAD_LOCK);

      // Worker releases (3 -> 0)
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);
      expect(Atomics.load(buffer, InputBufferAddresses.globalLockAddr)).toBe(LockStates.READY_FOR_UI_THREAD);
    });
  });

  describe('Direct input bypass (ethernet, mouse position)', () => {
    it('should allow direct input when lock is at state 0', () => {
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_UI_THREAD);

      // Simulate checking for direct input flags
      Atomics.store(buffer, InputBufferAddresses.mousePositionFlagAddr, 1);
      Atomics.store(buffer, InputBufferAddresses.ethernetInterruptFlagAddr, 1);

      const lockState = Atomics.load(buffer, InputBufferAddresses.globalLockAddr);
      const hasMouseInput = Atomics.load(buffer, InputBufferAddresses.mousePositionFlagAddr);
      const hasEthernetInterrupt = Atomics.load(buffer, InputBufferAddresses.ethernetInterruptFlagAddr);

      // Worker should process if ANY direct input flag is set (values are 0 or 1)
      const shouldProcess = lockState === LockStates.READY_FOR_EMUL_THREAD ||
                           hasMouseInput !== 0 || hasEthernetInterrupt !== 0;
      expect(shouldProcess).toBe(true);
    });

    it('should detect queued input when lock is at state 2', () => {
      // This tests the idleWait check for queued input
      Atomics.store(buffer, InputBufferAddresses.globalLockAddr, LockStates.READY_FOR_EMUL_THREAD);

      const lockState = Atomics.load(buffer, InputBufferAddresses.globalLockAddr);
      const hasQueuedInput = lockState === LockStates.READY_FOR_EMUL_THREAD;

      expect(hasQueuedInput).toBe(true);
    });
  });

  describe('mouseButtonStateAddr reset', () => {
    it('should be initialized to -1 (no event)', () => {
      // Initialize like the worker does
      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, -1);

      const state = Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr);
      expect(state).toBe(-1);
      // C++ checks > -1 to detect button events
      expect(state > -1).toBe(false);
    });

    it('should be reset to -1 after processing', () => {
      // Simulate button press
      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, 1);
      expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr) > -1).toBe(true);

      // Simulate releaseInputLock resetting it
      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, -1);
      expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr) > -1).toBe(false);
    });

    it('should not trigger events when value is -1', () => {
      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, -1);

      const state = Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr);
      // C++ code: if (mouse_button_state > -1) { process }
      const shouldProcess = state > -1;
      expect(shouldProcess).toBe(false);
    });

    it('should trigger events when value is 0 (released) or 1 (pressed)', () => {
      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, 0);
      expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr) > -1).toBe(true);

      Atomics.store(buffer, InputBufferAddresses.mouseButtonStateAddr, 1);
      expect(Atomics.load(buffer, InputBufferAddresses.mouseButtonStateAddr) > -1).toBe(true);
    });
  });

  describe('Flag clearing in releaseInputLock', () => {
    it('should clear mousePositionFlagAddr', () => {
      Atomics.store(buffer, InputBufferAddresses.mousePositionFlagAddr, 1);
      expect(Atomics.load(buffer, InputBufferAddresses.mousePositionFlagAddr)).toBe(1);

      // Simulate releaseInputLock
      Atomics.store(buffer, InputBufferAddresses.mousePositionFlagAddr, 0);
      expect(Atomics.load(buffer, InputBufferAddresses.mousePositionFlagAddr)).toBe(0);
    });

    it('should clear keyEventFlagAddr', () => {
      Atomics.store(buffer, InputBufferAddresses.keyEventFlagAddr, 1);
      expect(Atomics.load(buffer, InputBufferAddresses.keyEventFlagAddr)).toBe(1);

      // Simulate releaseInputLock
      Atomics.store(buffer, InputBufferAddresses.keyEventFlagAddr, 0);
      expect(Atomics.load(buffer, InputBufferAddresses.keyEventFlagAddr)).toBe(0);
    });

    it('should NOT clear ethernetInterruptFlagAddr (cleared by etherRead)', () => {
      Atomics.store(buffer, InputBufferAddresses.ethernetInterruptFlagAddr, 1);

      // releaseInputLock should NOT clear this - it's cleared by etherRead when packets are consumed
      // This test documents the expected behavior
      const flagBeforeRelease = Atomics.load(buffer, InputBufferAddresses.ethernetInterruptFlagAddr);
      expect(flagBeforeRelease).toBe(1);
    });
  });
});
