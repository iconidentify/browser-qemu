/**
 * Basilisk Adapter Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { BasiliskAdapter, createBasiliskAdapter } from './BasiliskAdapter';
import type { EmulatorConfig } from '../types';

// Mock the Worker constructor
vi.mock('./basilisk-worker.ts', () => ({}));

describe('BasiliskAdapter', () => {
  describe('properties', () => {
    it('should have correct id', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.id).toBe('basilisk');
    });

    it('should have correct display name', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.displayName).toBe('Macintosh 68k');
    });
  });

  describe('capabilities', () => {
    it('should have correct screen limits', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.maxScreenWidth).toBe(1600);
      expect(adapter.capabilities.maxScreenHeight).toBe(1200);
    });

    it('should support hardware cursor', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.supportsHardwareCursor).toBe(true);
    });

    it('should not support mouse deltas (uses absolute)', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.supportsMouseDeltas).toBe(false);
    });

    it('should support ethernet and AppleTalk', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.supportsEthernet).toBe(true);
      expect(adapter.capabilities.supportsAppleTalk).toBe(true);
      expect(adapter.capabilities.supportsIPX).toBe(false);
    });

    it('should support clipboard and sound', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.supportsClipboard).toBe(true);
      expect(adapter.capabilities.supportsSound).toBe(true);
    });

    it('should support Mac disk extensions', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.capabilities.supportedDiskExtensions).toContain('.dsk');
      expect(adapter.capabilities.supportedDiskExtensions).toContain('.img');
      expect(adapter.capabilities.supportedDiskExtensions).toContain('.hda');
      expect(adapter.capabilities.supportedDiskExtensions).toContain('.iso');
    });
  });

  describe('getWasmPath', () => {
    it('should return correct WASM path', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.getWasmPath()).toBe('emulator/BasiliskII.wasm');
    });
  });

  describe('generateConfig', () => {
    it('should generate prefs with correct screen settings', () => {
      const adapter = new BasiliskAdapter();
      const config: EmulatorConfig = {
        screenWidth: 1024,
        screenHeight: 768,
        ramSizeMB: 32,
        diskPaths: ['/path/to/boot.dsk'],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
      };

      const prefs = adapter.generateConfig(config);
      expect(prefs).toContain('screen win/1024/768');
    });

    it('should generate prefs with correct RAM size', () => {
      const adapter = new BasiliskAdapter();
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: ['/disk.img'],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: false,
      };

      const prefs = adapter.generateConfig(config);
      expect(prefs).toContain('ramsize 16777216'); // 16 * 1024 * 1024
    });

    it('should generate prefs with JIT setting', () => {
      const adapter = new BasiliskAdapter();
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: [],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
      };

      const prefs = adapter.generateConfig(config);
      expect(prefs).toContain('jit true');
    });
  });

  describe('getRomPath', () => {
    it('should return default ROM path', () => {
      const adapter = new BasiliskAdapter();
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: [],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
      };

      expect(adapter.getRomPath(config)).toBe('rom/quadra650.rom');
    });

    it('should return custom ROM path from coreConfig', () => {
      const adapter = new BasiliskAdapter();
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: [],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
        coreConfig: {
          romPath: 'custom/path/mac2ci.rom',
        },
      };

      expect(adapter.getRomPath(config)).toBe('custom/path/mac2ci.rom');
    });
  });

  describe('mapKeyCode', () => {
    it('should map letter keys to ADB codes', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.mapKeyCode('KeyA')).toBe(0x00);
      expect(adapter.mapKeyCode('KeyZ')).toBe(0x06);
    });

    it('should map special keys to ADB codes', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.mapKeyCode('Enter')).toBe(0x24);
      expect(adapter.mapKeyCode('Space')).toBe(0x31);
      expect(adapter.mapKeyCode('Escape')).toBe(0x35);
    });

    it('should return -1 for unmapped keys', () => {
      const adapter = new BasiliskAdapter();
      expect(adapter.mapKeyCode('UnknownKey')).toBe(-1);
    });
  });

  describe('parseCursor', () => {
    it('should parse empty cursor as hidden', () => {
      const adapter = new BasiliskAdapter();
      const emptyData = new Uint8Array(64);
      const result = adapter.parseCursor(emptyData, 0, 0);

      expect(result.format).toBe('hidden');
    });

    it('should parse valid cursor data', () => {
      const adapter = new BasiliskAdapter();
      const data = new Uint8Array(64);
      data[0] = 0xFF;
      data[32] = 0xFF;

      const result = adapter.parseCursor(data, 5, 5);

      expect(result.format).toBe('mac-1bit');
      expect(result.width).toBe(16);
      expect(result.height).toBe(16);
      expect(result.hotspotX).toBe(5);
      expect(result.hotspotY).toBe(5);
    });
  });

  describe('cursorToCss', () => {
    it('should return none for hidden cursor', () => {
      const adapter = new BasiliskAdapter();
      const cursor = {
        format: 'hidden' as const,
        width: 0,
        height: 0,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8Array(0),
      };

      expect(adapter.cursorToCss(cursor, 1)).toBe('none');
    });

    it('should return default cursor for non mac-1bit format', () => {
      const adapter = new BasiliskAdapter();
      const cursor = {
        format: 'win-color' as const,
        width: 32,
        height: 32,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8Array(32),
      };

      const result = adapter.cursorToCss(cursor, 1);
      expect(result).toContain('url('); // Default Mac cursor has URL
    });

    it('should return default cursor for mac-1bit without mask', () => {
      const adapter = new BasiliskAdapter();
      const cursor = {
        format: 'mac-1bit' as const,
        width: 16,
        height: 16,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8Array(32),
        // No mask
      };

      const result = adapter.cursorToCss(cursor, 1);
      expect(result).toContain('url(');
    });
  });

  describe('createBasiliskAdapter', () => {
    it('should create a new BasiliskAdapter instance', () => {
      const adapter = createBasiliskAdapter();
      expect(adapter).toBeInstanceOf(BasiliskAdapter);
      expect(adapter.id).toBe('basilisk');
    });
  });
});
