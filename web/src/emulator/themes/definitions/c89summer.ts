/**
 * C89 Summer Theme (1989)
 *
 * The C89 Summer brand from the se30 project: ANSI C, BSD sockets,
 * real UNIX. The workstation sits in a dusk office - indigo room,
 * sunset coming through the blinds, a faint grid floor, neon rim
 * light off the case, and the C89 Summer sticker on the tower.
 */

import type { MacTheme } from '../types';

export const c89SummerTheme: MacTheme = {
  id: 'c89summer',
  name: 'C89 Summer',
  era: '1989',
  model: 'Summer Edition',
  description: 'Sunset office - ANSI C, BSD sockets, real UNIX',
  className: 'theme-c89',

  colors: {
    // Dusk office: indigo sky into a magenta horizon, dark floor below
    shellBg: '#191030',
    shellBgGradient: `linear-gradient(
      180deg,
      #0E0A22 0%,
      #1A1040 40%,
      #34164E 62%,
      #6E2160 74%,
      #C04A6E 79%,
      #2A1240 82%,
      #150E28 100%
    )`,

    // Platinum case, slightly dimmed by the evening light
    housingPrimary: '#B9AFA8',
    housingLight: '#CCC2BA',
    housingLighter: '#DCD2C8',
    housingDark: '#9B9189',
    housingDarker: '#857B74',

    // Screen bezel - deep, screen glows in the dark room
    screenBezel: '#241F1E',
    screenInner: '#0A0908',
    screenShadow: 'rgba(0, 0, 0, 0.85)',

    // Control strip
    controlBg: '#A89E96',
    controlBorder: '#8A8078',
    controlHover: '#9A9088',

    // Text
    textPrimary: '#241F1C',
    textSecondary: '#453E38',
    textDim: '#6B625B',
    textOnDark: '#F5E9FF',

    // Accents - neon
    accentPrimary: '#FF2E97',
    accentSecondary: '#00D4AA',
    accentWarning: '#FFB000',
    accentError: '#FF3355',

    // Panels
    panelBg: '#CCC2BA',
    panelBorder: '#9B9189',
    cardBg: '#EEE8E2',
  },

  leds: {
    power: {
      off: '#1E1A18',
      on: '#00FFC8',
      glow: 'rgba(0, 255, 200, 0.55)',
    },
    network: {
      disconnected: '#1E1A18',
      connected: '#00D4FF',
      connecting: '#FFB000',
      glow: 'rgba(0, 212, 255, 0.5)',
    },
    tx: {
      idle: '#2A0A1E',
      active: '#FF2E97',
      glow: 'rgba(255, 46, 151, 0.6)',
    },
    rx: {
      idle: '#06202A',
      active: '#00D4FF',
      glow: 'rgba(0, 212, 255, 0.6)',
    },
    activity: {
      idle: '#2A1A0A',
      active: '#FFB000',
      glow: 'rgba(255, 176, 0, 0.5)',
    },
  },

  textures: {
    noiseOpacity: 0.03,
    noiseFrequency: 0.8,
    highlightGradient: true,
    highlightIntensity: 0.06,
    ventStyle: 'horizontal',
    ventCount: 10,
    ventColor: '#0E0C0A',
    ventShadow: 'inset 0 1px 3px rgba(0, 0, 0, 0.8)',
    chamferSize: 4,
    screenRadius: 8,
  },

  fonts: {
    badge: "'EB Garamond', 'Apple Garamond', Georgia, serif",
    ui: "'Geneva', 'Helvetica Neue', sans-serif",
    mono: "'Monaco', 'SF Mono', monospace",
    badgeSize: '0.8rem',
    labelSize: '0.625rem',
  },

  badge: {
    brand: 'Dialtone',
    model: 'C89 Summer',
    showAppleLogo: false,
    showRainbowLogo: true,
    badgeStyle: 'printed',
  },

  modem: {
    style: 'external',
    panelColor: '#16121E',
    panelBorder: '#08060E',
    labelColor: '#8A7F9E',
    showPacketStats: true,
  },
};
