/**
 * VolumeKnob - Rotary volume control with visual indicator
 *
 * A satisfying knob control that mimics classic hardware volume dials.
 * Features:
 * - Vertical drag: up = louder, down = quieter
 * - Scroll wheel: up = louder, down = quieter
 * - Double-click to reset to max volume
 * - Full keyboard accessibility
 */

import { useState, useRef, useCallback } from 'react';
import './VolumeKnob.css';

interface VolumeKnobProps {
  /** Current volume (0-1) */
  value: number;
  /** Called when volume changes */
  onChange: (value: number) => void;
  /** Optional size in pixels (default 32) */
  size?: number;
}

// Map 0-1 volume to rotation degrees
// 0% = -135deg (7 o'clock), 100% = 135deg (5 o'clock)
const MIN_ROTATION = -135;
const MAX_ROTATION = 135;

export function VolumeKnob({ value, onChange, size = 32 }: VolumeKnobProps) {
  const knobRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ y: number; startValue: number } | null>(null);

  // Convert value (0-1) to rotation degrees
  const rotation = MIN_ROTATION + (value * (MAX_ROTATION - MIN_ROTATION));

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Capture pointer for tracking outside element
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartRef.current = { y: e.clientY, startValue: value };
  }, [value]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    e.preventDefault();

    // Vertical-only drag: up = increase, down = decrease
    const deltaY = dragStartRef.current.y - e.clientY;
    const sensitivity = 0.01; // Volume change per pixel
    const newValue = Math.max(0, Math.min(1, dragStartRef.current.startValue + (deltaY * sensitivity)));
    onChange(newValue);
  }, [isDragging, onChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setIsDragging(false);
    dragStartRef.current = null;
  }, []);

  // Handle wheel scrolling - scroll up = volume up
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    // deltaY is positive when scrolling down, negative when scrolling up
    // Negate so scroll up = volume up (natural direction)
    const delta = -e.deltaY * 0.002;
    const newValue = Math.max(0, Math.min(1, value + delta));
    onChange(newValue);
  }, [value, onChange]);

  // Double-click to reset to max volume
  const handleDoubleClick = useCallback(() => {
    onChange(1.0);
  }, [onChange]);

  // Keyboard accessibility
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.05;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        e.preventDefault();
        onChange(Math.min(1, value + step));
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        e.preventDefault();
        onChange(Math.max(0, value - step));
        break;
      case 'Home':
        e.preventDefault();
        onChange(0);
        break;
      case 'End':
        e.preventDefault();
        onChange(1);
        break;
    }
  }, [value, onChange]);

  // No need for global event listeners - pointer capture handles it

  return (
    <div
      ref={knobRef}
      role="slider"
      aria-label="Volume"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(value * 100)}% volume`}
      tabIndex={0}
      className={`volume-knob ${isDragging ? 'dragging' : ''}`}
      style={{
        width: size,
        height: size,
        transform: `rotate(${rotation}deg)`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      title={`Volume: ${Math.round(value * 100)}% (drag up/down, scroll, or use arrow keys)`}
    >
      <div className="volume-knob-indicator" />
    </div>
  );
}
