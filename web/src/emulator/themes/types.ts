/**
 * Theme System Types
 *
 * Museum-quality hardware recreation of classic Macintosh aesthetics.
 * Each theme captures the authentic materials, colors, and proportions
 * of specific Mac models from the late 80s and 90s.
 */

export type VentStyle = 'horizontal' | 'vertical' | 'grid' | 'curved';
export type ModemStyle = 'internal' | 'external';
export type ThemeId = 'performa630' | 'classic' | 'iici' | 'quadra700' | 'powerbook140' | 'dark' | 'c89summer';

export interface ThemeColors {
  // Shell background
  shellBg: string;
  shellBgGradient?: string;

  // Housing (main computer body)
  housingPrimary: string;
  housingLight: string;
  housingLighter: string;
  housingDark: string;
  housingDarker: string;

  // Screen bezel area
  screenBezel: string;
  screenInner: string;
  screenShadow: string;

  // Control strip
  controlBg: string;
  controlBorder: string;
  controlHover: string;

  // Text colors
  textPrimary: string;
  textSecondary: string;
  textDim: string;
  textOnDark: string;

  // Accent colors
  accentPrimary: string;
  accentSecondary: string;
  accentWarning: string;
  accentError: string;

  // Panel/Modal colors
  panelBg: string;
  panelBorder: string;
  cardBg: string;
}

export interface ThemeLEDs {
  power: {
    off: string;
    on: string;
    glow: string;
  };
  network: {
    disconnected: string;
    connected: string;
    connecting: string;
    glow: string;
  };
  tx: {
    idle: string;
    active: string;
    glow: string;
  };
  rx: {
    idle: string;
    active: string;
    glow: string;
  };
  activity: {
    idle: string;
    active: string;
    glow: string;
  };
  /** Keyboard backlight settings (only for dark themes) */
  keyboard?: {
    /** Base illumination color for keys */
    backlight: string;
    /** Outer glow/bleed color */
    glow: string;
    /** Text illumination color */
    text: string;
    /** Ambient intensity (0-1) when system is loaded */
    intensity: number;
  };
}

export interface ThemeTextures {
  // Noise overlay for ABS plastic appearance
  noiseOpacity: number;
  noiseFrequency: number;

  // Top highlight gradient (creates convex plastic illusion)
  highlightGradient: boolean;
  highlightIntensity: number;

  // Ventilation style
  ventStyle: VentStyle;
  ventCount: number;
  ventColor: string;
  ventShadow: string;

  // Bezel chamfer depth
  chamferSize: number;

  // Screen corner radius
  screenRadius: number;
}

export interface ThemeFonts {
  // Brand badge font (Apple Garamond style)
  badge: string;

  // UI font (Chicago style)
  ui: string;

  // Monospace font (Monaco style)
  mono: string;

  // Sizes
  badgeSize: string;
  labelSize: string;
}

export interface ThemeBadge {
  brand: string;
  model: string;
  showAppleLogo: boolean;
  showRainbowLogo: boolean;
  badgeStyle: 'embossed' | 'printed' | 'metal';
}

export interface ThemeModem {
  style: ModemStyle;
  panelColor: string;
  panelBorder: string;
  labelColor: string;
  showPacketStats: boolean;
}

export interface MacTheme {
  id: ThemeId;
  name: string;
  era: string;
  model: string;
  description: string;

  colors: ThemeColors;
  leds: ThemeLEDs;
  textures: ThemeTextures;
  fonts: ThemeFonts;
  badge: ThemeBadge;
  modem: ThemeModem;

  // CSS class suffix for theme-specific overrides
  className: string;
}

// Connection status types (matching DialtoneEthernet)
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// Network activity state for modem indicators
export interface NetworkActivityState {
  status: ConnectionStatus;
  txActive: boolean;
  rxActive: boolean;
  hdActive: boolean;
  packetsSent: number;
  packetsReceived: number;
  // Intensity values (0-1) for variable LED brightness
  txIntensity: number;
  rxIntensity: number;
  hdIntensity: number;
}
