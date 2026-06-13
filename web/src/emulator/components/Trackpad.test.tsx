/**
 * Tests for Trackpad component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Trackpad } from './Trackpad';
import type { InputBufferWriter } from '../input/types';

// Mock the CSS import
vi.mock('./Trackpad.css', () => ({}));

// Polyfill PointerEvent for jsdom
class MockPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}
(globalThis as unknown as { PointerEvent: typeof MockPointerEvent }).PointerEvent = MockPointerEvent;

// Mock AudioContext
class MockAudioContext {
  state = 'running';
  createOscillator = vi.fn(() => ({
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  }));
  destination = {};
  currentTime = 0;
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}
(globalThis as unknown as { AudioContext: typeof MockAudioContext }).AudioContext = MockAudioContext;

// Create mock buffer writer
function createMockBufferWriter(): InputBufferWriter {
  return {
    writeMousePosition: vi.fn(),
    writeMouseButton: vi.fn(),
    writeKeyEvent: vi.fn(),
    writeModifiers: vi.fn(),
  };
}

describe('Trackpad', () => {
  let mockWriter: InputBufferWriter;

  beforeEach(() => {
    mockWriter = createMockBufferWriter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render trackpad element', () => {
      render(<Trackpad inputBuffer={mockWriter} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });

    it('should have trackpad surface', () => {
      render(<Trackpad inputBuffer={mockWriter} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      const surface = trackpad.querySelector('.trackpad__surface');
      expect(surface).toBeInTheDocument();
    });

    it('should have correct ARIA attributes', () => {
      render(<Trackpad inputBuffer={mockWriter} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toHaveAttribute('aria-label');
      expect(trackpad).toHaveAttribute('tabIndex', '0');
    });
  });

  describe('disabled state', () => {
    it('should apply disabled class when disabled', () => {
      render(<Trackpad inputBuffer={mockWriter} enabled={false} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toHaveClass('trackpad--disabled');
    });

    it('should have tabIndex -1 when disabled', () => {
      render(<Trackpad inputBuffer={mockWriter} enabled={false} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toHaveAttribute('tabIndex', '-1');
    });

    it('should not have disabled class when enabled', () => {
      render(<Trackpad inputBuffer={mockWriter} enabled={true} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).not.toHaveClass('trackpad--disabled');
    });
  });

  describe('null buffer', () => {
    it('should render without input buffer', () => {
      render(<Trackpad inputBuffer={null} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });
  });

  describe('props', () => {
    it('should accept custom screen dimensions', () => {
      render(
        <Trackpad
          inputBuffer={mockWriter}
          screenWidth={800}
          screenHeight={600}
        />
      );

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });

    it('should accept custom sensitivity', () => {
      render(
        <Trackpad
          inputBuffer={mockWriter}
          sensitivity={2.0}
        />
      );

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });

    it('should accept haptic options', () => {
      render(
        <Trackpad
          inputBuffer={mockWriter}
          hapticSound={false}
          hapticVisual={false}
        />
      );

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });

    it('should accept scroll callback', () => {
      const scrollCallback = vi.fn();
      render(
        <Trackpad
          inputBuffer={mockWriter}
          onScroll={scrollCallback}
        />
      );

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });
  });

  describe('touch interaction', () => {
    it('should handle touch-action style', () => {
      render(<Trackpad inputBuffer={mockWriter} />);

      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      // The handler sets touch-action: none when attached
      expect(trackpad.style.touchAction).toBe('none');
    });
  });

  describe('cleanup', () => {
    it('should cleanup on unmount', () => {
      const { unmount } = render(<Trackpad inputBuffer={mockWriter} />);

      // Should not throw
      unmount();
    });

    it('should cleanup when disabled changes', () => {
      const { rerender } = render(<Trackpad inputBuffer={mockWriter} enabled={true} />);

      // Disable
      rerender(<Trackpad inputBuffer={mockWriter} enabled={false} />);

      // Re-enable
      rerender(<Trackpad inputBuffer={mockWriter} enabled={true} />);

      // Should not throw
      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });

    it('should handle buffer becoming null', () => {
      const { rerender } = render(<Trackpad inputBuffer={mockWriter} />);

      // Set buffer to null
      rerender(<Trackpad inputBuffer={null} />);

      // Should not throw
      const trackpad = screen.getByRole('application', { name: /trackpad/i });
      expect(trackpad).toBeInTheDocument();
    });
  });
});
