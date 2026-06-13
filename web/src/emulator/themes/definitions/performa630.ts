/**
 * Macintosh Performa 630 Theme (1994)
 *
 * The Performa 630 represented Apple's consumer-friendly approach -
 * softer curves, lighter beige tones, and an approachable aesthetic.
 * This is the default theme, offering a warm, nostalgic welcome.
 */

import type { MacTheme } from '../types';

export const performa630Theme: MacTheme = {
  id: 'performa630',
  name: 'Warm Beige',
  era: '1994',
  model: 'Warm Beige',
  description: 'Soft, warm tones with a friendly aesthetic',
  className: 'theme-performa',

  colors: {
    // Warm, light shell background
    shellBg: '#E8E2D8',
    shellBgGradient: 'radial-gradient(ellipse at 50% 30%, #F0EBE3 0%, #E8E2D8 50%, #D8D2C8 100%)',

    // Housing - light warm beige (slightly lighter than Classic)
    housingPrimary: '#EDE8DF',
    housingLight: '#F5F2EB',
    housingLighter: '#FAF8F4',
    housingDark: '#D4CFC4',
    housingDarker: '#C4BFB4',

    // Screen bezel - deep gray with subtle warmth
    screenBezel: '#3A3832',
    screenInner: '#1A1918',
    screenShadow: 'rgba(0, 0, 0, 0.6)',

    // Control strip - slightly darker than housing
    controlBg: '#E0DBD0',
    controlBorder: '#C8C3B8',
    controlHover: '#D4CFC4',

    // Text - dark grays with warmth
    textPrimary: '#2A2824',
    textSecondary: '#5A5850',
    textDim: '#8A887E',
    textOnDark: '#E8E8E8',

    // Accents
    accentPrimary: '#2B6CB0',
    accentSecondary: '#38A169',
    accentWarning: '#D69E2E',
    accentError: '#C53030',

    // Panels
    panelBg: '#F5F2EB',
    panelBorder: '#D4CFC4',
    cardBg: '#FFFFFF',
  },

  leds: {
    power: {
      off: '#4A4840',
      on: '#22C55E',
      glow: 'rgba(34, 197, 94, 0.5)',
    },
    network: {
      disconnected: '#4A4840',
      connected: '#22C55E',
      connecting: '#EAB308',
      glow: 'rgba(34, 197, 94, 0.4)',
    },
    tx: {
      idle: '#3A3832',
      active: '#22C55E',
      glow: 'rgba(34, 197, 94, 0.6)',
    },
    rx: {
      idle: '#3A3832',
      active: '#F97316',
      glow: 'rgba(249, 115, 22, 0.6)',
    },
    activity: {
      idle: '#4A4840',
      active: '#22C55E',
      glow: 'rgba(34, 197, 94, 0.4)',
    },
  },

  textures: {
    noiseOpacity: 0.025,
    noiseFrequency: 0.8,
    highlightGradient: true,
    highlightIntensity: 0.08,
    ventStyle: 'curved',
    ventCount: 10,
    ventColor: '#2A2824',
    ventShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.7)',
    chamferSize: 4,
    screenRadius: 8,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'Geneva', 'Helvetica Neue', Helvetica, sans-serif",
    mono: "'Monaco', 'SF Mono', 'Menlo', monospace",
    badgeSize: '0.8rem',
    labelSize: '0.625rem',
  },

  badge: {
    brand: 'Macintosh',
    model: 'Performa 630',
    showAppleLogo: true,
    showRainbowLogo: true,
    badgeStyle: 'printed',
  },

  modem: {
    style: 'external',
    panelColor: '#3A3A3A',
    panelBorder: '#2A2A2A',
    labelColor: '#9CA3AF',
    showPacketStats: true,
  },
};
