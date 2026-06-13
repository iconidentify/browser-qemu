/**
 * Classic Mac OS Cursor Definitions
 *
 * CSS cursor values for the responsive cursor overlay feature.
 * These match the original System 7 cursor designs.
 */

// Classic Mac arrow cursor - 16x16, hotspot at (1, 1)
// Black outline with white fill
const ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path fill="black" d="M0,0 L0,15 L3,12 L5,16 L7,15 L5,11 L9,11 Z"/>
  <path fill="white" d="M1,2 L1,12 L3,10 L5,14 L6,14 L4,10 L8,10 Z"/>
</svg>`;

// Classic Mac I-beam cursor - 16x16, hotspot at (8, 8)
const IBEAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path fill="black" d="M4,0 L4,1 L6,1 L6,2 L7,2 L7,6 L6,6 L6,7 L7,7 L7,8 L6,8 L6,9 L7,9 L7,13 L6,13 L6,14 L4,14 L4,15 L11,15 L11,14 L9,14 L9,13 L8,13 L8,9 L9,9 L9,8 L8,8 L8,7 L9,7 L9,6 L8,6 L8,2 L9,2 L9,1 L11,1 L11,0 Z"/>
  <path fill="white" d="M5,1 L6,1 L6,2 L7,2 L7,7 L6,7 L6,8 L7,8 L7,13 L6,13 L6,14 L5,14 L5,13 L7,13 L7,8 L5,8 L5,7 L7,7 L7,2 L5,2 Z M10,1 L10,2 L8,2 L8,7 L10,7 L10,8 L8,8 L8,13 L10,13 L10,14 L9,14 L9,13 L8,13 L8,8 L9,8 L9,7 L8,7 L8,2 L9,2 L9,1 Z"/>
</svg>`;

// Classic Mac watch/busy cursor - 16x16, hotspot at (8, 8)
const WATCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <rect x="3" y="0" width="10" height="3" fill="black"/>
  <rect x="4" y="1" width="8" height="1" fill="#888"/>
  <rect x="3" y="13" width="10" height="3" fill="black"/>
  <rect x="4" y="14" width="8" height="1" fill="#888"/>
  <circle cx="8" cy="8" r="6" fill="black"/>
  <circle cx="8" cy="8" r="5" fill="white"/>
  <line x1="8" y1="8" x2="8" y2="4" stroke="black" stroke-width="1"/>
  <line x1="8" y1="8" x2="11" y2="8" stroke="black" stroke-width="1"/>
  <circle cx="8" cy="8" r="1" fill="black"/>
</svg>`;

// Classic Mac crosshair cursor - 16x16, hotspot at (8, 8)
const CROSSHAIR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <path fill="black" d="M7,0 L9,0 L9,6 L15,6 L15,9 L9,9 L9,15 L7,15 L7,9 L0,9 L0,6 L7,6 Z"/>
  <path fill="white" d="M8,1 L8,7 L1,7 L1,8 L8,8 L8,14 L8,8 L14,8 L14,7 L8,7 L8,1 Z"/>
</svg>`;

/**
 * Encode SVG to data URI for CSS cursor property
 */
function svgToDataUri(svg: string): string {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `data:image/svg+xml,${encoded}`;
}

/**
 * CSS cursor value for the Mac arrow cursor
 * Hotspot at (1, 1) - top-left corner of the arrow
 */
export const MAC_ARROW_CURSOR = `url("${svgToDataUri(ARROW_SVG)}") 1 1, default`;

/**
 * CSS cursor value for the Mac I-beam cursor
 * Hotspot at (8, 8) - center of the beam
 */
export const MAC_IBEAM_CURSOR = `url("${svgToDataUri(IBEAM_SVG)}") 8 8, text`;

/**
 * CSS cursor value for the Mac watch/busy cursor
 * Hotspot at (8, 8) - center of the watch
 */
export const MAC_WATCH_CURSOR = `url("${svgToDataUri(WATCH_SVG)}") 8 8, wait`;

/**
 * CSS cursor value for the Mac crosshair cursor
 * Hotspot at (8, 8) - center of the crosshair
 */
export const MAC_CROSSHAIR_CURSOR = `url("${svgToDataUri(CROSSHAIR_SVG)}") 8 8, crosshair`;

/**
 * Default cursor to use for responsive cursor mode
 */
export const DEFAULT_MAC_CURSOR = MAC_ARROW_CURSOR;

/**
 * Cursor cache to avoid expensive PNG encoding for repeated cursor bitmaps.
 * Key: hash of bitmap data + mask + hotspot + scale
 * Value: CSS cursor string
 */
const cursorCache = new Map<string, string>();
const MAX_CACHE_SIZE = 32; // Limit cache size to prevent memory bloat

/**
 * Clear the cursor cache (useful for testing)
 */
export function clearCursorCache(): void {
  cursorCache.clear();
}

/**
 * Generate a simple hash key for cursor caching.
 * Uses first/last bytes + hotspot + scale for fast comparison.
 */
function getCursorCacheKey(
  data: Uint8Array,
  mask: Uint8Array,
  hotspotX: number,
  hotspotY: number,
  scale: number
): string {
  // Use a combination of bytes spread across the data for a fast hash
  // This catches most cursor changes without computing a full hash
  return `${data[0]},${data[15]},${data[31]},${mask[0]},${mask[15]},${mask[31]},${hotspotX},${hotspotY},${scale}`;
}

/**
 * Convert Mac 1-bit cursor bitmap to CSS cursor data URL
 *
 * Mac cursors are 16x16 pixels with 1-bit depth.
 * Data bitmap: 32 bytes (2 bytes per row, 16 rows)
 * Mask bitmap: 32 bytes (2 bytes per row, 16 rows)
 *
 * Standard cursor (mask != 0):
 *   Mask bit = 1: pixel is visible
 *   Mask bit = 0: pixel is transparent
 *   Data bit = 1: black pixel (if mask=1)
 *   Data bit = 0: white pixel (if mask=1)
 *
 * XOR cursor (mask == 0, like I-beam):
 *   Data bit = 1: XOR with screen (we render as black)
 *   Data bit = 0: transparent
 */
export function bitmapToCssCursor(
  data: Uint8Array,    // 32 bytes: 16x16 1-bit pixels
  mask: Uint8Array,    // 32 bytes: 16x16 1-bit pixels
  hotspotX: number,
  hotspotY: number,
  scale: number = 1    // Display scale factor (e.g., 2 for 2x display)
): string {
  // Clamp scale to reasonable values (1-4x)
  const s = Math.max(1, Math.min(4, Math.round(scale)));
  const size = 16 * s;

  // Check cache first to avoid expensive PNG encoding
  const cacheKey = getCursorCacheKey(data, mask, hotspotX, hotspotY, s);
  const cached = cursorCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Use OffscreenCanvas for worker compatibility
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Fallback to default cursor if canvas not available
    return DEFAULT_MAC_CURSOR;
  }

  // Check if this is an XOR cursor (no mask content)
  let hasMask = false;
  for (let i = 0; i < 32; i++) {
    if (mask[i] !== 0) { hasMask = true; break; }
  }

  const imageData = ctx.createImageData(size, size);

  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const byteIdx = y * 2 + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      const dataBit = (data[byteIdx] >> bitIdx) & 1;
      const maskBit = (mask[byteIdx] >> bitIdx) & 1;

      // Determine pixel color
      let r = 0, g = 0, b = 0, a = 0;
      if (hasMask) {
        if (maskBit) {
          const color = dataBit ? 0 : 255;
          r = g = b = color;
          a = 255;
        }
      } else {
        if (dataBit) {
          r = g = b = 0;
          a = 255;
        }
      }

      // Draw scaled pixel (s x s block)
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const pixelIdx = ((y * s + dy) * size + (x * s + dx)) * 4;
          imageData.data[pixelIdx + 0] = r;
          imageData.data[pixelIdx + 1] = g;
          imageData.data[pixelIdx + 2] = b;
          imageData.data[pixelIdx + 3] = a;
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  // Convert to data URL - hotspot is also scaled
  const dataUrl = canvasToDataUrl(canvas, size);
  const result = `url("${dataUrl}") ${hotspotX * s} ${hotspotY * s}, auto`;

  // Store in cache, evicting oldest if full
  if (cursorCache.size >= MAX_CACHE_SIZE) {
    // Delete the first (oldest) entry
    const firstKey = cursorCache.keys().next().value;
    if (firstKey) cursorCache.delete(firstKey);
  }
  cursorCache.set(cacheKey, result);

  return result;
}

/**
 * Convert OffscreenCanvas to data URL
 * Uses a temporary regular canvas for compatibility
 */
function canvasToDataUrl(offscreen: OffscreenCanvas, size: number): string {
  // Create a temporary canvas to get data URL
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Draw the offscreen canvas content
  ctx.drawImage(offscreen, 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Parse a CSS cursor string to extract the image URL and hotspot.
 * Returns null if the cursor string is not a URL-based cursor.
 *
 * Used for rendering cursor overlays on touch devices where CSS cursors aren't visible.
 */
export function parseCssCursor(cssCursor: string): {
  imageUrl: string;
  hotspotX: number;
  hotspotY: number;
} | null {
  // CSS cursor format: url("data:...") X Y, fallback
  const match = cssCursor.match(/^url\("([^"]+)"\)\s+(\d+)\s+(\d+)/);
  if (!match) return null;

  return {
    imageUrl: match[1],
    hotspotX: parseInt(match[2], 10),
    hotspotY: parseInt(match[3], 10),
  };
}
