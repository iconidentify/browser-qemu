/**
 * Vitest global test setup
 *
 * Provides mocks for browser APIs not available in jsdom:
 * - SharedArrayBuffer / Atomics
 * - AudioContext / AudioWorkletNode
 * - IndexedDB (via fake-indexeddb)
 * - URL.createObjectURL
 */

import '@testing-library/jest-dom';
import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// Mock SharedArrayBuffer if not available (jsdom doesn't have it)
if (typeof SharedArrayBuffer === 'undefined') {
  (globalThis as unknown as { SharedArrayBuffer: typeof ArrayBuffer }).SharedArrayBuffer = ArrayBuffer;
}

// Mock Atomics if not available
if (typeof Atomics === 'undefined') {
  (globalThis as unknown as { Atomics: typeof Atomics }).Atomics = {
    load: (arr: Int32Array, idx: number) => arr[idx],
    store: (arr: Int32Array, idx: number, val: number) => {
      arr[idx] = val;
      return val;
    },
    add: (arr: Int32Array, idx: number, val: number) => {
      const old = arr[idx];
      arr[idx] += val;
      return old;
    },
    sub: (arr: Int32Array, idx: number, val: number) => {
      const old = arr[idx];
      arr[idx] -= val;
      return old;
    },
    notify: () => 0,
    wait: () => 'ok' as const,
    compareExchange: (arr: Int32Array, idx: number, expected: number, replacement: number) => {
      const old = arr[idx];
      if (old === expected) {
        arr[idx] = replacement;
      }
      return old;
    },
    exchange: (arr: Int32Array, idx: number, val: number) => {
      const old = arr[idx];
      arr[idx] = val;
      return old;
    },
    and: () => 0,
    or: () => 0,
    xor: () => 0,
    isLockFree: () => true,
    waitAsync: () => ({ async: false, value: 'ok' as const }),
  } as typeof Atomics;
}

// Mock AudioContext
class MockGainNode {
  gain = { value: 1, setTargetAtTime: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 22050;
  destination = {};

  createGain(): MockGainNode {
    return new MockGainNode();
  }

  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
  };

  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  suspend = vi.fn().mockResolvedValue(undefined);
}

vi.stubGlobal('AudioContext', MockAudioContext);

// Mock AudioWorkletNode
class MockAudioWorkletNode {
  port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

// Mock URL.createObjectURL / revokeObjectURL
URL.createObjectURL = vi.fn(() => 'blob:mock-url');
URL.revokeObjectURL = vi.fn();

// Mock crypto.getRandomValues if needed
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      getRandomValues: (arr: Uint8Array | Uint32Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
    },
  });
}

// Reset all mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});
