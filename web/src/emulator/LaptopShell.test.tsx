/**
 * Tests for LaptopShell component
 *
 * These are basic smoke tests - full integration testing
 * would require mocking many more dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Mock all the heavy dependencies
vi.mock('./EmulatorCanvas', () => ({
  EmulatorCanvas: vi.fn(() => null),
}));

vi.mock('./components/Trackpad', () => ({
  Trackpad: vi.fn(() => <div data-testid="mock-trackpad" />),
}));

vi.mock('./components/VirtualKeyboard', () => ({
  VirtualKeyboard: vi.fn(() => <div data-testid="mock-virtual-keyboard" />),
}));

vi.mock('./components/settings', () => ({
  SettingsModal: vi.fn(() => null),
}));

vi.mock('./components/VolumeKnob', () => ({
  VolumeKnob: vi.fn(() => <div data-testid="mock-volume-knob" />),
}));

vi.mock('./components/VUMeter', () => ({
  VUMeter: vi.fn(() => <div data-testid="mock-vu-meter" />),
}));

vi.mock('./DialtoneEthernet', () => ({
  defaultRelayUrl: () => 'ws://localhost:8081',
  defaultHttpRelayUrl: () => 'http://localhost:8081',
}));

vi.mock('./themes', () => ({
  useTheme: () => ({
    currentTheme: { className: 'theme-powerbook' },
    networkActivity: {
      hdActive: false,
      hdIntensity: 0,
      txActive: false,
      txIntensity: 0,
      rxActive: false,
      rxIntensity: 0,
    },
    setNetworkStatus: vi.fn(),
    incrementPacketsSent: vi.fn(),
    incrementPacketsReceived: vi.fn(),
    triggerHd: vi.fn(),
  }),
  useThemeStyles: vi.fn(),
  powerbook140Theme: {
    id: 'powerbook140',
    className: 'theme-powerbook',
  },
}));

vi.mock('./settings', () => ({
  useDiskSettings: () => ({
    mode: 'client-cached',
    bootDisk: 'test.dsk',
    dataDisks: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('./input/KeyboardHandler', () => ({
  createAtomicsBufferWriter: vi.fn(() => ({
    writeMousePosition: vi.fn(),
    writeMouseButton: vi.fn(),
    writeKeyEvent: vi.fn(),
    writeModifiers: vi.fn(),
  })),
}));

// Mock CSS
vi.mock('./LaptopShell.css', () => ({}));

// Now import the component
import { LaptopShell } from './LaptopShell';

describe('LaptopShell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render the laptop shell', () => {
      render(<LaptopShell />);

      const shell = document.querySelector('.laptop-shell');
      expect(shell).toBeInTheDocument();
    });

    it('should render with PowerBook theme class', () => {
      render(<LaptopShell />);

      const shell = document.querySelector('.laptop-shell');
      expect(shell).toHaveClass('theme-powerbook');
    });

    it('should render screen area', () => {
      render(<LaptopShell />);

      const screenArea = document.querySelector('.laptop-screen-area');
      expect(screenArea).toBeInTheDocument();
    });

    it('should render trackpad area', () => {
      render(<LaptopShell />);

      const trackpadArea = document.querySelector('.laptop-trackpad-area');
      expect(trackpadArea).toBeInTheDocument();
    });

    it('should render trackpad component', () => {
      render(<LaptopShell />);

      const trackpad = screen.getByTestId('mock-trackpad');
      expect(trackpad).toBeInTheDocument();
    });

    it('should render keyboard area', () => {
      render(<LaptopShell />);

      const keyboardArea = document.querySelector('.laptop-keyboard-area');
      expect(keyboardArea).toBeInTheDocument();
    });

    it('should render virtual keyboard component', () => {
      render(<LaptopShell />);

      const keyboard = screen.getByTestId('mock-virtual-keyboard');
      expect(keyboard).toBeInTheDocument();
    });

    it('should render control strip with action buttons', () => {
      render(<LaptopShell />);

      const controlStrip = document.querySelector('.laptop-control-strip');
      expect(controlStrip).toBeInTheDocument();

      const buttons = controlStrip?.querySelectorAll('.laptop-action-btn');
      expect(buttons?.length).toBeGreaterThan(0);
    });

    it('should render status LEDs', () => {
      render(<LaptopShell />);

      const statusCluster = document.querySelector('.laptop-status-cluster');
      expect(statusCluster).toBeInTheDocument();

      const leds = statusCluster?.querySelectorAll('.laptop-status-led');
      expect(leds?.length).toBe(4); // PWR, HD, TX, RX
    });

    it('should render audio controls', () => {
      render(<LaptopShell />);

      const audioControls = document.querySelector('.laptop-audio-controls');
      expect(audioControls).toBeInTheDocument();

      const vuMeter = screen.getByTestId('mock-vu-meter');
      expect(vuMeter).toBeInTheDocument();

      const volumeKnob = screen.getByTestId('mock-volume-knob');
      expect(volumeKnob).toBeInTheDocument();
    });
  });

  describe('props', () => {
    it('should accept custom dimensions', () => {
      render(<LaptopShell width={800} height={600} />);

      const shell = document.querySelector('.laptop-shell');
      expect(shell).toBeInTheDocument();
    });

    it('should accept custom relay URL', () => {
      render(<LaptopShell relayUrl="ws://custom:8081" />);

      const shell = document.querySelector('.laptop-shell');
      expect(shell).toBeInTheDocument();
    });
  });

  describe('cleanup', () => {
    it('should unmount without errors', () => {
      const { unmount } = render(<LaptopShell />);
      unmount();
      // Should not throw
    });
  });
});
