/**
 * PointerHandler - Unified mouse/touch input handling using Pointer Events API
 *
 * Features:
 * - W3C Pointer Events API for unified mouse/touch/pen handling
 * - Gesture recognition for touch (tap, long-press, drag, double-tap)
 * - Two-finger pan for viewport scrolling
 * - Pointer capture during drag operations
 * - Coordinate translation relative to canvas
 * - Long-press triggers Ctrl+Click (right-click context menu on Mac)
 */

import { GestureRecognizer } from './GestureRecognizer';
import type { InputHandler, InputBufferWriter, PointerHandlerConfig, Point, GestureEvent } from './types';

/** Callback for viewport pan events (two-finger gesture) */
export type PanCallback = (deltaX: number, deltaY: number) => void;

/** Callback for pinch-to-zoom events (returns scale factor relative to last frame) */
export type ZoomCallback = (scale: number) => void;

export class PointerHandler implements InputHandler {
  private element: HTMLElement | null = null;
  private bufferWriter: InputBufferWriter;
  private config: Required<PointerHandlerConfig>;
  private onPan: PanCallback | null = null;
  private onZoom: ZoomCallback | null = null;

  private gestureRecognizer: GestureRecognizer;
  private attached = false;

  // Track button state for mouse events
  private buttonState = 0;

  // Track pending timers for cleanup on detach
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  // Multi-pointer tracking for two-finger pan and pinch-to-zoom
  private activePointers: Map<number, Point> = new Map();
  private isPanning = false;
  private lastPanCenter: Point | null = null;
  private lastPinchDistance: number | null = null;

  // Canvas dimensions for coordinate scaling (when CSS-scaled)
  private canvasWidth: number = 0;
  private canvasHeight: number = 0;

  // Glide mode: single-finger touch pans instead of cursor movement
  private glideMode = false;
  private lastGlidePosition: Point | null = null;

  // Bound handlers for cleanup
  private handlePointerDown: (e: PointerEvent) => void;
  private handlePointerMove: (e: PointerEvent) => void;
  private handlePointerUp: (e: PointerEvent) => void;
  private handlePointerCancel: (e: PointerEvent) => void;
  private handleContextMenu: (e: Event) => void;

  constructor(bufferWriter: InputBufferWriter, config: PointerHandlerConfig = {}, onPan?: PanCallback, onZoom?: ZoomCallback) {
    this.bufferWriter = bufferWriter;
    this.config = {
      enableGestures: config.enableGestures ?? true,
      captureOnDrag: config.captureOnDrag ?? true,
      gestureThresholds: config.gestureThresholds ?? {},
    };
    this.onPan = onPan ?? null;
    this.onZoom = onZoom ?? null;

    // Create gesture recognizer
    this.gestureRecognizer = new GestureRecognizer(
      this.handleGesture.bind(this),
      this.config.gestureThresholds
    );

    // Bind handlers
    this.handlePointerDown = this.onPointerDown.bind(this);
    this.handlePointerMove = this.onPointerMove.bind(this);
    this.handlePointerUp = this.onPointerUp.bind(this);
    this.handlePointerCancel = this.onPointerCancel.bind(this);
    this.handleContextMenu = this.onContextMenu.bind(this);
  }

  attach(element: HTMLElement | Window): void {
    if (this.attached) return;
    if (element === window) {
      throw new Error('PointerHandler must be attached to an element, not window');
    }

    this.element = element as HTMLElement;

    // Pointer events on the element
    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerCancel);
    this.element.addEventListener('contextmenu', this.handleContextMenu);

    // Prevent default touch actions (scroll, zoom) for better touch handling
    this.element.style.touchAction = 'none';

    this.attached = true;
  }

  detach(): void {
    if (!this.attached || !this.element) return;

    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerCancel);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);

    this.element.style.touchAction = '';
    this.element = null;
    this.attached = false;
    this.reset();
  }

  reset(): void {
    this.gestureRecognizer.reset();
    this.buttonState = 0;
    // Clear all pending timers
    for (const timerId of this.pendingTimers) {
      clearTimeout(timerId);
    }
    this.pendingTimers.clear();
    // Clear multi-pointer state
    this.activePointers.clear();
    this.isPanning = false;
    this.lastPanCenter = null;
    this.lastPinchDistance = null;
    // Release all mouse buttons
    this.bufferWriter.writeMouseButton(0, false);
    this.bufferWriter.writeMouseButton(1, false);
  }

  /**
   * Set or update the pan callback.
   */
  setOnPan(callback: PanCallback | null): void {
    this.onPan = callback;
  }

  /**
   * Set or update the zoom callback.
   */
  setOnZoom(callback: ZoomCallback | null): void {
    this.onZoom = callback;
  }

  /**
   * Set the native canvas dimensions for coordinate scaling.
   * When the canvas is CSS-scaled, this ensures input coordinates
   * are correctly translated to canvas coordinates.
   */
  setCanvasDimensions(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * Enable or disable glide mode.
   * In glide mode, single-finger touch pans the viewport instead of moving the cursor.
   * All clicks must come from the trackpad when in glide mode.
   */
  setGlideMode(enabled: boolean): void {
    this.glideMode = enabled;
    if (!enabled) {
      this.lastGlidePosition = null;
    }
  }

  /**
   * Check if glide mode is enabled.
   */
  isGlideModeEnabled(): boolean {
    return this.glideMode;
  }

  /**
   * Check if currently in two-finger pan mode.
   */
  isPanActive(): boolean {
    return this.isPanning;
  }

  /**
   * Calculate the center point between all active pointers.
   */
  private calculatePanCenter(): Point {
    if (this.activePointers.size === 0) {
      return { x: 0, y: 0 };
    }
    let sumX = 0;
    let sumY = 0;
    for (const pos of this.activePointers.values()) {
      sumX += pos.x;
      sumY += pos.y;
    }
    return {
      x: sumX / this.activePointers.size,
      y: sumY / this.activePointers.size,
    };
  }

  /**
   * Schedule a timer that is automatically tracked and cleaned up on detach.
   */
  private scheduleTimer(callback: () => void, delay: number): void {
    const timerId = setTimeout(() => {
      this.pendingTimers.delete(timerId);
      callback();
    }, delay);
    this.pendingTimers.add(timerId);
  }

  /**
   * Check if touch input is currently active.
   */
  isTouchActive(): boolean {
    return this.gestureRecognizer.isTouchActive();
  }

  /**
   * Get the position relative to the element, scaled to native canvas coordinates.
   * When the canvas is CSS-scaled (displayed at a different size than its native
   * resolution), this method converts physical screen coordinates to canvas coordinates.
   */
  private getRelativePosition(event: PointerEvent): Point {
    if (!this.element) return { x: 0, y: 0 };

    const rect = this.element.getBoundingClientRect();

    // Physical position within displayed element
    const physicalX = event.clientX - rect.left;
    const physicalY = event.clientY - rect.top;

    // If canvas dimensions are set, scale to native coordinates
    if (this.canvasWidth > 0 && this.canvasHeight > 0) {
      const scaleX = this.canvasWidth / rect.width;
      const scaleY = this.canvasHeight / rect.height;

      return {
        x: Math.round(physicalX * scaleX),
        y: Math.round(physicalY * scaleY),
      };
    }

    // Fallback to unscaled (assume 1:1)
    return {
      x: Math.round(physicalX),
      y: Math.round(physicalY),
    };
  }

  private onPointerDown(event: PointerEvent): void {
    event.preventDefault();

    // preventDefault (above) drives the emulated Mac's cursor but also suppresses
    // the browser's native click-to-focus. Restore it explicitly so typing always
    // works right after clicking the Mac: the keydown listener lives on `window`,
    // so the canvas (tabIndex=0) must hold focus, and inside an embedded iframe
    // (e.g. dialtone.live/quick) the parent can't see these clicks to refocus us.
    // Mouse/pen only - on touch, typing goes through the virtual-keyboard input,
    // and stealing focus to the canvas would dismiss the soft keyboard.
    // preventScroll keeps a larger-than-viewport, now-scrollable shell from jumping.
    if (event.pointerType !== 'touch') {
      this.element?.focus({ preventScroll: true });
    }

    const position = this.getRelativePosition(event);

    if (event.pointerType === 'touch') {
      // Track this pointer
      this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      // If we now have 2+ pointers, enter pan mode
      if (this.activePointers.size >= 2) {
        // Cancel any ongoing single-finger gesture
        this.gestureRecognizer.reset();
        this.lastGlidePosition = null; // Exit glide pan if multi-finger
        this.isPanning = true;
        this.lastPanCenter = this.calculatePanCenter();
        return;
      }

      // Single finger in glide mode: start glide panning
      if (this.glideMode) {
        this.lastGlidePosition = { x: event.clientX, y: event.clientY };
        return;
      }

      // Single finger: let gesture recognizer handle it
      if (this.config.enableGestures) {
        this.gestureRecognizer.onPointerDown(event, position);
      }
    } else {
      // Mouse/pen: direct button handling
      this.handleMouseDown(event, position);
    }
  }

  private onPointerMove(event: PointerEvent): void {
    event.preventDefault();

    const position = this.getRelativePosition(event);

    if (event.pointerType === 'touch') {
      // Update this pointer's position
      if (this.activePointers.has(event.pointerId)) {
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      // If in pan mode (2+ fingers), calculate pan delta and pinch zoom
      if (this.isPanning && this.activePointers.size >= 2) {
        const pointers = Array.from(this.activePointers.values());

        // Calculate pinch-to-zoom (distance between first two fingers)
        if (pointers.length >= 2 && this.onZoom) {
          const p1 = pointers[0];
          const p2 = pointers[1];
          const distance = Math.hypot(p2.x - p1.x, p2.y - p1.y);

          if (this.lastPinchDistance !== null) {
            const scale = distance / this.lastPinchDistance;
            // Only emit zoom if scale changed significantly (avoid micro-jitter)
            if (Math.abs(scale - 1) > 0.01) {
              this.onZoom(scale);
            }
          }
          this.lastPinchDistance = distance;
        }

        // Calculate pan delta
        if (this.onPan) {
          const newCenter = this.calculatePanCenter();
          if (this.lastPanCenter) {
            const deltaX = newCenter.x - this.lastPanCenter.x;
            const deltaY = newCenter.y - this.lastPanCenter.y;
            this.onPan(deltaX, deltaY);
          }
          this.lastPanCenter = newCenter;
        }
        return;
      }

      // Single finger in glide mode: pan the viewport
      if (this.glideMode && this.lastGlidePosition && this.activePointers.size === 1) {
        const currentPos = { x: event.clientX, y: event.clientY };
        const deltaX = currentPos.x - this.lastGlidePosition.x;
        const deltaY = currentPos.y - this.lastGlidePosition.y;
        this.lastGlidePosition = currentPos;
        if (this.onPan) {
          this.onPan(deltaX, deltaY);
        }
        return;
      }

      // Single finger: let gesture recognizer handle it
      if (this.config.enableGestures && !this.isPanning) {
        this.gestureRecognizer.onPointerMove(event, position);
      }
    } else {
      // Always update mouse position for mouse/pen
      this.bufferWriter.writeMousePosition(position.x, position.y);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    event.preventDefault();

    const position = this.getRelativePosition(event);

    if (event.pointerType === 'touch') {
      // Remove this pointer
      this.activePointers.delete(event.pointerId);

      // If we drop below 2 pointers, exit pan mode
      if (this.activePointers.size < 2 && this.isPanning) {
        this.isPanning = false;
        this.lastPanCenter = null;
        this.lastPinchDistance = null;
        // Release any held buttons when exiting pan mode to prevent sticky mouse
        this.bufferWriter.writeMouseButton(0, false);
        this.bufferWriter.writeMouseButton(1, false);
        // Don't forward to gesture recognizer - the pan gesture is complete
        return;
      }

      // Glide mode: just clear state, no click
      if (this.glideMode && this.lastGlidePosition) {
        this.lastGlidePosition = null;
        return;
      }

      // Single finger up: let gesture recognizer handle it
      if (this.config.enableGestures && !this.isPanning) {
        this.gestureRecognizer.onPointerUp(event, position);
      }
    } else {
      // Mouse/pen: direct button handling
      this.handleMouseUp(event, position);
    }

    // Release pointer capture
    if (this.element && this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    if (event.pointerType === 'touch') {
      // Remove this pointer
      this.activePointers.delete(event.pointerId);

      // Exit pan mode if needed
      if (this.activePointers.size < 2) {
        this.isPanning = false;
        this.lastPanCenter = null;
        this.lastPinchDistance = null;
      }

      if (this.config.enableGestures) {
        this.gestureRecognizer.onPointerCancel(event);
      }
    }

    // Release all buttons on cancel
    this.buttonState = 0;
    this.bufferWriter.writeMouseButton(0, false);
    this.bufferWriter.writeMouseButton(1, false);

    // Release pointer capture
    if (this.element && this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
  }

  private onContextMenu(event: Event): void {
    // Prevent context menu to allow right-click handling
    event.preventDefault();
  }

  private handleMouseDown(event: PointerEvent, position: Point): void {
    // Update position
    this.bufferWriter.writeMousePosition(position.x, position.y);

    // Handle buttons
    // button: 0 = primary (left), 1 = middle, 2 = secondary (right)
    if (event.button === 0) {
      this.buttonState |= 1;
      this.bufferWriter.writeMouseButton(0, true);
    } else if (event.button === 2) {
      this.buttonState |= 2;
      this.bufferWriter.writeMouseButton(1, true);
    }

    // Capture pointer for drag
    if (this.config.captureOnDrag && this.element) {
      this.element.setPointerCapture(event.pointerId);
    }
  }

  private handleMouseUp(event: PointerEvent, position: Point): void {
    // Update position
    this.bufferWriter.writeMousePosition(position.x, position.y);

    // Handle buttons
    if (event.button === 0) {
      this.buttonState &= ~1;
      this.bufferWriter.writeMouseButton(0, false);
    } else if (event.button === 2) {
      this.buttonState &= ~2;
      this.bufferWriter.writeMouseButton(1, false);
    }
  }

  private handleGesture(gesture: GestureEvent): void {
    const { type, position, startPosition } = gesture;

    switch (type) {
      case 'tap':
        // Single click at position
        this.bufferWriter.writeMousePosition(position.x, position.y);
        this.bufferWriter.writeMouseButton(0, true);
        // Release after a short delay
        this.scheduleTimer(() => {
          this.bufferWriter.writeMouseButton(0, false);
        }, 50);
        break;

      case 'double-tap':
        // Double-click: two quick clicks
        this.bufferWriter.writeMousePosition(position.x, position.y);
        this.bufferWriter.writeMouseButton(0, true);
        this.scheduleTimer(() => {
          this.bufferWriter.writeMouseButton(0, false);
          this.scheduleTimer(() => {
            this.bufferWriter.writeMouseButton(0, true);
            this.scheduleTimer(() => {
              this.bufferWriter.writeMouseButton(0, false);
            }, 50);
          }, 50);
        }, 50);
        break;

      case 'long-press':
        // Disabled: Long-press right-click removed from mobile UX.
        // Right-click available via two-finger tap on trackpad.
        break;

      case 'drag-start':
        // Mouse down at start position
        if (startPosition) {
          this.bufferWriter.writeMousePosition(startPosition.x, startPosition.y);
        }
        this.bufferWriter.writeMouseButton(0, true);

        // Capture pointer
        if (this.config.captureOnDrag && this.element) {
          this.element.setPointerCapture(gesture.originalEvent.pointerId);
        }
        break;

      case 'drag-move':
        // Update position during drag
        this.bufferWriter.writeMousePosition(position.x, position.y);
        break;

      case 'drag-end':
        // Mouse up at end position
        this.bufferWriter.writeMousePosition(position.x, position.y);
        this.bufferWriter.writeMouseButton(0, false);

        // Release pointer
        if (this.element && this.element.hasPointerCapture(gesture.originalEvent.pointerId)) {
          this.element.releasePointerCapture(gesture.originalEvent.pointerId);
        }
        break;
    }
  }
}
