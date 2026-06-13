/**
 * Dark Theme
 *
 * Modern dark interface with phosphor-green accents.
 * Preserves the original aesthetic as an option.
 */

import type { MacTheme } from '../types';

export const darkTheme: MacTheme = {
  id: 'dark',
  name: 'Dark',
  era: 'Modern',
  model: 'Dark',
  description: 'Modern dark interface with phosphor accents',
  className: 'theme-dark',

  colors: {
    // Deep dark shell
    shellBg: '#0a0a0b',
    shellBgGradient: 'radial-gradient(ellipse at 50% 0%, rgba(0, 255, 136, 0.03) 0%, transparent 60%)',

    // Housing - dark gray
    housingPrimary: '#141416',
    housingLight: '#1e1e22',
    housingLighter: '#252529',
    housingDark: '#0d0d0e',
    housingDarker: '#080809',

    // Screen bezel - near black
    screenBezel: '#1a1a1d',
    screenInner: '#0d0d0e',
    screenShadow: 'rgba(0, 0, 0, 0.5)',

    // Control strip
    controlBg: '#1c1c20',
    controlBorder: '#1e1e22',
    controlHover: '#252529',

    // Text
    textPrimary: '#e8e8e8',
    textSecondary: '#888890',
    textDim: '#505058',
    textOnDark: '#e8e8e8',

    // Accents - phosphor green
    accentPrimary: '#00ff88',
    accentSecondary: '#00cc6a',
    accentWarning: '#ffaa00',
    accentError: '#ff4444',

    // Panels
    panelBg: '#121214',
    panelBorder: '#1e1e22',
    cardBg: '#1a1a1d',
  },

  leds: {
    power: {
      off: '#505058',
      on: '#00ff88',
      glow: 'rgba(0, 255, 136, 0.5)',
    },
    network: {
      disconnected: '#505058',
      connected: '#00ff88',
      connecting: '#ffaa00',
      glow: 'rgba(0, 255, 136, 0.4)',
    },
    tx: {
      idle: '#1a1a1d',
      active: '#00ff88',
      glow: 'rgba(0, 255, 136, 0.6)',
    },
    rx: {
      idle: '#1a1a1d',
      active: '#ffaa00',
      glow: 'rgba(255, 170, 0, 0.6)',
    },
    activity: {
      idle: '#505058',
      active: '#00ff88',
      glow: 'rgba(0, 255, 136, 0.4)',
    },
    // LED backlit keyboard - subtle phosphor green glow
    keyboard: {
      backlight: 'rgba(0, 255, 136, 0.05)',
      glow: 'rgba(0, 255, 136, 0.08)',
      text: 'rgba(255, 255, 255, 0.9)',
      intensity: 0.25,
    },
  },

  textures: {
    noiseOpacity: 0.03,
    noiseFrequency: 0.9,
    highlightGradient: false,
    highlightIntensity: 0,
    ventStyle: 'horizontal',
    ventCount: 12,
    ventColor: '#1a1a1d',
    ventShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.5)',
    chamferSize: 0,
    screenRadius: 8,
  },

  fonts: {
    badge: "'Space Grotesk', -apple-system, sans-serif",
    ui: "'Space Grotesk', -apple-system, sans-serif",
    mono: "'JetBrains Mono', 'SF Mono', monospace",
    badgeSize: '0.7rem',
    labelSize: '0.5rem',
  },

  badge: {
    brand: 'Dialtone',
    model: 'Classic',
    showAppleLogo: false,
    showRainbowLogo: false,
    badgeStyle: 'printed',
  },

  modem: {
    style: 'internal',
    panelColor: '#1c1c20',
    panelBorder: '#1e1e22',
    labelColor: '#505058',
    showPacketStats: true,
  },
};
