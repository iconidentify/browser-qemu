/**
 * GeneralTab Component
 *
 * Display settings (resolution, scale, cursor) and Appearance (theme grid).
 * Scale and cursor apply live, resolution requires restart.
 */

import { memo } from 'react';
import {
  RESOLUTION_OPTIONS,
  SCALE_OPTIONS,
  CURSOR_SCALE_OPTIONS,
  type ScreenResolution,
  type DisplayScale,
  type CursorScale,
} from '../../../settings';
import { ThemeGrid } from '../ThemeGrid';

interface GeneralTabProps {
  resolution: ScreenResolution;
  scale: DisplayScale;
  hardwareCursor: boolean;
  cursorScale: CursorScale;
  onResolutionChange: (res: ScreenResolution) => void;
  onScaleChange: (scale: DisplayScale) => void;
  onHardwareCursorChange: (enabled: boolean) => void;
  onCursorScaleChange: (scale: CursorScale) => void;
  isMobile: boolean;
}

export const GeneralTab = memo(function GeneralTab({
  resolution,
  scale,
  hardwareCursor,
  cursorScale,
  onResolutionChange,
  onScaleChange,
  onHardwareCursorChange,
  onCursorScaleChange,
  isMobile,
}: GeneralTabProps) {
  return (
    <div className="tab-content" role="tabpanel" id="panel-general" aria-labelledby="tab-general">
      {/* Display Section - Desktop only */}
      {!isMobile && (
        <section className="settings-section">
          <h3 className="section-title">Display</h3>

          {/* Resolution */}
          <div className="setting-group">
            <div className="setting-label">
              <span>Resolution</span>
              <span className="restart-badge" title="Requires restart">Restart</span>
            </div>
            <div className="radio-group">
              {RESOLUTION_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`radio-option ${resolution === option.value ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolution === option.value}
                    onChange={() => onResolutionChange(option.value)}
                  />
                  <span className="radio-indicator" />
                  <span className="radio-label">{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div className="setting-group">
            <div className="setting-label">
              <span>Scale</span>
              <span className="live-badge" title="Applies immediately">Live</span>
            </div>
            <div className="radio-group">
              {SCALE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`radio-option ${scale === option.value ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="scale"
                    checked={scale === option.value}
                    onChange={() => onScaleChange(option.value)}
                  />
                  <span className="radio-indicator" />
                  <span className="radio-label">{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Cursor Section */}
      <section className="settings-section">
        <h3 className="section-title">Cursor</h3>

        {/* Hardware Cursor Toggle */}
        <div className="setting-group">
          <div className="checkbox-group">
            <label className={`checkbox-option toggle ${hardwareCursor ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={hardwareCursor}
                onChange={(e) => onHardwareCursorChange(e.target.checked)}
              />
              <span className="checkbox-indicator" />
              <div className="option-content">
                <div className="option-title-row">
                  <span className="option-title">Hardware Cursor</span>
                  <span className="live-badge" title="Applies immediately">Live</span>
                </div>
                <span className="option-desc">
                  {isMobile
                    ? 'Shows a cursor overlay on the screen. Disable to see the Mac-rendered cursor in the video frame.'
                    : 'Renders the Mac cursor as a native browser cursor overlay. Stays perfectly smooth even when the emulator is under heavy load. Disable for authentic software-rendered cursor that matches VM frame rate.'}
                </span>
              </div>
            </label>
          </div>
        </div>

        {/* Cursor Size - only show when hardware cursor is enabled */}
        {hardwareCursor && (
          <div className="setting-group">
            <div className="setting-label">
              <span>Cursor Size</span>
              <span className="live-badge" title="Applies immediately">Live</span>
            </div>
            <div className="radio-group">
              {CURSOR_SCALE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`radio-option ${cursorScale === option.value ? 'selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="cursorScale"
                    checked={cursorScale === option.value}
                    onChange={() => onCursorScaleChange(option.value)}
                  />
                  <span className="radio-indicator" />
                  <span className="radio-label">{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Appearance Section */}
      <section className="settings-section">
        <h3 className="section-title">Appearance</h3>
        <p className="section-hint">Select a theme. Changes apply immediately.</p>
        <ThemeGrid />
      </section>
    </div>
  );
});

export default GeneralTab;
