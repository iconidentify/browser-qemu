/**
 * ClipboardHandler - Clipboard integration for the Mac emulator
 *
 * Features:
 * - Detects Cmd+V / Ctrl+V paste shortcuts
 * - Reads from system clipboard using Clipboard API
 * - Provides clipboard text for injection into emulator
 * - Fallback for older browsers (execCommand)
 */

import type { InputHandler, ClipboardHandlerConfig } from './types';
import { logger } from '../logger';

export type ClipboardTextCallback = (text: string) => void;

export class ClipboardHandler implements InputHandler {
  private config: Required<ClipboardHandlerConfig>;
  private callback: ClipboardTextCallback;
  private attached = false;

  // Pre-loaded clipboard text (loaded when paste shortcut is detected)
  private clipboardText = '';
  private clipboardPromise: Promise<string> | null = null;

  // Bound handlers for cleanup
  private handlePaste: (e: ClipboardEvent) => void;

  constructor(callback: ClipboardTextCallback, config: ClipboardHandlerConfig = {}) {
    this.callback = callback;
    this.config = {
      maxLength: config.maxLength ?? 65535,
    };

    // Bind handlers
    this.handlePaste = this.onPaste.bind(this);
  }

  attach(_element: HTMLElement | Window): void {
    if (this.attached) return;

    // Listen for paste events on document
    document.addEventListener('paste', this.handlePaste);

    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;

    document.removeEventListener('paste', this.handlePaste);

    this.attached = false;
    this.reset();
  }

  reset(): void {
    this.clipboardText = '';
    this.clipboardPromise = null;
  }

  /**
   * Pre-load clipboard content when a paste shortcut is detected.
   * This should be called by the keyboard handler when Cmd+V or Ctrl+V is pressed.
   * Returns a promise that resolves with the clipboard text.
   */
  preloadClipboard(): Promise<string> {
    // If already loading, return the existing promise
    if (this.clipboardPromise) {
      return this.clipboardPromise;
    }

    this.clipboardPromise = this.readClipboard().then((text) => {
      this.clipboardText = text;
      this.clipboardPromise = null;
      return text;
    }).catch((error) => {
      this.clipboardPromise = null;
      throw error;
    });

    return this.clipboardPromise;
  }

  /**
   * Get the current clipboard text (if preloaded).
   */
  getClipboardText(): string {
    return this.clipboardText;
  }

  /**
   * Clear the cached clipboard text.
   */
  clearClipboardText(): void {
    this.clipboardText = '';
  }

  /**
   * Read text from the system clipboard.
   */
  private async readClipboard(): Promise<string> {
    try {
      // Try modern Clipboard API first
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        return this.truncateText(text);
      }

      // Fallback: use a temporary textarea
      return this.readClipboardFallback();
    } catch (error) {
      // Permission denied or other error
      logger.warn('[ClipboardHandler] Could not read clipboard:', error);
      return '';
    }
  }

  /**
   * Fallback method using execCommand (deprecated but still works in some browsers).
   */
  private readClipboardFallback(): string {
    const textarea = document.createElement('textarea');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);

    textarea.focus();
    document.execCommand('paste');
    const text = textarea.value;

    document.body.removeChild(textarea);

    return this.truncateText(text);
  }

  /**
   * Truncate text to max length.
   */
  private truncateText(text: string): string {
    if (text.length > this.config.maxLength) {
      return text.substring(0, this.config.maxLength);
    }
    return text;
  }

  /**
   * Handle paste event from browser.
   */
  private onPaste(event: ClipboardEvent): void {
    // Get text from the paste event
    const text = event.clipboardData?.getData('text/plain') ?? '';

    if (text) {
      this.clipboardText = this.truncateText(text);
      this.callback(this.clipboardText);
    }
  }
}
