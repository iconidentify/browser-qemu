/**
 * Tests for ClipboardHandler
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClipboardHandler, type ClipboardTextCallback } from './ClipboardHandler';

// Polyfill DataTransfer for jsdom
class MockDataTransfer {
  private data = new Map<string, string>();

  setData(format: string, data: string): void {
    this.data.set(format, data);
  }

  getData(format: string): string {
    return this.data.get(format) ?? '';
  }
}

// Use the mock if DataTransfer doesn't exist
if (typeof DataTransfer === 'undefined') {
  (globalThis as any).DataTransfer = MockDataTransfer;
}

// Polyfill ClipboardEvent for jsdom
class MockClipboardEvent extends Event {
  clipboardData: MockDataTransfer | null;

  constructor(type: string, init?: { clipboardData?: MockDataTransfer }) {
    super(type, { bubbles: true, cancelable: true });
    this.clipboardData = init?.clipboardData ?? null;
  }
}

// Use the mock if ClipboardEvent doesn't exist
if (typeof ClipboardEvent === 'undefined') {
  (globalThis as any).ClipboardEvent = MockClipboardEvent;
}

// Helper to create a paste event
function createPasteEvent(text: string): Event {
  const dataTransfer = new (globalThis as any).DataTransfer();
  dataTransfer.setData('text/plain', text);
  return new (globalThis as any).ClipboardEvent('paste', { clipboardData: dataTransfer });
}

describe('ClipboardHandler', () => {
  let callback: ClipboardTextCallback;
  let capturedTexts: string[];
  let handler: ClipboardHandler;

  beforeEach(() => {
    capturedTexts = [];
    callback = (text) => capturedTexts.push(text);
    handler = new ClipboardHandler(callback);
    handler.attach(document);
  });

  afterEach(() => {
    handler.detach();
    vi.restoreAllMocks();
  });

  describe('paste event handling', () => {
    it('should capture text from paste event', () => {
      document.dispatchEvent(createPasteEvent('Hello World'));

      expect(capturedTexts.length).toBe(1);
      expect(capturedTexts[0]).toBe('Hello World');
    });

    it('should truncate text to max length', () => {
      handler.detach();
      handler = new ClipboardHandler(callback, { maxLength: 10 });
      handler.attach(document);

      document.dispatchEvent(createPasteEvent('This is a very long text'));

      expect(capturedTexts[0]).toBe('This is a ');
      expect(capturedTexts[0].length).toBe(10);
    });

    it('should store text in clipboardText', () => {
      document.dispatchEvent(createPasteEvent('Test text'));

      expect(handler.getClipboardText()).toBe('Test text');
    });

    it('should not call callback for empty paste', () => {
      document.dispatchEvent(createPasteEvent(''));

      expect(capturedTexts.length).toBe(0);
    });
  });

  describe('preloadClipboard', () => {
    it('should read from clipboard API', async () => {
      // Mock the clipboard API
      const mockReadText = vi.fn().mockResolvedValue('Clipboard content');
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: mockReadText },
        configurable: true,
      });

      const text = await handler.preloadClipboard();

      expect(text).toBe('Clipboard content');
      expect(mockReadText).toHaveBeenCalled();
    });

    it('should return cached promise if already loading', async () => {
      const mockReadText = vi.fn().mockResolvedValue('Content');
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: mockReadText },
        configurable: true,
      });

      // Start two preloads simultaneously
      const promise1 = handler.preloadClipboard();
      const promise2 = handler.preloadClipboard();

      expect(promise1).toBe(promise2);
      await promise1;

      // Should only call readText once
      expect(mockReadText).toHaveBeenCalledTimes(1);
    });

    it('should handle clipboard API errors gracefully', async () => {
      const mockReadText = vi.fn().mockRejectedValue(new Error('Permission denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: mockReadText },
        configurable: true,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const text = await handler.preloadClipboard();

      expect(text).toBe('');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should truncate preloaded text', async () => {
      handler.detach();
      handler = new ClipboardHandler(callback, { maxLength: 5 });
      handler.attach(document);

      const mockReadText = vi.fn().mockResolvedValue('Long text');
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: mockReadText },
        configurable: true,
      });

      const text = await handler.preloadClipboard();

      expect(text).toBe('Long ');
      expect(text.length).toBe(5);
    });
  });

  describe('getClipboardText', () => {
    it('should return empty string initially', () => {
      expect(handler.getClipboardText()).toBe('');
    });

    it('should return text after paste', () => {
      document.dispatchEvent(createPasteEvent('Pasted text'));

      expect(handler.getClipboardText()).toBe('Pasted text');
    });
  });

  describe('clearClipboardText', () => {
    it('should clear stored clipboard text', () => {
      document.dispatchEvent(createPasteEvent('Some text'));
      expect(handler.getClipboardText()).toBe('Some text');

      handler.clearClipboardText();
      expect(handler.getClipboardText()).toBe('');
    });
  });

  describe('reset', () => {
    it('should clear clipboard text on reset', () => {
      document.dispatchEvent(createPasteEvent('Text'));
      handler.reset();

      expect(handler.getClipboardText()).toBe('');
    });
  });

  describe('attach/detach', () => {
    it('should not process events after detach', () => {
      handler.detach();
      capturedTexts = [];

      document.dispatchEvent(createPasteEvent('Should not capture'));

      expect(capturedTexts.length).toBe(0);
    });

    it('should only attach once', () => {
      handler.attach(document);
      handler.attach(document);

      document.dispatchEvent(createPasteEvent('Single event'));

      // Should only receive one event, not duplicates
      expect(capturedTexts.length).toBe(1);
    });
  });
});
