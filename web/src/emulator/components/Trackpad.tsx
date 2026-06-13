/**
 * Trackpad - Touch input surface component for the laptop interface
 *
 * A realistic trackpad that translates touch gestures into mouse input.
 * Features:
 * - Single tap: Left click
 * - Two-finger tap: Right click (Ctrl+click)
 * - Drag: Cursor movement
 * - Two-finger drag: Scroll
 * - Tap + hold + drag: Click-and-drag
 * - Double-tap: Double-click
 * - Simulated haptic feedback (sound + visual)
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { TrackpadHandler, type ScrollCallback, type DragHoldCallback, type CursorMoveCallback } from '../input/TrackpadHandler';
import { TrackpadHaptics } from '../input/TrackpadHaptics';
import type { InputBufferWriter } from '../input/types';
import './Trackpad.css';

export interface TrackpadProps {
  /** Input buffer writer for communicating with emulator */
  inputBuffer: InputBufferWriter | null;
  /** Width of the emulator screen (for cursor bounds) */
  screenWidth?: number;
  /** Height of the emulator screen (for cursor bounds) */
  screenHeight?: number;
  /** Cursor movement sensitivity (default: 1.5) */
  sensitivity?: number;
  /** Enable haptic sound feedback (default: true) */
  hapticSound?: boolean;
  /** Enable haptic visual feedback (default: true) */
  hapticVisual?: boolean;
  /** Callback when scrolling (for emulator scroll handling) */
  onScroll?: ScrollCallback;
  /** Whether the trackpad is enabled */
  enabled?: boolean;
  /** Use compact size (for when keyboard is visible) */
  compact?: boolean;
  /**
   * Enable extended tracking mode (default: false).
   * When false, cursor movement only registers while touch is within trackpad bounds.
   * When true, cursor continues tracking even if touch moves outside trackpad area.
   */
  extendedTracking?: boolean;
  /**
   * Enable sticky click / drag hold mode (default: false).
   * When enabled, lifting finger during drag maintains click state for 800ms,
   * allowing repositioning finger to continue dragging (useful for menu navigation).
   */
  stickyClickEnabled?: boolean;
  /**
   * Callback when cursor position changes (for overlay rendering on touch devices).
   */
  onCursorMove?: CursorMoveCallback;
}

export function Trackpad({
  inputBuffer,
  screenWidth = 640,
  screenHeight = 480,
  sensitivity = 1.5,
  hapticSound = true,
  hapticVisual = true,
  onScroll,
  enabled = true,
  compact = false,
  extendedTracking = false,
  stickyClickEnabled = false,
  onCursorMove,
}: TrackpadProps) {
  const trackpadRef = useRef<HTMLDivElement>(null);
  const handlerRef = useRef<TrackpadHandler | null>(null);
  const hapticsRef = useRef<TrackpadHaptics | null>(null);

  const [isTouching, setIsTouching] = useState(false);
  const [isDragHeld, setIsDragHeld] = useState(false);

  // Initialize haptics
  useEffect(() => {
    hapticsRef.current = new TrackpadHaptics({
      sound: hapticSound,
      visual: hapticVisual,
    });

    return () => {
      hapticsRef.current?.dispose();
      hapticsRef.current = null;
    };
  }, [hapticSound, hapticVisual]);

  // Update haptics element reference
  useEffect(() => {
    if (hapticsRef.current && trackpadRef.current) {
      hapticsRef.current.setElement(trackpadRef.current);
    }
  }, []);

  // Handle scroll - forward to emulator or handle internally
  const handleScroll = useCallback((deltaX: number, deltaY: number) => {
    if (onScroll) {
      onScroll(deltaX, deltaY);
    }
    // Could also implement keyboard arrow key injection for scroll here
  }, [onScroll]);

  // Handle haptic feedback
  const handleHaptic = useCallback((type: 'tap' | 'release' | 'hold' | 'resume') => {
    if (hapticsRef.current) {
      if (type === 'tap' || type === 'resume') {
        hapticsRef.current.triggerPress();
      } else if (type === 'release') {
        hapticsRef.current.triggerRelease();
      } else if (type === 'hold') {
        // Subtle feedback for hold state - lighter tap
        hapticsRef.current.triggerTap();
      }
    }
  }, []);

  // Handle drag hold state changes
  const handleDragHold: DragHoldCallback = useCallback((isHeld: boolean) => {
    setIsDragHeld(isHeld);
  }, []);

  // Create and attach trackpad handler
  useEffect(() => {
    if (!enabled || !inputBuffer || !trackpadRef.current) {
      if (handlerRef.current) {
        handlerRef.current.detach();
        handlerRef.current = null;
      }
      return;
    }

    const handler = new TrackpadHandler(
      inputBuffer,
      { sensitivity, extendedTracking, stickyClickEnabled },
      handleScroll,
      handleHaptic,
      handleDragHold
    );

    handler.setScreenBounds(screenWidth, screenHeight);
    if (onCursorMove) {
      handler.setOnCursorMove(onCursorMove);
    }
    handler.attach(trackpadRef.current);
    handlerRef.current = handler;

    // Set up touch state tracking and context menu prevention
    const trackpad = trackpadRef.current;
    const onPointerDown = () => setIsTouching(true);
    const onPointerUp = () => setIsTouching(false);
    const onPointerCancel = () => setIsTouching(false);

    // Prevent iOS context menu / callout
    const preventContextMenu = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    // Prevent text selection on touch
    const preventSelection = (e: Event) => {
      e.preventDefault();
    };

    // Prevent iOS Safari gesture events (pinch, rotate) that trigger context menus
    const preventGesture = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Prevent 3D Touch / Haptic Touch force events (triggers iOS magnifying glass)
    const preventForceTouch = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    trackpad.addEventListener('pointerdown', onPointerDown);
    trackpad.addEventListener('pointerup', onPointerUp);
    trackpad.addEventListener('pointercancel', onPointerCancel);
    trackpad.addEventListener('contextmenu', preventContextMenu, { passive: false });
    trackpad.addEventListener('selectstart', preventSelection, { passive: false });

    // iOS Safari gesture prevention
    trackpad.addEventListener('gesturestart', preventGesture, { passive: false });
    trackpad.addEventListener('gesturechange', preventGesture, { passive: false });
    trackpad.addEventListener('gestureend', preventGesture, { passive: false });

    // iOS 3D Touch / Haptic Touch prevention (helps prevent magnifying glass)
    trackpad.addEventListener('touchforcechange', preventForceTouch, { passive: false });
    trackpad.addEventListener('webkitmouseforcedown', preventForceTouch, { passive: false });
    trackpad.addEventListener('webkitmouseforceup', preventForceTouch, { passive: false });
    trackpad.addEventListener('webkitmouseforcechanged', preventForceTouch, { passive: false });

    return () => {
      handler.detach();
      handlerRef.current = null;

      trackpad.removeEventListener('pointerdown', onPointerDown);
      trackpad.removeEventListener('pointerup', onPointerUp);
      trackpad.removeEventListener('pointercancel', onPointerCancel);
      trackpad.removeEventListener('contextmenu', preventContextMenu);
      trackpad.removeEventListener('selectstart', preventSelection);
      trackpad.removeEventListener('gesturestart', preventGesture);
      trackpad.removeEventListener('gesturechange', preventGesture);
      trackpad.removeEventListener('gestureend', preventGesture);
      trackpad.removeEventListener('touchforcechange', preventForceTouch);
      trackpad.removeEventListener('webkitmouseforcedown', preventForceTouch);
      trackpad.removeEventListener('webkitmouseforceup', preventForceTouch);
      trackpad.removeEventListener('webkitmouseforcechanged', preventForceTouch);
    };
  }, [enabled, inputBuffer, sensitivity, extendedTracking, stickyClickEnabled, screenWidth, screenHeight, handleScroll, handleHaptic, handleDragHold]);

  // Update screen bounds when they change
  useEffect(() => {
    if (handlerRef.current) {
      handlerRef.current.setScreenBounds(screenWidth, screenHeight);
    }
  }, [screenWidth, screenHeight]);

  // Update sensitivity when it changes
  useEffect(() => {
    if (handlerRef.current) {
      handlerRef.current.setSensitivity(sensitivity);
    }
  }, [sensitivity]);

  // Update sticky click when it changes
  useEffect(() => {
    if (handlerRef.current) {
      handlerRef.current.setStickyClickEnabled(stickyClickEnabled);
    }
  }, [stickyClickEnabled]);

  // Update cursor move callback when it changes
  useEffect(() => {
    if (handlerRef.current) {
      handlerRef.current.setOnCursorMove(onCursorMove ?? null);
    }
  }, [onCursorMove]);

  return (
    <div
      ref={trackpadRef}
      className={`trackpad ${isTouching ? 'trackpad--touching' : ''} ${!enabled ? 'trackpad--disabled' : ''} ${compact ? 'trackpad--compact' : ''} ${isDragHeld ? 'trackpad--drag-held' : ''}`}
      data-drag-held={isDragHeld ? 'true' : undefined}
      role="application"
      aria-label="Trackpad - use gestures to control the cursor"
      tabIndex={enabled ? 0 : -1}
    >
      <div className="trackpad__surface" />
    </div>
  );
}
