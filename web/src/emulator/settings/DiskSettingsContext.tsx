/**
 * Disk Settings Context Provider
 *
 * Provides disk settings state to the entire app.
 * Settings are read-only during runtime - changes are only saved when
 * the user explicitly clicks "Save & Restart" in the Settings modal.
 *
 * Supports:
 * - Boot disk selection (single, from bootable/ directory)
 * - Data disk selection (up to 3, from data/ directory)
 * - Storage mode selection (local mode only)
 * - Disk creation (local mode only)
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { DiskStorageMode, DiskInfo } from '../disk/types';
import { fetchDiskList, createDiskImage } from '../disk/DiskFactory';
import { clearAllDiskCache, getCacheStorageInfo } from '../disk/OPFSCache';
import { logger } from '../logger';

// Storage info for cache management
export interface StorageInfo {
  used: number;
  quota: number;
  percentage: number;
}

// Screen resolution types and constants
export type ScreenResolution = '640x480' | '800x600' | '1024x768';

export const RESOLUTION_OPTIONS = [
  { value: '640x480' as const, label: '640 x 480', width: 640, height: 480 },
  { value: '800x600' as const, label: '800 x 600', width: 800, height: 600 },
  { value: '1024x768' as const, label: '1024 x 768', width: 1024, height: 768 },
];

const DEFAULT_RESOLUTION: ScreenResolution = '800x600';

export function getResolutionDimensions(res: ScreenResolution): { width: number; height: number } {
  const option = RESOLUTION_OPTIONS.find(o => o.value === res);
  return option ? { width: option.width, height: option.height } : { width: 800, height: 600 };
}

/**
 * Select the default boot disk using priority rules:
 * 1. Disks starting with "default" (case-insensitive), most recent first
 * 2. If no "default" disks, use most recent disk by modification time
 */
export function selectDefaultBootDisk(disks: DiskInfo[]): string | null {
  if (disks.length === 0) return null;

  // Find disks starting with "default" (case-insensitive)
  const defaultDisks = disks.filter(d =>
    d.name.toLowerCase().startsWith('default')
  );

  // Sort by modTime descending (most recent first)
  const sortByRecent = (a: DiskInfo, b: DiskInfo) => b.modTime - a.modTime;

  if (defaultDisks.length > 0) {
    // Use most recent "default" disk
    return defaultDisks.sort(sortByRecent)[0].name;
  }

  // No "default" disks - use most recent disk overall
  return [...disks].sort(sortByRecent)[0].name;
}

// Display scale types and constants (applies live, no restart needed)
export type DisplayScale = 1 | 1.5 | 2;

export const SCALE_OPTIONS: Array<{ value: DisplayScale; label: string }> = [
  { value: 1, label: '1x (Native)' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x' },
];

const DEFAULT_SCALE: DisplayScale = 1;

// Cursor scale types and constants (applies live, no restart needed)
export type CursorScale = 1 | 1.5 | 2 | 2.5 | 3;

export const CURSOR_SCALE_OPTIONS: Array<{ value: CursorScale; label: string }> = [
  { value: 1, label: '1x (Native)' },
  { value: 1.5, label: '1.5x' },
  { value: 2, label: '2x' },
  { value: 2.5, label: '2.5x' },
  { value: 3, label: '3x' },
];

const DEFAULT_CURSOR_SCALE: CursorScale = 1;

interface DiskSettingsContextValue {
  // Current active settings (read-only during runtime)
  mode: DiskStorageMode;
  bootDisk: string | null;
  dataDisks: string[];
  networkZone: string; // Empty = private isolated zone
  jit: boolean; // JIT compilation enabled
  resolution: ScreenResolution; // Screen resolution (desktop only)
  displayScale: DisplayScale; // Display scale factor (applies live)
  hardwareCursor: boolean; // Use CSS cursor overlay (applies live)
  cursorScale: CursorScale; // Hardware cursor size multiplier (applies live)
  availableBootDisks: DiskInfo[];
  availableDataDisks: DiskInfo[];

  // Actions
  saveAndRestart: (mode: DiskStorageMode, bootDisk: string | null, dataDisks: string[], networkZone: string, jit: boolean, resolution: ScreenResolution) => void;
  setDisplayScale: (scale: DisplayScale) => void; // Live update, no restart
  setHardwareCursor: (enabled: boolean) => void; // Live update, no restart
  setCursorScale: (scale: CursorScale) => void; // Live update, no restart
  createDisk: (name: string, sizeBytes: number) => Promise<void>;
  addTransferDisk: (diskName: string) => void; // Add transfer disk and restart
  refreshDiskList: () => Promise<void>;

  // Cache management
  storageInfo: StorageInfo | null;
  refreshStorageInfo: () => Promise<void>;
  clearCacheAndRestart: () => Promise<void>;
  isClearingCache: boolean;

  // Status
  isLoading: boolean;
  error: string | null;
  isCreatingDisk: boolean;
}

const DiskSettingsContext = createContext<DiskSettingsContextValue | null>(
  null
);

const STORAGE_KEY = 'dialtone-disk-settings-v2';
const DEFAULT_MODE: DiskStorageMode = 'client-cached';

/**
 * Get network zone from URL parameter (?zone=xxx)
 * Returns null if no zone parameter is present
 */
function getZoneFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('zone');
}

/**
 * Admin launch override (from Dialtone /admin/disk). When an adminToken is
 * present in the URL we honor ?mode= and ?disk= so the admin editing surface
 * can force a writable disk-server session against a specific base image.
 * Without the token these overrides are ignored - normal visitors can't switch
 * into writable mode just by editing the URL (the relay would reject writes
 * anyway, but we also keep the UI honest).
 */
function getAdminLaunchOverride(): { mode?: DiskStorageMode; bootDisk?: string } {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  if (!params.get('adminToken')) return {};
  const override: { mode?: DiskStorageMode; bootDisk?: string } = {};
  const mode = params.get('mode');
  if (mode === 'disk-server' || mode === 'client-cached') override.mode = mode;
  const disk = params.get('disk');
  if (disk) override.bootDisk = disk;
  return override;
}

// Check if running in local mode
const isLocalMode = typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_LOCAL_MODE === 'true';

// Runtime config (fetched from /config.json if available)
interface RuntimeConfig {
  defaultBootDisk?: string;
}

let runtimeConfig: RuntimeConfig = {};

// Fetch runtime config on module load (non-blocking)
if (typeof window !== 'undefined') {
  fetch('/config.json')
    .then(res => res.ok ? res.json() : {})
    .then((config: RuntimeConfig) => {
      runtimeConfig = config;
      if (config.defaultBootDisk) {
        logger.log(`[DiskSettings] Loaded runtime config: defaultBootDisk=${config.defaultBootDisk}`);
      }
    })
    .catch(() => {
      // Config file not found - that's fine, use defaults
    });
}

// Get default boot disk from runtime config or build-time env
function getDefaultBootDisk(): string | undefined {
  return runtimeConfig.defaultBootDisk
    || (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DEFAULT_BOOT_DISK : undefined);
}

interface DiskSettings {
  mode: DiskStorageMode;
  bootDisk: string | null;
  dataDisks: string[];
  networkZone: string; // Empty = private isolated zone
  jit: boolean; // JIT compilation enabled (default: true)
  resolution: ScreenResolution; // Screen resolution (default: 800x600)
  displayScale: DisplayScale; // Display scale factor (default: 1)
  hardwareCursor: boolean; // Use CSS cursor overlay (default: true)
  cursorScale: CursorScale; // Hardware cursor size multiplier (default: 1)
}

interface DiskSettingsProviderProps {
  children: ReactNode;
  relayUrl: string;
}

export function DiskSettingsProvider({
  children,
  relayUrl,
}: DiskSettingsProviderProps) {
  // Load from localStorage - settings are read-only during runtime
  // Changes only take effect after page reload
  // Boot disk can be null - will be resolved to random selection after disk list loads
  // URL parameters (like ?zone=xxx) take precedence over stored settings
  const [settings, setSettings] = useState<DiskSettings>(() => {
    if (typeof window === 'undefined') {
      return { mode: DEFAULT_MODE, bootDisk: null, dataDisks: [], networkZone: '', jit: true, resolution: DEFAULT_RESOLUTION, displayScale: DEFAULT_SCALE, hardwareCursor: true, cursorScale: DEFAULT_CURSOR_SCALE };
    }

    // Check for zone in URL - this takes precedence over stored settings
    const urlZone = getZoneFromUrl();
    // Admin launch overrides (only honored when an adminToken is present)
    const admin = getAdminLaunchOverride();

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return {
          mode: admin.mode || parsed.mode || DEFAULT_MODE,
          bootDisk: admin.bootDisk ?? parsed.bootDisk ?? null, // null means "pick random"
          dataDisks: Array.isArray(parsed.dataDisks) ? parsed.dataDisks : [],
          networkZone: urlZone ?? parsed.networkZone ?? '', // URL zone takes precedence
          jit: parsed.jit ?? true, // Default to enabled if not set
          resolution: parsed.resolution || DEFAULT_RESOLUTION, // Default to 800x600 if not set
          displayScale: DEFAULT_SCALE, // Always start at 1x on page load
          hardwareCursor: parsed.hardwareCursor ?? parsed.responsiveCursor ?? true, // Migrate from old name
          cursorScale: parsed.cursorScale ?? DEFAULT_CURSOR_SCALE, // Default to 1x
        };
      } catch {
        // Invalid JSON, use defaults
      }
    }
    // Try migrating from old storage key
    const oldStored = localStorage.getItem('dialtone-disk-settings');
    if (oldStored) {
      try {
        const parsed = JSON.parse(oldStored);
        return {
          mode: parsed.mode || DEFAULT_MODE,
          bootDisk: parsed.selectedDisk || null,
          dataDisks: [],
          networkZone: urlZone ?? '', // URL zone takes precedence
          jit: true, // Default enabled
          resolution: DEFAULT_RESOLUTION, // Default resolution
          displayScale: DEFAULT_SCALE, // Default scale
          hardwareCursor: true, // Default enabled
          cursorScale: DEFAULT_CURSOR_SCALE, // Default cursor scale
        };
      } catch {
        // Invalid JSON, use defaults
      }
    }
    return { mode: admin.mode || DEFAULT_MODE, bootDisk: admin.bootDisk ?? null, dataDisks: [], networkZone: urlZone ?? '', jit: true, resolution: DEFAULT_RESOLUTION, displayScale: DEFAULT_SCALE, hardwareCursor: true, cursorScale: DEFAULT_CURSOR_SCALE };
  });

  const [availableBootDisks, setAvailableBootDisks] = useState<DiskInfo[]>([]);
  const [availableDataDisks, setAvailableDataDisks] = useState<DiskInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingDisk, setIsCreatingDisk] = useState(false);

  // Cache management state
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);

  // Track if boot disk has been resolved (prevents re-selection on Settings modal open)
  // Must start as false so validation runs even when bootDisk is loaded from localStorage
  const bootDiskResolved = useRef(false);

  // Track previous effectiveDataDisks to maintain stable reference
  const prevEffectiveDataDisksRef = useRef<string[]>([]);

  // Save settings to localStorage (called when user clicks "Save & Restart")
  // Does not update React state since page will reload
  const saveAndRestart = useCallback(
    (mode: DiskStorageMode, bootDisk: string | null, dataDisks: string[], networkZone: string, jit: boolean, resolution: ScreenResolution) => {
      // Preserve current live settings when saving restart-required settings
      const { displayScale, hardwareCursor, cursorScale } = settings;
      const newSettings: DiskSettings = { mode, bootDisk, dataDisks, networkZone, jit, resolution, displayScale, hardwareCursor, cursorScale };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
    },
    [settings.displayScale, settings.hardwareCursor, settings.cursorScale]
  );

  // Set display scale (applies live, no restart needed)
  const setDisplayScale = useCallback(
    (scale: DisplayScale) => {
      setSettings(prev => {
        const newSettings = { ...prev, displayScale: scale };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
        return newSettings;
      });
    },
    []
  );

  // Set hardware cursor mode (applies live, no restart needed)
  const setHardwareCursor = useCallback(
    (enabled: boolean) => {
      setSettings(prev => {
        const newSettings = { ...prev, hardwareCursor: enabled };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
        return newSettings;
      });
    },
    []
  );

  // Set cursor scale (applies live, no restart needed)
  const setCursorScale = useCallback(
    (scale: CursorScale) => {
      setSettings(prev => {
        const newSettings = { ...prev, cursorScale: scale };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
        return newSettings;
      });
    },
    []
  );

  // Add a transfer disk and restart to mount it
  // Transfer disks go in the data/ directory so they're treated as data disks
  const addTransferDisk = useCallback(
    (diskName: string) => {
      // Get current settings from storage (not React state) to ensure we have latest
      const stored = localStorage.getItem(STORAGE_KEY);
      let currentSettings: DiskSettings = settings;
      if (stored) {
        try {
          currentSettings = JSON.parse(stored);
        } catch {
          // Use React state as fallback
        }
      }

      // Add new disk to dataDisks if not already present
      const newDataDisks = currentSettings.dataDisks.includes(diskName)
        ? currentSettings.dataDisks
        : [...currentSettings.dataDisks, diskName];

      // Save updated settings
      const newSettings: DiskSettings = {
        ...currentSettings,
        dataDisks: newDataDisks,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));

      logger.log(`[DiskSettings] Added transfer disk: ${diskName}, restarting...`);

      // Reload to mount the new disk
      window.location.reload();
    },
    [settings]
  );

  // Refresh storage info for cache management
  const refreshStorageInfo = useCallback(async () => {
    try {
      const info = await getCacheStorageInfo();
      setStorageInfo({
        used: info.used,
        quota: info.quota,
        percentage: info.quota > 0 ? (info.used / info.quota) * 100 : 0,
      });
    } catch (e) {
      logger.warn('[DiskSettings] Failed to get storage info:', e);
    }
  }, []);

  // Clear all disk cache and restart
  const clearCacheAndRestart = useCallback(async () => {
    setIsClearingCache(true);
    try {
      await clearAllDiskCache();
      logger.log('[DiskSettings] Cache cleared, restarting...');
      // Reload the page to restart with fresh cache
      window.location.reload();
    } catch (e) {
      logger.error('[DiskSettings] Failed to clear cache:', e);
      setError(e instanceof Error ? e.message : 'Failed to clear cache');
      setIsClearingCache(false);
    }
  }, []);

  const refreshDiskList = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { bootable, data } = await fetchDiskList(relayUrl);
      setAvailableBootDisks(bootable);
      setAvailableDataDisks(data);

      // Only select a boot disk on initial mount (when bootDiskResolved is false)
      // This prevents restarting the emulator when Settings modal opens
      if (!bootDiskResolved.current && bootable.length > 0) {
        setSettings(prev => {
          const defaultDisk = getDefaultBootDisk();

          if (prev.bootDisk === null) {
            // Try configured default first
            if (defaultDisk && bootable.some(d => d.name === defaultDisk)) {
              logger.log(`[DiskSettings] Using configured default boot disk: ${defaultDisk}`);
              bootDiskResolved.current = true;
              return { ...prev, bootDisk: defaultDisk };
            }
            // Use deterministic selection: prefer "default*" disks, then most recent
            const selectedDisk = selectDefaultBootDisk(bootable);
            logger.log(`[DiskSettings] Selected boot disk: ${selectedDisk}`);
            bootDiskResolved.current = true;
            return { ...prev, bootDisk: selectedDisk };
          }
          // If selected boot disk doesn't exist in the list, try default or select new
          if (prev.bootDisk && !bootable.some(d => d.name === prev.bootDisk)) {
            // Try configured default first
            if (defaultDisk && bootable.some(d => d.name === defaultDisk)) {
              logger.log(`[DiskSettings] Saved disk "${prev.bootDisk}" not found, using default: ${defaultDisk}`);
              bootDiskResolved.current = true;
              return { ...prev, bootDisk: defaultDisk };
            }
            // Use deterministic selection: prefer "default*" disks, then most recent
            const selectedDisk = selectDefaultBootDisk(bootable);
            logger.log(`[DiskSettings] Saved boot disk "${prev.bootDisk}" not found, selected: ${selectedDisk}`);
            bootDiskResolved.current = true;
            return { ...prev, bootDisk: selectedDisk };
          }
          // Boot disk exists in the list - mark as resolved
          bootDiskResolved.current = true;
          return prev;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch disk list');
      setAvailableBootDisks([]);
      setAvailableDataDisks([]);
    } finally {
      setIsLoading(false);
    }
  }, [relayUrl]);

  const createDisk = useCallback(
    async (name: string, sizeBytes: number) => {
      setIsCreatingDisk(true);
      setError(null);
      try {
        await createDiskImage(relayUrl, name, sizeBytes);
        // Refresh disk list to show the new disk
        await refreshDiskList();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create disk');
        throw e;
      } finally {
        setIsCreatingDisk(false);
      }
    },
    [relayUrl, refreshDiskList]
  );

  // Fetch disk list on mount
  useEffect(() => {
    refreshDiskList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl]);

  // Only show disks from the data/ directory for data disk selection
  // Users must manually move images to appropriate directories
  const combinedDataDisks = useMemo(() => {
    return [...availableDataDisks].sort((a, b) => a.name.localeCompare(b.name));
  }, [availableDataDisks]);

  // In production mode, auto-mount ALL data disks
  // In local mode, use user's selection
  // IMPORTANT: Returns stable reference if content unchanged to prevent emulator restart
  const effectiveDataDisks = useMemo(() => {
    let newValue: string[];
    if (isLocalMode) {
      // Local mode: user selects which data disks to mount
      newValue = settings.dataDisks;
    } else {
      // Production mode: auto-mount all available data disks
      newValue = availableDataDisks.map(d => d.name);
    }

    // Only update reference if content actually changed
    const prev = prevEffectiveDataDisksRef.current;
    if (prev.length === newValue.length &&
        prev.every((v, i) => v === newValue[i])) {
      return prev; // Return stable reference
    }
    prevEffectiveDataDisksRef.current = newValue;
    return newValue;
  }, [settings.dataDisks, availableDataDisks]);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const value = useMemo<DiskSettingsContextValue>(
    () => ({
      mode: settings.mode,
      bootDisk: settings.bootDisk,
      dataDisks: effectiveDataDisks,
      networkZone: settings.networkZone,
      jit: settings.jit,
      resolution: settings.resolution,
      displayScale: settings.displayScale,
      hardwareCursor: settings.hardwareCursor,
      cursorScale: settings.cursorScale,
      availableBootDisks,
      availableDataDisks: combinedDataDisks,
      saveAndRestart,
      setDisplayScale,
      setHardwareCursor,
      setCursorScale,
      createDisk,
      addTransferDisk,
      refreshDiskList,
      storageInfo,
      refreshStorageInfo,
      clearCacheAndRestart,
      isClearingCache,
      isLoading,
      error,
      isCreatingDisk,
    }),
    [
      settings.mode,
      settings.bootDisk,
      effectiveDataDisks,
      settings.networkZone,
      settings.jit,
      settings.resolution,
      settings.displayScale,
      settings.hardwareCursor,
      settings.cursorScale,
      availableBootDisks,
      combinedDataDisks,
      saveAndRestart,
      setDisplayScale,
      setHardwareCursor,
      setCursorScale,
      createDisk,
      addTransferDisk,
      refreshDiskList,
      storageInfo,
      refreshStorageInfo,
      clearCacheAndRestart,
      isClearingCache,
      isLoading,
      error,
      isCreatingDisk,
    ]
  );

  return (
    <DiskSettingsContext.Provider value={value}>
      {children}
    </DiskSettingsContext.Provider>
  );
}

export function useDiskSettings(): DiskSettingsContextValue {
  const context = useContext(DiskSettingsContext);
  if (!context) {
    throw new Error(
      'useDiskSettings must be used within a DiskSettingsProvider'
    );
  }
  return context;
}
