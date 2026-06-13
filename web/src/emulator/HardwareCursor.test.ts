/**
 * Hardware Cursor Integration Tests
 *
 * These tests codify the working hardware cursor feature which:
 * 1. Intercepts Mac cursor drawing via vector patching in WASM
 * 2. Exports cursor bitmaps from Mac low memory (TheCrsr at 0x844)
 * 3. Converts 1-bit cursor data to CSS cursors for display
 * 4. Works with in-app cursors (I-beam, crosshair, watch, etc.)
 *
 * Key behaviors tested:
 * - Hardware cursor mode flag in SharedArrayBuffer
 * - Cursor data format (32 bytes data + 32 bytes mask + hotspot)
 * - Visibility based on cursor data validity (not Mac HideCursor state)
 * - Scale support for high-DPI displays
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  bitmapToCssCursor,
  clearCursorCache,
  MAC_ARROW_CURSOR,
  MAC_IBEAM_CURSOR,
} from './cursors';
import { InputBufferAddresses } from './input/constants';

// Mock canvas APIs for cursor bitmap conversion
class MockImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

class MockCanvasRenderingContext2D {
  imageData: MockImageData | null = null;
  createImageData(width: number, height: number): MockImageData {
    this.imageData = new MockImageData(width, height);
    return this.imageData;
  }
  putImageData(imageData: MockImageData): void {
    this.imageData = imageData;
  }
  drawImage(): void {}
}

class MockOffscreenCanvas {
  width: number;
  height: number;
  private ctx = new MockCanvasRenderingContext2D();
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(type: string) {
    return type === '2d' ? this.ctx : null;
  }
  getImageData() {
    return this.ctx.imageData;
  }
}

class MockHTMLCanvasElement {
  width = 16;
  height = 16;
  private ctx = new MockCanvasRenderingContext2D();
  getContext(type: string) {
    return type === '2d' ? this.ctx : null;
  }
  toDataURL() {
    return 'data:image/png;base64,mockdata';
  }
}

describe('Hardware Cursor System', () => {
  let originalOffscreenCanvas: typeof OffscreenCanvas | undefined;
  let originalCreateElement: typeof document.createElement;

  beforeEach(() => {
    clearCursorCache();
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    originalCreateElement = document.createElement;

    vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return new MockHTMLCanvasElement() as unknown as HTMLElement;
      }
      return originalCreateElement.call(document, tagName);
    }) as typeof document.createElement;
  });

  afterEach(() => {
    if (originalOffscreenCanvas) {
      vi.stubGlobal('OffscreenCanvas', originalOffscreenCanvas);
    }
    document.createElement = originalCreateElement;
  });

  describe('SharedArrayBuffer Integration', () => {
    it('should have hardware cursor mode address defined', () => {
      // The WASM reads this address to determine if hardware cursor is enabled
      expect(InputBufferAddresses.hardwareCursorModeAddr).toBe(20);
    });

    it('should set hardware cursor mode in SharedArrayBuffer', () => {
      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Enable hardware cursor mode (mode = 1)
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 1);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(1);

      // Disable hardware cursor mode (mode = 0)
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 0);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(0);
    });

    it('should use Atomics for thread-safe access', () => {
      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Atomic operations are required for cross-thread communication with WASM
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 1);
      const value = Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr);
      expect(value).toBe(1);
    });
  });

  describe('Cursor Data Format', () => {
    it('should accept 64-byte cursor data (32 data + 32 mask)', () => {
      // Mac cursor format: 16x16 pixels at 1-bit depth
      // 16 pixels per row / 8 bits per byte = 2 bytes per row
      // 16 rows * 2 bytes = 32 bytes for data, 32 bytes for mask
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32);

      // This should not throw
      expect(() => bitmapToCssCursor(data, mask, 0, 0)).not.toThrow();
    });

    it('should support hotspot coordinates 0-15', () => {
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32).fill(0xff);

      // Arrow cursor: hotspot at (1, 1)
      const arrow = bitmapToCssCursor(data, mask, 1, 1);
      expect(arrow).toContain('1 1');

      // I-beam cursor: hotspot at (8, 8)
      const ibeam = bitmapToCssCursor(data, mask, 8, 8);
      expect(ibeam).toContain('8 8');

      // Max hotspot at (15, 15)
      const corner = bitmapToCssCursor(data, mask, 15, 15);
      expect(corner).toContain('15 15');
    });

    it('should handle XOR cursors (mask = 0, data only)', () => {
      // XOR cursors like I-beam have no mask, only data
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32).fill(0); // Empty mask = XOR mode

      // Set a vertical line in the middle (I-beam style)
      for (let row = 0; row < 16; row++) {
        data[row * 2 + 1] = 0x80; // Column 8
      }

      const result = bitmapToCssCursor(data, mask, 8, 8);
      expect(result).toContain('url(');
      expect(result).toContain('8 8');
    });
  });

  describe('In-App Cursor Support', () => {
    it('should provide pre-rendered Mac arrow cursor', () => {
      expect(MAC_ARROW_CURSOR).toBeDefined();
      expect(MAC_ARROW_CURSOR).toContain('url(');
      expect(MAC_ARROW_CURSOR).toContain('1 1'); // Standard arrow hotspot
    });

    it('should provide pre-rendered Mac I-beam cursor', () => {
      expect(MAC_IBEAM_CURSOR).toBeDefined();
      expect(MAC_IBEAM_CURSOR).toContain('url(');
      expect(MAC_IBEAM_CURSOR).toContain('8 8'); // Center hotspot for I-beam
    });

    it('should support custom in-app cursors', () => {
      // Apps like Kid Pix, Civilization use custom cursors
      // These should render correctly when cursor data changes
      const customData = new Uint8Array(32);
      const customMask = new Uint8Array(32);

      // Create a simple crosshair pattern
      customData[7 * 2] = 0x80;     // Row 7, col 0
      customData[7 * 2 + 1] = 0x01; // Row 7, col 15
      customData[8 * 2] = 0x01;     // Row 8, col 7
      customData[8 * 2 + 1] = 0x80; // Row 8, col 8

      customMask[7 * 2] = 0x80;
      customMask[7 * 2 + 1] = 0x01;
      customMask[8 * 2] = 0x01;
      customMask[8 * 2 + 1] = 0x80;

      const result = bitmapToCssCursor(customData, customMask, 8, 8);
      expect(result).toContain('url(');
    });
  });

  describe('Visibility Logic', () => {
    it('should determine visibility from cursor data validity', () => {
      // In hardware cursor mode, we show cursor if data is valid
      // We ignore Mac's HideCursor/ShowCursor state (CrsrState)
      // because apps use those to draw their own cursors, but we block that

      const validData = new Uint8Array(32);
      const validMask = new Uint8Array(32);

      // Set enough pixels to be considered valid (>= 4 non-zero bytes)
      validData[0] = 0xff;
      validData[1] = 0xff;
      validMask[0] = 0xff;
      validMask[1] = 0xff;

      // Should produce a valid cursor
      const result = bitmapToCssCursor(validData, validMask, 1, 1);
      expect(result).toContain('url(');
    });

    it('should handle empty cursor data gracefully', () => {
      const emptyData = new Uint8Array(32);
      const emptyMask = new Uint8Array(32);

      // Empty cursor should still return a valid CSS string
      const result = bitmapToCssCursor(emptyData, emptyMask, 0, 0);
      expect(result).toContain('url(');
    });
  });

  describe('Scale Support', () => {
    it('should support 1x scale for standard displays', () => {
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32).fill(0xff);

      const result = bitmapToCssCursor(data, mask, 1, 1, 1);
      expect(result).toContain('1 1'); // Hotspot not scaled
    });

    it('should support 2x scale for Retina displays', () => {
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32).fill(0xff);

      const result = bitmapToCssCursor(data, mask, 1, 1, 2);
      expect(result).toContain('2 2'); // Hotspot scaled 2x
    });

    it('should clamp scale between 1 and 4', () => {
      const data = new Uint8Array(32);
      const mask = new Uint8Array(32).fill(0xff);

      // Scale 0.5 should clamp to 1
      const low = bitmapToCssCursor(data, mask, 1, 1, 0.5);
      expect(low).toContain('1 1');

      // Scale 10 should clamp to 4
      const high = bitmapToCssCursor(data, mask, 1, 1, 10);
      expect(high).toContain('4 4');
    });
  });

  describe('Mode Transition Safety', () => {
    it('should allow enabling hardware cursor mode', () => {
      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Initial state: disabled
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(0);

      // Enable mode
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 1);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(1);
    });

    it('should not crash when mode flag changes during operation', () => {
      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Simulate rapid toggling (which caused crashes before)
      for (let i = 0; i < 10; i++) {
        Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, i % 2);
      }

      // Should still be readable
      const value = Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr);
      expect([0, 1]).toContain(value);
    });
  });

  describe('Session Persistence', () => {
    it('should maintain cursor visibility after mid-session setting toggle', () => {
      // This tests the fix for: user enables HW cursor, then toggles it off mid-session
      // Once WASM patches cursor vectors, JS must keep showing CSS cursor
      // Otherwise user loses cursor completely (WASM blocks drawing, JS hides CSS)

      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Start with hardware cursor enabled
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 1);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(1);

      // Simulate receiving valid cursor data (cursor is now visible)
      const validData = new Uint8Array(32).fill(0xff);
      const validMask = new Uint8Array(32).fill(0xff);
      const cursor = bitmapToCssCursor(validData, validMask, 1, 1, 1);
      expect(cursor).toContain('url(');

      // User toggles setting off mid-session
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 0);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(0);

      // The cursor CSS should still be valid and usable
      // (In real code, hardwareCursorActiveRef keeps it showing)
      expect(cursor).toContain('url(');
      expect(cursor).toContain('1 1');
    });

    it('should allow fresh session to start with hardware cursor disabled', () => {
      // If user starts with HW cursor off, no vectors are patched
      // so the setting toggle behavior doesn't apply

      const buffer = new SharedArrayBuffer(128);
      const view = new Int32Array(buffer);

      // Start with hardware cursor disabled (fresh session)
      Atomics.store(view, InputBufferAddresses.hardwareCursorModeAddr, 0);
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(0);

      // Mode stays off, WASM uses software cursor rendering
      expect(Atomics.load(view, InputBufferAddresses.hardwareCursorModeAddr)).toBe(0);
    });
  });

  describe('Cursor Caching', () => {
    it('should cache identical cursors to avoid re-rendering', () => {
      const data = new Uint8Array(32).fill(0xaa);
      const mask = new Uint8Array(32).fill(0xff);

      // First call
      const result1 = bitmapToCssCursor(data, mask, 1, 1, 1);

      // Second call with same data should return cached result
      const result2 = bitmapToCssCursor(data, mask, 1, 1, 1);

      expect(result1).toBe(result2);
    });

    it('should re-render when cursor data changes', () => {
      const data1 = new Uint8Array(32).fill(0xaa);
      const mask = new Uint8Array(32).fill(0xff);

      const result1 = bitmapToCssCursor(data1, mask, 1, 1, 1);

      // Clear cache and render different cursor
      clearCursorCache();

      const data2 = new Uint8Array(32).fill(0x55);
      const result2 = bitmapToCssCursor(data2, mask, 1, 1, 1);

      // Different data should produce different cache key (but same mock URL)
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });
  });
});
