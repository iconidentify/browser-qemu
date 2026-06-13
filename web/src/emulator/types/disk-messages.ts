/**
 * Disk operation message types for worker <-> main thread communication
 */

// Messages from Main Thread to Worker
export type MainToWorkerDiskMessage =
  | { type: 'disk_mount'; diskId: string; name: string; data: ArrayBuffer }
  | { type: 'disk_create'; diskId: string; name: string; templateData: ArrayBuffer }
  | { type: 'disk_eject'; diskId: string }
  | { type: 'disk_get_data'; diskId: string }
  | { type: 'disk_clear_dirty'; diskId: string }
  | { type: 'disk_list' };

// Messages from Worker to Main Thread
export type WorkerToMainDiskMessage =
  | { type: 'disk_mounted'; diskId: string; name: string; sizeBytes: number; isBootDisk: boolean }
  | { type: 'disk_ejected'; diskId: string; name: string }
  | { type: 'disk_error'; diskId: string; error: string }
  | { type: 'disk_dirty'; diskId: string; isDirty: boolean; dirtyBytes?: number }
  | { type: 'disk_data'; diskId: string; data: ArrayBuffer }
  | { type: 'disk_list_response'; disks: DiskInfo[] };

export interface DiskInfo {
  diskId: string;
  name: string;
  size: number;
  isDirty: boolean;
  isBootDisk: boolean;
}

export interface MountedDiskInfo extends DiskInfo {
  mountedAt?: number;
  lastWriteTime?: number;
}

// Size presets for creating blank disks
export const DISK_SIZE_PRESETS = [
  { label: '800K', bytes: 800 * 1024, description: 'Floppy disk' },
  { label: '1.4MB', bytes: 1.4 * 1024 * 1024, description: 'HD floppy' },
  { label: '10MB', bytes: 10 * 1024 * 1024, description: 'Small disk' },
  { label: '50MB', bytes: 50 * 1024 * 1024, description: 'Medium disk' },
  { label: '100MB', bytes: 100 * 1024 * 1024, description: 'Large disk' },
] as const;

export type DiskSizePreset = typeof DISK_SIZE_PRESETS[number];
