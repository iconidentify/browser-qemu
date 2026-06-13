/**
 * InputManager - Unified input handling orchestrator for the Mac emulator
 *
 * Combines all input handlers into a single interface:
 * - KeyboardHandler: Keyboard input with macOS bug fixes
 * - PointerHandler: Mouse/touch input with gesture recognition
 * - ClipboardHandler: Clipboard integration
 *
 * Also provides virtual keyboard support for mobile devices.
 */

import { KeyboardHandler, createAtomicsBufferWriter } from './KeyboardHandler';
import { PointerHandler, type PanCallback } from './PointerHandler';
import { ClipboardHandler, type ClipboardTextCallback } from './ClipboardHandler';
import { QueuedInputBufferWriter, createQueuedBufferWriter } from './QueuedInputBufferWriter';
import type { InputHandler, InputBufferWriter, InputManagerConfig } from './types';
import type { InputQueueStats } from './queue';

/**
 * Check if the device is primarily touch-based (mobile).
 * Uses multiple detection methods for better compatibility with device emulators.
 */
function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;

  // Check for touch capability first
  const hasTouchCapability =
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    (navigator as any).msMaxTouchPoints > 0;

  if (!hasTouchCapability) return false;

  // Check media query for touch-primary device
  if (typeof window.matchMedia === 'function') {
    const result = window.matchMedia('(hover: none) and (pointer: coarse)');
    if (result?.matches) return true;
  }

  // Fallback: narrow viewport likely means mobile
  // This helps with device emulators that don't fully simulate media queries
  if (window.innerWidth <= 1024 && hasTouchCapability) {
    return true;
  }

  return false;
}

export class InputManager implements InputHandler {
  private keyboard: KeyboardHandler;
  private pointer: PointerHandler;
  private clipboard: ClipboardHandler;

  private bufferWriter: InputBufferWriter;
  private queuedWriter: QueuedInputBufferWriter | null = null;
  private attached = false;
  private element: HTMLElement | null = null;

  // Virtual keyboard support
  private virtualKeyboardInput: HTMLInputElement | null = null;
  private onClipboardText: ClipboardTextCallback | null = null;

  constructor(
    inputBuffer: Int32Array,
    config: InputManagerConfig = {},
    onClipboardText?: ClipboardTextCallback,
    onPan?: PanCallback
  ) {
    // Queued input system provides key buffering to prevent dropped keys.
    // Mouse position is written directly (latency-critical), keys are queued.
    const useQueuing = config.useQueuing ?? true;

    if (useQueuing) {
      console.log('[InputManager] Using queued input system');
      this.queuedWriter = createQueuedBufferWriter(inputBuffer, {
        debug: config.debugQueue,
      });
      this.bufferWriter = this.queuedWriter;
    } else {
      console.log('[InputManager] Using direct (non-queued) input system');
      this.bufferWriter = createAtomicsBufferWriter(inputBuffer);
    }

    this.onClipboardText = onClipboardText ?? null;

    // Create handlers
    this.keyboard = new KeyboardHandler(this.bufferWriter, config.keyboard);
    this.pointer = new PointerHandler(this.bufferWriter, config.pointer, onPan);
    this.clipboard = new ClipboardHandler(
      (text) => this.handleClipboardText(text),
      config.clipboard
    );
  }

  /**
   * Set or update the pan callback for two-finger viewport panning.
   */
  setOnPan(callback: PanCallback | null): void {
    this.pointer.setOnPan(callback);
  }

  /**
   * Set the native canvas dimensions for coordinate scaling.
   * When the canvas is CSS-scaled, this ensures input coordinates
   * are correctly translated to canvas coordinates.
   */
  setCanvasDimensions(width: number, height: number): void {
    this.pointer.setCanvasDimensions(width, height);
  }

  /**
   * Enable or disable glide mode.
   * In glide mode, single-finger touch pans the viewport instead of moving the cursor.
   */
  setGlideMode(enabled: boolean): void {
    this.pointer.setGlideMode(enabled);
  }

  attach(element: HTMLElement | Window): void {
    if (this.attached) return;
    if (element === window) {
      throw new Error('InputManager must be attached to an element, not window');
    }

    this.element = element as HTMLElement;

    // Attach all handlers
    this.keyboard.attach(window);
    this.pointer.attach(this.element);
    this.clipboard.attach(window);

    // Create virtual keyboard input for mobile
    if (isTouchDevice()) {
      this.createVirtualKeyboardInput();
    }

    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;

    this.keyboard.detach();
    this.pointer.detach();
    this.clipboard.detach();

    // Clean up queued writer
    if (this.queuedWriter) {
      this.queuedWriter.dispose();
    }

    // Remove virtual keyboard input
    if (this.virtualKeyboardInput) {
      this.virtualKeyboardInput.remove();
      this.virtualKeyboardInput = null;
    }

    this.element = null;
    this.attached = false;
  }

  reset(): void {
    this.keyboard.reset();
    this.pointer.reset();
    this.clipboard.reset();
  }

  /**
   * Release all tracked keys (use when emulator loses focus).
   */
  releaseAllKeys(): void {
    this.keyboard.releaseAllKeys();
  }

  /**
   * Get the current set of pressed key codes.
   */
  getPressedKeys(): Set<string> {
    return this.keyboard.getPressedKeys();
  }

  /**
   * Check if touch input is currently active.
   */
  isTouchActive(): boolean {
    return this.pointer.isTouchActive();
  }

  /**
   * Get the keyboard handler (for advanced use cases).
   */
  getKeyboardHandler(): KeyboardHandler {
    return this.keyboard;
  }

  /**
   * Get the pointer handler (for advanced use cases).
   */
  getPointerHandler(): PointerHandler {
    return this.pointer;
  }

  /**
   * Get the clipboard handler (for advanced use cases).
   */
  getClipboardHandler(): ClipboardHandler {
    return this.clipboard;
  }

  /**
   * Check if the device should show a virtual keyboard button.
   */
  shouldShowVirtualKeyboardButton(): boolean {
    return isTouchDevice();
  }

  /**
   * Trigger the virtual keyboard to show.
   */
  triggerVirtualKeyboard(): void {
    if (this.virtualKeyboardInput) {
      this.virtualKeyboardInput.focus();
    }
  }

  /**
   * Get clipboard text that was pasted.
   */
  getClipboardText(): string {
    return this.clipboard.getClipboardText();
  }

  /**
   * Clear the cached clipboard text.
   */
  clearClipboardText(): void {
    this.clipboard.clearClipboardText();
  }

  /**
   * Get input queue statistics (for debugging).
   * Returns null if queuing is not enabled.
   */
  getInputQueueStats(): InputQueueStats | null {
    return this.queuedWriter?.getStats() ?? null;
  }

  /**
   * Check if there are pending input events.
   * Returns false if queuing is not enabled.
   */
  hasPendingInputEvents(): boolean {
    return this.queuedWriter?.hasPendingEvents() ?? false;
  }

  /**
   * Check if the queued input system is enabled.
   */
  isQueuingEnabled(): boolean {
    return this.queuedWriter !== null;
  }

  private handleClipboardText(text: string): void {
    if (this.onClipboardText) {
      this.onClipboardText(text);
    }
  }

  private createVirtualKeyboardInput(): void {
    // Create a hidden input that can trigger the system keyboard
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'none';
    input.spellcheck = false;

    // Position off-screen but not display:none (which prevents keyboard)
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    input.style.width = '1px';
    input.style.height = '1px';

    // Forward key events to the keyboard handler
    input.addEventListener('keydown', (_e) => {
      // Don't prevent default for the hidden input - let it handle text
    });

    // Handle input changes (for mobile text input)
    input.addEventListener('input', () => {
      const text = input.value;
      if (text) {
        // Inject each character to the keyboard handler
        for (const char of text) {
          this.keyboard.injectCharacter(char);
        }
      }
      // Clear the input after processing
      input.value = '';
    });

    document.body.appendChild(input);
    this.virtualKeyboardInput = input;
  }
}
