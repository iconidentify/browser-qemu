/**
 * Tests for DiskLockManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiskLockManager, LockConflictError, disposeLockManager } from './DiskLockManager';

// Mock sessionStorage
const mockSessionStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

vi.stubGlobal('sessionStorage', mockSessionStorage);

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => 'test-uuid-1234-5678-9abc-def012345678'),
});

// Mock navigator.sendBeacon
vi.stubGlobal('navigator', {
  sendBeacon: vi.fn(() => true),
});

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('DiskLockManager', () => {
  let manager: DiskLockManager;
  const relayUrl = 'http://localhost:8081';
  const sessionId = 'test-session-id';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.clear();
    disposeLockManager();

    manager = new DiskLockManager({
      relayUrl,
      sessionId,
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  describe('acquireLock', () => {
    it('should acquire lock successfully', async () => {
      const lockInfo = {
        diskName: 'test.dsk',
        tabId: 'test-uuid-1234-5678-9abc-def012345678',
        sessionId: 'test-session-id',
        acquiredAt: '2024-01-01T00:00:00Z',
        lastHeartbeat: '2024-01-01T00:00:00Z',
        userAgent: 'Test',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lockInfo),
      });

      const result = await manager.acquireLock('test.dsk');

      expect(result.diskName).toBe('test.dsk');
      expect(manager.holdsLock('test.dsk')).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/disk/lock'),
        { method: 'POST' }
      );
    });

    it('should throw LockConflictError on 409', async () => {
      const holder = {
        diskName: 'test.dsk',
        tabId: 'other-tab-id',
        sessionId: 'other-session',
        acquiredAt: '2024-01-01T00:00:00Z',
        lastHeartbeat: '2024-01-01T00:00:00Z',
        userAgent: 'Other Browser',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'locked', holder }),
      });

      try {
        await manager.acquireLock('test.dsk');
        expect.fail('Expected LockConflictError to be thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LockConflictError);
        expect((e as LockConflictError).holder.tabId).toBe('other-tab-id');
      }
    });

    it('should throw error on other HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(manager.acquireLock('test.dsk')).rejects.toThrow('Failed to acquire lock: 500');
    });
  });

  describe('releaseLock', () => {
    it('should release a held lock', async () => {
      // First acquire
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            diskName: 'test.dsk',
            tabId: 'test-tab',
            sessionId: 'test-session',
            acquiredAt: '2024-01-01T00:00:00Z',
            lastHeartbeat: '2024-01-01T00:00:00Z',
            userAgent: 'Test',
          }),
      });

      await manager.acquireLock('test.dsk');
      expect(manager.holdsLock('test.dsk')).toBe(true);

      // Then release
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await manager.releaseLock('test.dsk');
      expect(manager.holdsLock('test.dsk')).toBe(false);
    });

    it('should handle releasing non-held lock gracefully', async () => {
      // Should not throw
      await manager.releaseLock('non-existent.dsk');
      expect(manager.holdsLock('non-existent.dsk')).toBe(false);
    });
  });

  describe('checkLockStatus', () => {
    it('should return null for unlocked disk', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ locked: false }),
      });

      const status = await manager.checkLockStatus('test.dsk');
      expect(status).toBeNull();
    });

    it('should return holder info for locked disk', async () => {
      const holder = {
        diskName: 'test.dsk',
        tabId: 'other-tab',
        sessionId: 'other-session',
        acquiredAt: '2024-01-01T00:00:00Z',
        lastHeartbeat: '2024-01-01T00:00:00Z',
        userAgent: 'Other',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ locked: true, holder }),
      });

      const status = await manager.checkLockStatus('test.dsk');
      expect(status).not.toBeNull();
      expect(status?.tabId).toBe('other-tab');
    });
  });

  describe('takeoverLock', () => {
    it('should takeover an existing lock', async () => {
      const previous = {
        diskName: 'test.dsk',
        tabId: 'old-tab',
        sessionId: 'old-session',
        acquiredAt: '2024-01-01T00:00:00Z',
        lastHeartbeat: '2024-01-01T00:00:00Z',
        userAgent: 'Old Browser',
      };

      const newLock = {
        diskName: 'test.dsk',
        tabId: 'test-uuid-1234-5678-9abc-def012345678',
        sessionId: 'test-session-id',
        acquiredAt: '2024-01-01T01:00:00Z',
        lastHeartbeat: '2024-01-01T01:00:00Z',
        userAgent: 'Test',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ lock: newLock, previous }),
      });

      const result = await manager.takeoverLock('test.dsk');

      expect(result.lock.tabId).toBe('test-uuid-1234-5678-9abc-def012345678');
      expect(result.previous?.tabId).toBe('old-tab');
      expect(manager.holdsLock('test.dsk')).toBe(true);
    });
  });

  describe('heartbeat', () => {
    // Note: Heartbeats are now handled by the main thread (EmulatorCanvas),
    // not by DiskLockManager. The worker's event loop is blocked by the emulator,
    // so setInterval callbacks never fire. Main thread sends heartbeats instead.
    it('should export heartbeat info for main thread', async () => {
      const { getHeartbeatInfo } = await import('./DiskLockManager');

      // Clear singleton and create fresh manager via getLockManager
      disposeLockManager();
      const { getLockManager } = await import('./DiskLockManager');
      const mgr = getLockManager(relayUrl, sessionId);

      // Acquire a lock
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            diskName: 'test.dsk',
            tabId: 'test-tab',
            sessionId: 'test-session',
            acquiredAt: '2024-01-01T00:00:00Z',
            lastHeartbeat: '2024-01-01T00:00:00Z',
            userAgent: 'Test',
          }),
      });

      await mgr.acquireLock('test.dsk');

      // Should export info for main thread to send heartbeats
      const info = getHeartbeatInfo();
      expect(info).not.toBeNull();
      expect(info?.relayUrl).toBe(relayUrl);
      expect(info?.diskNames).toContain('test.dsk');

      mgr.dispose();
    });
  });

  describe('releaseAllLocks', () => {
    it('should use sendBeacon on page unload', async () => {
      // Reset mock to clear any previous state
      mockFetch.mockReset();

      // Acquire some locks - use mockResolvedValueOnce for each call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            diskName: 'disk1.dsk',
            tabId: 'test-tab',
            sessionId: 'test-session',
            acquiredAt: '2024-01-01T00:00:00Z',
            lastHeartbeat: '2024-01-01T00:00:00Z',
            userAgent: 'Test',
          }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            diskName: 'disk2.dsk',
            tabId: 'test-tab',
            sessionId: 'test-session',
            acquiredAt: '2024-01-01T00:00:00Z',
            lastHeartbeat: '2024-01-01T00:00:00Z',
            userAgent: 'Test',
          }),
      });

      await manager.acquireLock('disk1.dsk');
      await manager.acquireLock('disk2.dsk');

      // Trigger release all
      manager.releaseAllLocks();

      // Should have called sendBeacon for each lock
      expect(navigator.sendBeacon).toHaveBeenCalledTimes(2);
      expect(navigator.sendBeacon).toHaveBeenCalledWith(
        expect.stringContaining('/disk/unlock')
      );
    });
  });

  describe('getHeldLocks', () => {
    it('should return list of held lock names', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            diskName: 'test.dsk',
            tabId: 'test-tab',
            sessionId: 'test-session',
            acquiredAt: '2024-01-01T00:00:00Z',
            lastHeartbeat: '2024-01-01T00:00:00Z',
            userAgent: 'Test',
          }),
      });

      await manager.acquireLock('disk1.dsk');
      await manager.acquireLock('disk2.dsk');

      const held = manager.getHeldLocks();
      expect(held).toContain('disk1.dsk');
      expect(held).toContain('disk2.dsk');
      expect(held.length).toBe(2);
    });
  });

  describe('tab ID persistence', () => {
    it('should persist tab ID in sessionStorage', () => {
      // The tab ID should have been set when manager was created
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        'dialtone-tab-id',
        expect.any(String)
      );
    });

    it('should reuse existing tab ID', () => {
      // Clear the mock and reset count
      (crypto.randomUUID as ReturnType<typeof vi.fn>).mockClear();

      const existingTabId = 'existing-tab-id-12345';
      mockSessionStorage.getItem.mockReturnValueOnce(existingTabId);

      const manager2 = new DiskLockManager({
        relayUrl,
        sessionId,
      });

      // Should not create a new tab ID since one already exists
      expect(crypto.randomUUID).not.toHaveBeenCalled();

      manager2.dispose();
    });
  });
});
