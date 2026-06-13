/**
 * Mock WebSocket for testing DialtoneEthernet
 *
 * Provides methods to simulate connection events:
 * - simulateOpen() - trigger onopen
 * - simulateMessage(data) - trigger onmessage with JSON data
 * - simulateClose() - trigger onclose
 * - simulateError() - trigger onerror
 */

import { vi } from 'vitest';

export class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0; // CONNECTING

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    const messageData = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.(new MessageEvent('message', { data: messageData }));
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static getLastInstance(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static getAllInstances(): MockWebSocket[] {
    return MockWebSocket.instances;
  }
}

/**
 * Install the MockWebSocket globally
 * Call this in beforeEach() and restore in afterEach()
 */
export function installMockWebSocket(): typeof WebSocket {
  const original = globalThis.WebSocket;
  MockWebSocket.reset();
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return original;
}

/**
 * Restore the original WebSocket
 */
export function restoreWebSocket(original: typeof WebSocket): void {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = original;
  MockWebSocket.reset();
}
