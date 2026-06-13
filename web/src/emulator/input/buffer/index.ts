/**
 * Buffer writer module.
 *
 * Provides atomic batch writing to SharedArrayBuffer.
 */

export {
  SharedMemoryBufferWriter,
  type SharedMemoryBufferWriterConfig,
} from './SharedMemoryBufferWriter';

export {
  MockBufferWriter,
  type RecordedWrite,
  type RecordedMouseMove,
  type RecordedMouseButton,
  type RecordedKeyEvent,
} from './MockBufferWriter';
