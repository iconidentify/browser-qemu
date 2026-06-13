/**
 * Basilisk II Core Adapter
 *
 * Implements the CoreAdapter interface for the Basilisk II emulator,
 * providing 68k Macintosh emulation (System 7, Mac OS 8/9).
 */

import type { CoreAdapter, EmulatorCapabilities, EmulatorConfig, CursorData } from '../types';
import { mapAdbKeyCode } from '../../input/keymaps/adb';
import { parseMacCursor } from './cursor-parser';
import { generatePrefsFromConfig } from './prefs-generator';
import { bitmapToCssCursor, DEFAULT_MAC_CURSOR } from '../../cursors';

/**
 * Basilisk II emulator adapter for 68k Macintosh emulation.
 */
export class BasiliskAdapter implements CoreAdapter {
  readonly id = 'basilisk';
  readonly displayName = 'Macintosh 68k';

  readonly capabilities: EmulatorCapabilities = {
    // Display - Basilisk II supports up to 1600x1200
    maxScreenWidth: 1600,
    maxScreenHeight: 1200,
    supportsHardwareCursor: true,

    // Input - Mac uses absolute mouse positioning
    supportsMouseDeltas: false,

    // Networking
    supportsEthernet: true,
    supportsAppleTalk: true,
    supportsIPX: false,

    // Features
    supportsClipboard: true,
    supportsSound: true,

    // Disk formats
    supportedDiskExtensions: ['.dsk', '.img', '.hda', '.iso'],
  };

  /**
   * Create a new Web Worker for the Basilisk II core.
   */
  createWorker(): Worker {
    return new Worker(
      new URL('./basilisk-worker.ts', import.meta.url),
      { type: 'module' }
    );
  }

  /**
   * Get the path to the Basilisk II WASM module.
   */
  getWasmPath(): string {
    return 'emulator/BasiliskII.wasm';
  }

  /**
   * Generate Basilisk II prefs file content from EmulatorConfig.
   */
  generateConfig(config: EmulatorConfig): string {
    const romPath = this.getRomPath(config);
    const romFileName = romPath.split('/').pop() || 'quadra650.rom';
    return generatePrefsFromConfig(config, romFileName);
  }

  /**
   * Get the ROM path for Basilisk II.
   */
  getRomPath(config: EmulatorConfig): string {
    return (config.coreConfig?.romPath as string) || 'rom/quadra650.rom';
  }

  /**
   * Map browser KeyboardEvent.code to Mac ADB keycode.
   */
  mapKeyCode(browserCode: string): number {
    return mapAdbKeyCode(browserCode);
  }

  /**
   * Parse raw cursor data from WASM into normalized CursorData.
   * Mac cursors are 16x16, 1-bit depth with 32 bytes data + 32 bytes mask.
   */
  parseCursor(rawData: Uint8Array, hotspotX: number, hotspotY: number): CursorData {
    return parseMacCursor(rawData, hotspotX, hotspotY);
  }

  /**
   * Convert CursorData to CSS cursor string.
   */
  cursorToCss(cursor: CursorData, scale: number): string {
    if (cursor.format === 'hidden') {
      return 'none';
    }

    if (cursor.format !== 'mac-1bit' || !cursor.mask) {
      return DEFAULT_MAC_CURSOR;
    }

    return bitmapToCssCursor(
      cursor.data,
      cursor.mask,
      cursor.hotspotX,
      cursor.hotspotY,
      scale
    );
  }
}

/**
 * Default Basilisk adapter instance factory.
 */
export function createBasiliskAdapter(): BasiliskAdapter {
  return new BasiliskAdapter();
}
