/**
 * EmulatorShell - Quadra 700 workstation housing
 *
 * A period-accurate 1991 setup: platinum monitor on a tilt-swivel stand
 * with a Quadra 700 mini-tower standing beside it.
 *
 * Features:
 * - Swappable color themes
 * - Tower LED cluster (PWR, HD, TX, RX)
 * - Vertical SuperDrive slot and six-color logo on the tower
 * - Volume control knob and VU meter on the tower control panel
 * - DIALTONE wordmark on the monitor chin
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { EmulatorCanvas, EmulatorStatus, type EmulatorCanvasHandle, type VUMeterData } from './EmulatorCanvas';
import { defaultRelayUrl, type ConnectionStatus } from './DialtoneEthernet';
import { useTheme, useThemeStyles } from './themes';
import { useDiskSettings, getResolutionDimensions } from './settings';
import { SettingsModal } from './components/settings';
import { VolumeKnob } from './components/VolumeKnob';
import { VUMeter } from './components/VUMeter';
import { CpuLoadGraph } from './components/CpuLoadGraph';
import { FileTransferDropZone } from './components/FileTransferDropZone';
import { FileTransferModal } from './components/FileTransferModal';
import { useFileTransfer } from './hooks/useFileTransfer';
import { useFullscreen } from './hooks/useFullscreen';
import './EmulatorShell.css';

interface EmulatorShellProps {
  defaultDiskPath?: string;
  defaultRomPath?: string;
  relayUrl?: string;
}

export function EmulatorShell({
  defaultDiskPath = '/disk/dialtone-system.dsk',
  defaultRomPath = '/rom/quadra650.rom',
  relayUrl = defaultRelayUrl()
}: EmulatorShellProps) {
  const {
    currentTheme,
    networkActivity,
    setNetworkStatus,
    incrementPacketsSent,
    incrementPacketsReceived,
    triggerHd,
  } = useTheme();

  useThemeStyles(currentTheme);

  // Local mode check (file transfer only available in dev)
  const isLocalMode = import.meta.env.VITE_LOCAL_MODE === 'true';

  // Disk settings
  const { mode: diskMode, bootDisk, dataDisks, networkZone, jit, resolution, displayScale, hardwareCursor, cursorScale, addTransferDisk, isLoading: isLoadingDiskSettings, error: diskSettingsError } = useDiskSettings();

  // Core selection: ?core=qemu drives the page-hosted QEMU A/UX core; anything
  // else (default) drives the worker-hosted Basilisk II core. Both render through
  // this same shell + theme + SAB display contract.
  const coreId = useMemo(() => {
    if (typeof window === 'undefined') return 'basilisk';
    return new URLSearchParams(window.location.search).get('core') || 'basilisk';
  }, []);
  const isQemu = coreId === 'qemu';

  // Compute screen dimensions from resolution. QEMU's A/UX boots at the Quadra
  // 800 framebuffer's native 1152x870, so pin the screen to it for that core.
  const { width: resWidth, height: resHeight } = getResolutionDimensions(resolution);
  const screenWidth = isQemu ? 1152 : resWidth;
  const screenHeight = isQemu ? 870 : resHeight;

  // Track if we've completed initial disk settings load
  // Once loaded, don't unmount emulator for subsequent refreshes (e.g., when Settings modal opens)
  const hasInitiallyLoaded = useRef(false);
  if (bootDisk !== null && !isLoadingDiskSettings) {
    hasInitiallyLoaded.current = true;
  }

  // Track if disk settings loading has timed out (10 second timeout)
  const [diskSettingsTimeout, setDiskSettingsTimeout] = useState(false);
  useEffect(() => {
    if (isLoadingDiskSettings || bootDisk !== null) {
      setDiskSettingsTimeout(false);
      return;
    }
    // Start timeout timer if we're waiting for disk settings
    const timer = setTimeout(() => {
      setDiskSettingsTimeout(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, [isLoadingDiskSettings, bootDisk]);

  // Wait for disk settings to be resolved before showing emulator
  // Once initially loaded, don't unmount for subsequent refreshes (Settings modal opening)
  // The QEMU core boots from its own range-served lazy disk and does not use the
  // relay's disk list, so it is always "ready" and never blocked by disk-server errors.
  const isDiskSettingsReady = isQemu || hasInitiallyLoaded.current || (!isLoadingDiskSettings && bootDisk !== null && !diskSettingsError);
  const hasDiskSettingsError = !isQemu && !hasInitiallyLoaded.current && (diskSettingsError || diskSettingsTimeout);

  // Build disk paths array (boot disk first, then data disks)
  // Memoized to prevent unnecessary effect re-runs in EmulatorCanvas
  const diskPaths = useMemo(() => [
    bootDisk ? `/disk/${bootDisk}` : defaultDiskPath,
    ...dataDisks.map(d => `/disk/${d}`)
  ], [bootDisk, dataDisks, defaultDiskPath]);

  // Refs
  const emulatorRef = useRef<EmulatorCanvasHandle>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  // Fullscreen (keyboard lock is opt-in via separate button)
  const {
    isFullscreen,
    isKeyboardLocked,
    isKeyboardLockSupported,
    toggleFullscreen,
    lockKeyboard,
    unlockKeyboard,
  } = useFullscreen({
    elementRef: shellRef,
    lockKeyboard: false, // Don't auto-lock, let user opt-in
  });

  // Toggle keyboard lock (only available in fullscreen)
  const handleToggleKeyboardLock = useCallback(() => {
    if (isKeyboardLocked) {
      unlockKeyboard();
    } else {
      lockKeyboard();
    }
  }, [isKeyboardLocked, lockKeyboard, unlockKeyboard]);

  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [powerOn, setPowerOn] = useState(true);
  const [powerToggleDisabled, setPowerToggleDisabled] = useState(false);

  // Audio state
  const [volume, setVolume] = useState(1.0);
  const [vuMeterData, setVuMeterData] = useState<VUMeterData | null>(null);

  // CPU load history for the tower's LED graph (~2 samples/second from the worker)
  const CPU_HISTORY_LENGTH = 16;
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const handleCpuLoad = useCallback((load: number) => {
    setCpuHistory(prev => [...prev.slice(-(CPU_HISTORY_LENGTH - 1)), load]);
  }, []);

  // File transfer state
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const {
    transferFiles,
    stage: transferStage,
    progress: transferProgress,
    result: transferResult,
    error: transferError,
    reset: resetTransfer,
    isTransferring,
  } = useFileTransfer();

  // Handle files dropped on the emulator
  const handleFilesDropped = useCallback((files: File[]) => {
    setTransferModalOpen(true);
    transferFiles(files);
  }, [transferFiles]);

  // Handle restart after file transfer
  const handleTransferRestart = useCallback(() => {
    if (transferResult?.diskName) {
      addTransferDisk(transferResult.diskName);
    }
  }, [transferResult, addTransferDisk]);

  // Handle closing the transfer modal
  const handleTransferModalClose = useCallback(() => {
    setTransferModalOpen(false);
    resetTransfer();
  }, [resetTransfer]);

  const handleNetworkStatusChange = useCallback((newStatus: ConnectionStatus) => {
    setNetworkStatus(newStatus);
  }, [setNetworkStatus]);

  const handlePacketSent = useCallback(() => {
    incrementPacketsSent();
  }, [incrementPacketsSent]);

  const handlePacketReceived = useCallback(() => {
    incrementPacketsReceived();
  }, [incrementPacketsReceived]);

  const handleStatusChange = useCallback((newStatus: EmulatorStatus) => {
    if (newStatus === 'ready') {
      setPowerOn(true);
    }
  }, []);

  const handlePowerToggle = useCallback(() => {
    if (powerToggleDisabled) return;
    // Debounce power toggle to prevent rapid cycling which can cause race conditions
    setPowerToggleDisabled(true);
    setCpuHistory([]);
    setPowerOn(prev => !prev);
    // Re-enable after 1 second (allows cleanup and re-init to complete)
    setTimeout(() => setPowerToggleDisabled(false), 1000);
  }, [powerToggleDisabled]);

  // Volume control
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
    emulatorRef.current?.setVolume(newVolume);
  }, []);

  // VU meter updates
  const handleVUMeterUpdate = useCallback((data: VUMeterData) => {
    setVuMeterData(data);
  }, []);

  // Reboot handler - reload the page with new settings
  const handleReboot = useCallback(() => {
    window.location.reload();
  }, []);

  // Close handlers - memoized to prevent effect re-runs
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  return (
    <div
      ref={shellRef}
      className={`emulator-shell ${currentTheme.className}${isFullscreen ? ' fullscreen-mode' : ''}`}
    >
      <div className="quadra-setup">
        {/* Monitor on its tilt-swivel stand */}
        <div className="monitor-column">
          <div className="emulator-housing monitor-unit">
            <FileTransferDropZone
              onFilesDropped={handleFilesDropped}
              disabled={!isLocalMode || isTransferring || !isDiskSettingsReady || !powerOn}
            >
              <div className="screen-bezel">
                <div className="bezel-inner">
                  <div
                    className="crt-frame"
                    style={{
                      '--screen-width': `${screenWidth}px`,
                      '--screen-height': `${screenHeight}px`,
                      '--display-scale': displayScale,
                    } as React.CSSProperties}
                  >
                    {!powerOn ? (
                      <div className="power-off-screen">
                        <span>System Off</span>
                      </div>
                    ) : hasDiskSettingsError ? (
                      <div className="loading-placeholder" style={{ textAlign: 'center' }}>
                        <span style={{ color: '#ff6b6b' }}>
                          {diskSettingsError || 'Connection timed out'}
                        </span>
                        <button
                          onClick={() => window.location.reload()}
                          className="retry-btn"
                        >
                          Retry
                        </button>
                      </div>
                    ) : !isDiskSettingsReady ? (
                      <div className="loading-placeholder">
                        <span>Connecting to disk server...</span>
                      </div>
                    ) : (
                      <EmulatorCanvas
                        ref={emulatorRef}
                        coreId={coreId}
                        diskPaths={diskPaths}
                        diskMode={diskMode}
                        romPath={defaultRomPath}
                        relayUrl={relayUrl}
                        networkZone={networkZone}
                        jit={jit}
                        width={screenWidth}
                        height={screenHeight}
                        initialVolume={volume}
                        hardwareCursor={hardwareCursor}
                        cursorScale={cursorScale}
                        onStatusChange={handleStatusChange}
                        onNetworkStatusChange={handleNetworkStatusChange}
                        onPacketSent={handlePacketSent}
                        onPacketReceived={handlePacketReceived}
                        onHdActivity={triggerHd}
                        onCpuLoad={handleCpuLoad}
                        onVUMeterUpdate={handleVUMeterUpdate}
                        enableAutomation={import.meta.env.DEV}
                      />
                    )}
                    <div className="crt-overlay" />
                    <div className="crt-scanlines" />
                  </div>
                </div>
              </div>
            </FileTransferDropZone>

            {/* Monitor chin: brand wordmark and power light */}
            <div className="monitor-chin">
              <span className="chin-brand">DIALTONE</span>
              <div
                className={`monitor-power-led ${powerOn ? 'on' : ''}`}
                title={powerOn ? 'Power On' : 'Power Off'}
              />
            </div>

            {/* DEF CON sticker on the bezel corner - C89 Summer theme only */}
            <img
              className="monitor-sticker-defcon"
              src="/defcon98.png"
              alt=""
              aria-hidden="true"
            />
          </div>

          <div className="monitor-stand" aria-hidden="true">
            <div className="stand-neck" />
            <div className="stand-base" />
          </div>
        </div>

        {/* Quadra 700 mini-tower */}
        <div className="tower-unit">
          <div className="tower-grooves" aria-hidden="true" />

          <div className="tower-header">
            <div className="tower-logo" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>

          {/* Vertical SuperDrive slot along the right edge */}
          <div className="tower-drive-bay" aria-hidden="true">
            <div className="floppy-slot" />
            <div className="floppy-eject" />
          </div>

          {/* Status LEDs and CPU load graph */}
          <div className="tower-leds">
            <div className="led-column">
              <div className={`status-led power-led ${powerOn ? 'on' : ''}`}>
                <div className="led-glow" />
                <span className="led-label">PWR</span>
              </div>
              <div
                className={`status-led hd-led ${networkActivity.hdActive ? 'active' : ''}`}
                style={{ '--led-intensity': networkActivity.hdIntensity } as React.CSSProperties}
              >
                <div className="led-glow" />
                <span className="led-label">HD</span>
              </div>
              <div
                className={`status-led tx-led ${networkActivity.txActive ? 'active' : ''}`}
                style={{ '--led-intensity': networkActivity.txIntensity } as React.CSSProperties}
              >
                <div className="led-glow" />
                <span className="led-label">TX</span>
              </div>
              <div
                className={`status-led rx-led ${networkActivity.rxActive ? 'active' : ''}`}
                style={{ '--led-intensity': networkActivity.rxIntensity } as React.CSSProperties}
              >
                <div className="led-glow" />
                <span className="led-label">RX</span>
              </div>
            </div>
            <CpuLoadGraph history={powerOn ? cpuHistory : []} columns={14} />
          </div>

          {/* Front control panel */}
          <div className="tower-controls">
            <div className="tower-audio">
              <VUMeter data={vuMeterData} segments={5} />
              <VolumeKnob value={volume} onChange={handleVolumeChange} />
            </div>
            <div className="tower-buttons">
            <button
              className="control-btn settings-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              className="control-btn fullscreen-btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen Mode'}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
            {/* Keyboard lock button - only in fullscreen on supported browsers */}
            {isFullscreen && isKeyboardLockSupported && (
              <button
                className={`control-btn keyboard-lock-btn${isKeyboardLocked ? ' locked' : ''}`}
                onClick={handleToggleKeyboardLock}
                title={isKeyboardLocked ? 'Unlock Keyboard' : 'Lock Keyboard (capture Cmd+W, etc.)'}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {isKeyboardLocked ? (
                    <>
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </>
                  ) : (
                    <>
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </>
                  )}
                </svg>
              </button>
            )}
            <button
              className="control-btn power-btn"
              onClick={handlePowerToggle}
              title={powerOn ? 'Power Off' : 'Power On'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3v9" />
                <circle cx="12" cy="12" r="8" strokeDasharray="40 12" />
              </svg>
            </button>
            </div>
          </div>

          {/* C89 Summer stickers - only visible in the C89 Summer theme */}
          <div className="tower-stickers">
            <div className="sticker-c89" aria-hidden="true">
              <img src="/c89-summer-color.png" alt="" />
            </div>
            <img className="sticker-sun" src="/c89-sun.png" alt="" aria-hidden="true" />
            <a
              className="sticker-forested"
              href="https://x.com/SiliconForested"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="SiliconForested on X"
              title="@SiliconForested on X"
            >
              <img src="/siliconforested.png" alt="" />
            </a>
          </div>

          {/* Model badge */}
          <div className="tower-badge">
            <span className="badge-model">Dialtone</span>
          </div>

          <div className="tower-grooves bottom" aria-hidden="true" />
          <div className="tower-feet" aria-hidden="true">
            <span />
            <span />
          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={handleCloseSettings}
        onReboot={handleReboot}
      />

      <FileTransferModal
        isOpen={transferModalOpen}
        stage={transferStage}
        progress={transferProgress}
        result={transferResult}
        error={transferError}
        onRestart={handleTransferRestart}
        onClose={handleTransferModalClose}
      />
    </div>
  );
}
