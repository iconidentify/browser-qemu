/**
 * Tests for DiskFactory
 *
 * Tests the disk creation factory including:
 * - createDisk with different storage modes
 * - fetchDiskList from relay
 * - createDiskImage for new disks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDisk, fetchDiskList, createDiskImage } from './DiskFactory';

// Mock SimpleDisk module
vi.mock('./SimpleDisk', () => ({
  SimpleDisk: {
    create: vi.fn().mockResolvedValue({
      name: 'test.dsk',
      size: 1024,
      mode: 'disk-server',
      read: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

// Mock CachedRelayDisk module (dynamic import)
vi.mock('./CachedRelayDisk', () => ({
  CachedRelayDisk: {
    create: vi.fn().mockResolvedValue({
      name: 'test.dsk',
      size: 1024,
      mode: 'client-cached',
      read: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
    }),
    createOffline: vi.fn().mockResolvedValue(null),
  },
}));

// Mock DiskLockManager module
const mockAcquireLock = vi.fn().mockResolvedValue({
  diskName: 'test.dsk',
  tabId: 'test-tab',
  sessionId: 'test-session',
  acquiredAt: '2024-01-01T00:00:00Z',
  lastHeartbeat: '2024-01-01T00:00:00Z',
  userAgent: 'Test',
});
const mockReleaseLock = vi.fn().mockResolvedValue(undefined);

vi.mock('./DiskLockManager', () => ({
  getLockManager: vi.fn(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
  LockConflictError: class LockConflictError extends Error {
    holder: unknown;
    constructor(diskName: string, holder: unknown) {
      super(`Disk "${diskName}" is locked by another tab`);
      this.name = 'LockConflictError';
      this.holder = holder;
    }
  },
}));

describe('createDisk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create SimpleDisk for disk-server mode', async () => {
    const { SimpleDisk } = await import('./SimpleDisk');

    const disk = await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'disk-server',
    });

    expect(SimpleDisk.create).toHaveBeenCalledWith(
      'test.dsk',
      'http://relay:8081',
      'user1',
      undefined // adminToken - absent for a normal (non-admin) session
    );
    expect(disk.mode).toBe('disk-server');
  });

  it('should create CachedRelayDisk for client-cached mode', async () => {
    const { CachedRelayDisk } = await import('./CachedRelayDisk');

    const disk = await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'client-cached',
    });

    expect(CachedRelayDisk.create).toHaveBeenCalledWith(
      'test.dsk',
      'http://relay:8081',
      'user1',
      undefined // sessionId (optional)
    );
    expect(disk.mode).toBe('client-cached');
  });

  it('should pass sessionId to CachedRelayDisk when provided', async () => {
    const { CachedRelayDisk } = await import('./CachedRelayDisk');

    await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'client-cached',
      sessionId: 'session-123',
    });

    expect(CachedRelayDisk.create).toHaveBeenCalledWith(
      'test.dsk',
      'http://relay:8081',
      'user1',
      'session-123'
    );
  });

  it('should try offline cache when relay fails in client-cached mode', async () => {
    const { CachedRelayDisk } = await import('./CachedRelayDisk');
    (CachedRelayDisk.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network error')
    );

    // Offline returns null, so should re-throw original error
    await expect(
      createDisk({
        name: 'test.dsk',
        relayUrl: 'http://relay:8081',
        userId: 'user1',
        mode: 'client-cached',
      })
    ).rejects.toThrow('Network error');

    expect(CachedRelayDisk.createOffline).toHaveBeenCalledWith('test.dsk');
  });

  it('should return offline disk if available', async () => {
    const { CachedRelayDisk } = await import('./CachedRelayDisk');
    (CachedRelayDisk.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Network error')
    );
    (
      CachedRelayDisk.createOffline as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      name: 'test.dsk',
      size: 1024,
      mode: 'client-cached',
      read: vi.fn(),
      write: vi.fn(),
      dispose: vi.fn(),
    });

    const disk = await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'client-cached',
    });

    expect(disk).toBeDefined();
    expect(disk.mode).toBe('client-cached');
  });

  it('should acquire lock for disk-server mode', async () => {
    await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'disk-server',
    });

    expect(mockAcquireLock).toHaveBeenCalledWith('test.dsk');
  });

  it('should throw LockConflictError when disk is locked', async () => {
    const { LockConflictError } = await import('./DiskLockManager');
    mockAcquireLock.mockRejectedValueOnce(
      new LockConflictError('test.dsk', { tabId: 'other-tab' })
    );

    await expect(
      createDisk({
        name: 'test.dsk',
        relayUrl: 'http://relay:8081',
        userId: 'user1',
        mode: 'disk-server',
      })
    ).rejects.toThrow('locked by another tab');
  });

  it('should release lock on dispose for disk-server mode', async () => {
    const disk = await createDisk({
      name: 'test.dsk',
      relayUrl: 'http://relay:8081',
      userId: 'user1',
      mode: 'disk-server',
    });

    // Call dispose which should release the lock
    await disk.dispose();

    expect(mockReleaseLock).toHaveBeenCalledWith('test.dsk');
  });

  it('should release lock if SimpleDisk creation fails', async () => {
    const { SimpleDisk } = await import('./SimpleDisk');
    (SimpleDisk.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Disk not found')
    );

    await expect(
      createDisk({
        name: 'test.dsk',
        relayUrl: 'http://relay:8081',
        userId: 'user1',
        mode: 'disk-server',
      })
    ).rejects.toThrow('Disk not found');

    // Lock should have been released after failure
    expect(mockReleaseLock).toHaveBeenCalledWith('test.dsk');
  });
});

describe('fetchDiskList', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should fetch and parse disk list from relay', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          bootable: [{ name: 'system.dsk', size: 1024 }],
          data: [{ name: 'work.dsk', size: 2048 }],
        }),
    });

    const result = await fetchDiskList('http://relay:8081');

    expect(mockFetch).toHaveBeenCalledWith('http://relay:8081/disk/list');
    expect(result.bootable).toHaveLength(1);
    expect(result.bootable[0].name).toBe('system.dsk');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe('work.dsk');
  });

  it('should throw error on HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(fetchDiskList('http://relay:8081')).rejects.toThrow(
      'Failed to fetch disk list: 500 Internal Server Error'
    );
  });

  it('should handle empty response arrays', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await fetchDiskList('http://relay:8081');

    expect(result.bootable).toEqual([]);
    expect(result.data).toEqual([]);
  });

  it('should handle null arrays in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ bootable: null, data: null }),
    });

    const result = await fetchDiskList('http://relay:8081');

    expect(result.bootable).toEqual([]);
    expect(result.data).toEqual([]);
  });
});

describe('createDiskImage', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create a new disk image on relay', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ name: 'new.dsk', size: 10485760 }),
    });

    const result = await createDiskImage(
      'http://relay:8081',
      'new.dsk',
      10485760
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://relay:8081/disk/create?name=new.dsk&size=10485760',
      { method: 'POST' }
    );
    expect(result.name).toBe('new.dsk');
    expect(result.size).toBe(10485760);
  });

  it('should encode disk name in URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ name: 'my disk.dsk', size: 1024 }),
    });

    await createDiskImage('http://relay:8081', 'my disk.dsk', 1024);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://relay:8081/disk/create?name=my%20disk.dsk&size=1024',
      { method: 'POST' }
    );
  });

  it('should throw error with server message on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Disk already exists'),
    });

    await expect(
      createDiskImage('http://relay:8081', 'existing.dsk', 1024)
    ).rejects.toThrow('Disk already exists');
  });

  it('should throw generic error when no message provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(''),
    });

    await expect(
      createDiskImage('http://relay:8081', 'test.dsk', 1024)
    ).rejects.toThrow('Failed to create disk: 500');
  });
});
