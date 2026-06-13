/**
 * Tests for DiskSettingsContext
 *
 * Tests the disk settings context provider including:
 * - Provider rendering and context access
 * - Settings loading from localStorage
 * - Disk list fetching
 * - Save and restart functionality
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { DiskSettingsProvider, useDiskSettings } from './DiskSettingsContext';
import * as DiskFactory from '../disk/DiskFactory';

// Mock DiskFactory
vi.mock('../disk/DiskFactory', () => ({
  fetchDiskList: vi.fn(),
  createDiskImage: vi.fn(),
}));

// Test component that uses the context
function TestConsumer() {
  const settings = useDiskSettings();
  return (
    <div>
      <span data-testid="mode">{settings.mode}</span>
      <span data-testid="bootDisk">{settings.bootDisk || 'none'}</span>
      <span data-testid="dataDisks">{settings.dataDisks.join(',') || 'none'}</span>
      <span data-testid="isLoading">{settings.isLoading ? 'loading' : 'ready'}</span>
      <span data-testid="error">{settings.error || 'no-error'}</span>
      <span data-testid="bootDisksCount">{settings.availableBootDisks.length}</span>
      <button onClick={() => settings.saveAndRestart('disk-server', 'test.dsk', ['data1.dsk'])}>
        Save
      </button>
    </div>
  );
}

describe('DiskSettingsContext', () => {
  const mockFetchDiskList = DiskFactory.fetchDiskList as ReturnType<typeof vi.fn>;
  const mockCreateDiskImage = DiskFactory.createDiskImage as ReturnType<typeof vi.fn>;
  const originalLocalStorage = global.localStorage;
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage = {};

    // Mock localStorage
    Object.defineProperty(global, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
        setItem: vi.fn((key: string, value: string) => {
          mockLocalStorage[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete mockLocalStorage[key];
        }),
        clear: vi.fn(() => {
          mockLocalStorage = {};
        }),
      },
      writable: true,
    });

    // Default mock response
    mockFetchDiskList.mockResolvedValue({
      bootable: [{ name: 'system.dsk', size: 1024 }],
      data: [{ name: 'data.dsk', size: 2048 }],
    });
  });

  afterEach(() => {
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  describe('Provider', () => {
    it('should render children', async () => {
      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <div data-testid="child">Child Content</div>
        </DiskSettingsProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child Content');
    });

    it('should provide default settings', async () => {
      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('isLoading')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('mode')).toHaveTextContent('client-cached');
    });

    it('should fetch disk list on mount', async () => {
      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(mockFetchDiskList).toHaveBeenCalledWith('http://relay:8081');
      });

      await waitFor(() => {
        expect(screen.getByTestId('bootDisksCount')).toHaveTextContent('1');
      });
    });

    it('should handle fetch error', async () => {
      mockFetchDiskList.mockRejectedValueOnce(new Error('Network error'));

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('error')).toHaveTextContent('Network error');
      });
    });

    it('should load settings from localStorage', async () => {
      mockLocalStorage['dialtone-disk-settings-v2'] = JSON.stringify({
        mode: 'disk-server',
        bootDisk: 'saved.dsk',
        dataDisks: ['extra.dsk'],
      });

      // Mock to include the saved disk
      mockFetchDiskList.mockResolvedValue({
        bootable: [{ name: 'saved.dsk', size: 1024 }],
        data: [],
      });

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('isLoading')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('mode')).toHaveTextContent('disk-server');
      expect(screen.getByTestId('bootDisk')).toHaveTextContent('saved.dsk');
    });

    it('should pick random boot disk when none selected', async () => {
      mockFetchDiskList.mockResolvedValue({
        bootable: [
          { name: 'disk1.dsk', size: 1024 },
          { name: 'disk2.dsk', size: 1024 },
        ],
        data: [],
      });

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('isLoading')).toHaveTextContent('ready');
      });

      // Should have picked one of the available disks
      const bootDisk = screen.getByTestId('bootDisk').textContent;
      expect(['disk1.dsk', 'disk2.dsk']).toContain(bootDisk);
    });

    it('should migrate from old storage key', async () => {
      mockLocalStorage['dialtone-disk-settings'] = JSON.stringify({
        mode: 'disk-server',
        selectedDisk: 'old.dsk',
      });

      mockFetchDiskList.mockResolvedValue({
        bootable: [{ name: 'old.dsk', size: 1024 }],
        data: [],
      });

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('isLoading')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('bootDisk')).toHaveTextContent('old.dsk');
    });

    it('should save settings to localStorage', async () => {
      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <TestConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('isLoading')).toHaveTextContent('ready');
      });

      // Click save button
      await act(async () => {
        screen.getByText('Save').click();
      });

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'dialtone-disk-settings-v2',
        expect.stringContaining('disk-server')
      );
    });
  });

  describe('useDiskSettings', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useDiskSettings must be used within a DiskSettingsProvider');

      consoleSpy.mockRestore();
    });
  });

  describe('createDisk', () => {
    it('should call createDiskImage and refresh list', async () => {
      mockCreateDiskImage.mockResolvedValue({ name: 'new.dsk', size: 1024 });

      let capturedSettings: ReturnType<typeof useDiskSettings> | null = null;

      function CaptureConsumer() {
        capturedSettings = useDiskSettings();
        return null;
      }

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <CaptureConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(capturedSettings?.isLoading).toBe(false);
      });

      // Call createDisk
      await act(async () => {
        await capturedSettings?.createDisk('new.dsk', 10485760);
      });

      expect(mockCreateDiskImage).toHaveBeenCalledWith(
        'http://relay:8081',
        'new.dsk',
        10485760
      );

      // Should have refreshed the disk list
      expect(mockFetchDiskList).toHaveBeenCalledTimes(2);
    });

    it('should handle createDisk error', async () => {
      mockCreateDiskImage.mockRejectedValue(new Error('Disk exists'));

      let capturedSettings: ReturnType<typeof useDiskSettings> | null = null;

      function CaptureConsumer() {
        capturedSettings = useDiskSettings();
        return null;
      }

      render(
        <DiskSettingsProvider relayUrl="http://relay:8081">
          <CaptureConsumer />
        </DiskSettingsProvider>
      );

      await waitFor(() => {
        expect(capturedSettings?.isLoading).toBe(false);
      });

      // Call createDisk - should throw
      await expect(
        act(async () => {
          await capturedSettings?.createDisk('new.dsk', 1024);
        })
      ).rejects.toThrow('Disk exists');
    });
  });
});
