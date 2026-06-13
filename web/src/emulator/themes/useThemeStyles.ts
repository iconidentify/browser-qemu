/**
 * Theme Styles Hook
 *
 * Injects CSS custom properties based on the current theme.
 * This bridges the React theme system with CSS styling.
 * Also updates the iOS Safari status bar color meta tag.
 */

import { useEffect, useMemo } from 'react';
import type { MacTheme, ThemeId } from './types';

/**
 * Maps theme IDs to status bar colors for iOS Safari / Android Chrome
 */
const THEME_STATUS_BAR_COLORS: Record<ThemeId, string> = {
  iici: '#C8C0B4',        // Platinum
  classic: '#E8E2D8',     // Beige
  quadra700: '#D4D0C8',   // Light Gray
  performa630: '#D8D4CC', // Lighter Platinum
  powerbook140: '#4A4846', // Charcoal
  dark: '#141416',        // Near Black
  c89summer: '#0E0A22',   // Dusk Indigo
};

/**
 * Generates a noise texture SVG data URL for ABS plastic appearance
 */
function generateNoiseTexture(opacity: number, frequency: number): string {
  return `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='${opacity}'/%3E%3C/svg%3E")`;
}

/**
 * Hook to inject theme CSS variables into the document
 */
export function useThemeStyles(theme: MacTheme): void {
  const cssVars = useMemo(() => ({
    // Shell background
    '--shell-bg': theme.colors.shellBg,
    '--shell-bg-gradient': theme.colors.shellBgGradient || theme.colors.shellBg,

    // Housing colors
    '--housing-primary': theme.colors.housingPrimary,
    '--housing-light': theme.colors.housingLight,
    '--housing-lighter': theme.colors.housingLighter,
    '--housing-dark': theme.colors.housingDark,
    '--housing-darker': theme.colors.housingDarker,

    // Screen bezel
    '--screen-bezel': theme.colors.screenBezel,
    '--screen-inner': theme.colors.screenInner,
    '--screen-shadow': theme.colors.screenShadow,

    // Control strip
    '--control-bg': theme.colors.controlBg,
    '--control-border': theme.colors.controlBorder,
    '--control-hover': theme.colors.controlHover,

    // Text colors
    '--text-primary': theme.colors.textPrimary,
    '--text-secondary': theme.colors.textSecondary,
    '--text-dim': theme.colors.textDim,
    '--text-on-dark': theme.colors.textOnDark,

    // Accents
    '--accent-primary': theme.colors.accentPrimary,
    '--accent-secondary': theme.colors.accentSecondary,
    '--accent-warning': theme.colors.accentWarning,
    '--accent-error': theme.colors.accentError,

    // Panels
    '--panel-bg': theme.colors.panelBg,
    '--panel-border': theme.colors.panelBorder,
    '--card-bg': theme.colors.cardBg,

    // LED colors
    '--led-power-off': theme.leds.power.off,
    '--led-power-on': theme.leds.power.on,
    '--led-power-glow': theme.leds.power.glow,

    '--led-network-disconnected': theme.leds.network.disconnected,
    '--led-network-connected': theme.leds.network.connected,
    '--led-network-connecting': theme.leds.network.connecting,
    '--led-network-glow': theme.leds.network.glow,

    '--led-tx-idle': theme.leds.tx.idle,
    '--led-tx-active': theme.leds.tx.active,
    '--led-tx-glow': theme.leds.tx.glow,

    '--led-rx-idle': theme.leds.rx.idle,
    '--led-rx-active': theme.leds.rx.active,
    '--led-rx-glow': theme.leds.rx.glow,

    '--led-activity-idle': theme.leds.activity.idle,
    '--led-activity-active': theme.leds.activity.active,
    '--led-activity-glow': theme.leds.activity.glow,

    // Textures
    '--noise-texture': generateNoiseTexture(theme.textures.noiseOpacity, theme.textures.noiseFrequency),
    '--noise-opacity': String(theme.textures.noiseOpacity),
    '--highlight-intensity': String(theme.textures.highlightIntensity),
    '--chamfer-size': `${theme.textures.chamferSize}px`,
    '--screen-radius': `${theme.textures.screenRadius}px`,
    '--vent-color': theme.textures.ventColor,
    '--vent-shadow': theme.textures.ventShadow,

    // Fonts
    '--font-badge': theme.fonts.badge,
    '--font-ui': theme.fonts.ui,
    '--font-mono': theme.fonts.mono,
    '--font-badge-size': theme.fonts.badgeSize,
    '--font-label-size': theme.fonts.labelSize,

    // Modem panel
    '--modem-panel-color': theme.modem.panelColor,
    '--modem-panel-border': theme.modem.panelBorder,
    '--modem-label-color': theme.modem.labelColor,
  }), [theme]);

  useEffect(() => {
    const root = document.documentElement;

    // Set all CSS variables
    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });

    // Add theme class to body for theme-specific overrides
    document.body.className = document.body.className
      .replace(/theme-\w+/g, '')
      .trim() + ' ' + theme.className;

    // Update theme-color meta tags for iOS Safari / Android Chrome status bar
    // NOTE: Safari has a bug where it only reads theme-color on initial page load
    // and ignores setAttribute() updates. We must REMOVE and RECREATE the meta tags
    // to force Safari to re-read them.
    const statusBarColor = THEME_STATUS_BAR_COLORS[theme.id] || theme.colors.shellBg;
    const isDarkTheme = theme.id === 'dark' || theme.id === 'powerbook140' || theme.id === 'c89summer';

    // Remove ALL old theme-color meta tags (Safari won't respond to setAttribute)
    const oldMetaTags = document.querySelectorAll('meta[name="theme-color"]');
    oldMetaTags.forEach(tag => tag.remove());

    // Create new meta tags with media queries (forces Safari to re-read)
    // Light mode meta tag
    const metaLight = document.createElement('meta');
    metaLight.name = 'theme-color';
    metaLight.content = statusBarColor;
    metaLight.media = '(prefers-color-scheme: light)';
    document.head.appendChild(metaLight);

    // Dark mode meta tag
    const metaDark = document.createElement('meta');
    metaDark.name = 'theme-color';
    metaDark.content = isDarkTheme ? statusBarColor : THEME_STATUS_BAR_COLORS.dark;
    metaDark.media = '(prefers-color-scheme: dark)';
    document.head.appendChild(metaDark);

    // Also create a fallback without media query for browsers that don't support it
    const metaFallback = document.createElement('meta');
    metaFallback.name = 'theme-color';
    metaFallback.content = statusBarColor;
    document.head.appendChild(metaFallback);

    // Also update html AND body background as fallback
    // Safari auto-detects colors from visible elements at the top of the viewport
    document.documentElement.style.backgroundColor = statusBarColor;
    document.body.style.backgroundColor = statusBarColor;

    // Cleanup function
    return () => {
      Object.keys(cssVars).forEach(key => {
        root.style.removeProperty(key);
      });
    };
  }, [cssVars, theme.className, theme.id, theme.colors.shellBg]);
}

/**
 * Get CSS variable value helper (for components that need direct access)
 */
export function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
