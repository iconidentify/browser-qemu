/**
 * Basilisk II Prefs Generator Tests
 */

import { describe, it, expect } from 'vitest';
import {
  generatePrefs,
  generatePrefsFromConfig,
  DEFAULT_RAM_SIZE,
  DEFAULT_SCREEN,
} from './prefs-generator';
import type { EmulatorConfig } from '../types';

describe('prefs-generator', () => {
  describe('generatePrefs', () => {
    it('should generate basic prefs with required options', () => {
      const prefs = generatePrefs({
        romFileName: 'quadra650.rom',
        diskNames: ['boot.dsk'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      expect(prefs).toContain('rom quadra650.rom');
      expect(prefs).toContain('ramsize 16777216');
      expect(prefs).toContain('screen win/800/600');
      expect(prefs).toContain('disk boot.dsk');
      expect(prefs).toContain('jit true');
    });

    it('should include multiple disks in order', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['boot.dsk', 'data1.dsk', 'data2.dsk'],
        width: 640,
        height: 480,
        ramSize: 8 * 1024 * 1024,
        jit: false,
      });

      const lines = prefs.split('\n');
      const diskLines = lines.filter(l => l.startsWith('disk '));

      expect(diskLines.length).toBe(3);
      expect(diskLines[0]).toBe('disk boot.dsk');
      expect(diskLines[1]).toBe('disk data1.dsk');
      expect(diskLines[2]).toBe('disk data2.dsk');
    });

    it('should enable ethernet with js driver', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      expect(prefs).toContain('ether js');
    });

    it('should disable ExtFS', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      expect(prefs).toContain('extfs /disabled');
    });

    it('should use default values for optional parameters', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      // Default values
      expect(prefs).toContain('fpu true');
      expect(prefs).toContain('frameskip 0');
      expect(prefs).toContain('idlewait true');
      expect(prefs).toContain('nocdrom true');
      expect(prefs).toContain('nosound false');
    });

    it('should allow overriding optional parameters', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: false,
        fpu: false,
        frameskip: 2,
        sound: false,
        cdrom: true,
        idlewait: false,
      });

      expect(prefs).toContain('fpu false');
      expect(prefs).toContain('frameskip 2');
      expect(prefs).toContain('idlewait false');
      expect(prefs).toContain('nocdrom false'); // cdrom: true means nocdrom: false
      expect(prefs).toContain('nosound true');  // sound: false means nosound: true
      expect(prefs).toContain('jit false');
    });

    it('should set nogui to true', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      expect(prefs).toContain('nogui true');
    });

    it('should end with newline', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: ['disk.img'],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      expect(prefs.endsWith('\n')).toBe(true);
    });

    it('should handle empty disk list', () => {
      const prefs = generatePrefs({
        romFileName: 'rom.bin',
        diskNames: [],
        width: 800,
        height: 600,
        ramSize: 16 * 1024 * 1024,
        jit: true,
      });

      const lines = prefs.split('\n');
      const diskLines = lines.filter(l => l.startsWith('disk '));
      expect(diskLines.length).toBe(0);
    });
  });

  describe('generatePrefsFromConfig', () => {
    it('should convert EmulatorConfig to prefs', () => {
      const config: EmulatorConfig = {
        screenWidth: 1024,
        screenHeight: 768,
        ramSizeMB: 32,
        diskPaths: ['/path/to/boot.dsk', '/path/to/data.img'],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
      };

      const prefs = generatePrefsFromConfig(config, 'quadra650.rom');

      expect(prefs).toContain('rom quadra650.rom');
      expect(prefs).toContain('screen win/1024/768');
      expect(prefs).toContain('ramsize 33554432'); // 32 * 1024 * 1024
      expect(prefs).toContain('disk boot.dsk');
      expect(prefs).toContain('disk data.img');
      expect(prefs).toContain('jit true');
    });

    it('should extract disk names from paths', () => {
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: [
          '/some/long/path/to/system.dsk',
          'relative/path/apps.img',
          'simple.hda',
        ],
        diskMode: 'client-cached',
        relayUrl: 'ws://localhost:8080',
        jit: false,
      };

      const prefs = generatePrefsFromConfig(config, 'rom.bin');

      expect(prefs).toContain('disk system.dsk');
      expect(prefs).toContain('disk apps.img');
      expect(prefs).toContain('disk simple.hda');
    });

    it('should handle path with trailing slash', () => {
      const config: EmulatorConfig = {
        screenWidth: 800,
        screenHeight: 600,
        ramSizeMB: 16,
        diskPaths: ['/path/ending/with/slash/'],
        diskMode: 'disk-server',
        relayUrl: 'ws://localhost:8080',
        jit: true,
      };

      const prefs = generatePrefsFromConfig(config, 'rom.bin');

      // Should fall back to 'disk.img' for empty filename
      expect(prefs).toContain('disk disk.img');
    });
  });

  describe('constants', () => {
    it('should export DEFAULT_RAM_SIZE as 16MB', () => {
      expect(DEFAULT_RAM_SIZE).toBe(16 * 1024 * 1024);
    });

    it('should export DEFAULT_SCREEN dimensions', () => {
      expect(DEFAULT_SCREEN.width).toBe(800);
      expect(DEFAULT_SCREEN.height).toBe(600);
    });
  });
});
