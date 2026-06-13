/**
 * Settings Modal
 *
 * Tabbed settings interface with three sections:
 * - General: Display settings and appearance (theme)
 * - Disks: Startup disk, data disks, create new disk
 * - Advanced: Network zone, performance, storage mode
 *
 * Features:
 * - Accessible tab navigation with ARIA attributes
 * - Keyboard navigation (arrow keys for tabs, Escape to close)
 * - Unsaved changes confirmation
 * - Restart indicators for settings that require restart
 * - Live updates for scale and theme
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useDiskSettings, type ScreenResolution, type DisplayScale } from '../../settings';
import { useMobileDetection } from '../../hooks/useMobileDetection';
import type { DiskStorageMode } from '../../disk/types';
import { TabBar, type TabId } from './TabBar';
import { GeneralTab } from './tabs/GeneralTab';
import { DisksTab } from './tabs/DisksTab';
import { AdvancedTab } from './tabs/AdvancedTab';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReboot: () => void;
}

// Check if running in local mode
const isLocalMode = import.meta.env.VITE_LOCAL_MODE === 'true';

// Tab configuration
const TABS = [
  { id: 'general' as const, label: 'General' },
  { id: 'disks' as const, label: 'Disks' },
  { id: 'advanced' as const, label: 'Advanced' },
];

/**
 * Settings Modal Component
 */
export const SettingsModal = memo(function SettingsModal({
  isOpen,
  onClose,
  onReboot,
}: SettingsModalProps) {
  const {
    mode: savedMode,
    bootDisk: savedBootDisk,
    dataDisks: savedDataDisks,
    networkZone: savedNetworkZone,
    jit: savedJit,
    resolution: savedResolution,
    displayScale: savedDisplayScale,
    hardwareCursor,
    cursorScale,
    availableBootDisks,
    availableDataDisks,
    createDisk,
    refreshDiskList,
    saveAndRestart,
    setDisplayScale,
    setHardwareCursor,
    setCursorScale,
    storageInfo,
    refreshStorageInfo,
    clearCacheAndRestart,
    isClearingCache,
    isLoading,
    error,
    isCreatingDisk,
  } = useDiskSettings();

  const { isMobile } = useMobileDetection();

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabId>('general');

  // Local editing state - changes here don't affect the running emulator
  const [localMode, setLocalMode] = useState<DiskStorageMode>(savedMode);
  const [localBootDisk, setLocalBootDisk] = useState<string | null>(savedBootDisk);
  const [localDataDisks, setLocalDataDisks] = useState<string[]>(savedDataDisks);
  const [localNetworkZone, setLocalNetworkZone] = useState<string>(savedNetworkZone);
  const [localJit, setLocalJit] = useState<boolean>(savedJit);
  const [localResolution, setLocalResolution] = useState<ScreenResolution>(savedResolution);
  const [localScale, setLocalScale] = useState<DisplayScale>(savedDisplayScale);

  // Confirmation dialog state
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  // Track previous isOpen to detect open transition
  const wasOpen = useRef(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Reset local state when modal opens
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      // Modal just opened - refresh disk list and reset local state
      setActiveTab('general'); // Always open to General tab
      setLocalMode(savedMode);
      setLocalBootDisk(savedBootDisk);
      setLocalDataDisks(savedDataDisks);
      setLocalNetworkZone(savedNetworkZone);
      setLocalJit(savedJit);
      setLocalResolution(savedResolution);
      setLocalScale(savedDisplayScale);
      refreshDiskList();
    }
    wasOpen.current = isOpen;
  }, [isOpen, savedMode, savedBootDisk, savedDataDisks, savedNetworkZone, savedJit, savedResolution, savedDisplayScale, refreshDiskList]);

  // Focus trap and keyboard handling
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCloseAttempt();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Check if there are unsaved changes that require restart
  const hasRestartChanges =
    localMode !== savedMode ||
    localBootDisk !== savedBootDisk ||
    JSON.stringify(localDataDisks) !== JSON.stringify(savedDataDisks) ||
    localNetworkZone !== savedNetworkZone ||
    localJit !== savedJit ||
    localResolution !== savedResolution;

  // Handle close attempt - show confirmation if unsaved changes
  const handleCloseAttempt = useCallback(() => {
    if (hasRestartChanges) {
      setShowConfirmDialog(true);
    } else {
      onClose();
    }
  }, [hasRestartChanges, onClose]);

  // Handle confirmed close (discard changes)
  const handleConfirmedClose = useCallback(() => {
    setShowConfirmDialog(false);
    onClose();
  }, [onClose]);

  // Handle restart - save changes and reload
  const handleSaveAndRestart = useCallback(() => {
    saveAndRestart(localMode, localBootDisk, localDataDisks, localNetworkZone, localJit, localResolution);
    onClose();
    setTimeout(() => onReboot(), 100);
  }, [saveAndRestart, localMode, localBootDisk, localDataDisks, localNetworkZone, localJit, localResolution, onClose, onReboot]);

  // Handle scale change - applies immediately
  const handleScaleChange = useCallback((scale: DisplayScale) => {
    setLocalScale(scale);
    setDisplayScale(scale);
  }, [setDisplayScale]);

  // Toggle a data disk in local state
  const handleToggleDataDisk = useCallback((name: string) => {
    setLocalDataDisks(current => {
      const index = current.indexOf(name);
      if (index >= 0) {
        return current.filter(d => d !== name);
      }
      if (current.length >= 3) {
        return current;
      }
      return [...current, name];
    });
  }, []);

  // Handle backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleCloseAttempt();
    }
  }, [handleCloseAttempt]);

  if (!isOpen) return null;

  return (
    <div className="settings-modal-overlay" onClick={handleBackdropClick}>
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        {/* Header */}
        <div className="settings-modal-header">
          <div className="header-title">
            <h2 id="settings-title">Settings</h2>
            {isLocalMode && <span className="dev-badge">DEV</span>}
          </div>
          <button
            className="close-btn"
            onClick={handleCloseAttempt}
            type="button"
            aria-label="Close settings"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </div>

        {/* Tab Bar */}
        <TabBar
          tabs={TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {/* Tab Content */}
        <div className="settings-modal-content">
          {activeTab === 'general' && (
            <GeneralTab
              resolution={localResolution}
              scale={localScale}
              hardwareCursor={hardwareCursor}
              cursorScale={cursorScale}
              onResolutionChange={setLocalResolution}
              onScaleChange={handleScaleChange}
              onHardwareCursorChange={setHardwareCursor}
              onCursorScaleChange={setCursorScale}
              isMobile={isMobile}
            />
          )}
          {activeTab === 'disks' && (
            <DisksTab
              bootDisk={localBootDisk}
              dataDisks={localDataDisks}
              availableBootDisks={availableBootDisks}
              availableDataDisks={availableDataDisks}
              onBootDiskChange={setLocalBootDisk}
              onToggleDataDisk={handleToggleDataDisk}
              onCreateDisk={createDisk}
              isLoading={isLoading}
              error={error}
              isCreatingDisk={isCreatingDisk}
              isLocalMode={isLocalMode}
              storageInfo={storageInfo}
              onRefreshStorageInfo={refreshStorageInfo}
              onClearCacheAndRestart={clearCacheAndRestart}
              isClearingCache={isClearingCache}
            />
          )}
          {activeTab === 'advanced' && (
            <AdvancedTab
              networkZone={localNetworkZone}
              jit={localJit}
              mode={localMode}
              onNetworkZoneChange={setLocalNetworkZone}
              onJitChange={setLocalJit}
              onModeChange={setLocalMode}
              isLocalMode={isLocalMode}
            />
          )}
        </div>

        {/* Footer */}
        <div className="settings-modal-footer">
          {hasRestartChanges ? (
            <button
              className="save-restart-btn"
              onClick={handleSaveAndRestart}
              type="button"
            >
              Save &amp; Restart
            </button>
          ) : (
            <span className="no-changes-hint">No changes</span>
          )}
        </div>

        {/* Unsaved Changes Confirmation Dialog */}
        {showConfirmDialog && (
          <div className="confirm-dialog-overlay" onClick={() => setShowConfirmDialog(false)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>Unsaved Changes</h3>
              <p>You have unsaved changes that require a restart. Close anyway?</p>
              <div className="confirm-actions">
                <button
                  className="confirm-btn secondary"
                  onClick={() => setShowConfirmDialog(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="confirm-btn primary"
                  onClick={handleConfirmedClose}
                  type="button"
                >
                  Discard Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default SettingsModal;
