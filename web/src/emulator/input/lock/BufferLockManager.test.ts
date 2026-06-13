/**
 * Tests for BufferLockManager.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockBufferLockManager, LockState } from './BufferLockManager';

describe('MockBufferLockManager', () => {
  let lock: MockBufferLockManager;

  beforeEach(() => {
    lock = new MockBufferLockManager();
  });

  describe('tryAcquire', () => {
    it('should acquire lock when available', () => {
      expect(lock.tryAcquire()).toBe(true);
    });

    it('should fail to acquire when already locked', () => {
      lock.tryAcquire();
      expect(lock.tryAcquire()).toBe(false);
    });

    it('should succeed after release', () => {
      lock.tryAcquire();
      lock.release();
      expect(lock.tryAcquire()).toBe(true);
    });
  });

  describe('release', () => {
    it('should release the lock', () => {
      lock.tryAcquire();
      lock.release();
      expect(lock.isAvailable()).toBe(true);
    });
  });

  describe('getState', () => {
    it('should return READY_FOR_UI when unlocked', () => {
      expect(lock.getState()).toBe(LockState.READY_FOR_UI);
    });

    it('should return UI_LOCKED when locked', () => {
      lock.tryAcquire();
      expect(lock.getState()).toBe(LockState.UI_LOCKED);
    });
  });

  describe('isAvailable', () => {
    it('should return true when unlocked', () => {
      expect(lock.isAvailable()).toBe(true);
    });

    it('should return false when locked', () => {
      lock.tryAcquire();
      expect(lock.isAvailable()).toBe(false);
    });
  });

  describe('forceReset', () => {
    it('should reset lock to available state', () => {
      lock.tryAcquire();
      lock.forceReset();
      expect(lock.isAvailable()).toBe(true);
    });
  });
});

describe('LockState', () => {
  it('should have correct values for 4-state protocol', () => {
    expect(LockState.READY_FOR_UI).toBe(0);
    expect(LockState.UI_LOCKED).toBe(1);
    expect(LockState.READY_FOR_EMULATOR).toBe(2);
    expect(LockState.EMULATOR_LOCKED).toBe(3);
  });
});
