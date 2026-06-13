/**
 * DisksTab Component
 *
 * Startup disk selection, data disks (local mode), create new disk form,
 * and cache management.
 */

import { memo, useCallback } from 'react';
import type { DiskInfo } from '../../../disk/types';
import type { StorageInfo } from '../../../settings';
import { CreateDiskForm } from '../../CreateDiskForm';
import { CacheSection } from '../CacheSection';

// Max data disks
const MAX_DATA_DISKS = 3;

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

interface DisksTabProps {
  bootDisk: string | null;
  dataDisks: string[];
  availableBootDisks: DiskInfo[];
  availableDataDisks: DiskInfo[];
  onBootDiskChange: (name: string) => void;
  onToggleDataDisk: (name: string) => void;
  onCreateDisk: (name: string, sizeBytes: number) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  isCreatingDisk: boolean;
  isLocalMode: boolean;
  // Cache management
  storageInfo: StorageInfo | null;
  onRefreshStorageInfo: () => Promise<void>;
  onClearCacheAndRestart: () => Promise<void>;
  isClearingCache: boolean;
}

export const DisksTab = memo(function DisksTab({
  bootDisk,
  dataDisks,
  availableBootDisks,
  availableDataDisks,
  onBootDiskChange,
  onToggleDataDisk,
  onCreateDisk,
  isLoading,
  error,
  isCreatingDisk,
  isLocalMode,
  storageInfo,
  onRefreshStorageInfo,
  onClearCacheAndRestart,
  isClearingCache,
}: DisksTabProps) {
  const handleRetry = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div className="tab-content" role="tabpanel" id="panel-disks" aria-labelledby="tab-disks">
      {/* Startup Disk Section */}
      <section className="settings-section">
        <div className="section-header">
          <h3 className="section-title">Startup Disk</h3>
          <span className="restart-badge" title="Requires restart">Restart</span>
        </div>

        {isLoading ? (
          <div className="loading-state">
            <div className="loading-spinner" />
            <span>Connecting to disk server...</span>
          </div>
        ) : error ? (
          <div className="error-state">
            <span className="error-message">{error}</span>
            <button className="retry-btn" onClick={handleRetry} type="button">
              Retry
            </button>
          </div>
        ) : availableBootDisks.length === 0 ? (
          <div className="empty-state">No bootable disks available</div>
        ) : (
          <div className="disk-list">
            {availableBootDisks.map((disk) => (
              <label
                key={disk.name}
                className={`disk-option ${bootDisk === disk.name ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="bootDisk"
                  checked={bootDisk === disk.name}
                  onChange={() => onBootDiskChange(disk.name)}
                />
                <span className="radio-indicator" />
                <span className="disk-name">{disk.name}</span>
                <span className="disk-size">{formatBytes(disk.size)}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      {/* Data Disks Section (local mode only) */}
      {isLocalMode && (
        <section className="settings-section">
          <div className="section-header">
            <h3 className="section-title">Data Disks</h3>
            <span className="section-count">{dataDisks.length} / {MAX_DATA_DISKS}</span>
          </div>
          <p className="section-hint">
            Select up to {MAX_DATA_DISKS} additional disks to mount alongside your startup disk.
          </p>

          {availableDataDisks.length === 0 ? (
            <div className="empty-state">
              No data disks available. Create one below.
            </div>
          ) : (
            <div className="disk-list">
              {availableDataDisks.map((disk) => {
                const isSelected = dataDisks.includes(disk.name);
                const isDisabled = !isSelected && dataDisks.length >= MAX_DATA_DISKS;
                return (
                  <label
                    key={disk.name}
                    className={`disk-option checkbox ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleDataDisk(disk.name)}
                      disabled={isDisabled}
                    />
                    <span className="checkbox-indicator" />
                    <span className="disk-name">{disk.name}</span>
                    <span className="disk-size">{formatBytes(disk.size)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Create New Disk Section (local mode only) */}
      {isLocalMode && (
        <section className="settings-section">
          <h3 className="section-title">Create New Disk</h3>
          <CreateDiskForm
            onSubmit={onCreateDisk}
            isCreating={isCreatingDisk}
          />
        </section>
      )}

      {/* Cache Management Section */}
      <CacheSection
        storageInfo={storageInfo}
        onRefreshStorageInfo={onRefreshStorageInfo}
        onClearCacheAndRestart={onClearCacheAndRestart}
        isClearingCache={isClearingCache}
      />
    </div>
  );
});

export default DisksTab;
