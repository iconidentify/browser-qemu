/**
 * Core Abstraction Layer Exports
 *
 * Re-exports all types and utilities for the multi-core emulator architecture.
 */

// Types
export type {
  CoreAdapter,
  EmulatorCapabilities,
  EmulatorConfig,
  CursorData,
  MainToWorkerMessage,
  WorkerToMainMessage,
  WorkerStartConfig,
  WorkerApi,
  WorkerDiskApi,
  DiskStorageMode,
} from './types';

// Registry
export {
  registerCore,
  getCore,
  getRegisteredCores,
  isCoreRegistered,
  getAllCores,
  unregisterCore,
  clearCoreRegistry,
} from './registry';
export type { CoreAdapterFactory } from './registry';

// Basilisk II (68k Macintosh)
export { BasiliskAdapter, createBasiliskAdapter } from './basilisk';

// QEMU m68k (A/UX on a Quadra 800)
export { QEMUAdapter, createQEMUAdapter } from './qemu';

// Register adapters
import { registerCore } from './registry';
import { createBasiliskAdapter } from './basilisk';
import { createQEMUAdapter } from './qemu';
registerCore('basilisk', createBasiliskAdapter);
registerCore('qemu', createQEMUAdapter);
