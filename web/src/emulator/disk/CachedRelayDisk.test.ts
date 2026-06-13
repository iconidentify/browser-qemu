/**
 * Tests for CachedRelayDisk
 *
 * Tests the cached disk I/O layer including:
 * - Disk creation from relay
 * - Cache hierarchy (memory -> OPFS -> relay)
 * - LRU eviction
 * - Read/Write operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CachedRelayDisk } from './CachedRelayDisk';

// Mock OPFSCache module
vi.mock('./OPFSCache', () => ({
  OPFSCache: {
    create: vi.fn().mockResolvedValue(null),
  },
}));

describe('CachedRelayDisk', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('create()', () => {
    it('should create a CachedRelayDisk with disk info from relay', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      expect(disk.name).toBe('test.dsk');
      expect(disk.size).toBe(1048576);
      expect(disk.mode).toBe('client-cached');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://relay:8081/disk/info?name=test.dsk'
      );
    });

    it('should throw error if disk not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        CachedRelayDisk.create('notfound.dsk', 'http://relay:8081', 'user1')
      ).rejects.toThrow('Disk not found: notfound.dsk (404)');
    });

    it('should throw error if disk info is missing size', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk' }), // No size
      });

      await expect(
        CachedRelayDisk.create('test.dsk', 'http://relay:8081', 'user1')
      ).rejects.toThrow('Invalid disk info for test.dsk: missing size');
    });

    it('should encode disk name in URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'my disk.dsk', size: 1024 }),
      });

      await CachedRelayDisk.create('my disk.dsk', 'http://relay:8081', 'user1');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://relay:8081/disk/info?name=my%20disk.dsk'
      );
    });
  });

  describe('createOffline()', () => {
    it('should return null (not fully implemented)', async () => {
      const result = await CachedRelayDisk.createOffline('test.dsk');
      expect(result).toBeNull();
    });
  });

  describe('read()', () => {
    let mockXHR: {
      open: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      status: number;
      response: ArrayBuffer | null;
      responseType: string;
    };

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024), // Full chunk
        responseType: '',
      };

      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );
    });

    it('should read data from relay when not cached', async () => {
      const chunkData = new Uint8Array(128 * 1024);
      chunkData.set([1, 2, 3, 4, 5]); // Put some data at start
      mockXHR.response = chunkData.buffer;

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );
      const buffer = new Uint8Array(5);
      const bytesRead = disk.read(buffer, 0, 5);

      expect(bytesRead).toBe(5);
      expect(buffer).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      expect(mockXHR.open).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/disk/read?name=test.dsk'),
        false
      );
    });

    it('should return 0 bytes on network error', async () => {
      mockXHR.send = vi.fn(() => {
        throw new Error('Network error');
      });

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 0, 10);

      // Should fill with zeros on error
      expect(bytesRead).toBe(10);
      expect(buffer[0]).toBe(0);
    });

    it('should handle HTTP errors gracefully', async () => {
      mockXHR.status = 500;

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 0, 10);

      expect(bytesRead).toBe(10);
    });

    it('should cache chunks in memory for subsequent reads', async () => {
      const chunkData = new Uint8Array(128 * 1024);
      chunkData.set([0xaa, 0xbb, 0xcc]);
      mockXHR.response = chunkData.buffer;

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      // First read - should fetch from relay
      const buffer1 = new Uint8Array(3);
      disk.read(buffer1, 0, 3);
      expect(mockXHR.send).toHaveBeenCalledTimes(1);

      // Reset XHR mock
      mockXHR.send.mockClear();

      // Second read from same chunk - should use cache
      const buffer2 = new Uint8Array(3);
      disk.read(buffer2, 0, 3);

      // Should NOT call send again (using cache)
      expect(mockXHR.send).not.toHaveBeenCalled();
      expect(buffer2).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    });

    it('should handle reading across chunk boundaries', async () => {
      const chunk0 = new Uint8Array(128 * 1024);
      chunk0.fill(0x11);
      const chunk1 = new Uint8Array(128 * 1024);
      chunk1.fill(0x22);

      let callCount = 0;
      mockXHR.send = vi.fn(() => {
        mockXHR.response = callCount === 0 ? chunk0.buffer : chunk1.buffer;
        callCount++;
      });

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      // Read across chunk boundary (128KB - 10 bytes into next chunk)
      const buffer = new Uint8Array(20);
      const offset = 128 * 1024 - 10;
      const bytesRead = disk.read(buffer, offset, 20);

      expect(bytesRead).toBe(20);
      // First 10 bytes from chunk 0, next 10 from chunk 1
      expect(buffer.slice(0, 10).every((b) => b === 0x11)).toBe(true);
      expect(buffer.slice(10, 20).every((b) => b === 0x22)).toBe(true);
    });

    it('should respect disk size limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'small.dsk', size: 100 }),
      });

      const disk = await CachedRelayDisk.create(
        'small.dsk',
        'http://relay:8081',
        'user1'
      );

      const buffer = new Uint8Array(200);
      const bytesRead = disk.read(buffer, 50, 200);

      // Should only read up to disk size
      expect(bytesRead).toBe(50); // 100 - 50 = 50 bytes available
    });
  });

  describe('write()', () => {
    let mockXHR: {
      open: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      status: number;
      response: ArrayBuffer | null;
      responseType: string;
    };

    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024),
        responseType: '',
      };

      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );
    });

    it('should write data to local overlay', async () => {
      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const bytesWritten = disk.write(data, 100, 4);

      expect(bytesWritten).toBe(4);

      // Read back should return written data
      const buffer = new Uint8Array(4);
      disk.read(buffer, 100, 4);
      expect(buffer).toEqual(data);
    });

    it('should handle writes at chunk boundaries', async () => {
      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      // Write at end of first chunk
      const data = new Uint8Array([0xff, 0xee]);
      const offset = 128 * 1024 - 1; // Last byte of chunk 0
      const bytesWritten = disk.write(data, offset, 2);

      expect(bytesWritten).toBe(2);
    });
  });

  describe('dispose()', () => {
    it('should clear all caches', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1024 }),
      });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024),
        responseType: '',
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      // Load some chunks
      const buffer = new Uint8Array(10);
      disk.read(buffer, 0, 10);

      // Dispose should not throw
      expect(() => disk.dispose()).not.toThrow();
    });
  });

  describe('getCacheStats()', () => {
    it('should return cache statistics', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024),
        responseType: '',
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      const stats = disk.getCacheStats();

      expect(stats.memoryChunks).toBe(0); // No chunks loaded yet
      expect(stats.opfsChunks).toBe(0); // OPFS mocked to null
      expect(stats.totalChunks).toBe(8); // 1MB / 128KB = 8 chunks
    });

    it('should update after reads', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 512 * 1024 }),
      });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024),
        responseType: '',
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );

      const disk = await CachedRelayDisk.create(
        'test.dsk',
        'http://relay:8081',
        'user1'
      );

      // Load 2 chunks
      disk.read(new Uint8Array(10), 0, 10); // Chunk 0
      disk.read(new Uint8Array(10), 128 * 1024, 10); // Chunk 1

      const stats = disk.getCacheStats();
      expect(stats.memoryChunks).toBe(2);
      expect(stats.totalChunks).toBe(4); // 512KB / 128KB = 4 chunks
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest chunks when limit exceeded', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        // Large disk to test eviction
        json: () => Promise.resolve({ name: 'large.dsk', size: 100 * 1024 * 1024 }),
      });

      const mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(128 * 1024),
        responseType: '',
      };
      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );

      const disk = await CachedRelayDisk.create(
        'large.dsk',
        'http://relay:8081',
        'user1'
      );

      // Load more than MAX_LOADED_CHUNKS (256)
      for (let i = 0; i < 300; i++) {
        disk.read(new Uint8Array(10), i * 128 * 1024, 10);
      }

      const stats = disk.getCacheStats();
      // Should have evicted down to MAX_LOADED_CHUNKS
      expect(stats.memoryChunks).toBeLessThanOrEqual(
        CachedRelayDisk.MAX_LOADED_CHUNKS
      );
    });
  });
});
