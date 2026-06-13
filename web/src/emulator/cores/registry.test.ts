/**
 * Core Registry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCore,
  getCore,
  getRegisteredCores,
  isCoreRegistered,
  getAllCores,
  unregisterCore,
  clearCoreRegistry,
} from './registry';
import type { CoreAdapter, EmulatorCapabilities, EmulatorConfig, CursorData } from './types';

// Mock adapter for testing
function createMockAdapter(id: string, displayName: string): CoreAdapter {
  const capabilities: EmulatorCapabilities = {
    maxScreenWidth: 1024,
    maxScreenHeight: 768,
    supportsHardwareCursor: true,
    supportsMouseDeltas: false,
    supportsEthernet: true,
    supportsAppleTalk: false,
    supportsIPX: false,
    supportsClipboard: true,
    supportsSound: true,
    supportedDiskExtensions: ['.img'],
  };

  return {
    id,
    displayName,
    capabilities,
    createWorker: () => ({} as Worker),
    getWasmPath: () => `emulator/${id}.wasm`,
    generateConfig: () => 'mock config',
    mapKeyCode: (code: string) => code.charCodeAt(0),
    parseCursor: (rawData: Uint8Array, hotspotX: number, hotspotY: number): CursorData => ({
      format: 'hidden',
      width: 0,
      height: 0,
      hotspotX,
      hotspotY,
      data: new Uint8Array(0),
    }),
    cursorToCss: () => 'default',
  };
}

describe('Core Registry', () => {
  beforeEach(() => {
    clearCoreRegistry();
  });

  describe('registerCore', () => {
    it('should register a core adapter factory', () => {
      const factory = () => createMockAdapter('test', 'Test Core');
      registerCore('test', factory);
      expect(isCoreRegistered('test')).toBe(true);
    });

    it('should allow overwriting existing registration', () => {
      const factory1 = () => createMockAdapter('test', 'First');
      const factory2 = () => createMockAdapter('test', 'Second');

      registerCore('test', factory1);
      registerCore('test', factory2);

      const adapter = getCore('test');
      expect(adapter.displayName).toBe('Second');
    });
  });

  describe('getCore', () => {
    it('should return adapter from factory', () => {
      const factory = () => createMockAdapter('mycore', 'My Core');
      registerCore('mycore', factory);

      const adapter = getCore('mycore');
      expect(adapter.id).toBe('mycore');
      expect(adapter.displayName).toBe('My Core');
    });

    it('should throw for unknown core', () => {
      expect(() => getCore('nonexistent')).toThrow('Unknown core: "nonexistent"');
    });

    it('should create new instance each call', () => {
      let callCount = 0;
      const factory = () => {
        callCount++;
        return createMockAdapter('test', `Instance ${callCount}`);
      };
      registerCore('test', factory);

      const adapter1 = getCore('test');
      const adapter2 = getCore('test');

      expect(adapter1.displayName).toBe('Instance 1');
      expect(adapter2.displayName).toBe('Instance 2');
      expect(callCount).toBe(2);
    });
  });

  describe('getRegisteredCores', () => {
    it('should return empty array when no cores registered', () => {
      expect(getRegisteredCores()).toEqual([]);
    });

    it('should return all registered core IDs', () => {
      registerCore('core1', () => createMockAdapter('core1', 'Core 1'));
      registerCore('core2', () => createMockAdapter('core2', 'Core 2'));
      registerCore('core3', () => createMockAdapter('core3', 'Core 3'));

      const cores = getRegisteredCores();
      expect(cores).toContain('core1');
      expect(cores).toContain('core2');
      expect(cores).toContain('core3');
      expect(cores.length).toBe(3);
    });
  });

  describe('isCoreRegistered', () => {
    it('should return false for unregistered core', () => {
      expect(isCoreRegistered('unknown')).toBe(false);
    });

    it('should return true for registered core', () => {
      registerCore('known', () => createMockAdapter('known', 'Known'));
      expect(isCoreRegistered('known')).toBe(true);
    });
  });

  describe('getAllCores', () => {
    it('should return empty array when no cores registered', () => {
      expect(getAllCores()).toEqual([]);
    });

    it('should return adapter instances for all registered cores', () => {
      registerCore('a', () => createMockAdapter('a', 'Core A'));
      registerCore('b', () => createMockAdapter('b', 'Core B'));

      const cores = getAllCores();
      expect(cores.length).toBe(2);
      expect(cores.map(c => c.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('unregisterCore', () => {
    it('should remove a registered core', () => {
      registerCore('temp', () => createMockAdapter('temp', 'Temp'));
      expect(isCoreRegistered('temp')).toBe(true);

      const result = unregisterCore('temp');
      expect(result).toBe(true);
      expect(isCoreRegistered('temp')).toBe(false);
    });

    it('should return false for non-existent core', () => {
      const result = unregisterCore('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('clearCoreRegistry', () => {
    it('should remove all registered cores', () => {
      registerCore('a', () => createMockAdapter('a', 'A'));
      registerCore('b', () => createMockAdapter('b', 'B'));
      expect(getRegisteredCores().length).toBe(2);

      clearCoreRegistry();
      expect(getRegisteredCores().length).toBe(0);
    });
  });
});
