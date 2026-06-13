/**
 * Buffer lock protocol module.
 *
 * Provides the 4-state cyclical lock for SharedArrayBuffer coordination.
 */

export {
  BufferLockManager,
  MockBufferLockManager,
  LockState,
  type BufferLockManagerConfig,
  type IBufferLockManager,
} from './BufferLockManager';
