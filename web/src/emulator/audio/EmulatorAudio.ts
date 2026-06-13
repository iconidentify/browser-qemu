/**
 * EmulatorAudio - Main audio controller for 68k Mac emulator
 *
 * Manages the Web Audio API pipeline:
 * - Creates AudioContext with low-latency settings
 * - Loads and creates AudioWorkletNode
 * - Provides volume control via GainNode
 * - Handles browser autoplay restrictions
 * - Implements startup delay for buffer priming
 */

import type { AudioConfig, AudioBuffers, VUMeterData } from './types';
import { logger } from '../logger';

// Buffer size: ~2 seconds at 22050Hz, 16-bit mono
// This is larger than Infinite Mac's 1 second buffer for more resilience
const AUDIO_BUFFER_SIZE = 22050 * 2 * 2; // 88,200 bytes

// Delay before signaling emulator to start audio
// Allows buffer to prime and prevents initial underrun
const STARTUP_DELAY_MS = 250;

export interface EmulatorAudioCallbacks {
  /** Called with VU meter data (~10 times per second) */
  onVUMeter?: (data: VUMeterData) => void;
  /** Called when audio is ready to receive data */
  onReady?: () => void;
  /** Called when buffer underrun occurs */
  onUnderrun?: () => void;
}

export class EmulatorAudio {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;

  // SharedArrayBuffers for audio data
  private audioDataBuffer: SharedArrayBuffer;
  private audioControlBuffer: SharedArrayBuffer;

  private callbacks: EmulatorAudioCallbacks;
  private _config: AudioConfig | null = null;
  private initialized = false;

  // Event handlers for cleanup
  private resumeHandler: (() => void) | null = null;

  constructor(callbacks: EmulatorAudioCallbacks = {}) {
    this.callbacks = callbacks;

    // Pre-allocate SharedArrayBuffers
    this.audioDataBuffer = new SharedArrayBuffer(AUDIO_BUFFER_SIZE);
    this.audioControlBuffer = new SharedArrayBuffer(16); // [writeIdx, readIdx]

    logger.log('[EmulatorAudio] Created with buffer size:', AUDIO_BUFFER_SIZE, 'bytes');
  }

  /**
   * Get buffers to pass to worker
   */
  getBuffers(): AudioBuffers {
    return {
      dataBuffer: this.audioDataBuffer,
      controlBuffer: this.audioControlBuffer,
    };
  }

  /**
   * Initialize audio system
   * Called when emulator reports audio configuration
   */
  async init(config: AudioConfig): Promise<void> {
    if (this.initialized) {
      logger.warn('[EmulatorAudio] Already initialized');
      return;
    }

    this._config = config;
    logger.log(
      `[EmulatorAudio] Initializing: ${config.sampleRate}Hz, ${config.sampleSize}-bit, ${config.channels}ch`
    );

    try {
      // Create AudioContext
      // Note: Setting sampleRate to Mac's rate lets the browser handle resampling
      this.audioContext = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: config.sampleRate,
      });

      // Load the worklet module using inline Blob URL
      // This avoids issues with Vite bundling AudioWorklet modules
      const workletCode = getAudioWorkletCode();
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl); // Clean up after loading

      // Create the worklet node
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        'emulator-audio-processor',
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [config.channels],
          processorOptions: {
            sampleRate: config.sampleRate,
            sampleSize: config.sampleSize,
            channels: config.channels,
            audioBuffer: this.audioDataBuffer,
            controlBuffer: this.audioControlBuffer,
          },
        }
      );

      // Handle messages from worklet
      this.workletNode.port.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'vu-meter':
            this.callbacks.onVUMeter?.(msg.data);
            break;
          case 'underrun':
            this.callbacks.onUnderrun?.();
            break;
          case 'ready':
            logger.log('[EmulatorAudio] Worklet ready');
            break;
        }
      };

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;

      // Connect: worklet -> gain -> destination
      this.workletNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      this.initialized = true;

      // Handle AudioContext state
      await this.handleAudioContextState();

    } catch (err) {
      console.error('[EmulatorAudio] Initialization failed:', err);
      throw err;
    }
  }

  /**
   * Handle browser autoplay restrictions
   */
  private async handleAudioContextState(): Promise<void> {
    const ctx = this.audioContext;
    if (!ctx) return;

    const initialState = ctx.state;

    if (initialState === 'suspended') {
      logger.log('[EmulatorAudio] AudioContext suspended, waiting for user gesture');

      // Set up handler for user gesture
      this.resumeHandler = async () => {
        if (this.audioContext?.state === 'suspended') {
          try {
            await this.audioContext.resume();
            logger.log('[EmulatorAudio] AudioContext resumed via user gesture');
          } catch (err) {
            console.error('[EmulatorAudio] Failed to resume:', err);
            return;
          }
        }

        if (this.audioContext?.state === 'running') {
          this.removeResumeHandler();
          this.scheduleAudioStart();
        }
      };

      // Listen for user gestures
      window.addEventListener('pointerdown', this.resumeHandler, { once: false });
      window.addEventListener('keydown', this.resumeHandler, { once: false });

      // Also try to resume immediately (works if autoplay is allowed)
      try {
        await ctx.resume();
        if (ctx.state === 'running') {
          this.removeResumeHandler();
          this.scheduleAudioStart();
        }
      } catch {
        // Expected to fail if autoplay is blocked
        logger.log('[EmulatorAudio] Autoplay blocked, waiting for user gesture');
      }
    } else if (initialState === 'running') {
      this.scheduleAudioStart();
    }
  }

  /**
   * Remove user gesture event handlers
   */
  private removeResumeHandler(): void {
    if (this.resumeHandler) {
      window.removeEventListener('pointerdown', this.resumeHandler);
      window.removeEventListener('keydown', this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  /**
   * Schedule audio start after buffer priming delay
   */
  private scheduleAudioStart(): void {
    logger.log(`[EmulatorAudio] Scheduling audio start in ${STARTUP_DELAY_MS}ms`);
    setTimeout(() => {
      logger.log('[EmulatorAudio] Audio context running, signaling emulator');
      this.callbacks.onReady?.();
    }, STARTUP_DELAY_MS);
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    if (this.gainNode && this.audioContext) {
      const clampedVolume = Math.max(0, Math.min(1, volume));
      // Use exponential ramp for natural volume perception
      this.gainNode.gain.setTargetAtTime(
        clampedVolume,
        this.audioContext.currentTime,
        0.015 // 15ms time constant for smooth transition
      );
    }
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.gainNode?.gain.value ?? 1.0;
  }

  /**
   * Mute audio
   */
  mute(): void {
    this.setVolume(0);
  }

  /**
   * Get audio context state
   */
  getState(): AudioContextState | 'uninitialized' {
    return this.audioContext?.state ?? 'uninitialized';
  }

  /**
   * Get current audio configuration
   */
  getConfig(): AudioConfig | null {
    return this._config;
  }

  /**
   * Get buffer statistics
   */
  getBufferStats(): { used: number; available: number; capacity: number } {
    const ctrlBuffer = new Int32Array(this.audioControlBuffer);
    const writeIdx = Atomics.load(ctrlBuffer, 0);
    const readIdx = Atomics.load(ctrlBuffer, 1);
    const capacity = AUDIO_BUFFER_SIZE;

    const used = writeIdx >= readIdx
      ? writeIdx - readIdx
      : capacity - readIdx + writeIdx;

    return {
      used,
      available: capacity - used - 1,
      capacity,
    };
  }

  /**
   * Reset audio buffer (e.g., on seek or restart)
   */
  reset(): void {
    const ctrlBuffer = new Int32Array(this.audioControlBuffer);
    Atomics.store(ctrlBuffer, 0, 0); // writeIdx
    Atomics.store(ctrlBuffer, 1, 0); // readIdx
    logger.log('[EmulatorAudio] Buffer reset');
  }

  /**
   * Stop audio playback and cleanup
   */
  stop(): void {
    this.removeResumeHandler();

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        logger.warn('[EmulatorAudio] Error closing AudioContext:', err);
      });
      this.audioContext = null;
    }

    this.initialized = false;
    logger.log('[EmulatorAudio] Stopped');
  }
}

/**
 * Get the AudioWorklet processor code as a string.
 * This allows us to load the worklet via Blob URL, which is more reliable
 * than trying to bundle it with Vite.
 */
function getAudioWorkletCode(): string {
  return `
// Ring buffer control indices
const WRITE_INDEX = 0;
const READ_INDEX = 1;

// VU meter update interval (in samples at worklet rate)
// 512 samples at 22050Hz = ~23ms for snappy response
const VU_METER_INTERVAL = 512;

class EmulatorAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions;

    this.dataBuffer = new Uint8Array(opts.audioBuffer);
    this.dataView = new DataView(opts.audioBuffer);
    this.controlBuffer = new Int32Array(opts.controlBuffer);
    this.bytesPerSample = opts.sampleSize / 8;
    this.capacity = opts.audioBuffer.byteLength;

    // VU meter state
    this.peakHold = 0;
    this.rmsSum = 0;
    this.sampleCount = 0;

    this.port.postMessage({ type: 'ready' });
  }

  availableRead() {
    const writeIdx = Atomics.load(this.controlBuffer, WRITE_INDEX);
    const readIdx = Atomics.load(this.controlBuffer, READ_INDEX);
    return writeIdx >= readIdx
      ? writeIdx - readIdx
      : this.capacity - readIdx + writeIdx;
  }

  generateSample() {
    const available = this.availableRead();

    if (available < this.bytesPerSample) {
      // Underruns are normal during startup/tab switching, no need to log
      return 0;
    }

    const readIdx = Atomics.load(this.controlBuffer, READ_INDEX);

    // Read 16-bit signed sample (big-endian)
    let sample16;
    if (readIdx + 2 <= this.capacity) {
      sample16 = this.dataView.getInt16(readIdx, false);
    } else {
      const byte0 = this.dataBuffer[readIdx];
      const byte1 = this.dataBuffer[0];
      sample16 = (byte0 << 8) | byte1;
      if (sample16 >= 0x8000) sample16 -= 0x10000;
    }

    const newReadIdx = (readIdx + this.bytesPerSample) % this.capacity;
    Atomics.store(this.controlBuffer, READ_INDEX, newReadIdx);

    return sample16 / 0x8000;
  }

  updateVUMeter(samples) {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const absSample = Math.abs(sample);
      this.peakHold = Math.max(this.peakHold, absSample);
      this.rmsSum += sample * sample;
      this.sampleCount++;
    }

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

      // Fast peak decay for snappy meter response
      this.peakHold *= 0.5;
      this.rmsSum = 0;
      this.sampleCount = 0;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];

    for (let i = 0; i < channel.length; i++) {
      channel[i] = this.generateSample();
    }

    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(channel);
    }

    this.updateVUMeter(channel);

    return true;
  }
}

registerProcessor('emulator-audio-processor', EmulatorAudioProcessor);
`;
}
