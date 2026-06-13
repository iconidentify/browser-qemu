/**
 * Audio type definitions for the 68k Macintosh emulator
 */

/**
 * Audio configuration from the Mac emulator
 */
export interface AudioConfig {
  /** Sample rate in Hz (typically 22050) */
  sampleRate: number;
  /** Sample size in bits (typically 16) */
  sampleSize: number;
  /** Number of channels (typically 1 for mono) */
  channels: number;
}

/**
 * SharedArrayBuffer pair for audio ring buffer
 */
export interface AudioBuffers {
  /** Ring buffer for audio sample data */
  dataBuffer: SharedArrayBuffer;
  /** Control buffer: [writeIdx, readIdx] */
  controlBuffer: SharedArrayBuffer;
}

/**
 * Options passed to the AudioWorkletProcessor
 */
export interface AudioWorkletOptions {
  /** Sample rate in Hz */
  sampleRate: number;
  /** Sample size in bits */
  sampleSize: number;
  /** Number of channels */
  channels: number;
  /** SharedArrayBuffer for audio sample data */
  audioBuffer: SharedArrayBuffer;
  /** SharedArrayBuffer for control indices */
  controlBuffer: SharedArrayBuffer;
}

/**
 * VU meter data sent from worklet to main thread
 */
export interface VUMeterData {
  /** Peak level (0-1 range) */
  peak: number;
  /** RMS level (0-1 range) */
  rms: number;
  /** True if audio is clipping */
  clipping: boolean;
}

/**
 * Messages sent from AudioWorklet to main thread
 */
export type AudioWorkletMessage =
  | { type: 'vu-meter'; data: VUMeterData }
  | { type: 'underrun' }
  | { type: 'ready' };
