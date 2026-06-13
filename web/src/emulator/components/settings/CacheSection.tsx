/**
 * CacheSection Component
 *
 * Displays storage usage and provides cache clearing functionality.
 * Located at the bottom of the Disks tab.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import type { StorageInfo } from '../../settings';

interface CacheSectionProps {
  storageInfo: StorageInfo | null;
  onRefreshStorageInfo: () => Promise<void>;
  onClearCacheAndRestart: () => Promise<void>;
  isClearingCache: boolean;
}

/**
 * Format bytes for display
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const CacheSection = memo(function CacheSection({
  storageInfo,
  onRefreshStorageInfo,
  onClearCacheAndRestart,
  isClearingCache,
}: CacheSectionProps) {
  // Confirmation state for clear all
  const [showConfirm, setShowConfirm] = useState(false);

  // Fetch storage info on mount
  useEffect(() => {
    onRefreshStorageInfo();
  }, [onRefreshStorageInfo]);

  // Reset confirmation after timeout
  useEffect(() => {
    if (showConfirm) {
      const timer = setTimeout(() => setShowConfirm(false), 4000);
      return () => clearTimeout(timer);
    }
  }, [showConfirm]);

  const handleClearClick = useCallback(() => {
    if (showConfirm) {
      // Second click - actually clear
      onClearCacheAndRestart();
    } else {
      // First click - show confirmation
      setShowConfirm(true);
    }
  }, [showConfirm, onClearCacheAndRestart]);

  const handleCancel = useCallback(() => {
    setShowConfirm(false);
  }, []);

  return (
    <section className="settings-section cache-section">
      <h3 className="section-title">Local Storage</h3>
      <p className="section-hint">
        Disk images are cached locally for faster loading. Clear the cache to free up space or fix issues.
      </p>

      {/* Storage bar */}
      <div className="storage-summary">
        {storageInfo ? (
          <>
            <div className="storage-bar-container">
              <div
                className={`storage-bar ${storageInfo.percentage > 80 ? 'warning' : ''}`}
                style={{ '--storage-percentage': `${Math.min(storageInfo.percentage, 100)}%` } as React.CSSProperties}
              />
            </div>
            <div className="storage-text">
              <span className="storage-used">{formatBytes(storageInfo.used)}</span>
              <span className="storage-separator"> of </span>
              <span className="storage-total">{formatBytes(storageInfo.quota)}</span>
            </div>
          </>
        ) : (
          <div className="storage-loading">
            <div className="loading-spinner" />
            <span>Checking storage...</span>
          </div>
        )}
      </div>

      {/* Clear cache button with inline confirmation */}
      <div className="cache-actions">
        {showConfirm ? (
          <div className="confirm-inline">
            <span className="confirm-text">Clear all cached data?</span>
            <button
              className="confirm-btn-inline destructive"
              onClick={handleClearClick}
              disabled={isClearingCache}
              type="button"
            >
              {isClearingCache ? 'Clearing...' : 'Clear & Restart'}
            </button>
            <button
              className="confirm-btn-inline cancel"
              onClick={handleCancel}
              disabled={isClearingCache}
              type="button"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="clear-cache-btn"
            onClick={handleClearClick}
            disabled={isClearingCache || !storageInfo}
            type="button"
          >
            Clear Cache & Restart
          </button>
        )}
      </div>
    </section>
  );
});

export default CacheSection;
