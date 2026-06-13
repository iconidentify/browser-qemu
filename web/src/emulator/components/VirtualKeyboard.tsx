/**
 * VirtualKeyboard - Compact on-screen keyboard for mobile
 *
 * Features:
 * - 4-row compact layout (no number row in letter mode)
 * - Toggle between letters and numbers/symbols
 * - Modifier keys (Shift, Cmd) with visual feedback
 * - Arrow keys cluster
 * - Haptic feedback on key press
 * - Themed to match PowerBook aesthetic
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { mapKeyCode } from '../input/constants';
import { TrackpadHaptics } from '../input/TrackpadHaptics';
import { useCurrentTheme } from '../themes';
import type { InputBufferWriter } from '../input/types';
import './VirtualKeyboard.css';

/** System state for LED backlight effects */
export type KeyboardSystemState = 'loading' | 'ready' | 'off';

export interface VirtualKeyboardProps {
  /** Input buffer writer for sending key events */
  inputBuffer: InputBufferWriter | null;
  /** Whether the keyboard is enabled */
  enabled?: boolean;
  /** Enable haptic sound feedback */
  hapticSound?: boolean;
  /** System state for LED backlight effects (dark themes only) */
  systemState?: KeyboardSystemState;
}

/** Key definition for the keyboard layout */
interface KeyDef {
  /** Display label */
  label: string;
  /** Secondary label (shown when shifted) */
  shiftLabel?: string;
  /** Character to send (for letter/symbol keys) */
  char?: string;
  /** Shifted character */
  shiftChar?: string;
  /** Key code (for special keys like Backspace, arrows) */
  code?: string;
  /** Key type for styling */
  type?: 'letter' | 'modifier' | 'special' | 'space' | 'action' | 'utility';
  /** Width multiplier (default 1) */
  width?: number;
  /** Shortcut identifier for utility keys */
  shortcut?: 'copy' | 'paste' | 'cut' | 'undo' | 'quit' | 'close';
}

type KeyboardMode = 'letters' | 'numbers' | 'symbols';

// Letter mode layout (4 rows)
const LETTER_ROWS: KeyDef[][] = [
  // Row 1: Q-P + Backspace
  [
    { label: 'Q', char: 'q', shiftChar: 'Q' },
    { label: 'W', char: 'w', shiftChar: 'W' },
    { label: 'E', char: 'e', shiftChar: 'E' },
    { label: 'R', char: 'r', shiftChar: 'R' },
    { label: 'T', char: 't', shiftChar: 'T' },
    { label: 'Y', char: 'y', shiftChar: 'Y' },
    { label: 'U', char: 'u', shiftChar: 'U' },
    { label: 'I', char: 'i', shiftChar: 'I' },
    { label: 'O', char: 'o', shiftChar: 'O' },
    { label: 'P', char: 'p', shiftChar: 'P' },
    { label: 'DEL', code: 'Backspace', type: 'special', width: 1.2 },
  ],
  // Row 2: A-L + Enter
  [
    { label: 'A', char: 'a', shiftChar: 'A' },
    { label: 'S', char: 's', shiftChar: 'S' },
    { label: 'D', char: 'd', shiftChar: 'D' },
    { label: 'F', char: 'f', shiftChar: 'F' },
    { label: 'G', char: 'g', shiftChar: 'G' },
    { label: 'H', char: 'h', shiftChar: 'H' },
    { label: 'J', char: 'j', shiftChar: 'J' },
    { label: 'K', char: 'k', shiftChar: 'K' },
    { label: 'L', char: 'l', shiftChar: 'L' },
    { label: 'RET', code: 'Enter', type: 'special', width: 1.5 },
  ],
  // Row 3: Shift + Z-M + Shift
  [
    { label: 'SHIFT', code: 'ShiftLeft', type: 'modifier', width: 1.5 },
    { label: 'Z', char: 'z', shiftChar: 'Z' },
    { label: 'X', char: 'x', shiftChar: 'X' },
    { label: 'C', char: 'c', shiftChar: 'C' },
    { label: 'V', char: 'v', shiftChar: 'V' },
    { label: 'B', char: 'b', shiftChar: 'B' },
    { label: 'N', char: 'n', shiftChar: 'N' },
    { label: 'M', char: 'm', shiftChar: 'M' },
    { label: 'SHIFT', code: 'ShiftRight', type: 'modifier', width: 1.5 },
  ],
  // Row 4: 123 + Cmd + Space + . + Arrows
  [
    { label: '123', type: 'action', width: 1.3 },
    { label: 'CMD', code: 'MetaLeft', type: 'modifier', width: 1.2 },
    { label: '', char: ' ', type: 'space', width: 4 },
    { label: '.', char: '.', shiftChar: '>' },
    { label: 'ARROWS', type: 'action', width: 1.5 },
  ],
];

// Number mode layout
const NUMBER_ROWS: KeyDef[][] = [
  // Row 1: 1-0 + Backspace
  [
    { label: '1', char: '1', shiftChar: '!' },
    { label: '2', char: '2', shiftChar: '@' },
    { label: '3', char: '3', shiftChar: '#' },
    { label: '4', char: '4', shiftChar: '$' },
    { label: '5', char: '5', shiftChar: '%' },
    { label: '6', char: '6', shiftChar: '^' },
    { label: '7', char: '7', shiftChar: '&' },
    { label: '8', char: '8', shiftChar: '*' },
    { label: '9', char: '9', shiftChar: '(' },
    { label: '0', char: '0', shiftChar: ')' },
    { label: 'DEL', code: 'Backspace', type: 'special', width: 1.2 },
  ],
  // Row 2: Symbols
  [
    { label: '-', char: '-', shiftChar: '_' },
    { label: '/', char: '/', shiftChar: '?' },
    { label: ':', char: ':', shiftChar: ':' },
    { label: ';', char: ';', shiftChar: ':' },
    { label: '(', char: '(' },
    { label: ')', char: ')' },
    { label: '$', char: '$' },
    { label: '&', char: '&' },
    { label: '@', char: '@' },
    { label: 'RET', code: 'Enter', type: 'special', width: 1.5 },
  ],
  // Row 3: More symbols
  [
    { label: '#+', type: 'action', width: 1.5 },
    { label: '.', char: '.' },
    { label: ',', char: ',' },
    { label: '?', char: '?' },
    { label: '!', char: '!' },
    { label: "'", char: "'" },
    { label: '"', char: '"' },
    { label: '#+', type: 'action', width: 1.5 },
  ],
  // Row 4: ABC + Cmd + Space + . + Arrows
  [
    { label: 'ABC', type: 'action', width: 1.3 },
    { label: 'CMD', code: 'MetaLeft', type: 'modifier', width: 1.2 },
    { label: '', char: ' ', type: 'space', width: 4 },
    { label: '.', char: '.' },
    { label: 'ARROWS', type: 'action', width: 1.5 },
  ],
];

// Symbol mode layout (when #+= pressed)
const SYMBOL_ROWS: KeyDef[][] = [
  [
    { label: '[', char: '[' },
    { label: ']', char: ']' },
    { label: '{', char: '{' },
    { label: '}', char: '}' },
    { label: '#', char: '#' },
    { label: '%', char: '%' },
    { label: '^', char: '^' },
    { label: '*', char: '*' },
    { label: '+', char: '+' },
    { label: '=', char: '=' },
    { label: 'DEL', code: 'Backspace', type: 'special', width: 1.2 },
  ],
  [
    { label: '_', char: '_' },
    { label: '\\', char: '\\' },
    { label: '|', char: '|' },
    { label: '~', char: '~' },
    { label: '<', char: '<' },
    { label: '>', char: '>' },
    { label: '`', char: '`' },
    { label: 'TAB', code: 'Tab', type: 'special' },
    { label: 'ESC', code: 'Escape', type: 'special' },
    { label: 'RET', code: 'Enter', type: 'special', width: 1.5 },
  ],
  [
    { label: '123', type: 'action', width: 1.5 },
    { label: '.', char: '.' },
    { label: ',', char: ',' },
    { label: '?', char: '?' },
    { label: '!', char: '!' },
    { label: "'", char: "'" },
    { label: '"', char: '"' },
    { label: '123', type: 'action', width: 1.5 },
  ],
  [
    { label: 'ABC', type: 'action', width: 1.3 },
    { label: 'CMD', code: 'MetaLeft', type: 'modifier', width: 1.2 },
    { label: '', char: ' ', type: 'space', width: 4 },
    { label: '.', char: '.' },
    { label: 'ARROWS', type: 'action', width: 1.5 },
  ],
];

// Arrow keys overlay
const ARROW_KEYS: KeyDef[][] = [
  [{ label: '', width: 1 }, { label: 'UP', code: 'ArrowUp' }, { label: '', width: 1 }],
  [
    { label: 'LT', code: 'ArrowLeft' },
    { label: 'DN', code: 'ArrowDown' },
    { label: 'RT', code: 'ArrowRight' },
  ],
];

// Utility keys for common shortcuts
const UTILITY_KEYS: KeyDef[] = [
  { label: 'ESC', code: 'Escape', type: 'utility' },
  { label: 'TAB', code: 'Tab', type: 'utility' },
  { label: 'COPY', type: 'utility', shortcut: 'copy' },
  { label: 'PASTE', type: 'utility', shortcut: 'paste' },
  { label: 'CUT', type: 'utility', shortcut: 'cut' },
  { label: 'UNDO', type: 'utility', shortcut: 'undo' },
  { label: 'QUIT', type: 'utility', shortcut: 'quit' },
  { label: 'CLOSE', type: 'utility', shortcut: 'close' },
];

export function VirtualKeyboard({
  inputBuffer,
  enabled = true,
  hapticSound = true,
  systemState = 'ready',
}: VirtualKeyboardProps) {
  const [mode, setMode] = useState<KeyboardMode>('letters');
  const [shiftActive, setShiftActive] = useState(false);
  const [cmdActive, setCmdActive] = useState(false);
  const [showArrows, setShowArrows] = useState(false);
  const [pressedKey, setPressedKey] = useState<string | null>(null);

  const keyboardRef = useRef<HTMLDivElement>(null);
  const hapticsRef = useRef<TrackpadHaptics | null>(null);

  // Track keys currently held down (for sending keyup on release)
  const heldKeysRef = useRef<Map<string, number>>(new Map());

  // Get current theme for LED backlight settings
  const currentTheme = useCurrentTheme();
  const hasBacklight = useMemo(() => !!currentTheme.leds.keyboard, [currentTheme]);

  // Track startup animation - always play on first mount for dark themes
  const [isStartupAnimating, setIsStartupAnimating] = useState(hasBacklight);
  const startupAnimationDone = useRef(false);

  // Calculate total key count for banner animation stagger
  const totalKeyCount = useMemo(() => {
    const rows = mode === 'letters' ? LETTER_ROWS
      : mode === 'numbers' ? NUMBER_ROWS
      : SYMBOL_ROWS;
    return UTILITY_KEYS.length + rows.reduce((sum, row) => sum + row.length, 0);
  }, [mode]);

  // Handle startup animation completion
  useEffect(() => {
    if (hasBacklight && isStartupAnimating && !startupAnimationDone.current) {
      // Calculate total animation duration (last key stagger + animation duration)
      const animationDuration = totalKeyCount * 35 + 600;
      const timer = setTimeout(() => {
        setIsStartupAnimating(false);
        startupAnimationDone.current = true;
      }, animationDuration);
      return () => clearTimeout(timer);
    }
  }, [hasBacklight, isStartupAnimating, totalKeyCount]);

  // Initialize haptics
  useEffect(() => {
    hapticsRef.current = new TrackpadHaptics({
      sound: hapticSound,
      visual: false, // No visual feedback on keyboard itself
    });

    return () => {
      hapticsRef.current?.dispose();
      hapticsRef.current = null;
    };
  }, [hapticSound]);

  // Release held keys on unmount to prevent stuck keys
  useEffect(() => {
    return () => {
      if (inputBuffer) {
        for (const [, adbKeyCode] of heldKeysRef.current) {
          inputBuffer.writeKeyEvent(adbKeyCode, false);
        }
        heldKeysRef.current.clear();
      }
    };
  }, [inputBuffer]);

  // Release all held keys when tab/window loses visibility (prevents stuck keys)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && inputBuffer) {
        for (const [, adbKeyCode] of heldKeysRef.current) {
          inputBuffer.writeKeyEvent(adbKeyCode, false);
        }
        heldKeysRef.current.clear();
        setPressedKey(null);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [inputBuffer]);

  // Prevent iOS Safari gestures, context menus, and magnifying glass
  useEffect(() => {
    const keyboard = keyboardRef.current;
    if (!keyboard) return;

    const preventEvent = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Standard gesture prevention
    keyboard.addEventListener('gesturestart', preventEvent, { passive: false });
    keyboard.addEventListener('gesturechange', preventEvent, { passive: false });
    keyboard.addEventListener('gestureend', preventEvent, { passive: false });
    keyboard.addEventListener('contextmenu', preventEvent, { passive: false });
    keyboard.addEventListener('selectstart', preventEvent, { passive: false });

    // iOS 3D Touch / Haptic Touch prevention (prevents magnifying glass)
    keyboard.addEventListener('touchforcechange', preventEvent, { passive: false });
    keyboard.addEventListener('webkitmouseforcedown', preventEvent, { passive: false });
    keyboard.addEventListener('webkitmouseforceup', preventEvent, { passive: false });
    keyboard.addEventListener('webkitmouseforcechanged', preventEvent, { passive: false });

    return () => {
      keyboard.removeEventListener('gesturestart', preventEvent);
      keyboard.removeEventListener('gesturechange', preventEvent);
      keyboard.removeEventListener('gestureend', preventEvent);
      keyboard.removeEventListener('contextmenu', preventEvent);
      keyboard.removeEventListener('selectstart', preventEvent);
      keyboard.removeEventListener('touchforcechange', preventEvent);
      keyboard.removeEventListener('webkitmouseforcedown', preventEvent);
      keyboard.removeEventListener('webkitmouseforceup', preventEvent);
      keyboard.removeEventListener('webkitmouseforcechanged', preventEvent);
    };
  }, []);

  // Trigger device vibration if supported
  const triggerDeviceHaptic = useCallback(() => {
    if ('vibrate' in navigator) {
      navigator.vibrate(10); // 10ms pulse
    }
  }, []);

  // Get ADB keycode for a key definition
  const getAdbKeyCode = useCallback((key: KeyDef): number => {
    if (key.code) {
      return mapKeyCode(key.code);
    }
    if (key.char) {
      const upperChar = key.char.toUpperCase();
      let code: string = '';
      if (upperChar >= 'A' && upperChar <= 'Z') {
        code = `Key${upperChar}`;
      } else if (key.char >= '0' && key.char <= '9') {
        code = `Digit${key.char}`;
      } else {
        const charMap: Record<string, string> = {
          ' ': 'Space', '.': 'Period', ',': 'Comma', '/': 'Slash',
          ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight',
          '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
          ':': 'Semicolon', '?': 'Slash', '!': 'Digit1', '@': 'Digit2',
          '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6',
          '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
          '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
          '|': 'Backslash', '~': 'Backquote', '<': 'Comma', '>': 'Period',
          '"': 'Quote',
        };
        code = charMap[key.char] || '';
      }
      if (code) return mapKeyCode(code);
    }
    return -1;
  }, []);

  // Send a keyboard shortcut (e.g., Cmd+C for copy)
  // Sends modifier down, key down, key up, modifier up in sequence
  const sendShortcut = useCallback((shortcut: string) => {
    if (!inputBuffer) return;

    const shortcuts: Record<string, { modifierKeys: string[]; keyCode: string }> = {
      copy: { modifierKeys: ['MetaLeft'], keyCode: 'KeyC' },
      paste: { modifierKeys: ['MetaLeft'], keyCode: 'KeyV' },
      cut: { modifierKeys: ['MetaLeft'], keyCode: 'KeyX' },
      undo: { modifierKeys: ['MetaLeft'], keyCode: 'KeyZ' },
      quit: { modifierKeys: ['MetaLeft'], keyCode: 'KeyQ' },
      close: { modifierKeys: ['MetaLeft'], keyCode: 'KeyW' },
    };

    const shortcutDef = shortcuts[shortcut];
    if (!shortcutDef) return;

    const mainKeyCode = mapKeyCode(shortcutDef.keyCode);
    if (mainKeyCode === -1) return;

    const modifierKeyCodes = shortcutDef.modifierKeys
      .map(code => mapKeyCode(code))
      .filter(code => code !== -1);

    // Send complete key sequence: modifier down, key down, key up, modifier up
    for (const modCode of modifierKeyCodes) {
      inputBuffer.writeKeyEvent(modCode, true);
    }
    inputBuffer.writeKeyEvent(mainKeyCode, true);
    inputBuffer.writeKeyEvent(mainKeyCode, false);
    for (const modCode of [...modifierKeyCodes].reverse()) {
      inputBuffer.writeKeyEvent(modCode, false);
    }
  }, [inputBuffer]);

  // Handle pointer down - send raw keydown event (like real ADB keyboard)
  // Key repeat is handled by the emulated Mac OS, not by us
  const handlePointerDown = useCallback((key: KeyDef, keyId: string) => {
    if (!enabled) return;

    // Haptic feedback
    hapticsRef.current?.triggerTap();
    triggerDeviceHaptic();
    setPressedKey(keyId);

    // Action keys (mode switches) - no key event, just UI state
    if (key.type === 'action') {
      if (key.label === '123') {
        setMode('numbers');
        setShowArrows(false);
      } else if (key.label === 'ABC') {
        setMode('letters');
        setShowArrows(false);
      } else if (key.label === '#+') {
        setMode('symbols');
        setShowArrows(false);
      } else if (key.label === 'ARROWS') {
        setShowArrows(prev => !prev);
      }
      return;
    }

    // Modifier keys - toggle UI state (sticky modifiers for touch)
    if (key.type === 'modifier') {
      if (key.code === 'ShiftLeft' || key.code === 'ShiftRight') {
        setShiftActive(prev => !prev);
      } else if (key.code === 'MetaLeft') {
        setCmdActive(prev => !prev);
      }
      return;
    }

    // Utility keys (shortcuts like COPY, PASTE) - send complete shortcut sequence
    if (key.type === 'utility') {
      if (key.shortcut) {
        sendShortcut(key.shortcut);
      } else if (key.code) {
        // Simple utility key like ESC, TAB
        const adbKeyCode = mapKeyCode(key.code);
        if (adbKeyCode !== -1 && inputBuffer) {
          inputBuffer.writeKeyEvent(adbKeyCode, true);
          heldKeysRef.current.set(keyId, adbKeyCode);
        }
      }
      return;
    }

    // Regular keys - send keydown, track for keyup on release
    const adbKeyCode = getAdbKeyCode(key);
    if (adbKeyCode === -1 || !inputBuffer) return;

    // If shift is active, send shift down first
    if (shiftActive) {
      const shiftCode = mapKeyCode('ShiftLeft');
      if (shiftCode !== -1) {
        inputBuffer.writeKeyEvent(shiftCode, true);
      }
    }

    // If cmd is active, send cmd down first
    if (cmdActive) {
      const cmdCode = mapKeyCode('MetaLeft');
      if (cmdCode !== -1) {
        inputBuffer.writeKeyEvent(cmdCode, true);
      }
    }

    // Send key down
    inputBuffer.writeKeyEvent(adbKeyCode, true);
    heldKeysRef.current.set(keyId, adbKeyCode);

    // Auto-release shift after pressing a key (one-shot behavior)
    if (shiftActive) {
      setShiftActive(false);
    }
  }, [enabled, inputBuffer, shiftActive, cmdActive, triggerDeviceHaptic, getAdbKeyCode, sendShortcut]);

  // Handle pointer up - send raw keyup event
  const handlePointerUp = useCallback((keyId?: string) => {
    if (!keyId || !inputBuffer) {
      setPressedKey(null);
      return;
    }

    const adbKeyCode = heldKeysRef.current.get(keyId);
    if (adbKeyCode !== undefined) {
      // Send key up
      inputBuffer.writeKeyEvent(adbKeyCode, false);
      heldKeysRef.current.delete(keyId);

      // If cmd was active, release it too
      if (cmdActive) {
        const cmdCode = mapKeyCode('MetaLeft');
        if (cmdCode !== -1) {
          inputBuffer.writeKeyEvent(cmdCode, false);
        }
        setCmdActive(false);
      }
    }

    setPressedKey(null);
  }, [inputBuffer, cmdActive]);

  // Get current rows based on mode
  const currentRows = mode === 'letters' ? LETTER_ROWS
    : mode === 'numbers' ? NUMBER_ROWS
    : SYMBOL_ROWS;

  // Helper to get backlit key props
  const getBacklitProps = useCallback((keyIndex: number) => {
    if (!hasBacklight || systemState === 'off') return {};
    // Use startup animation state (plays on mount) instead of system loading state
    const isAnimating = isStartupAnimating;
    return {
      'data-backlit': 'true',
      'data-loading': isAnimating ? 'true' : undefined,
      style: {
        '--key-stagger': `${keyIndex * 35}ms`,
        '--total-keys': totalKeyCount,
      } as React.CSSProperties,
    };
  }, [hasBacklight, systemState, isStartupAnimating, totalKeyCount]);

  // Determine keyboard state for CSS (animation vs ready)
  const keyboardState = isStartupAnimating ? 'loading' : (systemState === 'off' ? 'off' : 'ready');

  return (
    <div
      ref={keyboardRef}
      className={`virtual-keyboard ${!enabled ? 'virtual-keyboard--disabled' : ''}`}
      data-backlit-keyboard={hasBacklight && systemState !== 'off' ? 'true' : undefined}
      data-system-state={keyboardState}
    >
      {showArrows ? (
        // Arrow keys overlay
        <div className="vk-arrows-overlay">
          <div className="vk-arrows-grid">
            {ARROW_KEYS.map((row, rowIndex) => (
              <div key={rowIndex} className="vk-row vk-arrows-row">
                {row.map((key, keyIndex) => {
                  if (!key.code) {
                    return <div key={keyIndex} className="vk-arrow-spacer" />;
                  }
                  const keyId = `arrow-${key.code}`;
                  return (
                    <button
                      key={keyIndex}
                      className={`vk-key vk-key--arrow ${pressedKey === keyId ? 'vk-key--pressed' : ''}`}
                      onPointerDown={() => handlePointerDown(key, keyId)}
                      onPointerUp={() => handlePointerUp(keyId)}
                      onPointerLeave={() => handlePointerUp(keyId)}
                      onPointerCancel={() => handlePointerUp(keyId)}
                      disabled={!enabled}
                    >
                      {key.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <button
            className="vk-arrows-close"
            onClick={() => setShowArrows(false)}
          >
            CLOSE
          </button>
        </div>
      ) : (
        // Normal keyboard
        <div className="vk-keyboard">
          {/* Utility keys row */}
          <div className="vk-row vk-row--utility">
            {UTILITY_KEYS.map((key, keyIndex) => {
              const keyId = `utility-${keyIndex}`;
              const backlitProps = getBacklitProps(keyIndex);
              return (
                <button
                  key={keyIndex}
                  className={`vk-key vk-key--utility ${pressedKey === keyId ? 'vk-key--pressed' : ''}`}
                  onPointerDown={() => handlePointerDown(key, keyId)}
                  onPointerUp={() => handlePointerUp(keyId)}
                  onPointerLeave={() => handlePointerUp(keyId)}
                  onPointerCancel={() => handlePointerUp(keyId)}
                  disabled={!enabled}
                  {...backlitProps}
                >
                  {key.label}
                </button>
              );
            })}
          </div>

          {/* Main keyboard rows */}
          {currentRows.map((row, rowIndex) => {
            // Calculate flat index offset for this row (utility keys + previous rows)
            const rowOffset = UTILITY_KEYS.length + currentRows
              .slice(0, rowIndex)
              .reduce((sum, r) => sum + r.length, 0);

            return (
              <div key={rowIndex} className="vk-row">
                {row.map((key, keyIndex) => {
                  const keyId = `${rowIndex}-${keyIndex}`;
                  const flatIndex = rowOffset + keyIndex;
                  const isModifierActive =
                    (key.code === 'ShiftLeft' || key.code === 'ShiftRight') && shiftActive ||
                    key.code === 'MetaLeft' && cmdActive;

                  const keyClasses = [
                    'vk-key',
                    key.type ? `vk-key--${key.type}` : 'vk-key--letter',
                    isModifierActive ? 'vk-key--active' : '',
                    pressedKey === keyId ? 'vk-key--pressed' : '',
                  ].filter(Boolean).join(' ');

                  const backlitProps = getBacklitProps(flatIndex);
                  const baseStyle = key.width ? { flex: key.width } : {};
                  const combinedStyle = backlitProps.style
                    ? { ...baseStyle, ...backlitProps.style }
                    : baseStyle;

                  // Display label (show shifted for letters when shift active)
                  let displayLabel = key.label;
                  if (key.type !== 'modifier' && key.type !== 'action' && key.type !== 'special') {
                    if (shiftActive && key.shiftLabel) {
                      displayLabel = key.shiftLabel;
                    } else if (shiftActive && key.char && key.char >= 'a' && key.char <= 'z') {
                      displayLabel = key.char.toUpperCase();
                    }
                  }

                  return (
                    <button
                      key={keyIndex}
                      className={keyClasses}
                      style={Object.keys(combinedStyle).length > 0 ? combinedStyle : undefined}
                      onPointerDown={() => handlePointerDown(key, keyId)}
                      onPointerUp={() => handlePointerUp(keyId)}
                      onPointerLeave={() => handlePointerUp(keyId)}
                      onPointerCancel={() => handlePointerUp(keyId)}
                      disabled={!enabled}
                      data-backlit={backlitProps['data-backlit']}
                      data-loading={backlitProps['data-loading']}
                    >
                      {displayLabel}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
