/**
 * ThemeGrid Component
 *
 * Compact grid of theme preview cards for the General tab.
 * Based on ThemeSwitcher but integrated into the settings modal.
 */

import { memo, useCallback } from 'react';
import { useTheme, themes, type MacTheme, type ThemeId } from '../../themes';

/**
 * Theme Preview Card
 */
const ThemeCard = memo(function ThemeCard({
  theme,
  isSelected,
  onSelect,
}: {
  theme: MacTheme;
  isSelected: boolean;
  onSelect: (id: ThemeId) => void;
}) {
  const handleClick = useCallback(() => {
    onSelect(theme.id);
  }, [theme.id, onSelect]);

  return (
    <button
      className={`theme-card-compact ${isSelected ? 'selected' : ''} ${theme.className}`}
      onClick={handleClick}
      type="button"
      aria-pressed={isSelected}
    >
      {/* Theme preview mini-frame */}
      <div
        className="theme-preview-compact"
        style={{
          '--preview-housing': theme.colors.housingPrimary,
          '--preview-bezel': theme.colors.screenBezel,
          '--preview-screen': theme.colors.screenInner,
          '--preview-control': theme.colors.controlBg,
        } as React.CSSProperties}
      >
        <div className="preview-housing-compact">
          <div className="preview-vents-compact">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="preview-vent-compact" />
            ))}
          </div>
          <div className="preview-bezel-compact">
            <div className="preview-screen-compact" />
          </div>
          <div className="preview-control-compact">
            <div className="preview-led-compact active" />
          </div>
        </div>
      </div>

      {/* Theme name */}
      <span className="theme-name-compact">{theme.name}</span>

      {/* Selection indicator */}
      {isSelected && (
        <div className="theme-check-compact">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M5 12l5 5L19 7" />
          </svg>
        </div>
      )}
    </button>
  );
});

/**
 * Theme Grid for Settings
 */
export const ThemeGrid = memo(function ThemeGrid() {
  const { currentTheme, setTheme } = useTheme();

  const handleSelect = useCallback((id: ThemeId) => {
    setTheme(id);
  }, [setTheme]);

  return (
    <div className="theme-grid-compact">
      {themes.map((theme) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          isSelected={currentTheme.id === theme.id}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
});

export default ThemeGrid;
