/**
 * KeyboardHandler - Unified keyboard input handling for the Mac emulator
 *
 * Features:
 * - ADB keycode mapping
 * - Modifier state tracking (Shift, Ctrl, Alt, Cmd, Caps Lock)
 * - Caps Lock toggle handling
 * - macOS Command+Key bug fix (synthesizes missing keyup events)
 * - Command+W close prevention
 * - Window blur key release (prevents stuck keys)
 */

import {
  InputBufferAddresses,
  Modifiers,
  UNMAPPED_KEY,
  mapKeyCode,
  mapCharToKeyCode,
  isModifierKey,
} from './constants';
import type { InputHandler, InputBufferWriter, KeyboardHandlerConfig } from './types';

/**
 * Default InputBufferWriter that writes to a SharedArrayBuffer using Atomics.
 * WARNING: This does NOT use the lock protocol and may drop keys if typing fast.
 * Use QueuedInputBufferWriter instead for reliable input handling.
 */
export function createAtomicsBufferWriter(buffer: Int32Array): InputBufferWriter {
  return {
    writeMousePosition(x: number, y: number): void {
      Atomics.store(buffer, InputBufferAddresses.mousePositionXAddr, x);
      Atomics.store(buffer, InputBufferAddresses.mousePositionYAddr, y);
      Atomics.store(buffer, InputBufferAddresses.mousePositionFlagAddr, 1);
    },

    writeMouseButton(button: number, pressed: boolean): void {
      const addr = button === 0
        ? InputBufferAddresses.mouseButtonStateAddr
        : InputBufferAddresses.mouseButton2StateAddr;
      Atomics.store(buffer, addr, pressed ? 1 : 0);
    },

    writeKeyEvent(keyCode: number, pressed: boolean): void {
      Atomics.store(buffer, InputBufferAddresses.keyCodeAddr, keyCode);
      Atomics.store(buffer, InputBufferAddresses.keyStateAddr, pressed ? 1 : 0);
      Atomics.store(buffer, InputBufferAddresses.keyEventFlagAddr, 1);
    },

    writeModifiers(modifiers: number): void {
      Atomics.store(buffer, InputBufferAddresses.keyModifiersAddr, modifiers);
    },
  };
}

/**
 * Detects if the current platform is macOS.
 */
export function isMacOS(): boolean {
  // Check userAgentData first (modern API), fallback to platform
  if (typeof navigator !== 'undefined') {
    const uad = (navigator as any).userAgentData;
    if (uad?.platform) {
      return uad.platform === 'macOS';
    }
    // Fallback to deprecated navigator.platform
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  }
  return false;
}

export class KeyboardHandler implements InputHandler {
  private bufferWriter: InputBufferWriter;
  private config: Required<KeyboardHandlerConfig>;

  // State tracking
  private pressedKeys = new Set<string>();
  private capsLockState = false;
  private modifierState = 0;
  private attached = false;

  // Bound handlers for cleanup
  private handleKeyDown: (e: KeyboardEvent) => void;
  private handleKeyUp: (e: KeyboardEvent) => void;
  private handleBlur: () => void;
  private handleBeforeUnload: (e: BeforeUnloadEvent) => void;

  constructor(bufferWriter: InputBufferWriter, config: KeyboardHandlerConfig = {}) {
    this.bufferWriter = bufferWriter;
    this.config = {
      preventDefaults: config.preventDefaults ?? true,
      fixMacCommandKeyBug: config.fixMacCommandKeyBug ?? isMacOS(),
      preventCommandW: config.preventCommandW ?? true,
    };

    // Bind handlers
    this.handleKeyDown = this.onKeyDown.bind(this);
    this.handleKeyUp = this.onKeyUp.bind(this);
    this.handleBlur = this.onBlur.bind(this);
    this.handleBeforeUnload = this.onBeforeUnload.bind(this);
  }

  attach(_element: HTMLElement | Window): void {
    if (this.attached) return;

    // Keyboard events on window to catch all keys
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);

    // Prevent Command+W closing the tab
    if (this.config.preventCommandW) {
      window.addEventListener('beforeunload', this.handleBeforeUnload);
    }

    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);

    this.attached = false;
    this.reset();
  }

  reset(): void {
    this.releaseAllKeys();
    this.pressedKeys.clear();
    // Clear ALL state including Caps Lock on blur/reset
    // The next keydown will sync with host OS via getModifierState()
    this.capsLockState = false;
    this.modifierState = 0;
    this.bufferWriter.writeModifiers(this.modifierState);
  }

  /**
   * Get the current set of pressed key codes.
   */
  getPressedKeys(): Set<string> {
    return new Set(this.pressedKeys);
  }

  /**
   * Get current modifier state bitmask.
   */
  getModifierState(): number {
    return this.modifierState;
  }

  /**
   * Get current Caps Lock toggle state.
   */
  getCapsLockState(): boolean {
    return this.capsLockState;
  }

  /**
   * Check if a modifier key is currently pressed.
   */
  hasMetaKeyPressed(): boolean {
    return this.pressedKeys.has('MetaLeft') || this.pressedKeys.has('MetaRight');
  }

  /**
   * Release all tracked keys (prevents stuck keys on blur/focus loss).
   */
  releaseAllKeys(): void {
    for (const code of this.pressedKeys) {
      const keyCode = mapKeyCode(code);
      if (keyCode !== UNMAPPED_KEY) {
        this.bufferWriter.writeKeyEvent(keyCode, false);
      }
    }
    this.pressedKeys.clear();
  }

  /**
   * Inject a character as if it was typed on the keyboard.
   * Used for virtual keyboard input on mobile devices.
   *
   * @param char - A single character to inject
   */
  injectCharacter(char: string): void {
    const mapping = mapCharToKeyCode(char);
    if (!mapping) return;

    const adbKeyCode = mapKeyCode(mapping.code);
    if (adbKeyCode === UNMAPPED_KEY) return;

    // Apply shift modifier if needed
    if (mapping.shift) {
      this.modifierState |= Modifiers.SHIFT;
      this.bufferWriter.writeModifiers(this.modifierState);
    }

    // Send key down
    this.bufferWriter.writeKeyEvent(adbKeyCode, true);

    // Schedule key up after a brief delay
    setTimeout(() => {
      this.bufferWriter.writeKeyEvent(adbKeyCode, false);

      // Remove shift modifier if we added it
      if (mapping.shift) {
        this.modifierState &= ~Modifiers.SHIFT;
        this.bufferWriter.writeModifiers(this.modifierState);
      }
    }, 50);
  }

  private updateModifiers(e: KeyboardEvent): void {
    let mods = 0;
    if (e.shiftKey) mods |= Modifiers.SHIFT;
    if (e.ctrlKey) mods |= Modifiers.CTRL;
    if (e.altKey) mods |= Modifiers.ALT;
    if (e.metaKey) mods |= Modifiers.CMD;
    if (this.capsLockState) mods |= Modifiers.CAPS;

    this.modifierState = mods;
    this.bufferWriter.writeModifiers(mods);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Don't capture keyboard events when user is typing in an input field
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    if (this.config.preventDefaults) {
      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();
    }

    // Sync Caps Lock with host OS state
    // This fixes issues where Caps Lock is toggled while window is unfocused
    // getModifierState returns the actual current state from the OS
    const hostCapsLock = e.getModifierState('CapsLock');
    if (hostCapsLock !== this.capsLockState) {
      this.capsLockState = hostCapsLock;
    }

    // If this is the Caps Lock key itself, toggle our state
    // (the getModifierState above gives us the state AFTER the toggle on keydown)
    if (e.code === 'CapsLock') {
      // CapsLock keydown: getModifierState already reflects the NEW state
      // so we don't need to toggle - just accept what the OS says
      this.capsLockState = hostCapsLock;
    }

    // Update modifier state first (critical for Shift+key)
    this.updateModifiers(e);

    // Track this key as pressed
    this.pressedKeys.add(e.code);

    const keyCode = mapKeyCode(e.code);
    if (keyCode === UNMAPPED_KEY) return;

    // Special handling for Caps Lock - it's a toggle key
    // Send key down immediately, then key up after a brief delay
    if (e.code === 'CapsLock') {
      this.bufferWriter.writeKeyEvent(keyCode, true);
      setTimeout(() => {
        this.bufferWriter.writeKeyEvent(keyCode, false);
      }, 50);
      return;
    }

    // Normal key press
    this.bufferWriter.writeKeyEvent(keyCode, true);
  }

  private onKeyUp(e: KeyboardEvent): void {
    // Don't capture keyboard events when user is typing in an input field
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    if (this.config.preventDefaults) {
      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();
    }

    // Update modifier state
    this.updateModifiers(e);

    // macOS Command+Key bug fix:
    // When Meta (Command) is released on macOS, the browser doesn't fire keyup
    // events for any keys that were pressed while Meta was held. We need to
    // synthesize those keyup events to prevent stuck keys.
    if (this.config.fixMacCommandKeyBug && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
      this.fixMacCommandKeyup();
    }

    // Remove from pressed keys and send keyup
    this.pressedKeys.delete(e.code);

    // Don't send keyup for Caps Lock (handled as toggle in keydown)
    if (e.code === 'CapsLock') return;

    const keyCode = mapKeyCode(e.code);
    if (keyCode !== UNMAPPED_KEY) {
      this.bufferWriter.writeKeyEvent(keyCode, false);
    }
  }

  /**
   * Fixes the macOS bug where keyup events are not fired for keys that were
   * pressed while Command was held down. When Command is released, we
   * synthesize keyup events for all non-modifier keys.
   */
  private fixMacCommandKeyup(): void {
    for (const code of this.pressedKeys) {
      if (!isModifierKey(code)) {
        const keyCode = mapKeyCode(code);
        if (keyCode !== UNMAPPED_KEY) {
          this.bufferWriter.writeKeyEvent(keyCode, false);
        }
        this.pressedKeys.delete(code);
      }
    }
  }

  private onBlur(): void {
    // Release all keys when window loses focus to prevent stuck keys
    this.reset();
  }

  private onBeforeUnload(e: BeforeUnloadEvent): void {
    // If Meta key is pressed, show the browser's "Leave site?" dialog
    // This prevents Command+W from immediately closing the tab
    if (this.hasMetaKeyPressed()) {
      e.preventDefault();
      // Modern browsers ignore custom messages, but we need to set returnValue
      e.returnValue = '';
      // Release all keys since we're potentially leaving
      this.releaseAllKeys();
    }
  }
}
