/**
 * SimpleDisk - Direct relay disk I/O
 *
 * All disk reads and writes go directly to the Go relay server via sync XHR.
 * No local caching - the relay owns all disk state.
 *
 * Features:
 * - Sync XHR for blocking WASM I/O requirements
 * - Per-user overlay support (writes don't modify base image)
 * - Simple, no threading complexity
 */

import type { Disk, DiskStorageMode } from './types';
import { logger } from '../logger';

// Re-export Disk interface for backward compatibility
export type { Disk };

function describeXhrResponse(xhr: XMLHttpRequest): string {
  try {
    if (xhr.responseType === '' || xhr.responseType === 'text') {
      return xhr.responseText || '(no text)';
    }
  } catch {
    // responseText throws when responseType is arraybuffer/blob/etc.
  }

  const response = xhr.response;
  const isArrayBuffer =
    response instanceof ArrayBuffer ||
    Object.prototype.toString.call(response) === '[object ArrayBuffer]' ||
    (
      response !== null &&
      typeof response === 'object' &&
      typeof (response as ArrayBuffer).byteLength === 'number' &&
      typeof (response as ArrayBuffer).slice === 'function'
    );

  if (isArrayBuffer) {
    const arrayBuffer = response as ArrayBuffer;
    if (arrayBuffer.byteLength === 0) {
      return '(empty binary response)';
    }
    try {
      const maxBytes = 200;
      const bytes = new Uint8Array(arrayBuffer.slice(0, maxBytes));
      const text = new TextDecoder().decode(bytes).trim();
      if (text) {
        return arrayBuffer.byteLength > maxBytes ? `${text}...` : text;
      }
    } catch {
      // Fall through to a byte count.
    }
    return `(${arrayBuffer.byteLength} binary bytes)`;
  }

  return '(no text)';
}

export class SimpleDisk implements Disk {
  readonly name: string;
  readonly size: number;
  readonly mode: DiskStorageMode = 'disk-server';
  #relayUrl: string;
  #userId: string;
  #adminToken?: string;

  private constructor(name: string, relayUrl: string, userId: string, size: number, adminToken?: string) {
    this.name = name;
    this.size = size;
    this.#relayUrl = relayUrl;
    this.#userId = userId;
    this.#adminToken = adminToken;
  }

  /**
   * Create a SimpleDisk by fetching disk info from the relay
   */
  static async create(name: string, relayUrl: string, userId: string, adminToken?: string): Promise<SimpleDisk> {
    const resp = await fetch(`${relayUrl}/disk/info?name=${encodeURIComponent(name)}`);
    if (!resp.ok) {
      throw new Error(`Disk not found: ${name} (${resp.status})`);
    }
    const info = await resp.json();
    if (!info.size) {
      throw new Error(`Invalid disk info for ${name}: missing size`);
    }
    logger.log(`[SimpleDisk] Created disk: ${name}, size: ${info.size}, user: ${userId}, admin: ${adminToken ? 'yes' : 'no'}`);
    return new SimpleDisk(name, relayUrl, userId, info.size, adminToken);
  }

  /**
   * Read data from disk via sync XHR to relay
   */
  read(buffer: Uint8Array, offset: number, length: number): number {
    const xhr = new XMLHttpRequest();
    const url = `${this.#relayUrl}/disk/read?name=${encodeURIComponent(this.name)}&offset=${offset}&length=${length}`;
    xhr.open('GET', url, false); // SYNC - required for WASM blocking calls
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('X-User-Id', this.#userId);

    try {
      xhr.send();
    } catch (e) {
      logger.error(`[SimpleDisk] Read network error at offset ${offset}:`, e);
      return 0;
    }

    if (xhr.status === 200) {
      // Check for valid response
      if (!xhr.response) {
        logger.error(`[SimpleDisk] Read returned null response at offset ${offset}`);
        return 0;
      }
      const data = new Uint8Array(xhr.response as ArrayBuffer);
      if (data.length === 0) {
        logger.warn(`[SimpleDisk] Read returned 0 bytes at offset ${offset}, requested ${length}`);
      }
      const copyLen = Math.min(data.length, length, buffer.length);
      buffer.set(data.subarray(0, copyLen));
      return copyLen;
    }

    logger.error(`[SimpleDisk] Read failed at offset ${offset}: HTTP ${xhr.status}, response: ${describeXhrResponse(xhr)}`);
    return 0;
  }

  /**
   * Write data to disk via sync XHR to relay
   * Writes go to per-user overlay, not the base image
   */
  write(buffer: Uint8Array, offset: number, length: number): number {
    const xhr = new XMLHttpRequest();
    const url = `${this.#relayUrl}/disk/write?name=${encodeURIComponent(this.name)}&offset=${offset}`;
    xhr.open('POST', url, false); // SYNC - required for WASM blocking calls
    xhr.setRequestHeader('X-User-Id', this.#userId);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    // Admin writes to the shared base image require the Dialtone admin token.
    if (this.#adminToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${this.#adminToken}`);
    }

    try {
      // Copy to new Uint8Array for TypeScript compatibility (subarray may reference SharedArrayBuffer)
      // Use Uint8Array directly (not .buffer) to avoid Safari deprecation warning
      const data = new Uint8Array(buffer.subarray(0, length));
      xhr.send(data);
    } catch (e) {
      logger.error(`[SimpleDisk] Write network error at offset ${offset}:`, e);
      return 0;
    }

    if (xhr.status === 200) {
      return length;
    }

    logger.error(`[SimpleDisk] Write failed at offset ${offset}: HTTP ${xhr.status}`);
    return 0;
  }

  /**
   * Clean up resources (no-op for SimpleDisk)
   */
  dispose(): void {
    // SimpleDisk has no local resources to clean up
  }
}

/**
 * LocalDisk - Direct local file disk I/O
 *
 * For loading disk images from local files (File objects).
 * Uses FileReaderSync for blocking reads (works in workers).
 * Writes are stored in memory only (not persisted).
 */
export class LocalDisk implements Disk {
  readonly name: string;
  readonly size: number;
  readonly mode: DiskStorageMode = 'disk-server'; // Uses same mode designation
  #file: File;
  #writes: Map<number, Uint8Array> = new Map(); // In-memory write overlay

  constructor(file: File) {
    this.name = file.name;
    this.size = file.size;
    this.#file = file;
    logger.log(`[LocalDisk] Created disk: ${file.name}, size: ${file.size}`);
  }

  /**
   * Read data from local file using FileReaderSync
   */
  read(buffer: Uint8Array, offset: number, length: number): number {
    // Check in-memory writes first
    for (const [writeOffset, writeData] of this.#writes) {
      const writeEnd = writeOffset + writeData.length;
      const readEnd = offset + length;

      // Check for overlap
      if (writeEnd <= offset || writeOffset >= readEnd) {
        continue;
      }

      // Apply overlapping write
      const overlapStart = Math.max(offset, writeOffset);
      const overlapEnd = Math.min(readEnd, writeEnd);
      const srcStart = overlapStart - writeOffset;
      const dstStart = overlapStart - offset;
      const copyLen = overlapEnd - overlapStart;

      buffer.set(writeData.subarray(srcStart, srcStart + copyLen), dstStart);
    }

    // Read from file for non-overlapping portions
    try {
      const blob = this.#file.slice(offset, offset + length);
      const reader = new FileReaderSync();
      const arrayBuffer = reader.readAsArrayBuffer(blob);
      const fileData = new Uint8Array(arrayBuffer);

      // Only copy bytes that weren't covered by writes
      for (let i = 0; i < length && i < fileData.length; i++) {
        const absOffset = offset + i;
        let coveredByWrite = false;
        for (const [writeOffset, writeData] of this.#writes) {
          if (absOffset >= writeOffset && absOffset < writeOffset + writeData.length) {
            coveredByWrite = true;
            break;
          }
        }
        if (!coveredByWrite) {
          buffer[i] = fileData[i];
        }
      }

      return Math.min(length, fileData.length);
    } catch (e) {
      logger.error(`[LocalDisk] Read error at offset ${offset}:`, e);
      return 0;
    }
  }

  /**
   * Write data to in-memory overlay (not persisted)
   */
  write(buffer: Uint8Array, offset: number, length: number): number {
    const data = new Uint8Array(length);
    data.set(buffer.subarray(0, length));
    this.#writes.set(offset, data);
    return length;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.#writes.clear();
  }
}
