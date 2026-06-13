/**
 * Theme Context Provider
 *
 * Provides theme state and switching functionality to the entire app.
 * Persists theme selection to localStorage for consistency across visits.
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { MacTheme, ThemeId, NetworkActivityState, ConnectionStatus } from './types';
import { themes, getThemeById, DEFAULT_THEME_ID } from './index';

interface ThemeContextValue {
  // Current theme
  currentTheme: MacTheme;

  // Theme switching
  setTheme: (themeId: ThemeId) => void;
  availableThemes: MacTheme[];

  // Network activity state (for modem indicators)
  networkActivity: NetworkActivityState;
  setNetworkStatus: (status: ConnectionStatus) => void;
  triggerTx: () => void;
  triggerRx: () => void;
  triggerHd: () => void;
  incrementPacketsSent: () => void;
  incrementPacketsReceived: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'dialtone-theme';
const LED_FLASH_DURATION = 80;
const INTENSITY_DECAY_INTERVAL = 50;
const INTENSITY_DECAY_RATE = 0.15;

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: ThemeId;
}

export function ThemeProvider({ children, defaultTheme }: ThemeProviderProps) {
  // Initialize theme from localStorage; a user's explicit choice always wins.
  // No stored preference means the site default (C89 Summer).
  const [themeId, setThemeId] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return defaultTheme || DEFAULT_THEME_ID;
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    // Only use stored theme if it's valid - otherwise use the default
    if (stored && getThemeById(stored)) {
      return stored;
    }
    return defaultTheme || DEFAULT_THEME_ID;
  });

  // Network activity state
  const [networkActivity, setNetworkActivity] = useState<NetworkActivityState>({
    status: 'disconnected',
    txActive: false,
    rxActive: false,
    hdActive: false,
    packetsSent: 0,
    packetsReceived: 0,
    txIntensity: 0,
    rxIntensity: 0,
    hdIntensity: 0,
  });

  // Flash timers (refs to avoid cleanup issues)
  const txTimeoutRef = useRef<number | null>(null);
  const rxTimeoutRef = useRef<number | null>(null);
  const hdTimeoutRef = useRef<number | null>(null);
  const intensityDecayRef = useRef<number | null>(null);

  const currentTheme = getThemeById(themeId) || themes[0];

  // Set theme and persist to localStorage
  const setTheme = useCallback((id: ThemeId) => {
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  // Network status updates
  const setNetworkStatus = useCallback((status: ConnectionStatus) => {
    setNetworkActivity(prev => ({ ...prev, status }));
  }, []);

  // Start intensity decay timer
  useEffect(() => {
    intensityDecayRef.current = window.setInterval(() => {
      setNetworkActivity(prev => ({
        ...prev,
        txIntensity: Math.max(0, prev.txIntensity - INTENSITY_DECAY_RATE),
        rxIntensity: Math.max(0, prev.rxIntensity - INTENSITY_DECAY_RATE),
        hdIntensity: Math.max(0, prev.hdIntensity - INTENSITY_DECAY_RATE),
      }));
    }, INTENSITY_DECAY_INTERVAL);

    return () => {
      if (intensityDecayRef.current) clearInterval(intensityDecayRef.current);
    };
  }, []);

  // TX flash with intensity boost
  const triggerTx = useCallback(() => {
    if (txTimeoutRef.current) clearTimeout(txTimeoutRef.current);
    setNetworkActivity(prev => ({
      ...prev,
      txActive: true,
      txIntensity: Math.min(1, prev.txIntensity + 0.4),
    }));
    txTimeoutRef.current = window.setTimeout(() => {
      setNetworkActivity(prev => ({ ...prev, txActive: false }));
      txTimeoutRef.current = null;
    }, LED_FLASH_DURATION);
  }, []);

  // RX flash with intensity boost
  const triggerRx = useCallback(() => {
    if (rxTimeoutRef.current) clearTimeout(rxTimeoutRef.current);
    setNetworkActivity(prev => ({
      ...prev,
      rxActive: true,
      rxIntensity: Math.min(1, prev.rxIntensity + 0.4),
    }));
    rxTimeoutRef.current = window.setTimeout(() => {
      setNetworkActivity(prev => ({ ...prev, rxActive: false }));
      rxTimeoutRef.current = null;
    }, LED_FLASH_DURATION);
  }, []);

  // HD flash with intensity boost
  const triggerHd = useCallback(() => {
    if (hdTimeoutRef.current) clearTimeout(hdTimeoutRef.current);
    setNetworkActivity(prev => ({
      ...prev,
      hdActive: true,
      hdIntensity: Math.min(1, prev.hdIntensity + 0.5),
    }));
    hdTimeoutRef.current = window.setTimeout(() => {
      setNetworkActivity(prev => ({ ...prev, hdActive: false }));
      hdTimeoutRef.current = null;
    }, LED_FLASH_DURATION);
  }, []);

  // Packet counters
  const incrementPacketsSent = useCallback(() => {
    setNetworkActivity(prev => ({ ...prev, packetsSent: prev.packetsSent + 1 }));
    triggerTx();
  }, [triggerTx]);

  const incrementPacketsReceived = useCallback(() => {
    setNetworkActivity(prev => ({ ...prev, packetsReceived: prev.packetsReceived + 1 }));
    triggerRx();
  }, [triggerRx]);

  // Cleanup timeouts on unmount only
  useEffect(() => {
    return () => {
      if (txTimeoutRef.current) clearTimeout(txTimeoutRef.current);
      if (rxTimeoutRef.current) clearTimeout(rxTimeoutRef.current);
      if (hdTimeoutRef.current) clearTimeout(hdTimeoutRef.current);
    };
  }, []);

  const value: ThemeContextValue = {
    currentTheme,
    setTheme,
    availableThemes: themes,
    networkActivity,
    setNetworkStatus,
    triggerTx,
    triggerRx,
    triggerHd,
    incrementPacketsSent,
    incrementPacketsReceived,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

// Convenience hook for just the current theme (no network state)
export function useCurrentTheme(): MacTheme {
  const { currentTheme } = useTheme();
  return currentTheme;
}
