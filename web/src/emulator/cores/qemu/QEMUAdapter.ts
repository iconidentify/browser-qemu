/**
 * QEMU m68k Core Adapter (A/UX 3.1.1 on a Quadra 800).
 *
 * QEMU is page-hosted (see qemu-page-backend.ts for why it can't run in a
 * worker). `createWorker()` returns a QemuPageBackend that duck-types the Worker
 * interface, so EmulatorShell/EmulatorCanvas drive it through the same contract
 * as the worker-hosted Basilisk core. This is the shared layer the project is
 * built around: one shell + theme system + SAB display contract, two cores.
 */

import type { CoreAdapter, EmulatorCapabilities, EmulatorConfig, CursorData } from '../types';
import { mapAdbKeyCode } from '../../input/keymaps/adb';
import { DEFAULT_MAC_CURSOR } from '../../cursors';
import { QemuPageBackend } from './qemu-page-backend';

/** A/UX boots at the Quadra 800 framebuffer's native 1152x870x8. */
export const QEMU_NATIVE_WIDTH = 1152;
export const QEMU_NATIVE_HEIGHT = 870;

export class QEMUAdapter implements CoreAdapter {
  readonly id = 'qemu';
  readonly displayName = 'A/UX (QEMU m68k)';

  readonly capabilities: EmulatorCapabilities = {
    // The macfb mode table tops out at 1152x870; the common screenBuffer SAB
    // (1600x1200) comfortably holds it.
    maxScreenWidth: QEMU_NATIVE_WIDTH,
    maxScreenHeight: QEMU_NATIVE_HEIGHT,
    supportsHardwareCursor: true, // SDL sets a real CSS cursor on the canvas

    supportsMouseDeltas: false, // A/UX uses absolute mouse positioning

    // Ethernet exists via the dialtone relay bridge but is not wired into this
    // page-host backend yet; advertise honestly until it is.
    supportsEthernet: false,
    supportsAppleTalk: false,
    supportsIPX: false,

    supportsClipboard: false,
    supportsSound: false,

    supportedDiskExtensions: ['.img'],
  };

  createWorker(): Worker {
    // QemuPageBackend implements the subset of the Worker interface that
    // EmulatorCanvas uses (postMessage / onmessage / addEventListener /
    // terminate / onerror) plus attachCanvas for the page-host render path.
    return new QemuPageBackend() as unknown as Worker;
  }

  getWasmPath(): string {
    return 'qemu-lazy/qemu-system-m68k.wasm';
  }

  /** QEMU's command line is supplied by the runtime's module.js, not generated. */
  generateConfig(_config: EmulatorConfig): string {
    return '';
  }

  /** Quadra 800 uses an ADB keyboard, the same keycodes the Mac cores use. */
  mapKeyCode(browserCode: string): number {
    return mapAdbKeyCode(browserCode);
  }

  /** QEMU drives its own CSS cursor through SDL on the shared canvas, so the
   *  shell's cursor pipeline is unused here; return safe defaults. */
  parseCursor(_rawData: Uint8Array, hotspotX: number, hotspotY: number): CursorData {
    return { format: 'hidden', width: 0, height: 0, hotspotX, hotspotY, data: new Uint8Array(0) };
  }

  cursorToCss(_cursor: CursorData, _scale: number): string {
    return DEFAULT_MAC_CURSOR;
  }
}

export function createQEMUAdapter(): QEMUAdapter {
  return new QEMUAdapter();
}
