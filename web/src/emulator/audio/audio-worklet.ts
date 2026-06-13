/**
 * EmulatorAudioProcessor - AudioWorklet for 68k Mac audio playback
 *
 * Runs in a dedicated audio thread at the browser's sample rate (typically 48kHz).
 * Reads 16-bit signed samples from a SharedArrayBuffer ring buffer and converts
 * to float32 for Web Audio API output.
 *
 * Features:
 * - Zero-copy read from SharedArrayBuffer
 * - VU meter calculation (peak, RMS, clipping)
 * - Graceful silence generation on buffer underrun
 * - Throttled logging to avoid performance impact
 */

// AudioWorklet type declarations (these are only available in worklet context)
declare const currentTime: number;
declare function registerProcessor(name: string, processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

// Ring buffer control indices
const WRITE_INDEX = 0;
const READ_INDEX = 1;

// VU meter update interval (in samples at worklet rate)
// At 48kHz, 9600 samples = 200ms (reduced from 100ms to lower message frequency)
const VU_METER_INTERVAL = 9600;

interface ProcessorOptions {
  sampleSize: number;
  audioBuffer: SharedArrayBuffer;
  controlBuffer: SharedArrayBuffer;
}

class EmulatorAudioProcessor extends AudioWorkletProcessor {
  private dataBuffer: Uint8Array;
  private dataView: DataView;
  private controlBuffer: Int32Array;
  private bytesPerSample: number;
  private capacity: number;

  // VU meter state
  private peakHold: number = 0;
  private rmsSum: number = 0;
  private sampleCount: number = 0;

  // Throttled logging
  private lastUnderrunLog: number = -1;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as ProcessorOptions;

    this.dataBuffer = new Uint8Array(opts.audioBuffer);
    this.dataView = new DataView(opts.audioBuffer);
    this.controlBuffer = new Int32Array(opts.controlBuffer);
    this.bytesPerSample = opts.sampleSize / 8; // bits to bytes
    this.capacity = opts.audioBuffer.byteLength;

    // Signal that we're ready
    this.port.postMessage({ type: 'ready' });
  }

  /**
   * Read a batch of samples from ring buffer into output array.
   * Uses only TWO Atomics operations per batch instead of per-sample.
   * Returns number of samples actually read (may be less than requested on underrun).
   */
  private readSampleBatch(output: Float32Array): number {
    // Read indices ONCE at start of batch (reduces Atomics from ~48K/sec to ~375/sec)
    const writeIdx = Atomics.load(this.controlBuffer, WRITE_INDEX);
    let readIdx = Atomics.load(this.controlBuffer, READ_INDEX);

    // Calculate available bytes
    const availableBytes = writeIdx >= readIdx
      ? writeIdx - readIdx
      : this.capacity - readIdx + writeIdx;

    const requestedBytes = output.length * this.bytesPerSample;
    const bytesToRead = Math.min(availableBytes, requestedBytes);
    const samplesToRead = Math.floor(bytesToRead / this.bytesPerSample);

    if (samplesToRead === 0) {
      // Buffer underrun - generate silence
      if (currentTime - this.lastUnderrunLog > 1) {
        console.warn('[AudioWorklet] Buffer underrun, generating silence');
        this.lastUnderrunLog = currentTime;
        this.port.postMessage({ type: 'underrun' });
      }
      output.fill(0);
      return 0;
    }

    // Read samples in batch (no Atomics inside loop)
    for (let i = 0; i < samplesToRead; i++) {
      // Read 16-bit signed sample (big-endian, as Mac audio is stored)
      let sample16: number;
      if (readIdx + 2 <= this.capacity) {
        sample16 = this.dataView.getInt16(readIdx, false); // big-endian
      } else {
        // Sample spans buffer wrap - read bytes separately
        const byte0 = this.dataBuffer[readIdx];
        const byte1 = this.dataBuffer[0];
        // Big-endian: high byte first
        sample16 = (byte0 << 8) | byte1;
        // Convert to signed
        if (sample16 >= 0x8000) {
          sample16 -= 0x10000;
        }
      }

      // Convert to float32 (-1 to +1)
      output[i] = sample16 / 0x8000;

      // Update local read index (no Atomics here)
      readIdx = (readIdx + this.bytesPerSample) % this.capacity;
    }

    // Fill remaining with silence if we didn't get enough samples
    for (let i = samplesToRead; i < output.length; i++) {
      output[i] = 0;
    }

    // Update shared read index ONCE at end of batch
    Atomics.store(this.controlBuffer, READ_INDEX, readIdx);

    return samplesToRead;
  }

  /**
   * Update VU meter and send data periodically
   */
  private updateVUMeter(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const absSample = Math.abs(sample);
      this.peakHold = Math.max(this.peakHold, absSample);
      this.rmsSum += sample * sample;
      this.sampleCount++;
    }

    // Send VU meter data at interval
    if (this.sampleCount >= VU_METER_INTERVAL) {
      const rms = Math.sqrt(this.rmsSum / this.sampleCount);
      this.port.postMessage({
        type: 'vu-meter',
        data: {
          peak: this.peakHold,
          rms: rms,
          clipping: this.peakHold >= 0.99,
        },
      });

      // Decay peak hold for visual effect
      this.peakHold *= 0.9;
      this.rmsSum = 0;
      this.sampleCount = 0;
    }
  }

  /**
   * Main audio processing callback
   * Called ~375 times per second at 48kHz with 128-sample blocks.
   * Now uses batched Atomics reads (~750 ops/sec instead of ~48K/sec).
   */
  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    // Get the first channel (mono)
    const channel = output[0];

    // Read samples in batch (only 2 Atomics ops per call instead of 2 per sample)
    this.readSampleBatch(channel);

    // Copy to other channels if stereo output requested
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    // Update VU meter
    this.updateVUMeter(channel);

    // Return true to keep processor alive
    return true;
  }
}

registerProcessor('emulator-audio-processor', EmulatorAudioProcessor);
