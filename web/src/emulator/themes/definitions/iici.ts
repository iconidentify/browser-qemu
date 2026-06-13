/**
 * Macintosh IIci Theme (1989)
 *
 * The IIci was a professional workhorse - modular design with
 * a darker platinum finish. Sophisticated and business-oriented.
 */

import type { MacTheme } from '../types';

export const iiciTheme: MacTheme = {
  id: 'iici',
  name: 'Platinum',
  era: '1989',
  model: 'Platinum',
  description: 'Cool platinum with professional refinement',
  className: 'theme-iici',

  colors: {
    // Cool platinum shell
    shellBg: '#D0CCC4',
    shellBgGradient: 'radial-gradient(ellipse at 50% 30%, #DAD6CE 0%, #D0CCC4 50%, #C0BCB4 100%)',

    // Housing - cool platinum gray
    housingPrimary: '#C8C0B4',
    housingLight: '#D4CCC0',
    housingLighter: '#E0D8CC',
    housingDark: '#B4ACA0',
    housingDarker: '#A49C90',

    // Screen bezel - darker professional gray
    screenBezel: '#242220',
    screenInner: '#0A0A09',
    screenShadow: 'rgba(0, 0, 0, 0.75)',

    // Control strip
    controlBg: '#BEB6AA',
    controlBorder: '#A8A094',
    controlHover: '#B4ACA0',

    // Text
    textPrimary: '#1A1816',
    textSecondary: '#4A4642',
    textDim: '#6A6662',
    textOnDark: '#E8E8E8',

    // Accents
    accentPrimary: '#1E3A8A',
    accentSecondary: '#065F46',
    accentWarning: '#92400E',
    accentError: '#991B1B',

    // Panels
    panelBg: '#D4CCC0',
    panelBorder: '#B4ACA0',
    cardBg: '#F5F3F0',
  },

  leds: {
    power: {
      off: '#2A2826',
      on: '#00DD00',
      glow: 'rgba(0, 221, 0, 0.5)',
    },
    network: {
      disconnected: '#2A2826',
      connected: '#00DD00',
      connecting: '#DDAA00',
      glow: 'rgba(0, 221, 0, 0.4)',
    },
    tx: {
      idle: '#1A1816',
      active: '#00DD00',
      glow: 'rgba(0, 221, 0, 0.6)',
    },
    rx: {
      idle: '#1A1816',
      active: '#DD6600',
      glow: 'rgba(221, 102, 0, 0.6)',
    },
    activity: {
      idle: '#2A2826',
      active: '#00DD00',
      glow: 'rgba(0, 221, 0, 0.4)',
    },
  },

  textures: {
    noiseOpacity: 0.035,
    noiseFrequency: 0.85,
    highlightGradient: true,
    highlightIntensity: 0.07,
    ventStyle: 'horizontal',
    ventCount: 12,
    ventColor: '#1A1816',
    ventShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.75)',
    chamferSize: 4,
    screenRadius: 4,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'Geneva', 'Helvetica Neue', sans-serif",
    mono: "'Monaco', 'SF Mono', monospace",
    badgeSize: '0.7rem',
    labelSize: '0.5625rem',
  },

  badge: {
    brand: 'Macintosh',
    model: 'IIci',
    showAppleLogo: true,
    showRainbowLogo: true,
    badgeStyle: 'metal',
  },

  modem: {
    style: 'external',
    panelColor: '#2A2A2A',
    panelBorder: '#1A1A1A',
    labelColor: '#808080',
    showPacketStats: true,
  },
};
