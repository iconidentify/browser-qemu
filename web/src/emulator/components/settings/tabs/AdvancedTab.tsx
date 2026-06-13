/**
 * AdvancedTab Component
 *
 * Network zone, performance (JIT), storage mode, and cache persistence settings.
 * In production mode, only shows Network Zone for multiplayer.
 */

import { memo, useCallback, useState } from 'react';
import type { DiskStorageMode } from '../../../disk/types';
import { storageManager, type PersistenceMode } from '../../../services/StorageManager';

/**
 * Generate a shareable URL with the current zone
 */
function generateZoneLink(zone: string): string {
  const url = new URL(window.location.href);
  // Clear existing params and set only zone
  url.search = '';
  if (zone) {
    url.searchParams.set('zone', zone);
  }
  return url.toString();
}

interface AdvancedTabProps {
  networkZone: string;
  jit: boolean;
  mode: DiskStorageMode;
  onNetworkZoneChange: (zone: string) => void;
  onJitChange: (enabled: boolean) => void;
  onModeChange: (mode: DiskStorageMode) => void;
  isLocalMode: boolean;
}

export const AdvancedTab = memo(function AdvancedTab({
  networkZone,
  jit,
  mode,
  onNetworkZoneChange,
  onJitChange,
  onModeChange,
  isLocalMode,
}: AdvancedTabProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>(() =>
    storageManager.getPersistenceMode()
  );

  // Sync persistence mode to StorageManager when changed
  const handlePersistenceModeChange = useCallback((newMode: PersistenceMode) => {
    setPersistenceMode(newMode);
    storageManager.setPersistenceMode(newMode);
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (!networkZone) return;

    const link = generateZoneLink(networkZone);
    try {
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = link;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }, [networkZone]);

  return (
    <div className="tab-content" role="tabpanel" id="panel-advanced" aria-labelledby="tab-advanced">
      {/* Network Zone Section */}
      <section className="settings-section">
        <div className="section-header">
          <h3 className="section-title">Network Zone</h3>
          <span className="restart-badge" title="Requires restart">Restart</span>
        </div>
        <p className="section-hint">
          Enter a zone name to play multiplayer with others using the same zone.
          Leave empty for a private session.
        </p>
        <div className="input-group">
          <input
            type="text"
            className="text-input"
            value={networkZone}
            onChange={(e) => onNetworkZoneChange(e.target.value)}
            placeholder="e.g., warcraft-party"
            maxLength={32}
          />
          {networkZone && (
            <span className="input-badge">Custom</span>
          )}
        </div>

        {/* Copy invite link */}
        {networkZone && (
          <div className="invite-link-section">
            <p className="section-hint">
              Share this link to invite others to your zone:
            </p>
            <div className="invite-link-row">
              <code className="invite-link-preview">
                {generateZoneLink(networkZone)}
              </code>
              <button
                type="button"
                className={`copy-link-btn ${copyState === 'copied' ? 'copied' : ''}`}
                onClick={handleCopyLink}
                aria-label="Copy invite link"
              >
                {copyState === 'copied' ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                    Copy Link
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Performance Section (local mode only in full, production shows minimal) */}
      {isLocalMode && (
        <section className="settings-section">
          <div className="section-header">
            <h3 className="section-title">Performance</h3>
            <span className="restart-badge" title="Requires restart">Restart</span>
          </div>
          <div className="checkbox-group">
            <label className={`checkbox-option toggle ${jit ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={jit}
                onChange={(e) => onJitChange(e.target.checked)}
              />
              <span className="checkbox-indicator" />
              <div className="option-content">
                <span className="option-title">JIT Compilation</span>
                <span className="option-desc">
                  Enable dynamic recompilation for faster emulation.
                  Disable if you experience crashes or compatibility issues.
                </span>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* Storage Mode Section (local mode only) */}
      {isLocalMode && (
        <section className="settings-section">
          <div className="section-header">
            <h3 className="section-title">Storage Mode</h3>
            <span className="restart-badge" title="Requires restart">Restart</span>
          </div>
          <div className="radio-group vertical">
            <label className={`radio-option detailed ${mode === 'client-cached' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageMode"
                checked={mode === 'client-cached'}
                onChange={() => onModeChange('client-cached')}
              />
              <span className="radio-indicator" />
              <div className="option-content">
                <span className="option-title">Client Cached</span>
                <span className="option-desc">
                  Disk data cached locally in browser. Faster after initial load. Works offline once cached.
                </span>
              </div>
            </label>

            <label className={`radio-option detailed ${mode === 'disk-server' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageMode"
                checked={mode === 'disk-server'}
                onChange={() => onModeChange('disk-server')}
              />
              <span className="radio-indicator" />
              <div className="option-content">
                <span className="option-title">Disk Server</span>
                <span className="option-desc">
                  All disk I/O goes to relay server. Direct read/write to disk image. Requires active connection.
                </span>
              </div>
            </label>
          </div>
        </section>
      )}

      {/* Cache Persistence Section - only relevant for client-cached mode */}
      <section className={`settings-section ${mode === 'disk-server' ? 'disabled-section' : ''}`}>
        <div className="section-header">
          <h3 className="section-title">Cache Persistence</h3>
          {mode === 'client-cached' && (
            <span className="restart-badge" title="Takes effect on next reload">Reload</span>
          )}
        </div>
        {mode === 'disk-server' ? (
          <p className="section-hint disabled-hint">
            Cache persistence only applies to Client Cached mode. In Disk Server mode, all data is read/written directly to the server.
          </p>
        ) : (
          <p className="section-hint">
            Controls whether the disk cache persists between page reloads.
          </p>
        )}
        <div className="radio-group vertical">
          <label className={`radio-option detailed ${persistenceMode === 'ephemeral' ? 'selected' : ''} ${mode === 'disk-server' ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="persistenceMode"
              checked={persistenceMode === 'ephemeral'}
              onChange={() => handlePersistenceModeChange('ephemeral')}
              disabled={mode === 'disk-server'}
            />
            <span className="radio-indicator" />
            <div className="option-content">
              <span className="option-title">Fresh Start (Recommended)</span>
              <span className="option-desc">
                Each page refresh starts with a clean cache. Most reliable - fixes most boot issues.
              </span>
            </div>
          </label>

          <label className={`radio-option detailed ${persistenceMode === 'persistent' ? 'selected' : ''} ${mode === 'disk-server' ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="persistenceMode"
              checked={persistenceMode === 'persistent'}
              onChange={() => handlePersistenceModeChange('persistent')}
              disabled={mode === 'disk-server'}
            />
            <span className="radio-indicator" />
            <div className="option-content">
              <span className="option-title">Persistent Cache (Experimental)</span>
              <span className="option-desc">
                Disk cache survives page reloads for faster subsequent loads.
                May require manual cache clear if issues occur.
              </span>
            </div>
          </label>
        </div>
      </section>
    </div>
  );
});

export default AdvancedTab;
