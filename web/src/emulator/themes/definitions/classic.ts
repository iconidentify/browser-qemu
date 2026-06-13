/**
 * Macintosh Classic Theme (1990)
 *
 * The Macintosh Classic was the last of the original compact Macs -
 * an all-in-one design with the iconic vertical proportions.
 * Warm beige ABS plastic with horizontal ventilation slots.
 */

import type { MacTheme } from '../types';

export const classicTheme: MacTheme = {
  id: 'classic',
  name: 'Ivory',
  era: '1990',
  model: 'Ivory',
  description: 'Classic warm beige with timeless appeal',
  className: 'theme-classic',

  colors: {
    // Warm shell background
    shellBg: '#DED8CC',
    shellBgGradient: 'radial-gradient(ellipse at 50% 30%, #E8E2D6 0%, #DED8CC 50%, #CEC8BC 100%)',

    // Housing - classic warm beige (Snow White industrial design)
    housingPrimary: '#E8DFD0',
    housingLight: '#F0E8DA',
    housingLighter: '#F5F0E6',
    housingDark: '#D4C9B8',
    housingDarker: '#C4B9A8',

    // Screen bezel - dark charcoal
    screenBezel: '#2A2826',
    screenInner: '#0D0D0C',
    screenShadow: 'rgba(0, 0, 0, 0.7)',

    // Control strip
    controlBg: '#DDD4C4',
    controlBorder: '#C8BDA8',
    controlHover: '#D0C7B8',

    // Text
    textPrimary: '#1A1816',
    textSecondary: '#4A4640',
    textDim: '#7A7670',
    textOnDark: '#E8E8E8',

    // Accents
    accentPrimary: '#1E40AF',
    accentSecondary: '#047857',
    accentWarning: '#B45309',
    accentError: '#B91C1C',

    // Panels
    panelBg: '#F0E8DA',
    panelBorder: '#D4C9B8',
    cardBg: '#FDFBF8',
  },

  leds: {
    power: {
      off: '#3A3632',
      on: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.5)',
    },
    network: {
      disconnected: '#3A3632',
      connected: '#00FF00',
      connecting: '#FFAA00',
      glow: 'rgba(0, 255, 0, 0.4)',
    },
    tx: {
      idle: '#2A2826',
      active: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.6)',
    },
    rx: {
      idle: '#2A2826',
      active: '#FF6600',
      glow: 'rgba(255, 102, 0, 0.6)',
    },
    activity: {
      idle: '#3A3632',
      active: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.4)',
    },
  },

  textures: {
    noiseOpacity: 0.03,
    noiseFrequency: 0.9,
    highlightGradient: true,
    highlightIntensity: 0.1,
    ventStyle: 'horizontal',
    ventCount: 8,
    ventColor: '#1A1816',
    ventShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.8)',
    chamferSize: 3,
    screenRadius: 6,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'ChicagoFLF', 'Geneva', 'Helvetica Neue', sans-serif",
    mono: "'Monaco', 'SF Mono', monospace",
    badgeSize: '0.75rem',
    labelSize: '0.5625rem',
  },

  badge: {
    brand: 'Macintosh',
    model: 'Classic',
    showAppleLogo: true,
    showRainbowLogo: true,
    badgeStyle: 'embossed',
  },

  modem: {
    style: 'internal',
    panelColor: '#DDD4C4',
    panelBorder: '#C8BDA8',
    labelColor: '#5A5650',
    showPacketStats: false,
  },
};
