/**
 * TrackpadHandler - Touch input handling for the laptop-style trackpad
 *
 * Translates trackpad touch gestures into emulator mouse input.
 * Unlike PointerHandler (which uses absolute screen positions),
 * TrackpadHandler uses relative movement like a real laptop trackpad.
 *
 * Supported gestures:
 * - Single tap: Left click
 * - Two-finger tap: Right click (Ctrl+click)
 * - One-finger drag: Move cursor (relative deltas)
 * - Two-finger vertical drag: Scroll wheel
 * - Two-finger horizontal drag: Horizontal scroll
 * - Tap + hold (100ms) + drag: Click-and-drag
 * - Double-tap: Double-click
 */

import { TrackpadThresholds, Modifiers } from './constants';
import type { InputHandler, InputBufferWriter, Point } from './types';

/** Callback for scroll events */
export type ScrollCallback = (deltaX: number, deltaY: number) => void;

/** Callback for haptic feedback */
export type HapticCallback = (type: 'tap' | 'release' | 'hold' | 'resume') => void;

/** Callback for drag hold state changes */
export type DragHoldCallback = (isHeld: boolean) => void;

/** Callback for cursor position changes (for overlay rendering on touch devices) */
export type CursorMoveCallback = (x: number, y: number) => void;

/** Trackpad configuration options */
export interface TrackpadConfig {
  /** Cursor movement sensitivity multiplier (default: 1.5) */
  sensitivity?: number;
  /** Scroll speed multiplier (default: 2.0) */
  scrollSpeed?: number;
  /** Whether to enable haptic feedback callbacks (default: true) */
  enableHaptics?: boolean;
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
}

/** Trackpad gesture types */
export type TrackpadGestureType =
  | 'tap'
  | 'double-tap'
  | 'two-finger-tap'
  | 'drag-start'
  | 'drag-move'
  | 'drag-end'
  | 'scroll';

/** Internal touch state */
interface TouchState {
  pointerId: number;
  startTime: number;
  startPosition: Point;
  currentPosition: Point;
}

export class TrackpadHandler implements InputHandler {
  private element: HTMLElement | null = null;
  private bufferWriter: InputBufferWriter;
  private config: Required<TrackpadConfig>;
  private onScroll: ScrollCallback | null = null;
  private onHaptic: HapticCallback | null = null;
  private onDragHold: DragHoldCallback | null = null;
  private onCursorMove: CursorMoveCallback | null = null;

  private attached = false;

  // Track active touches
  private activePointers: Map<number, TouchState> = new Map();

  // Gesture state
  private isDragging = false;
  private isScrolling = false;
  private dragStartScheduled = false;
  private dragStartTimer: ReturnType<typeof setTimeout> | null = null;

  // Drag hold state (sticky click during menu navigation)
  private isDragHeld = false;
  private dragHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private stickyClickEnabled = false;

  // Track cursor position (virtual - not tied to screen)
  private cursorX = 320; // Start at center of 640x480
  private cursorY = 240;

  // Deferred tap for double-tap detection
  // First tap is held for TAP_DEFER_DELAY ms to see if second tap comes
  private pendingTap: { position: Point; time: number } | null = null;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TAP_DEFER_DELAY = 250; // ms to wait for second tap

  // Two-finger tap detection
  private twoFingerTapPending = false;
  private twoFingerTapTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending timers for cleanup
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // RAF batching for cursor updates (reduces buffer writes to once per frame)
  private rafId: number | null = null;
  private pendingCursorWrite = false;

  // Bound handlers
  private handlePointerDown: (e: PointerEvent) => void;
  private handlePointerMove: (e: PointerEvent) => void;
  private handlePointerUp: (e: PointerEvent) => void;
  private handlePointerCancel: (e: PointerEvent) => void;
  private handlePointerLeave: (e: PointerEvent) => void;

  constructor(
    bufferWriter: InputBufferWriter,
    config: TrackpadConfig = {},
    onScroll?: ScrollCallback,
    onHaptic?: HapticCallback,
    onDragHold?: DragHoldCallback
  ) {
    this.bufferWriter = bufferWriter;
    this.config = {
      sensitivity: config.sensitivity ?? TrackpadThresholds.SENSITIVITY,
      scrollSpeed: config.scrollSpeed ?? 2.0,
      enableHaptics: config.enableHaptics ?? true,
      extendedTracking: config.extendedTracking ?? false,
      stickyClickEnabled: config.stickyClickEnabled ?? false,
    };
    this.stickyClickEnabled = this.config.stickyClickEnabled;
    this.onScroll = onScroll ?? null;
    this.onHaptic = onHaptic ?? null;
    this.onDragHold = onDragHold ?? null;

    // Bind handlers
    this.handlePointerDown = this.onPointerDown.bind(this);
    this.handlePointerMove = this.onPointerMove.bind(this);
    this.handlePointerUp = this.onPointerUp.bind(this);
    this.handlePointerCancel = this.onPointerCancel.bind(this);
    this.handlePointerLeave = this.onPointerLeave.bind(this);
  }

  /**
   * Set the scroll callback.
   */
  setOnScroll(callback: ScrollCallback | null): void {
    this.onScroll = callback;
  }

  /**
   * Set the haptic feedback callback.
   */
  setOnHaptic(callback: HapticCallback | null): void {
    this.onHaptic = callback;
  }

  /**
   * Set the drag hold callback.
   */
  setOnDragHold(callback: DragHoldCallback | null): void {
    this.onDragHold = callback;
  }

  /**
   * Set the cursor move callback (for overlay rendering on touch devices).
   */
  setOnCursorMove(callback: CursorMoveCallback | null): void {
    this.onCursorMove = callback;
  }

  /**
   * Set the cursor sensitivity.
   */
  setSensitivity(sensitivity: number): void {
    this.config.sensitivity = sensitivity;
  }

  /**
   * Enable or disable extended tracking mode.
   */
  setExtendedTracking(enabled: boolean): void {
    this.config.extendedTracking = enabled;
  }

  /**
   * Enable or disable sticky click (drag hold) mode.
   */
  setStickyClickEnabled(enabled: boolean): void {
    this.stickyClickEnabled = enabled;
    this.config.stickyClickEnabled = enabled;
  }

  /**
   * Get the current virtual cursor position.
   */
  getCursorPosition(): Point {
    return { x: this.cursorX, y: this.cursorY };
  }

  /**
   * Set the screen bounds for cursor clamping.
   */
  private screenWidth = 640;
  private screenHeight = 480;

  setScreenBounds(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    // Re-center cursor if needed
    this.cursorX = Math.min(this.cursorX, width - 1);
    this.cursorY = Math.min(this.cursorY, height - 1);
  }

  attach(element: HTMLElement | Window): void {
    if (this.attached) return;
    if (element === window) {
      throw new Error('TrackpadHandler must be attached to an element, not window');
    }

    this.element = element as HTMLElement;

    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerCancel);
    this.element.addEventListener('pointerleave', this.handlePointerLeave);

    // Prevent default touch behaviors
    this.element.style.touchAction = 'none';

    this.attached = true;
  }

  detach(): void {
    if (!this.attached || !this.element) return;

    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerCancel);
    this.element.removeEventListener('pointerleave', this.handlePointerLeave);

    this.element.style.touchAction = '';
    this.element = null;
    this.attached = false;
    this.reset();
  }

  reset(): void {
    // Clear all timers
    for (const timerId of this.pendingTimers) {
      clearTimeout(timerId);
    }
    this.pendingTimers.clear();

    if (this.dragStartTimer) {
      clearTimeout(this.dragStartTimer);
      this.dragStartTimer = null;
    }

    if (this.twoFingerTapTimer) {
      clearTimeout(this.twoFingerTapTimer);
      this.twoFingerTapTimer = null;
    }

    if (this.dragHoldTimer) {
      clearTimeout(this.dragHoldTimer);
      this.dragHoldTimer = null;
    }

    // Cancel any pending tap
    this.cancelPendingTap();

    // Cancel pending RAF
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingCursorWrite = false;

    // Clear state
    this.activePointers.clear();
    this.isDragging = false;
    this.isScrolling = false;
    this.dragStartScheduled = false;
    this.twoFingerTapPending = false;
    this.isDragHeld = false;

    // Notify drag hold ended
    if (this.onDragHold) {
      this.onDragHold(false);
    }

    // Release any held buttons
    this.bufferWriter.writeMouseButton(0, false);
    this.bufferWriter.writeMouseButton(1, false);
    this.bufferWriter.writeModifiers(0);
  }

  /**
   * Schedule a timer that is tracked for cleanup.
   */
  private scheduleTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timerId = setTimeout(() => {
      this.pendingTimers.delete(timerId);
      callback();
    }, delay);
    this.pendingTimers.add(timerId);
    return timerId;
  }

  /**
   * Calculate distance between two points.
   */
  private calculateDistance(p1: Point, p2: Point): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Check if a point is within the trackpad element bounds.
   */
  private isWithinBounds(clientX: number, clientY: number): boolean {
    if (!this.element) return false;
    const rect = this.element.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  /**
   * Trigger haptic feedback.
   */
  private triggerHaptic(type: 'tap' | 'release' | 'hold' | 'resume'): void {
    if (this.config.enableHaptics && this.onHaptic) {
      this.onHaptic(type);
    }
  }

  /**
   * Apply non-linear acceleration curve to cursor movement.
   * Slow movements stay precise, fast movements are amplified.
   * This mimics native trackpad acceleration behavior.
   */
  private accelerate(delta: number): number {
    const sign = Math.sign(delta);
    const magnitude = Math.abs(delta);
    // Use power curve: slow movements (< 1px) stay linear,
    // fast movements get amplified with exponent 1.3
    const accelerated = Math.pow(magnitude, 1.3) * this.config.sensitivity;
    return sign * accelerated;
  }

  /**
   * Update cursor position with deltas.
   * Uses acceleration curve and RAF batching for smooth performance.
   */
  private moveCursor(deltaX: number, deltaY: number): void {
    // Apply non-linear acceleration curve
    const scaledDeltaX = this.accelerate(deltaX);
    const scaledDeltaY = this.accelerate(deltaY);

    // Update cursor position with clamping
    this.cursorX = Math.max(0, Math.min(this.screenWidth - 1, this.cursorX + scaledDeltaX));
    this.cursorY = Math.max(0, Math.min(this.screenHeight - 1, this.cursorY + scaledDeltaY));

    // Notify listener of cursor position (for overlay rendering on touch devices)
    if (this.onCursorMove) {
      this.onCursorMove(Math.round(this.cursorX), Math.round(this.cursorY));
    }

    // Schedule buffer write via RAF (batches multiple moves per frame)
    this.pendingCursorWrite = true;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        if (this.pendingCursorWrite) {
          this.bufferWriter.writeMousePosition(Math.round(this.cursorX), Math.round(this.cursorY));
          this.pendingCursorWrite = false;
        }
        this.rafId = null;
      });
    }
  }

  /**
   * Flush any pending cursor position immediately.
   * Called before click events to ensure cursor is at correct position.
   */
  private flushCursorPosition(): void {
    if (this.pendingCursorWrite) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.bufferWriter.writeMousePosition(Math.round(this.cursorX), Math.round(this.cursorY));
      this.pendingCursorWrite = false;
    }
  }

  /**
   * Handle scroll gesture.
   */
  private handleScroll(deltaX: number, deltaY: number): void {
    if (this.onScroll) {
      this.onScroll(
        deltaX * this.config.scrollSpeed,
        deltaY * this.config.scrollSpeed
      );
    }
  }

  /**
   * Cancel any pending tap without sending it.
   * Used when double-tap is detected or on reset.
   */
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
      // Send the deferred single click
      this.flushCursorPosition();
      this.bufferWriter.writeMouseButton(0, true);
      this.triggerHaptic('tap');
      this.scheduleTimer(() => {
        this.bufferWriter.writeMouseButton(0, false);
        this.triggerHaptic('release');
      }, 50);
      this.pendingTap = null;
    }
  }

  private onPointerDown(event: PointerEvent): void {
    event.preventDefault();

    // Only handle touch events on the trackpad
    if (event.pointerType !== 'touch') return;

    const position: Point = { x: event.clientX, y: event.clientY };

    // Check if we're resuming from a held drag state
    if (this.isDragHeld && this.activePointers.size === 0) {
      // Clear the hold timer since finger is back
      if (this.dragHoldTimer) {
        clearTimeout(this.dragHoldTimer);
        this.dragHoldTimer = null;
      }

      // Resume dragging seamlessly (button is already pressed)
      this.isDragHeld = false;
      this.isDragging = true;

      // Notify drag hold ended
      if (this.onDragHold) {
        this.onDragHold(false);
      }

      // Haptic feedback for resume
      this.triggerHaptic('resume');

      // Track this pointer
      this.activePointers.set(event.pointerId, {
        pointerId: event.pointerId,
        startTime: Date.now(),
        startPosition: { ...position },
        currentPosition: { ...position },
      });

      return;
    }

    // Track this pointer
    this.activePointers.set(event.pointerId, {
      pointerId: event.pointerId,
      startTime: Date.now(),
      startPosition: { ...position },
      currentPosition: { ...position },
    });

    // Check for two-finger tap potential
    if (this.activePointers.size === 2) {
      // Cancel any single-finger gestures
      if (this.dragStartTimer) {
        clearTimeout(this.dragStartTimer);
        this.dragStartTimer = null;
        this.dragStartScheduled = false;
      }

      // Two-finger tap during drag hold = immediate cancel
      if (this.isDragHeld) {
        this.cancelDragHold();
        return;
      }

      // Start two-finger tap detection
      this.twoFingerTapPending = true;
      if (this.twoFingerTapTimer) {
        clearTimeout(this.twoFingerTapTimer);
      }
      this.twoFingerTapTimer = setTimeout(() => {
        // If both fingers are still down after the window, it's not a tap
        this.twoFingerTapPending = false;
        this.twoFingerTapTimer = null;
      }, TrackpadThresholds.TWO_FINGER_TAP_WINDOW + 100);

      // Enter scroll mode
      this.isScrolling = true;
      return;
    }

    // Single finger - schedule drag-start after delay
    if (this.activePointers.size === 1) {
      this.dragStartScheduled = true;
      this.dragStartTimer = setTimeout(() => {
        if (this.dragStartScheduled && this.activePointers.size === 1) {
          // Start drag mode (click-and-hold)
          this.isDragging = true;
          // Flush any pending cursor position before clicking
          this.flushCursorPosition();
          this.bufferWriter.writeMouseButton(0, true);
          this.triggerHaptic('tap');
        }
        this.dragStartTimer = null;
      }, TrackpadThresholds.DRAG_START_DELAY);
    }
  }

  private onPointerMove(event: PointerEvent): void {
    event.preventDefault();

    if (event.pointerType !== 'touch') return;

    const touch = this.activePointers.get(event.pointerId);
    if (!touch) return;

    // Use coalesced events for smoother cursor tracking
    // This processes all intermediate points the browser captured between frames
    const events = event.getCoalescedEvents?.() || [event];

    let totalDeltaX = 0;
    let totalDeltaY = 0;
    let lastPosition = touch.currentPosition;

    for (const e of events) {
      const newPosition: Point = { x: e.clientX, y: e.clientY };
      totalDeltaX += newPosition.x - lastPosition.x;
      totalDeltaY += newPosition.y - lastPosition.y;
      lastPosition = newPosition;
    }

    // Update tracked position to final position
    touch.currentPosition = { ...lastPosition };

    // Check movement threshold using final position
    const totalMovement = this.calculateDistance(touch.startPosition, lastPosition);

    // Two-finger scroll
    if (this.activePointers.size >= 2 && this.isScrolling) {
      // Cancel two-finger tap if movement detected
      if (totalMovement > TrackpadThresholds.SCROLL_THRESHOLD) {
        this.twoFingerTapPending = false;
      }
      this.handleScroll(-totalDeltaX, -totalDeltaY); // Invert for natural scrolling
      return;
    }

    // Single finger movement
    if (this.activePointers.size === 1) {
      // Cancel drag-start if we move too much before delay
      if (totalMovement > TrackpadThresholds.TAP_MOVEMENT && !this.isDragging) {
        if (this.dragStartTimer) {
          clearTimeout(this.dragStartTimer);
          this.dragStartTimer = null;
        }
        this.dragStartScheduled = false;
      }

      // Only move cursor if within bounds (or extendedTracking is enabled)
      const withinBounds = this.isWithinBounds(event.clientX, event.clientY);
      if (withinBounds || this.config.extendedTracking) {
        this.moveCursor(totalDeltaX, totalDeltaY);
      }
    }
  }

  private onPointerUp(event: PointerEvent): void {
    event.preventDefault();

    if (event.pointerType !== 'touch') return;

    const touch = this.activePointers.get(event.pointerId);
    if (!touch) return;

    const duration = Date.now() - touch.startTime;
    const movement = this.calculateDistance(touch.startPosition, touch.currentPosition);

    // Remove this pointer
    this.activePointers.delete(event.pointerId);

    // Check for two-finger tap
    if (this.twoFingerTapPending && this.activePointers.size <= 1) {
      // Both fingers released quickly with little movement
      if (duration < TrackpadThresholds.TAP_DURATION && movement < TrackpadThresholds.TAP_MOVEMENT) {
        // Right-click (Ctrl+click)
        this.flushCursorPosition();
        this.bufferWriter.writeModifiers(Modifiers.CTRL);
        this.bufferWriter.writeMouseButton(0, true);
        this.triggerHaptic('tap');
        this.scheduleTimer(() => {
          this.bufferWriter.writeMouseButton(0, false);
          this.bufferWriter.writeModifiers(0);
          this.triggerHaptic('release');
        }, 50);

        this.twoFingerTapPending = false;
        if (this.twoFingerTapTimer) {
          clearTimeout(this.twoFingerTapTimer);
          this.twoFingerTapTimer = null;
        }
        return;
      }
    }

    // Exit scroll mode
    if (this.activePointers.size < 2) {
      this.isScrolling = false;
      this.twoFingerTapPending = false;
    }

    // Handle single finger up
    if (this.activePointers.size === 0) {
      // Cancel pending drag-start
      if (this.dragStartTimer) {
        clearTimeout(this.dragStartTimer);
        this.dragStartTimer = null;
        this.dragStartScheduled = false;
      }

      // End drag if active
      if (this.isDragging) {
        this.isDragging = false;

        // If sticky click is enabled, enter hold mode to allow repositioning
        // Otherwise, release click immediately
        if (this.stickyClickEnabled) {
          this.isDragHeld = true;

          // Notify component of held state
          if (this.onDragHold) {
            this.onDragHold(true);
          }

          // Haptic feedback for hold
          this.triggerHaptic('hold');

          // Start timeout - if finger doesn't return, release the click
          this.dragHoldTimer = setTimeout(() => {
            if (this.isDragHeld) {
              this.bufferWriter.writeMouseButton(0, false);
              this.triggerHaptic('release');
              this.isDragHeld = false;
              this.dragHoldTimer = null;

              // Notify drag hold ended
              if (this.onDragHold) {
                this.onDragHold(false);
              }
            }
          }, TrackpadThresholds.DRAG_HOLD_TIMEOUT);

          return;
        } else {
          // Sticky click disabled - release immediately
          this.bufferWriter.writeMouseButton(0, false);
          this.triggerHaptic('release');
          return;
        }
      }

      // Check for tap gesture
      if (duration < TrackpadThresholds.TAP_DURATION && movement < TrackpadThresholds.TAP_MOVEMENT) {
        const currentTime = Date.now();
        const currentPosition = touch.startPosition;

        // Check for double-tap using deferred tap detection
        if (
          this.pendingTap &&
          currentTime - this.pendingTap.time < TrackpadThresholds.DOUBLE_TAP_TIME &&
          this.calculateDistance(this.pendingTap.position, currentPosition) < TrackpadThresholds.DOUBLE_TAP_DISTANCE
        ) {
          // Double-tap detected - cancel pending single tap, emit double-click only
          this.cancelPendingTap();

          // Double-click: 2 clicks (not 3!)
          this.flushCursorPosition();
          this.bufferWriter.writeMouseButton(0, true);
          this.triggerHaptic('tap');
          this.scheduleTimer(() => {
            this.bufferWriter.writeMouseButton(0, false);
            this.scheduleTimer(() => {
              this.bufferWriter.writeMouseButton(0, true);
              this.scheduleTimer(() => {
                this.bufferWriter.writeMouseButton(0, false);
                this.triggerHaptic('release');
              }, 50);
            }, 50);
          }, 50);
        } else {
          // Not a double-tap yet - flush any existing pending tap, then defer this one
          this.flushPendingTap();

          // Set up this tap as the new pending tap
          this.pendingTap = { position: { ...currentPosition }, time: currentTime };

          this.pendingTapTimer = setTimeout(() => {
            if (this.pendingTap) {
              // No second tap came - send the single click now
              this.flushCursorPosition();
              this.bufferWriter.writeMouseButton(0, true);
              this.triggerHaptic('tap');
              this.scheduleTimer(() => {
                this.bufferWriter.writeMouseButton(0, false);
                this.triggerHaptic('release');
              }, 50);
              this.pendingTap = null;
            }
            this.pendingTapTimer = null;
          }, this.TAP_DEFER_DELAY);
        }
      } else {
        // Not a tap - clear any pending tap state
        this.cancelPendingTap();
      }
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;

    // Remove the pointer
    this.activePointers.delete(event.pointerId);

    // Clean up state if no pointers left
    if (this.activePointers.size === 0) {
      if (this.dragStartTimer) {
        clearTimeout(this.dragStartTimer);
        this.dragStartTimer = null;
        this.dragStartScheduled = false;
      }

      // On cancel, release any drag or drag hold immediately
      if (this.isDragging || this.isDragHeld) {
        this.bufferWriter.writeMouseButton(0, false);
        this.isDragging = false;

        if (this.isDragHeld) {
          this.isDragHeld = false;
          if (this.dragHoldTimer) {
            clearTimeout(this.dragHoldTimer);
            this.dragHoldTimer = null;
          }
          if (this.onDragHold) {
            this.onDragHold(false);
          }
        }
      }

      this.isScrolling = false;
      this.twoFingerTapPending = false;
    }

    // Exit scroll mode if needed
    if (this.activePointers.size < 2) {
      this.isScrolling = false;
    }
  }

  private onPointerLeave(event: PointerEvent): void {
    // When pointer leaves the trackpad area, handle the transition
    if (event.pointerType !== 'touch') return;

    const touch = this.activePointers.get(event.pointerId);
    if (!touch) return;

    // Don't do anything if we're already in drag hold mode
    // The user may be repositioning their finger
    if (this.isDragHeld) {
      return;
    }

    // Remove this pointer
    this.activePointers.delete(event.pointerId);

    // Cancel pending drag-start timer
    if (this.dragStartTimer) {
      clearTimeout(this.dragStartTimer);
      this.dragStartTimer = null;
      this.dragStartScheduled = false;
    }

    // If dragging when finger leaves
    if (this.isDragging && this.activePointers.size === 0) {
      this.isDragging = false;

      // If sticky click is enabled, enter hold mode to allow repositioning
      // Otherwise, release click immediately
      if (this.stickyClickEnabled) {
        this.isDragHeld = true;

        // Notify component of held state
        if (this.onDragHold) {
          this.onDragHold(true);
        }

        // Haptic feedback for hold
        this.triggerHaptic('hold');

        // Start timeout - if finger doesn't return, release the click
        this.dragHoldTimer = setTimeout(() => {
          if (this.isDragHeld) {
            this.bufferWriter.writeMouseButton(0, false);
            this.triggerHaptic('release');
            this.isDragHeld = false;
            this.dragHoldTimer = null;

            if (this.onDragHold) {
              this.onDragHold(false);
            }
          }
        }, TrackpadThresholds.DRAG_HOLD_TIMEOUT);
      } else {
        // Sticky click disabled - release immediately
        this.bufferWriter.writeMouseButton(0, false);
        this.triggerHaptic('release');
      }
    }

    // Clear other states
    if (this.activePointers.size === 0) {
      this.isScrolling = false;
      this.twoFingerTapPending = false;
      this.cancelPendingTap();
    }

    // Exit scroll mode if too few fingers
    if (this.activePointers.size < 2) {
      this.isScrolling = false;
      this.twoFingerTapPending = false;
    }
  }

  /**
   * Cancel any active drag hold immediately.
   * Call this for quick taps or two-finger taps during hold state.
   */
  cancelDragHold(): void {
    if (this.isDragHeld) {
      // Clear the timer
      if (this.dragHoldTimer) {
        clearTimeout(this.dragHoldTimer);
        this.dragHoldTimer = null;
      }

      // Release the button
      this.bufferWriter.writeMouseButton(0, false);
      this.triggerHaptic('release');
      this.isDragHeld = false;

      // Notify drag hold ended
      if (this.onDragHold) {
        this.onDragHold(false);
      }
    }
  }

  /**
   * Check if the trackpad is currently being touched.
   */
  isTouching(): boolean {
    return this.activePointers.size > 0;
  }

  /**
   * Check if a drag is in progress.
   */
  isDragActive(): boolean {
    return this.isDragging;
  }

  /**
   * Check if the click is being held for repositioning.
   */
  isDragHoldActive(): boolean {
    return this.isDragHeld;
  }

  /**
   * Check if scrolling is in progress.
   */
  isScrollActive(): boolean {
    return this.isScrolling;
  }
}
