/**
 * Tests for VirtualKeyboard component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VirtualKeyboard } from './VirtualKeyboard';
import { ThemeProvider } from '../themes';
import type { InputBufferWriter } from '../input/types';
import type { ReactNode } from 'react';

// Mock the CSS import
vi.mock('./VirtualKeyboard.css', () => ({}));

// Wrapper component to provide ThemeProvider
function TestWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// Helper to render with theme context
function renderWithTheme(ui: ReactNode) {
  return render(ui, { wrapper: TestWrapper });
}

// Mock TrackpadHaptics
vi.mock('../input/TrackpadHaptics', () => ({
  TrackpadHaptics: vi.fn().mockImplementation(() => ({
    triggerTap: vi.fn(),
    triggerPress: vi.fn(),
    triggerRelease: vi.fn(),
    dispose: vi.fn(),
    setElement: vi.fn(),
  })),
}));

describe('VirtualKeyboard', () => {
  let mockInputBuffer: InputBufferWriter;

  beforeEach(() => {
    mockInputBuffer = {
      writeMousePosition: vi.fn(),
      writeMouseButton: vi.fn(),
      writeKeyEvent: vi.fn(),
      writeModifiers: vi.fn(),
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('should render the virtual keyboard', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const keyboard = document.querySelector('.virtual-keyboard');
      expect(keyboard).toBeInTheDocument();
    });

    it('should render all letter keys in default mode', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      // Check for some letter keys
      expect(screen.getByText('Q')).toBeInTheDocument();
      expect(screen.getByText('W')).toBeInTheDocument();
      expect(screen.getByText('A')).toBeInTheDocument();
      expect(screen.getByText('Z')).toBeInTheDocument();
      expect(screen.getByText('M')).toBeInTheDocument();
    });

    it('should render special keys', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      expect(screen.getByText('DEL')).toBeInTheDocument();
      expect(screen.getByText('RET')).toBeInTheDocument();
      expect(screen.getAllByText('SHIFT').length).toBeGreaterThan(0);
    });

    it('should render action keys', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      expect(screen.getByText('123')).toBeInTheDocument();
      expect(screen.getByText('CMD')).toBeInTheDocument();
    });

    it('should render space bar', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const spaceKey = document.querySelector('.vk-key--space');
      expect(spaceKey).toBeInTheDocument();
    });

    it('should apply disabled class when not enabled', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} enabled={false} />);

      const keyboard = document.querySelector('.virtual-keyboard');
      expect(keyboard).toHaveClass('virtual-keyboard--disabled');
    });
  });

  describe('mode switching', () => {
    it('should switch to numbers mode when 123 is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const numberModeKey = screen.getByText('123');
      fireEvent.pointerDown(numberModeKey);

      // In number mode, should see numbers
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('0')).toBeInTheDocument();

      // Should see ABC button to switch back
      expect(screen.getByText('ABC')).toBeInTheDocument();
    });

    it('should switch back to letters mode when ABC is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      // Go to number mode
      fireEvent.pointerDown(screen.getByText('123'));

      // Go back to letter mode
      fireEvent.pointerDown(screen.getByText('ABC'));

      // Should see letters again
      expect(screen.getByText('Q')).toBeInTheDocument();
      expect(screen.getByText('123')).toBeInTheDocument();
    });

    it('should switch to symbols mode when #+ is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      // Go to number mode first
      fireEvent.pointerDown(screen.getByText('123'));

      // Go to symbols mode
      const symbolKeys = screen.getAllByText('#+');
      fireEvent.pointerDown(symbolKeys[0]);

      // Should see symbols
      expect(screen.getByText('[')).toBeInTheDocument();
      expect(screen.getByText('{')).toBeInTheDocument();
    });
  });

  describe('key press handling', () => {
    it('should call writeKeyEvent when a letter key is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const qKey = screen.getByText('Q');
      fireEvent.pointerDown(qKey);

      expect(mockInputBuffer.writeKeyEvent).toHaveBeenCalled();
    });

    it('should call writeKeyEvent for backspace', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const backspaceKey = screen.getByText('DEL');
      fireEvent.pointerDown(backspaceKey);

      expect(mockInputBuffer.writeKeyEvent).toHaveBeenCalled();
    });

    it('should call writeKeyEvent for enter', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const enterKey = screen.getByText('RET');
      fireEvent.pointerDown(enterKey);

      expect(mockInputBuffer.writeKeyEvent).toHaveBeenCalled();
    });
  });

  describe('modifier keys', () => {
    it('should toggle shift state when shift is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const shiftKeys = screen.getAllByText('SHIFT');
      fireEvent.pointerDown(shiftKeys[0]);

      // Check that shift key has active state
      expect(shiftKeys[0]).toHaveClass('vk-key--active');
    });

    it('should toggle cmd state when cmd is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const cmdKey = screen.getByText('CMD');
      fireEvent.pointerDown(cmdKey);

      // Check that cmd key has active state
      expect(cmdKey).toHaveClass('vk-key--active');
    });

    it('should clear shift after pressing a letter key', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const shiftKeys = screen.getAllByText('SHIFT');
      fireEvent.pointerDown(shiftKeys[0]);

      // Verify shift is active
      expect(shiftKeys[0]).toHaveClass('vk-key--active');

      // Press a letter key
      const aKey = screen.getByText('A');
      fireEvent.pointerDown(aKey);

      // Shift should be cleared
      expect(shiftKeys[0]).not.toHaveClass('vk-key--active');
    });
  });

  describe('arrow keys', () => {
    it('should show arrow keys overlay when ARROWS is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      const arrowsKey = screen.getByText('ARROWS');
      fireEvent.pointerDown(arrowsKey);

      // Should see arrow overlay
      const overlay = document.querySelector('.vk-arrows-overlay');
      expect(overlay).toBeInTheDocument();
    });

    it('should close arrow keys overlay when CLOSE is pressed', () => {
      renderWithTheme(<VirtualKeyboard inputBuffer={mockInputBuffer} />);

      // Open arrows
      fireEvent.pointerDown(screen.getByText('ARROWS'));

      // Close arrows
      fireEvent.click(screen.getByText('CLOSE'));

      // Overlay should be gone
      const overlay = document.querySelector('.vk-arrows-overlay');
      expect(overlay).not.toBeInTheDocument();
    });
  });

  describe('props', () => {
    it('should not throw when inputBuffer is null', () => {
      expect(() => {
        renderWithTheme(<VirtualKeyboard inputBuffer={null} />);
      }).not.toThrow();
    });
  });
});
