/**
 * LaptopShell - Mobile laptop-style interface for the emulator
 *
 * Creates a laptop metaphor with:
 * - 640x480 emulator screen at the top
 * - Trackpad below for cursor control
 * - Minimal controls (keyboard button, settings, theme)
 *
 * This component is rendered on mobile devices instead of EmulatorShell.
 */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { EmulatorCanvas, EmulatorStatus, type EmulatorCanvasHandle, type VUMeterData } from './EmulatorCanvas';
import { defaultRelayUrl, type ConnectionStatus } from './DialtoneEthernet';
import { useTheme, useThemeStyles } from './themes';
import { useDiskSettings } from './settings';
import { Trackpad } from './components/Trackpad';
import { SettingsModal } from './components/settings';
import { VolumeKnob } from './components/VolumeKnob';
import { VUMeter } from './components/VUMeter';
import { FileTransferDropZone } from './components/FileTransferDropZone';
import { FileTransferModal } from './components/FileTransferModal';
import { VirtualKeyboard, type KeyboardSystemState } from './components/VirtualKeyboard';
import { createQueuedBufferWriter } from './input/QueuedInputBufferWriter';
import { useFileTransfer } from './hooks/useFileTransfer';
import type { InputBufferWriter } from './input/types';
import './LaptopShell.css';

interface LaptopShellProps {
  defaultDiskPath?: string;
  defaultRomPath?: string;
  relayUrl?: string;
  /** Emulator screen width (default: 640) */
  width?: number;
  /** Emulator screen height (default: 480) */
  height?: number;
}

export function LaptopShell({
  defaultDiskPath = '/disk/dialtone-system.dsk',
  defaultRomPath = '/rom/quadra650.rom',
  relayUrl = defaultRelayUrl(),
  width = 640,
  height = 480,
}: LaptopShellProps) {
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
  const { mode: diskMode, bootDisk, dataDisks, networkZone, jit, hardwareCursor, cursorScale, addTransferDisk, isLoading: isLoadingDiskSettings, error: diskSettingsError } = useDiskSettings();

  // Track if we've completed initial disk settings load
  const hasInitiallyLoaded = useRef(false);
  if (bootDisk !== null && !isLoadingDiskSettings) {
    hasInitiallyLoaded.current = true;
  }

  // Track if disk settings loading has timed out
  const [diskSettingsTimeout, setDiskSettingsTimeout] = useState(false);
  useEffect(() => {
    if (isLoadingDiskSettings || bootDisk !== null) {
      setDiskSettingsTimeout(false);
      return;
    }
    const timer = setTimeout(() => {
      setDiskSettingsTimeout(true);
    }, 10000);
    return () => clearTimeout(timer);
  }, [isLoadingDiskSettings, bootDisk]);

  const isDiskSettingsReady = hasInitiallyLoaded.current || (!isLoadingDiskSettings && bootDisk !== null && !diskSettingsError);
  const hasDiskSettingsError = !hasInitiallyLoaded.current && (diskSettingsError || diskSettingsTimeout);

  // Build disk paths array
  const diskPaths = useMemo(() => [
    bootDisk ? `/disk/${bootDisk}` : defaultDiskPath,
    ...dataDisks.map(d => `/disk/${d}`)
  ], [bootDisk, dataDisks, defaultDiskPath]);

  // Refs
  const emulatorRef = useRef<EmulatorCanvasHandle>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const bezelRef = useRef<HTMLDivElement>(null);

  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [powerOn, setPowerOn] = useState(true);
  const [emulatorStatus, setEmulatorStatus] = useState<EmulatorStatus>('loading');

  // Cursor overlay position (for hardware cursor on touch devices)
  const [cursorPosition, setCursorPosition] = useState({ x: 320, y: 240 });

  // Map emulator status to keyboard LED state
  const keyboardSystemState: KeyboardSystemState = useMemo(() => {
    if (!powerOn) return 'off';
    if (emulatorStatus === 'ready') return 'ready';
    return 'loading';
  }, [powerOn, emulatorStatus]);

  // View mode: 'fit' scales to fit, 'glide' allows panning at native scale
  type ViewMode = 'fit' | 'glide';
  const [viewMode, setViewMode] = useState<ViewMode>('fit');
  const [glideOffset, setGlideOffset] = useState({ x: 0, y: 0 });

  // Handle glide pan from touch events on canvas
  // In glide mode, canvas scales to fit width, so only vertical panning is needed
  const handleGlidePan = useCallback((_deltaX: number, deltaY: number) => {
    if (viewMode !== 'glide') return;

    // Calculate max pan based on how much canvas extends beyond bezel
    const bezel = bezelRef.current;
    if (!bezel) return;

    const bezelRect = bezel.getBoundingClientRect();
    const bezelWidth = bezelRect.width - 12; // Account for bezel padding (6px each side)
    const bezelHeight = bezelRect.height - 12;

    // Canvas is scaled to fit width, calculate its rendered height
    const canvasHeight = bezelWidth * (height / width);

    // If canvas fits within bezel, no panning needed
    if (canvasHeight <= bezelHeight) {
      setGlideOffset({ x: 0, y: 0 });
      return;
    }

    // Max pan is half the overflow (centered by default)
    const maxPanY = (canvasHeight - bezelHeight) / 2;

    setGlideOffset(prev => ({
      x: 0, // No horizontal pan (width fits)
      y: Math.max(-maxPanY, Math.min(maxPanY, prev.y + deltaY)),
    }));
  }, [viewMode, width, height]);

  // Toggle between fit and glide modes
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      if (prev === 'fit') {
        // Switching to glide - reset offset to center
        setGlideOffset({ x: 0, y: 0 });
        return 'glide';
      }
      return 'fit';
    });
  }, []);

  // Input buffer for trackpad
  const [inputBufferWriter, setInputBufferWriter] = useState<InputBufferWriter | null>(null);

  // Create input buffer when emulator provides it
  // This will be provided by EmulatorCanvas through a callback
  const handleInputBufferReady = useCallback((buffer: Int32Array) => {
    setInputBufferWriter(createQueuedBufferWriter(buffer));
  }, []);

  // Handle cursor position updates from trackpad (for overlay on touch devices)
  const handleCursorMove = useCallback((x: number, y: number) => {
    setCursorPosition({ x, y });
  }, []);

  // Audio state
  const [volume, setVolume] = useState(1.0);
  const [vuMeterData, setVuMeterData] = useState<VUMeterData | null>(null);

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
    setEmulatorStatus(newStatus);
    if (newStatus === 'ready') {
      setPowerOn(true);
    }
  }, []);

  // Volume control
  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
    emulatorRef.current?.setVolume(newVolume);
  }, []);

  // VU meter updates
  const handleVUMeterUpdate = useCallback((data: VUMeterData) => {
    setVuMeterData(data);
  }, []);

  // Close settings
  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  // Reboot
  const handleReboot = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div
      ref={shellRef}
      className={`laptop-shell ${currentTheme.className}`}
    >
      {/* Screen area */}
      <FileTransferDropZone
        onFilesDropped={handleFilesDropped}
        disabled={!isLocalMode || isTransferring || !isDiskSettingsReady || !powerOn}
      >
        <div className="laptop-screen-area">
          <div ref={bezelRef} className="laptop-screen-bezel">
            <div
              className={`laptop-screen-inner ${viewMode === 'glide' ? 'laptop-screen-inner--glide' : ''}`}
              style={viewMode === 'glide' ? {
                transform: `translate(${glideOffset.x}px, ${glideOffset.y}px)`,
              } : undefined}
            >
              {!powerOn ? (
                <div className="laptop-power-off">
                  <span>System Off</span>
                </div>
              ) : hasDiskSettingsError ? (
                <div className="laptop-loading-placeholder" style={{ textAlign: 'center' }}>
                  <span style={{ color: '#ff6b6b' }}>
                    {diskSettingsError || 'Connection timed out'}
                  </span>
                  <button
                    onClick={() => window.location.reload()}
                    className="laptop-retry-btn"
                  >
                    Retry
                  </button>
                </div>
              ) : !isDiskSettingsReady ? (
                <div className="laptop-loading-placeholder">
                  <span>Connecting to disk server...</span>
                </div>
              ) : (
                <EmulatorCanvas
                  ref={emulatorRef}
                  diskPaths={diskPaths}
                  diskMode={diskMode}
                  romPath={defaultRomPath}
                  relayUrl={relayUrl}
                  networkZone={networkZone}
                  jit={jit}
                  width={width}
                  height={height}
                  initialVolume={volume}
                  hardwareCursor={hardwareCursor}
                  cursorScale={cursorScale}
                  cursorPosition={hardwareCursor ? cursorPosition : undefined}
                  onStatusChange={handleStatusChange}
                  onNetworkStatusChange={handleNetworkStatusChange}
                  onPacketSent={handlePacketSent}
                  onPacketReceived={handlePacketReceived}
                  onHdActivity={triggerHd}
                  onInputBufferReady={handleInputBufferReady}
                  onVUMeterUpdate={handleVUMeterUpdate}
                  hideVirtualKeyboardButton
                  glideMode={viewMode === 'glide'}
                  onGlidePan={handleGlidePan}
                  enableAutomation={import.meta.env.DEV}
                />
              )}
            </div>
          </div>
        </div>
      </FileTransferDropZone>

      {/* Control strip with status LEDs and audio controls - outside screen-area for full width */}
      <div className="laptop-control-strip">
        {/* Status LEDs */}
        <div className="laptop-status-cluster">
          <div className={`laptop-status-led power-led ${powerOn ? 'on' : ''}`}>
            <div className="led-glow" />
            <span className="led-label">PWR</span>
          </div>
          <div
            className={`laptop-status-led hd-led ${networkActivity.hdActive ? 'active' : ''}`}
            style={{ '--led-intensity': networkActivity.hdIntensity } as React.CSSProperties}
          >
            <div className="led-glow" />
            <span className="led-label">HD</span>
          </div>
          <div
            className={`laptop-status-led tx-led ${networkActivity.txActive ? 'active' : ''}`}
            style={{ '--led-intensity': networkActivity.txIntensity } as React.CSSProperties}
          >
            <div className="led-glow" />
            <span className="led-label">TX</span>
          </div>
          <div
            className={`laptop-status-led rx-led ${networkActivity.rxActive ? 'active' : ''}`}
            style={{ '--led-intensity': networkActivity.rxIntensity } as React.CSSProperties}
          >
            <div className="led-glow" />
            <span className="led-label">RX</span>
          </div>
        </div>

        {/* Audio controls */}
        <div className="laptop-audio-controls">
          <VUMeter data={vuMeterData} segments={5} />
          <VolumeKnob value={volume} onChange={handleVolumeChange} size={28} />
        </div>

        {/* Action buttons */}
        <div className="laptop-action-buttons">
          {/* View mode toggle */}
          <button
            className={`laptop-action-btn ${viewMode === 'glide' ? 'laptop-action-btn--active' : ''}`}
            onClick={toggleViewMode}
            title={viewMode === 'fit' ? 'Switch to Glide Mode' : 'Switch to Fit Mode'}
          >
            {viewMode === 'fit' ? (
              // Expand icon (switch to glide/native)
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              // Compress icon (switch to fit)
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>

          {/* Settings button */}
          <button
            className="laptop-action-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Virtual keyboard area */}
      <div className="laptop-keyboard-area">
        <VirtualKeyboard
          inputBuffer={inputBufferWriter}
          enabled={powerOn && isDiskSettingsReady}
          systemState={keyboardSystemState}
        />
      </div>

      {/* Trackpad area */}
      <div className="laptop-trackpad-area">
        <Trackpad
          inputBuffer={inputBufferWriter}
          screenWidth={width}
          screenHeight={height}
          enabled={powerOn && isDiskSettingsReady}
          compact
          onCursorMove={hardwareCursor ? handleCursorMove : undefined}
        />
      </div>

      {/* Settings modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={handleCloseSettings}
        onReboot={handleReboot}
      />

      {/* File transfer modal */}
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
