/**
 * Mac Cursor Parser
 *
 * Parses Mac 1-bit cursor format from WASM memory into normalized CursorData.
 *
 * Mac cursor format:
 * - 16x16 pixels, 1-bit depth
 * - Data bitmap: 32 bytes (2 bytes per row, 16 rows)
 * - Mask bitmap: 32 bytes (2 bytes per row, 16 rows)
 * - Total: 64 bytes
 *
 * Interpretation:
 * - Standard cursor (mask has content):
 *   - Mask bit = 1: pixel is visible
 *   - Mask bit = 0: pixel is transparent
 *   - Data bit = 1: black pixel (if mask=1)
 *   - Data bit = 0: white pixel (if mask=1)
 *
 * - XOR cursor (mask is all zeros, like I-beam):
 *   - Data bit = 1: XOR with screen (rendered as black)
 *   - Data bit = 0: transparent
 */

import type { CursorData } from '../types';

/**
 * Parse Mac 1-bit cursor format from raw WASM memory.
 *
 * @param rawData - 64 bytes: 32 bytes data + 32 bytes mask
 * @param hotspotX - Cursor hotspot X coordinate (0-15)
 * @param hotspotY - Cursor hotspot Y coordinate (0-15)
 * @returns Normalized CursorData
 */
export function parseMacCursor(
  rawData: Uint8Array,
  hotspotX: number,
  hotspotY: number
): CursorData {
  // Validate input size
  if (rawData.length < 64) {
    return createHiddenCursor();
  }

  // Split into data and mask bitmaps
  const data = rawData.slice(0, 32);
  const mask = rawData.slice(32, 64);

  // Check if cursor should be hidden (both bitmaps are all zeros)
  if (isEmptyCursor(data, mask)) {
    return createHiddenCursor();
  }

  return {
    format: 'mac-1bit',
    width: 16,
    height: 16,
    hotspotX: clampHotspot(hotspotX),
    hotspotY: clampHotspot(hotspotY),
    data,
    mask,
  };
}

/**
 * Check if cursor bitmaps are empty (all zeros).
 */
function isEmptyCursor(data: Uint8Array, mask: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) {
    if (data[i] !== 0 || mask[i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Create a hidden cursor result.
 */
function createHiddenCursor(): CursorData {
  return {
    format: 'hidden',
    width: 0,
    height: 0,
    hotspotX: 0,
    hotspotY: 0,
    data: new Uint8Array(0),
  };
}

/**
 * Clamp hotspot value to valid range (0-15).
 */
function clampHotspot(value: number): number {
  return Math.max(0, Math.min(15, Math.floor(value)));
}

/**
 * Check if cursor is an XOR cursor (mask is all zeros but data has content).
 * XOR cursors are used for I-beam and similar cursors that should
 * contrast against any background.
 */
export function isXorCursor(cursor: CursorData): boolean {
  if (cursor.format !== 'mac-1bit' || !cursor.mask) {
    return false;
  }

  // Check if mask is all zeros
  for (let i = 0; i < cursor.mask.length; i++) {
    if (cursor.mask[i] !== 0) {
      return false;
    }
  }

  // Check if data has content
  for (let i = 0; i < cursor.data.length; i++) {
    if (cursor.data[i] !== 0) {
      return true;
    }
  }

  return false;
}
