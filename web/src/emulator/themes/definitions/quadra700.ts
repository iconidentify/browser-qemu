/**
 * Quadra 700 Theme (1991)
 *
 * The Quadra 700 was Apple's first tower Mac - a powerful workstation
 * with a commanding presence. Vertical orientation, professional gray.
 */

import type { MacTheme } from '../types';

export const quadra700Theme: MacTheme = {
  id: 'quadra700',
  name: 'Slate',
  era: '1991',
  model: 'Slate',
  description: 'Sophisticated gray with understated elegance',
  className: 'theme-quadra',

  colors: {
    // Cool professional gray shell
    shellBg: '#C4C0B8',
    shellBgGradient: 'radial-gradient(ellipse at 50% 30%, #D0CCC4 0%, #C4C0B8 50%, #B4B0A8 100%)',

    // Housing - professional dark platinum
    housingPrimary: '#B8B0A4',
    housingLight: '#C8C0B4',
    housingLighter: '#D4CCC0',
    housingDark: '#A8A094',
    housingDarker: '#989088',

    // Screen bezel - dark professional
    screenBezel: '#1E1C1A',
    screenInner: '#080807',
    screenShadow: 'rgba(0, 0, 0, 0.8)',

    // Control strip
    controlBg: '#AEA69A',
    controlBorder: '#98908A',
    controlHover: '#A49C90',

    // Text
    textPrimary: '#141312',
    textSecondary: '#3A3836',
    textDim: '#5A5856',
    textOnDark: '#E8E8E8',

    // Accents - more muted, professional
    accentPrimary: '#1E3A5F',
    accentSecondary: '#1E5F3A',
    accentWarning: '#8B5A00',
    accentError: '#8B1A1A',

    // Panels
    panelBg: '#C8C0B4',
    panelBorder: '#A8A094',
    cardBg: '#EEECEA',
  },

  leds: {
    power: {
      off: '#1E1C1A',
      on: '#00CC00',
      glow: 'rgba(0, 204, 0, 0.5)',
    },
    network: {
      disconnected: '#1E1C1A',
      connected: '#00CC00',
      connecting: '#CC9900',
      glow: 'rgba(0, 204, 0, 0.4)',
    },
    tx: {
      idle: '#141210',
      active: '#00CC00',
      glow: 'rgba(0, 204, 0, 0.55)',
    },
    rx: {
      idle: '#141210',
      active: '#CC5500',
      glow: 'rgba(204, 85, 0, 0.55)',
    },
    activity: {
      idle: '#1E1C1A',
      active: '#00CC00',
      glow: 'rgba(0, 204, 0, 0.4)',
    },
  },

  textures: {
    noiseOpacity: 0.04,
    noiseFrequency: 0.8,
    highlightGradient: true,
    highlightIntensity: 0.06,
    ventStyle: 'horizontal',
    ventCount: 10,
    ventColor: '#0E0C0A',
    ventShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.8)',
    chamferSize: 5,
    screenRadius: 4,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'Geneva', 'Helvetica Neue', sans-serif",
    mono: "'Monaco', 'SF Mono', monospace",
    badgeSize: '0.75rem',
    labelSize: '0.5625rem',
  },

  badge: {
    brand: 'Quadra',
    model: '700',
    showAppleLogo: true,
    showRainbowLogo: false,
    badgeStyle: 'metal',
  },

  modem: {
    style: 'external',
    panelColor: '#1E1E1E',
    panelBorder: '#0E0E0E',
    labelColor: '#707070',
    showPacketStats: true,
  },
};
