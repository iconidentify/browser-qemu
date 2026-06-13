/**
 * Tests for cursors.ts
 *
 * Tests the hardware cursor bitmap-to-CSS conversion for the responsive cursor feature.
 * Mac cursors are 16x16 pixels with 1-bit depth (32 bytes data + 32 bytes mask).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  bitmapToCssCursor,
  clearCursorCache,
  DEFAULT_MAC_CURSOR,
  MAC_ARROW_CURSOR,
  MAC_IBEAM_CURSOR,
  MAC_WATCH_CURSOR,
  MAC_CROSSHAIR_CURSOR,
} from './cursors';

// Mock ImageData for OffscreenCanvas
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

// Mock OffscreenCanvas 2D context
class MockCanvasRenderingContext2D {
  canvas: MockOffscreenCanvas | MockHTMLCanvasElement;
  imageData: MockImageData | null = null;

  constructor(canvas: MockOffscreenCanvas | MockHTMLCanvasElement) {
    this.canvas = canvas;
  }

  createImageData(width: number, height: number): MockImageData {
    this.imageData = new MockImageData(width, height);
    return this.imageData;
  }

  putImageData(imageData: MockImageData, _x: number, _y: number): void {
    this.imageData = imageData;
  }

  drawImage(_source: unknown, _x: number, _y: number): void {
    // Mock implementation - does nothing but prevents error
  }
}

// Mock OffscreenCanvas
class MockOffscreenCanvas {
  width: number;
  height: number;
  private ctx: MockCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ctx = new MockCanvasRenderingContext2D(this);
  }

  getContext(type: string): MockCanvasRenderingContext2D | null {
    if (type === '2d') {
      return this.ctx;
    }
    return null;
  }

  // For inspection in tests
  getImageData(): MockImageData | null {
    return this.ctx.imageData;
  }
}

// Mock regular canvas for canvasToDataUrl
class MockHTMLCanvasElement {
  width = 16;
  height = 16;
  private ctx = new MockCanvasRenderingContext2D(this as unknown as MockOffscreenCanvas);

  getContext(type: string): MockCanvasRenderingContext2D | null {
    if (type === '2d') {
      return this.ctx;
    }
    return null;
  }

  toDataURL(_type?: string): string {
    return 'data:image/png;base64,mockdata';
  }
}

describe('cursors', () => {
  let originalOffscreenCanvas: typeof OffscreenCanvas | undefined;
  let originalCreateElement: typeof document.createElement;
  let lastCreatedOffscreenCanvas: MockOffscreenCanvas | null = null;

  beforeEach(() => {
    // Clear cursor cache before each test
    clearCursorCache();

    // Store originals
    originalOffscreenCanvas = globalThis.OffscreenCanvas;
    originalCreateElement = document.createElement;

    // Mock OffscreenCanvas
    lastCreatedOffscreenCanvas = null;
    vi.stubGlobal('OffscreenCanvas', class extends MockOffscreenCanvas {
      constructor(width: number, height: number) {
        super(width, height);
        lastCreatedOffscreenCanvas = this;
      }
    });

    // Mock document.createElement for canvas
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return new MockHTMLCanvasElement() as unknown as HTMLElement;
      }
      return originalCreateElement.call(document, tagName);
    }) as typeof document.createElement;
  });

  afterEach(() => {
    // Restore originals
    if (originalOffscreenCanvas) {
      vi.stubGlobal('OffscreenCanvas', originalOffscreenCanvas);
    }
    document.createElement = originalCreateElement;
    lastCreatedOffscreenCanvas = null;
  });

  describe('static cursor constants', () => {
    it('should export MAC_ARROW_CURSOR', () => {
      expect(MAC_ARROW_CURSOR).toBeDefined();
      expect(MAC_ARROW_CURSOR).toContain('url(');
      expect(MAC_ARROW_CURSOR).toContain('1 1'); // hotspot
      expect(MAC_ARROW_CURSOR).toContain('default');
    });

    it('should export MAC_IBEAM_CURSOR', () => {
      expect(MAC_IBEAM_CURSOR).toBeDefined();
      expect(MAC_IBEAM_CURSOR).toContain('url(');
      expect(MAC_IBEAM_CURSOR).toContain('8 8'); // hotspot at center
      expect(MAC_IBEAM_CURSOR).toContain('text');
    });

    it('should export MAC_WATCH_CURSOR', () => {
      expect(MAC_WATCH_CURSOR).toBeDefined();
      expect(MAC_WATCH_CURSOR).toContain('url(');
      expect(MAC_WATCH_CURSOR).toContain('8 8'); // hotspot at center
      expect(MAC_WATCH_CURSOR).toContain('wait');
    });

    it('should export MAC_CROSSHAIR_CURSOR', () => {
      expect(MAC_CROSSHAIR_CURSOR).toBeDefined();
      expect(MAC_CROSSHAIR_CURSOR).toContain('url(');
      expect(MAC_CROSSHAIR_CURSOR).toContain('8 8'); // hotspot at center
      expect(MAC_CROSSHAIR_CURSOR).toContain('crosshair');
    });

    it('should set DEFAULT_MAC_CURSOR to arrow', () => {
      expect(DEFAULT_MAC_CURSOR).toBe(MAC_ARROW_CURSOR);
    });
  });

  describe('bitmapToCssCursor', () => {
    describe('basic functionality', () => {
      it('should return a CSS cursor string', () => {
        const data = new Uint8Array(32).fill(0);
        const mask = new Uint8Array(32).fill(0xff);

        const result = bitmapToCssCursor(data, mask, 0, 0);

        expect(result).toContain('url(');
        expect(result).toContain('auto');
      });

      it('should include hotspot coordinates in result', () => {
        const data = new Uint8Array(32).fill(0);
        const mask = new Uint8Array(32).fill(0xff);

        const result = bitmapToCssCursor(data, mask, 5, 7);

        expect(result).toContain('5 7');
      });

      it('should create OffscreenCanvas with correct size', () => {
        const data = new Uint8Array(32).fill(0);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 1);

        expect(lastCreatedOffscreenCanvas).not.toBeNull();
        expect(lastCreatedOffscreenCanvas!.width).toBe(16);
        expect(lastCreatedOffscreenCanvas!.height).toBe(16);
      });
    });

    describe('standard cursor (with mask)', () => {
      it('should render black pixels where data=1 and mask=1', () => {
        // First row: all black (data=1, mask=1)
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);
        data[0] = 0xff; // First 8 pixels of row 0 = black
        data[1] = 0xff; // Last 8 pixels of row 0 = black
        mask[0] = 0xff; // First 8 pixels visible
        mask[1] = 0xff; // Last 8 pixels visible

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();
        expect(imageData).not.toBeNull();

        // Check first pixel (0,0) - should be black (r=0, g=0, b=0, a=255)
        expect(imageData!.data[0]).toBe(0); // R
        expect(imageData!.data[1]).toBe(0); // G
        expect(imageData!.data[2]).toBe(0); // B
        expect(imageData!.data[3]).toBe(255); // A
      });

      it('should render white pixels where data=0 and mask=1', () => {
        // First row: all white (data=0, mask=1)
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);
        data[0] = 0x00; // First 8 pixels = white
        data[1] = 0x00;
        mask[0] = 0xff; // Visible
        mask[1] = 0xff;

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Check first pixel (0,0) - should be white (r=255, g=255, b=255, a=255)
        expect(imageData!.data[0]).toBe(255); // R
        expect(imageData!.data[1]).toBe(255); // G
        expect(imageData!.data[2]).toBe(255); // B
        expect(imageData!.data[3]).toBe(255); // A
      });

      it('should render transparent pixels where mask=0', () => {
        // Mixed mask: some visible, some transparent
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Set row 1 to be visible (so it's not treated as XOR cursor)
        mask[2] = 0xff;
        mask[3] = 0xff;

        // Row 0: data is set but mask is 0 (transparent)
        data[0] = 0xff; // Would be black, but...
        mask[0] = 0x00; // ...mask is 0, so transparent

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Check first pixel (row 0) - should be transparent (a=0)
        expect(imageData!.data[3]).toBe(0); // A

        // Check pixel at row 1 - should be visible
        const row1Idx = 16 * 4; // Row 1 starts at pixel 16
        expect(imageData!.data[row1Idx + 3]).toBe(255); // A
      });
    });

    describe('XOR cursor (no mask)', () => {
      it('should detect XOR cursor when mask is all zeros', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0); // All zeros = XOR cursor

        // Set some data bits
        data[0] = 0xff;

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // XOR cursor: data=1 means black, data=0 means transparent
        // First pixel should be black (data[0] bit 7 = 1)
        expect(imageData!.data[0]).toBe(0); // R
        expect(imageData!.data[1]).toBe(0); // G
        expect(imageData!.data[2]).toBe(0); // B
        expect(imageData!.data[3]).toBe(255); // A
      });

      it('should render I-beam style cursor (data only)', () => {
        // Simulate I-beam: vertical line in middle
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0); // XOR mode

        // Set column 8 (middle) to be visible
        for (let row = 0; row < 16; row++) {
          // Byte 0 covers columns 0-7, byte 1 covers 8-15
          // Column 8 is bit 7 of byte 1 (each row is 2 bytes)
          data[row * 2 + 1] = 0x80; // bit 7 = column 8
        }

        bitmapToCssCursor(data, mask, 8, 8, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Check pixel at (8, 0) - should be black
        const pixelIdx = (0 * 16 + 8) * 4;
        expect(imageData!.data[pixelIdx + 3]).toBe(255); // Should be visible

        // Check pixel at (0, 0) - should be transparent
        expect(imageData!.data[3]).toBe(0); // Should be transparent
      });
    });

    describe('scale parameter', () => {
      it('should scale canvas size at 2x', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 2);

        expect(lastCreatedOffscreenCanvas!.width).toBe(32);
        expect(lastCreatedOffscreenCanvas!.height).toBe(32);
      });

      it('should scale hotspot at 2x', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        const result = bitmapToCssCursor(data, mask, 5, 7, 2);

        expect(result).toContain('10 14'); // 5*2, 7*2
      });

      it('should clamp scale to maximum of 4', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 10);

        expect(lastCreatedOffscreenCanvas!.width).toBe(64); // 16 * 4
        expect(lastCreatedOffscreenCanvas!.height).toBe(64);
      });

      it('should clamp scale to minimum of 1', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 0.5);

        expect(lastCreatedOffscreenCanvas!.width).toBe(16); // 16 * 1
        expect(lastCreatedOffscreenCanvas!.height).toBe(16);
      });

      it('should round scale to nearest integer', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 2.7);

        expect(lastCreatedOffscreenCanvas!.width).toBe(48); // 16 * 3
      });

      it('should render 2x2 blocks at scale 2', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Set just the first pixel to black
        data[0] = 0x80; // First bit of first byte
        mask[0] = 0x80;

        bitmapToCssCursor(data, mask, 0, 0, 2);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();
        const canvasWidth = 32; // 16 * 2

        // Check all 4 pixels of the 2x2 block at (0,0)
        // (0,0)
        expect(imageData!.data[0]).toBe(0); // R - black
        expect(imageData!.data[3]).toBe(255); // A - visible

        // (1,0)
        const idx10 = 1 * 4;
        expect(imageData!.data[idx10]).toBe(0);
        expect(imageData!.data[idx10 + 3]).toBe(255);

        // (0,1)
        const idx01 = canvasWidth * 4;
        expect(imageData!.data[idx01]).toBe(0);
        expect(imageData!.data[idx01 + 3]).toBe(255);

        // (1,1)
        const idx11 = (canvasWidth + 1) * 4;
        expect(imageData!.data[idx11]).toBe(0);
        expect(imageData!.data[idx11 + 3]).toBe(255);

        // (2,0) should be transparent (next pixel over)
        const idx20 = 2 * 4;
        expect(imageData!.data[idx20 + 3]).toBe(0);
      });
    });

    describe('bit indexing', () => {
      it('should correctly index bits in each byte (MSB first)', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Set bit 7 (MSB) of first byte = column 0
        data[0] = 0x80;
        mask[0] = 0x80;

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Column 0 should be black
        expect(imageData!.data[3]).toBe(255);

        // Column 1 should be transparent
        expect(imageData!.data[7]).toBe(0);
      });

      it('should map byte index correctly (2 bytes per row)', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Set bit in second byte of first row (columns 8-15)
        data[1] = 0x80; // bit 7 = column 8
        mask[1] = 0x80;

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Column 8 should be black
        const pixelIdx = 8 * 4;
        expect(imageData!.data[pixelIdx + 3]).toBe(255);

        // Column 0 should be transparent
        expect(imageData!.data[3]).toBe(0);
      });

      it('should handle row indexing correctly', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Set first pixel of row 1 (bytes 2-3)
        data[2] = 0x80;
        mask[2] = 0x80;

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Row 0, col 0 should be transparent
        expect(imageData!.data[3]).toBe(0);

        // Row 1, col 0 should be black
        const row1Idx = 16 * 4; // Row 1 starts at pixel 16
        expect(imageData!.data[row1Idx + 3]).toBe(255);
      });
    });

    describe('real cursor patterns', () => {
      it('should handle arrow cursor pattern', () => {
        // Simplified arrow pattern (first 3 rows)
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Row 0: single pixel at top-left
        data[0] = 0x80; mask[0] = 0x80;
        // Row 1: two pixels
        data[2] = 0xc0; mask[2] = 0xc0;
        // Row 2: three pixels
        data[4] = 0xe0; mask[4] = 0xe0;

        bitmapToCssCursor(data, mask, 1, 1, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Verify arrow shape
        expect(imageData!.data[3]).toBe(255); // (0,0) visible
        expect(imageData!.data[4 * 4 + 3]).toBe(0); // (4,0) transparent
      });

      it('should handle watch cursor with mixed colors', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        // Create a checkerboard pattern in first row
        data[0] = 0xaa; // 10101010
        data[1] = 0xaa;
        mask[0] = 0xff; // all visible
        mask[1] = 0xff;

        bitmapToCssCursor(data, mask, 8, 8, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // Pixel 0: data=1, should be black
        expect(imageData!.data[0]).toBe(0);
        expect(imageData!.data[3]).toBe(255);

        // Pixel 1: data=0, should be white
        expect(imageData!.data[4]).toBe(255);
        expect(imageData!.data[7]).toBe(255);
      });
    });

    describe('edge cases', () => {
      it('should handle empty cursor (all zeros)', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32);

        const result = bitmapToCssCursor(data, mask, 0, 0);

        // Should return a valid cursor string (even if empty)
        expect(result).toContain('url(');
      });

      it('should handle full black cursor', () => {
        const data = new Uint8Array(32).fill(0xff);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // All pixels should be black and visible
        for (let i = 0; i < 16 * 16; i++) {
          expect(imageData!.data[i * 4 + 0]).toBe(0); // R
          expect(imageData!.data[i * 4 + 3]).toBe(255); // A
        }
      });

      it('should handle full white cursor', () => {
        const data = new Uint8Array(32).fill(0x00);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 1);

        const imageData = lastCreatedOffscreenCanvas!.getImageData();

        // All pixels should be white and visible
        for (let i = 0; i < 16 * 16; i++) {
          expect(imageData!.data[i * 4 + 0]).toBe(255); // R
          expect(imageData!.data[i * 4 + 3]).toBe(255); // A
        }
      });

      it('should use default scale of 1', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 3, 5);

        expect(lastCreatedOffscreenCanvas!.width).toBe(16);
        expect(lastCreatedOffscreenCanvas!.height).toBe(16);
      });

      it('should handle zero hotspot', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        const result = bitmapToCssCursor(data, mask, 0, 0);

        expect(result).toContain('0 0');
      });

      it('should handle max hotspot (15, 15)', () => {
        const data = new Uint8Array(32);
        const mask = new Uint8Array(32).fill(0xff);

        const result = bitmapToCssCursor(data, mask, 15, 15, 1);

        expect(result).toContain('15 15');
      });
    });

    describe('caching behavior', () => {
      it('should return cached result for identical cursor data', () => {
        const data = new Uint8Array(32).fill(0xaa);
        const mask = new Uint8Array(32).fill(0xff);

        const result1 = bitmapToCssCursor(data, mask, 5, 5, 1);
        const result2 = bitmapToCssCursor(data, mask, 5, 5, 1);

        expect(result1).toBe(result2);
      });

      it('should create new canvas for different cursor data (cache miss)', () => {
        const data1 = new Uint8Array(32).fill(0xaa);
        const data2 = new Uint8Array(32).fill(0x55);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data1, mask, 5, 5, 1);
        const canvas1 = lastCreatedOffscreenCanvas;

        bitmapToCssCursor(data2, mask, 5, 5, 1);
        const canvas2 = lastCreatedOffscreenCanvas;

        // Different cursor data should create a new canvas (cache miss)
        expect(canvas2).not.toBe(canvas1);
      });

      it('should create new canvas for different hotspot (cache miss)', () => {
        const data = new Uint8Array(32).fill(0xaa);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 0, 0, 1);
        const canvas1 = lastCreatedOffscreenCanvas;

        bitmapToCssCursor(data, mask, 8, 8, 1);
        const canvas2 = lastCreatedOffscreenCanvas;

        // Different hotspot should create new canvas (cache miss)
        expect(canvas2).not.toBe(canvas1);
      });

      it('should create new canvas for different scale (cache miss)', () => {
        const data = new Uint8Array(32).fill(0xaa);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 5, 5, 1);
        const canvas1 = lastCreatedOffscreenCanvas;

        bitmapToCssCursor(data, mask, 5, 5, 2);
        const canvas2 = lastCreatedOffscreenCanvas;

        // Different scale should create new canvas (cache miss)
        expect(canvas2).not.toBe(canvas1);
      });

      it('should detect cursor changes via key bytes (arrow vs stopwatch)', () => {
        // Simulate arrow cursor (sparse pixels in corner)
        const arrowData = new Uint8Array(32);
        const arrowMask = new Uint8Array(32);
        arrowData[0] = 0x80; arrowData[15] = 0x00; arrowData[31] = 0x00;
        arrowMask[0] = 0x80; arrowMask[15] = 0x00; arrowMask[31] = 0x00;

        // Simulate stopwatch cursor (dense pixels in center)
        const watchData = new Uint8Array(32);
        const watchMask = new Uint8Array(32);
        watchData[0] = 0x00; watchData[15] = 0xff; watchData[31] = 0xff;
        watchMask[0] = 0x00; watchMask[15] = 0xff; watchMask[31] = 0xff;

        bitmapToCssCursor(arrowData, arrowMask, 1, 1, 1);
        const arrowCanvas = lastCreatedOffscreenCanvas;

        bitmapToCssCursor(watchData, watchMask, 8, 8, 1);
        const watchCanvas = lastCreatedOffscreenCanvas;

        // Arrow and stopwatch cursors should have different cache keys
        // This is critical for the stuck cursor fix
        expect(watchCanvas).not.toBe(arrowCanvas);
      });

      it('should clear cache when clearCursorCache is called', () => {
        const data = new Uint8Array(32).fill(0xaa);
        const mask = new Uint8Array(32).fill(0xff);

        bitmapToCssCursor(data, mask, 5, 5, 1);
        clearCursorCache();

        // After cache clear, a new canvas should be created
        lastCreatedOffscreenCanvas = null;
        bitmapToCssCursor(data, mask, 5, 5, 1);

        // A new OffscreenCanvas was created (cache miss)
        expect(lastCreatedOffscreenCanvas).not.toBeNull();
      });
    });
  });
});
