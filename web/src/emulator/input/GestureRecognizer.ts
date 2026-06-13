/**
 * GestureRecognizer - Touch gesture recognition for the Mac emulator
 *
 * Recognizes:
 * - Tap: Quick touch < TAP_MOVEMENT px, < DOUBLE_TAP_TIME ms
 * - Double-tap: Two taps < DOUBLE_TAP_TIME ms, < DOUBLE_TAP_DISTANCE px apart
 * - Long-press: Hold > LONG_PRESS_DELAY ms without movement (triggers Ctrl+Click)
 * - Drag: Touch + movement > TAP_MOVEMENT px
 */

import { GestureThresholds } from './constants';
import type { Point, GestureType, GestureEvent, GestureThresholdsConfig } from './types';

export type GestureCallback = (event: GestureEvent) => void;

// Use Date.now() instead of now() for testability with fake timers
const now = () => Date.now();

interface TouchState {
  startTime: number;
  startPosition: Point;
  currentPosition: Point;
  pointerId: number;
  originalEvent: PointerEvent;
}

export class GestureRecognizer {
  private thresholds: GestureThresholdsConfig;
  private callback: GestureCallback;

  // Current touch state
  private currentTouch: TouchState | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  // Double-tap tracking
  private lastTapTime = 0;

  // Deferred tap for double-tap detection
  // First tap is held for TAP_DEFER_DELAY ms to see if second tap comes
  private pendingTap: { position: Point; event: PointerEvent } | null = null;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TAP_DEFER_DELAY = 250; // ms to wait for second tap

  // Drag state
  private isDragging = false;

  constructor(callback: GestureCallback, thresholds?: Partial<GestureThresholdsConfig>) {
    this.callback = callback;
    this.thresholds = {
      tapMovement: thresholds?.tapMovement ?? GestureThresholds.TAP_MOVEMENT,
      longPressDelay: thresholds?.longPressDelay ?? GestureThresholds.LONG_PRESS_DELAY,
      doubleTapTime: thresholds?.doubleTapTime ?? GestureThresholds.DOUBLE_TAP_TIME,
      doubleTapDistance: thresholds?.doubleTapDistance ?? GestureThresholds.DOUBLE_TAP_DISTANCE,
    };
  }

  /**
   * Handle pointer down event.
   */
  onPointerDown(event: PointerEvent, position: Point): void {
    // Only handle touch events
    if (event.pointerType !== 'touch') return;

    // Handle pending tap when new touch starts.
    // If new touch is far from pending tap location, flush (emit) the pending tap.
    // If close, preserve it for potential double-tap detection.
    if (this.pendingTap) {
      const distance = this.calculateDistance(this.pendingTap.position, position);
      if (distance >= this.thresholds.doubleTapDistance) {
        // Too far apart - flush the pending tap (emit it now, then clear)
        // This ensures tap at Icon A is registered before user moves to Icon B
        this.flushPendingTap();
      }
    }

    this.currentTouch = {
      startTime: now(),
      startPosition: { ...position },
      currentPosition: { ...position },
      pointerId: event.pointerId,
      originalEvent: event,
    };

    // Start long-press timer
    this.startLongPressTimer(event, position);
  }

  /**
   * Handle pointer move event.
   */
  onPointerMove(event: PointerEvent, position: Point): void {
    if (!this.currentTouch || event.pointerId !== this.currentTouch.pointerId) return;

    this.currentTouch.currentPosition = { ...position };
    this.currentTouch.originalEvent = event;

    const movement = this.calculateDistance(this.currentTouch.startPosition, position);

    // If movement exceeds threshold, cancel long-press and start drag
    if (movement > this.thresholds.tapMovement) {
      this.cancelLongPressTimer();

      if (!this.isDragging) {
        this.isDragging = true;
        this.emitGesture('drag-start', this.currentTouch.startPosition, event, this.currentTouch.startPosition);
      }

      this.emitGesture('drag-move', position, event, this.currentTouch.startPosition);
    }
  }

  /**
   * Handle pointer up event.
   */
  onPointerUp(event: PointerEvent, position: Point): void {
    if (!this.currentTouch || event.pointerId !== this.currentTouch.pointerId) return;

    this.cancelLongPressTimer();

    const duration = now() - this.currentTouch.startTime;
    const movement = this.calculateDistance(this.currentTouch.startPosition, position);

    if (this.isDragging) {
      // End drag
      this.emitGesture('drag-end', position, event, this.currentTouch.startPosition);
      this.isDragging = false;
    } else if (movement <= this.thresholds.tapMovement && duration < this.thresholds.doubleTapTime) {
      // This is a tap - check for double-tap using deferred tap detection
      const currentTime = now();
      const timeSinceLastTap = currentTime - this.lastTapTime;

      if (
        this.pendingTap &&
        timeSinceLastTap < this.thresholds.doubleTapTime &&
        this.calculateDistance(this.pendingTap.position, position) < this.thresholds.doubleTapDistance
      ) {
        // Double-tap detected - cancel pending single tap, emit double-tap only
        this.cancelPendingTap();
        this.emitGesture('double-tap', position, event);
        this.lastTapTime = 0;
      } else {
        // Not a double-tap - emit any pending tap first, then defer this one
        // This handles the case where taps are too far apart or too slow
        this.flushPendingTap();

        // Now set up this tap as the new pending tap
        this.pendingTap = { position: { ...position }, event };
        this.lastTapTime = currentTime;

        this.pendingTapTimer = setTimeout(() => {
          if (this.pendingTap) {
            this.emitGesture('tap', this.pendingTap.position, this.pendingTap.event);
            this.pendingTap = null;
          }
          this.pendingTapTimer = null;
        }, this.TAP_DEFER_DELAY);
      }
    }

    this.currentTouch = null;
  }

  /**
   * Handle pointer cancel event.
   */
  onPointerCancel(event: PointerEvent): void {
    if (!this.currentTouch || event.pointerId !== this.currentTouch.pointerId) return;

    this.cancelLongPressTimer();

    if (this.isDragging) {
      // Cancel drag
      this.emitGesture('drag-end', this.currentTouch.currentPosition, event, this.currentTouch.startPosition);
      this.isDragging = false;
    }

    this.currentTouch = null;
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.cancelLongPressTimer();
    this.cancelPendingTap();

    // If dragging, emit drag-end to release mouse button before clearing state
    if (this.isDragging && this.currentTouch) {
      this.emitGesture('drag-end', this.currentTouch.currentPosition,
                       this.currentTouch.originalEvent, this.currentTouch.startPosition);
    }

    this.currentTouch = null;
    this.isDragging = false;
    this.lastTapTime = 0;
  }

  /**
   * Check if currently in a drag operation.
   */
  isDragActive(): boolean {
    return this.isDragging;
  }

  /**
   * Check if a touch is currently active.
   */
  isTouchActive(): boolean {
    return this.currentTouch !== null;
  }

  private startLongPressTimer(_event: PointerEvent, position: Point): void {
    this.cancelLongPressTimer();

    this.longPressTimer = setTimeout(() => {
      if (this.currentTouch && !this.isDragging) {
        const movement = this.calculateDistance(this.currentTouch.startPosition, this.currentTouch.currentPosition);
        if (movement <= this.thresholds.tapMovement) {
          this.emitGesture('long-press', position, this.currentTouch.originalEvent);
          // Clear state after long-press to prevent unexpected behavior on pointer up
          this.currentTouch = null;
        }
      }
    }, this.thresholds.longPressDelay);
  }

  private cancelLongPressTimer(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private cancelPendingTap(): void {
    if (this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
    }
    this.pendingTap = null;
  }

  /**
   * Emit the pending tap immediately if one exists, then clear it.
   * Used when a new tap comes in that doesn't form a double-tap.
   */
  private flushPendingTap(): void {
    if (this.pendingTapTimer) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
    }
    if (this.pendingTap) {
      this.emitGesture('tap', this.pendingTap.position, this.pendingTap.event);
      this.pendingTap = null;
    }
  }

  private emitGesture(
    type: GestureType,
    position: Point,
    event: PointerEvent,
    startPosition?: Point
  ): void {
    this.callback({
      type,
      position,
      startPosition,
      originalEvent: event,
    });
  }

  private calculateDistance(p1: Point, p2: Point): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
