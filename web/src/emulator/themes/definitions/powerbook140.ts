/**
 * PowerBook 140 Theme (1991)
 *
 * Apple's early portable Macs had a distinctive charcoal gray
 * aesthetic - darker, more utilitarian, built for the road.
 */

import type { MacTheme } from '../types';

export const powerbook140Theme: MacTheme = {
  id: 'powerbook140',
  name: 'Charcoal',
  era: '1991',
  model: 'Charcoal',
  description: 'Deep charcoal gray with modern sensibility',
  className: 'theme-powerbook',

  colors: {
    // Dark charcoal shell
    shellBg: '#3A3836',
    shellBgGradient: 'radial-gradient(ellipse at 50% 30%, #4A4846 0%, #3A3836 50%, #2A2826 100%)',

    // Housing - dark charcoal gray
    housingPrimary: '#4A4846',
    housingLight: '#5A5856',
    housingLighter: '#6A6866',
    housingDark: '#3A3836',
    housingDarker: '#2A2826',

    // Screen bezel - near black
    screenBezel: '#1A1918',
    screenInner: '#0A0909',
    screenShadow: 'rgba(0, 0, 0, 0.9)',

    // Control strip
    controlBg: '#3E3C3A',
    controlBorder: '#2A2826',
    controlHover: '#4A4846',

    // Text - light on dark
    textPrimary: '#E8E6E4',
    textSecondary: '#A8A6A4',
    textDim: '#787674',
    textOnDark: '#E8E8E8',

    // Accents
    accentPrimary: '#60A5FA',
    accentSecondary: '#4ADE80',
    accentWarning: '#FBBF24',
    accentError: '#F87171',

    // Panels - dark theme
    panelBg: '#2A2826',
    panelBorder: '#1A1918',
    cardBg: '#3A3836',
  },

  leds: {
    power: {
      off: '#1A1918',
      on: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.6)',
    },
    network: {
      disconnected: '#1A1918',
      connected: '#00FF00',
      connecting: '#FFCC00',
      glow: 'rgba(0, 255, 0, 0.5)',
    },
    tx: {
      idle: '#0A0909',
      active: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.7)',
    },
    rx: {
      idle: '#0A0909',
      active: '#FF7700',
      glow: 'rgba(255, 119, 0, 0.7)',
    },
    activity: {
      idle: '#1A1918',
      active: '#00FF00',
      glow: 'rgba(0, 255, 0, 0.5)',
    },
    // LED backlit keyboard - warm white glow
    keyboard: {
      backlight: 'rgba(255, 255, 255, 0.08)',
      glow: 'rgba(200, 195, 180, 0.12)',
      text: 'rgba(255, 255, 255, 0.9)',
      intensity: 0.3,
    },
  },

  textures: {
    noiseOpacity: 0.05,
    noiseFrequency: 0.7,
    highlightGradient: true,
    highlightIntensity: 0.04,
    ventStyle: 'grid',
    ventCount: 6,
    ventColor: '#0A0908',
    ventShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.9)',
    chamferSize: 3,
    screenRadius: 6,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'Geneva', 'Helvetica Neue', sans-serif",
    mono: "'Monaco', 'SF Mono', monospace",
    badgeSize: '0.7rem',
    labelSize: '0.5rem',
  },

  badge: {
    brand: 'PowerBook',
    model: '140',
    showAppleLogo: true,
    showRainbowLogo: false,
    badgeStyle: 'printed',
  },

  modem: {
    style: 'internal',
    panelColor: '#3E3C3A',
    panelBorder: '#2A2826',
    labelColor: '#787674',
    showPacketStats: false,
  },
};
