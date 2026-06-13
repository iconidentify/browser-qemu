/**
 * CursorQueue - Handles cursor update queueing during module initialization race.
 *
 * Problem: C++ may call setCursor() before the WASM module is fully initialized,
 * causing out-of-bounds memory access errors.
 *
 * Solution: Queue cursor updates when module not ready, process them when ready.
 *
 * Usage:
 *   const queue = new CursorQueue();
 *
 *   // In setCursor callback:
 *   if (!moduleReady) {
 *     queue.enqueue({ dataPtr, hotspotX, hotspotY, visible });
 *     return;
 *   }
 *   queue.clear(); // Clear pending since we're processing directly
 *
 *   // In preRun after module ready:
 *   const pending = queue.dequeue();
 *   if (pending) processCursor(pending);
 */

export interface CursorUpdate {
  /** Pointer to cursor data in WASM heap */
  dataPtr: number;
  /** Hotspot X coordinate (0-15) */
  hotspotX: number;
  /** Hotspot Y coordinate (0-15) */
  hotspotY: number;
  /** Visibility flag (1 = visible, 0 = hidden) */
  visible: number;
}

/**
 * Queue for cursor updates during module initialization.
 * Only stores the most recent update (newer updates replace older ones).
 */
export class CursorQueue {
  private pending: CursorUpdate | null = null;
  private processedCount = 0;
  private queuedCount = 0;

  /**
   * Queue a cursor update for later processing.
   * Only the most recent update is kept (cursor state is idempotent).
   */
  enqueue(update: CursorUpdate): void {
    this.pending = update;
    this.queuedCount++;
  }

  /**
   * Check if there's a pending cursor update.
   */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Get the pending cursor update (if any).
   * Does not remove it from the queue.
   */
  peek(): CursorUpdate | null {
    return this.pending;
  }

  /**
   * Get and remove the pending cursor update.
   * Returns null if no update is pending.
   */
  dequeue(): CursorUpdate | null {
    const update = this.pending;
    if (update) {
      this.pending = null;
      this.processedCount++;
    }
    return update;
  }

  /**
   * Clear any pending cursor update.
   * Used when a direct cursor update succeeds.
   */
  clear(): void {
    this.pending = null;
  }

  /**
   * Get statistics about cursor queue usage.
   * Useful for debugging race condition frequency.
   */
  getStats(): { queued: number; processed: number } {
    return {
      queued: this.queuedCount,
      processed: this.processedCount,
    };
  }

  /**
   * Reset statistics (useful for testing).
   */
  resetStats(): void {
    this.queuedCount = 0;
    this.processedCount = 0;
  }
}

/**
 * Validate a cursor update has reasonable values.
 * @returns true if the update appears valid
 */
export function isValidCursorUpdate(update: CursorUpdate): boolean {
  // dataPtr must be non-negative
  if (update.dataPtr < 0) return false;

  // Hotspot must be within 16x16 cursor bounds
  if (update.hotspotX < 0 || update.hotspotX > 15) return false;
  if (update.hotspotY < 0 || update.hotspotY > 15) return false;

  // Visible must be 0 or 1
  if (update.visible !== 0 && update.visible !== 1) return false;

  return true;
}

/**
 * Validate that a data pointer is within HEAPU8 bounds for cursor data.
 * Mac cursors require 64 bytes (32 data + 32 mask).
 */
export function isCursorPtrInBounds(dataPtr: number, heapSize: number): boolean {
  // Cursor data is 64 bytes (32 for bitmap + 32 for mask)
  const CURSOR_DATA_SIZE = 64;
  return dataPtr >= 0 && dataPtr + CURSOR_DATA_SIZE <= heapSize;
}
