/**
 * Tests for SimpleDisk and LocalDisk
 *
 * Tests the disk I/O modules including:
 * - SimpleDisk.create() factory method
 * - Sync XHR read/write operations
 * - Error handling for network failures
 * - LocalDisk in-memory write overlay
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpleDisk, LocalDisk } from './SimpleDisk';

describe('SimpleDisk', () => {
  // Mock fetch for create()
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('create()', () => {
    it('should create a SimpleDisk with disk info from relay', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');

      expect(disk.name).toBe('test.dsk');
      expect(disk.size).toBe(1048576);
      expect(disk.mode).toBe('disk-server');
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
        SimpleDisk.create('notfound.dsk', 'http://relay:8081', 'user1')
      ).rejects.toThrow('Disk not found: notfound.dsk (404)');
    });

    it('should throw error if disk info is missing size', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk' }), // No size
      });

      await expect(
        SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1')
      ).rejects.toThrow('Invalid disk info for test.dsk: missing size');
    });

    it('should encode disk name in URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'my disk.dsk', size: 1024 }),
      });

      await SimpleDisk.create('my disk.dsk', 'http://relay:8081', 'user1');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://relay:8081/disk/info?name=my%20disk.dsk'
      );
    });

    it('should handle different relay URLs', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 2048 }),
      });

      const disk = await SimpleDisk.create('test.dsk', 'https://other.relay.com', 'user1');

      expect(disk.size).toBe(2048);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://other.relay.com/disk/info?name=test.dsk'
      );
    });
  });

  describe('read()', () => {
    // Mock XMLHttpRequest for sync read/write operations
    let mockXHR: {
      open: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      status: number;
      response: ArrayBuffer | null;
      responseText: string;
      responseType: string;
    };

    beforeEach(() => {
      // Setup mock fetch for disk creation
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1048576 }),
      });

      // Setup mock XHR
      mockXHR = {
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(512),
        responseText: '',
        responseType: '',
      };

      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );
    });

    it('should read data via sync XHR', async () => {
      // Put some data in the response
      const responseData = new Uint8Array([1, 2, 3, 4, 5]);
      mockXHR.response = responseData.buffer;

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 0, 5);

      expect(bytesRead).toBe(5);
      expect(buffer.slice(0, 5)).toEqual(responseData);
      expect(mockXHR.open).toHaveBeenCalledWith(
        'GET',
        'http://relay:8081/disk/read?name=test.dsk&offset=0&length=5',
        false // sync
      );
      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith('X-User-Id', 'user1');
    });

    it('should return 0 on network error', async () => {
      mockXHR.send = vi.fn(() => {
        throw new Error('Network error');
      });

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 100, 10);

      expect(bytesRead).toBe(0);
    });

    it('should return 0 on HTTP error', async () => {
      mockXHR.status = 500;
      mockXHR.responseText = 'Internal Server Error';

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 0, 10);

      expect(bytesRead).toBe(0);
    });

    it('should not throw if binary HTTP error responseText is inaccessible', async () => {
      mockXHR.status = 404;
      mockXHR.response = new TextEncoder().encode('Disk not found').buffer;
      Object.defineProperty(mockXHR, 'responseText', {
        configurable: true,
        get() {
          if (mockXHR.responseType !== '' && mockXHR.responseType !== 'text') {
            throw new Error('responseText unavailable for binary response');
          }
          return 'Disk not found';
        },
      });

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      let bytesRead = -1;

      expect(() => {
        bytesRead = disk.read(buffer, 0, 10);
      }).not.toThrow();
      expect(bytesRead).toBe(0);
    });

    it('should return 0 if response is null', async () => {
      mockXHR.response = null;

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      const bytesRead = disk.read(buffer, 0, 10);

      expect(bytesRead).toBe(0);
    });

    it('should handle empty response', async () => {
      mockXHR.response = new ArrayBuffer(0);

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      buffer.fill(0xff);
      const bytesRead = disk.read(buffer, 0, 10);

      expect(bytesRead).toBe(0);
      expect(buffer[0]).toBe(0xff); // Buffer unchanged
    });

    it('should copy only available bytes to buffer', async () => {
      // Response has 3 bytes but we requested 10
      const responseData = new Uint8Array([0xaa, 0xbb, 0xcc]);
      mockXHR.response = responseData.buffer;

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const buffer = new Uint8Array(10);
      buffer.fill(0xff); // Pre-fill with 0xff
      const bytesRead = disk.read(buffer, 0, 10);

      expect(bytesRead).toBe(3);
      expect(buffer.slice(0, 3)).toEqual(responseData);
      expect(buffer[3]).toBe(0xff); // Rest unchanged
    });
  });

  describe('write()', () => {
    let mockXHR: {
      open: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      setRequestHeader: ReturnType<typeof vi.fn>;
      status: number;
      responseText: string;
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
        responseText: '',
      };

      vi.stubGlobal(
        'XMLHttpRequest',
        vi.fn(() => mockXHR)
      );
    });

    it('should write data via sync XHR', async () => {
      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const bytesWritten = disk.write(data, 100, 5);

      expect(bytesWritten).toBe(5);
      expect(mockXHR.open).toHaveBeenCalledWith(
        'POST',
        'http://relay:8081/disk/write?name=test.dsk&offset=100',
        false // sync
      );
      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith('X-User-Id', 'user1');
      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/octet-stream'
      );
      expect(mockXHR.send).toHaveBeenCalled();
    });

    it('should return 0 on network error', async () => {
      mockXHR.send = vi.fn(() => {
        throw new Error('Network error');
      });

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const data = new Uint8Array([1, 2, 3]);
      const bytesWritten = disk.write(data, 0, 3);

      expect(bytesWritten).toBe(0);
    });

    it('should return 0 on HTTP error', async () => {
      mockXHR.status = 400;

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const data = new Uint8Array([1, 2, 3]);
      const bytesWritten = disk.write(data, 0, 3);

      expect(bytesWritten).toBe(0);
    });

    it('should handle partial write length', async () => {
      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const bytesWritten = disk.write(data, 50, 3); // Only write first 3 bytes

      expect(bytesWritten).toBe(3);
      expect(mockXHR.open).toHaveBeenCalledWith(
        'POST',
        expect.stringContaining('offset=50'),
        false
      );
    });
  });

  describe('dispose()', () => {
    it('should not throw (no-op)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'test.dsk', size: 1024 }),
      });

      const disk = await SimpleDisk.create('test.dsk', 'http://relay:8081', 'user1');

      expect(() => disk.dispose()).not.toThrow();
    });
  });
});

describe('LocalDisk', () => {
  describe('constructor', () => {
    it('should create a LocalDisk from File object', () => {
      const file = new File(['test content'], 'local.dsk', {
        type: 'application/octet-stream',
      });

      const disk = new LocalDisk(file);

      expect(disk.name).toBe('local.dsk');
      expect(disk.size).toBe(12); // 'test content'.length
      expect(disk.mode).toBe('disk-server');
    });

    it('should use file name as disk name', () => {
      const file = new File(['data'], 'mydata.dsk');
      const disk = new LocalDisk(file);

      expect(disk.name).toBe('mydata.dsk');
    });

    it('should use file size as disk size', () => {
      const content = 'a'.repeat(1000);
      const file = new File([content], 'large.dsk');
      const disk = new LocalDisk(file);

      expect(disk.size).toBe(1000);
    });
  });

  describe('write()', () => {
    it('should store writes in memory overlay', () => {
      const file = new File(['original content'], 'test.dsk');
      const disk = new LocalDisk(file);

      const data = new Uint8Array([0xaa, 0xbb, 0xcc]);
      const bytesWritten = disk.write(data, 5, 3);

      expect(bytesWritten).toBe(3);
    });

    it('should return written length', () => {
      const file = new File(['test'], 'test.dsk');
      const disk = new LocalDisk(file);

      const data = new Uint8Array(100);
      const bytesWritten = disk.write(data, 0, 100);

      expect(bytesWritten).toBe(100);
    });
  });

  describe('dispose()', () => {
    it('should clear in-memory writes', () => {
      const file = new File(['test'], 'test.dsk');
      const disk = new LocalDisk(file);

      // Write some data
      disk.write(new Uint8Array([1, 2, 3]), 0, 3);

      // Dispose should clear
      expect(() => disk.dispose()).not.toThrow();
    });
  });

  // Note: read() tests require FileReaderSync which is only available in Web Workers
  // Those would need integration tests in a worker context
});

describe('Disk interface compliance', () => {
  it('SimpleDisk should have required Disk interface properties', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: 'test.dsk', size: 1024 }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal(
      'XMLHttpRequest',
      vi.fn(() => ({
        open: vi.fn(),
        send: vi.fn(),
        setRequestHeader: vi.fn(),
        status: 200,
        response: new ArrayBuffer(0),
      }))
    );

    const disk = await SimpleDisk.create('test.dsk', 'http://relay', 'user');

    // Check required properties
    expect(typeof disk.name).toBe('string');
    expect(typeof disk.size).toBe('number');
    expect(typeof disk.mode).toBe('string');
    expect(typeof disk.read).toBe('function');
    expect(typeof disk.write).toBe('function');
    expect(typeof disk.dispose).toBe('function');

    vi.unstubAllGlobals();
  });

  it('LocalDisk should have required Disk interface properties', () => {
    const file = new File(['test'], 'test.dsk');
    const disk = new LocalDisk(file);

    // Check required properties
    expect(typeof disk.name).toBe('string');
    expect(typeof disk.size).toBe('number');
    expect(typeof disk.mode).toBe('string');
    expect(typeof disk.read).toBe('function');
    expect(typeof disk.write).toBe('function');
    expect(typeof disk.dispose).toBe('function');
  });
});
