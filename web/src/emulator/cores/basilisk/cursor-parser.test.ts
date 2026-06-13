/**
 * Mac Cursor Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { parseMacCursor, isXorCursor } from './cursor-parser';

describe('cursor-parser', () => {
  describe('parseMacCursor', () => {
    it('should return hidden cursor for data less than 64 bytes', () => {
      const shortData = new Uint8Array(32);
      const result = parseMacCursor(shortData, 0, 0);

      expect(result.format).toBe('hidden');
      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });

    it('should return hidden cursor for empty data and mask', () => {
      const emptyData = new Uint8Array(64); // All zeros
      const result = parseMacCursor(emptyData, 5, 5);

      expect(result.format).toBe('hidden');
    });

    it('should parse valid cursor with data content', () => {
      const data = new Uint8Array(64);
      // Set some data bits (first 32 bytes are data)
      data[0] = 0xFF;
      data[1] = 0xFF;
      // Set corresponding mask bits (bytes 32-63 are mask)
      data[32] = 0xFF;
      data[33] = 0xFF;

      const result = parseMacCursor(data, 1, 1);

      expect(result.format).toBe('mac-1bit');
      expect(result.width).toBe(16);
      expect(result.height).toBe(16);
      expect(result.hotspotX).toBe(1);
      expect(result.hotspotY).toBe(1);
      expect(result.data.length).toBe(32);
      expect(result.mask?.length).toBe(32);
    });

    it('should parse cursor with only mask content', () => {
      const data = new Uint8Array(64);
      // Only mask has content
      data[32] = 0xFF;

      const result = parseMacCursor(data, 0, 0);

      expect(result.format).toBe('mac-1bit');
    });

    it('should parse cursor with only data content (XOR cursor)', () => {
      const data = new Uint8Array(64);
      // Only data has content, mask is zeros (XOR cursor like I-beam)
      data[0] = 0x80;
      data[2] = 0x80;

      const result = parseMacCursor(data, 8, 8);

      expect(result.format).toBe('mac-1bit');
      expect(result.hotspotX).toBe(8);
      expect(result.hotspotY).toBe(8);
    });

    it('should clamp hotspot values to valid range', () => {
      const data = new Uint8Array(64);
      data[0] = 0xFF;
      data[32] = 0xFF;

      // Test values outside range
      const result1 = parseMacCursor(data, -5, -10);
      expect(result1.hotspotX).toBe(0);
      expect(result1.hotspotY).toBe(0);

      const result2 = parseMacCursor(data, 20, 25);
      expect(result2.hotspotX).toBe(15);
      expect(result2.hotspotY).toBe(15);
    });

    it('should floor fractional hotspot values', () => {
      const data = new Uint8Array(64);
      data[0] = 0xFF;
      data[32] = 0xFF;

      const result = parseMacCursor(data, 3.7, 8.9);
      expect(result.hotspotX).toBe(3);
      expect(result.hotspotY).toBe(8);
    });

    it('should copy data and mask, not reference original', () => {
      const original = new Uint8Array(64);
      original[0] = 0xAA;
      original[32] = 0xBB;

      const result = parseMacCursor(original, 0, 0);

      // Modify original
      original[0] = 0x00;
      original[32] = 0x00;

      // Result should still have original values
      expect(result.data[0]).toBe(0xAA);
      expect(result.mask?.[0]).toBe(0xBB);
    });
  });

  describe('isXorCursor', () => {
    it('should return false for hidden cursor', () => {
      const cursor = parseMacCursor(new Uint8Array(32), 0, 0);
      expect(isXorCursor(cursor)).toBe(false);
    });

    it('should return false for cursor with mask content', () => {
      const data = new Uint8Array(64);
      data[0] = 0xFF;  // Data
      data[32] = 0xFF; // Mask has content

      const cursor = parseMacCursor(data, 0, 0);
      expect(isXorCursor(cursor)).toBe(false);
    });

    it('should return true for cursor with data but no mask (XOR cursor)', () => {
      const data = new Uint8Array(64);
      data[0] = 0xFF;  // Data has content
      // Mask bytes (32-63) are all zeros

      const cursor = parseMacCursor(data, 8, 8);
      expect(isXorCursor(cursor)).toBe(true);
    });

    it('should return false for cursor with empty data and empty mask', () => {
      // This would be a hidden cursor
      const cursor = parseMacCursor(new Uint8Array(64), 0, 0);
      expect(isXorCursor(cursor)).toBe(false);
    });

    it('should return false for non mac-1bit format', () => {
      const cursor = {
        format: 'win-color' as const,
        width: 32,
        height: 32,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8Array(32),
        mask: new Uint8Array(32),
      };
      expect(isXorCursor(cursor)).toBe(false);
    });

    it('should return false for cursor without mask property', () => {
      const cursor = {
        format: 'mac-1bit' as const,
        width: 16,
        height: 16,
        hotspotX: 0,
        hotspotY: 0,
        data: new Uint8Array(32),
        // No mask property
      };
      expect(isXorCursor(cursor)).toBe(false);
    });
  });
});
