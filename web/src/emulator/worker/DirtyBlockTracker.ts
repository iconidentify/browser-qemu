/**
 * DirtyBlockTracker - Efficient block-level dirty tracking for disk images
 *
 * Uses a bitmap where each bit represents one 512-byte block.
 * For a 100MB disk: 204,800 blocks = 25KB bitmap
 */

export class DirtyBlockTracker {
  private bitmap: Uint8Array;
  private readonly blockSize = 512;
  private readonly totalBlocks: number;
  private dirtyCount = 0;

  constructor(diskSizeBytes: number) {
    this.totalBlocks = Math.ceil(diskSizeBytes / this.blockSize);
    const bitmapBytes = Math.ceil(this.totalBlocks / 8);
    this.bitmap = new Uint8Array(bitmapBytes);
  }

  /**
   * Mark blocks as dirty for a given byte range
   */
  markDirty(offset: number, length: number): void {
    const startBlock = Math.floor(offset / this.blockSize);
    const endBlock = Math.ceil((offset + length) / this.blockSize);

    for (let block = startBlock; block < endBlock && block < this.totalBlocks; block++) {
      const byteIndex = block >> 3;
      const bitMask = 1 << (block & 7);

      if (!(this.bitmap[byteIndex] & bitMask)) {
        this.bitmap[byteIndex] |= bitMask;
        this.dirtyCount++;
      }
    }
  }

  /**
   * Check if any blocks are dirty
   */
  isDirty(): boolean {
    return this.dirtyCount > 0;
  }

  /**
   * Get count of dirty blocks
   */
  getDirtyBlockCount(): number {
    return this.dirtyCount;
  }

  /**
   * Get dirty byte ranges (for differential saves)
   */
  getDirtyRanges(): Array<{ startByte: number; endByte: number }> {
    const ranges: Array<{ startByte: number; endByte: number }> = [];
    let rangeStart = -1;

    for (let block = 0; block < this.totalBlocks; block++) {
      const isDirty = (this.bitmap[block >> 3] & (1 << (block & 7))) !== 0;

      if (isDirty && rangeStart === -1) {
        rangeStart = block;
      } else if (!isDirty && rangeStart !== -1) {
        ranges.push({
          startByte: rangeStart * this.blockSize,
          endByte: block * this.blockSize
        });
        rangeStart = -1;
      }
    }

    if (rangeStart !== -1) {
      ranges.push({
        startByte: rangeStart * this.blockSize,
        endByte: this.totalBlocks * this.blockSize
      });
    }

    return ranges;
  }

  /**
   * Clear all dirty flags
   */
  clear(): void {
    this.bitmap.fill(0);
    this.dirtyCount = 0;
  }

  /**
   * Get approximate dirty data size in bytes
   */
  getDirtyBytes(): number {
    return this.dirtyCount * this.blockSize;
  }
}
