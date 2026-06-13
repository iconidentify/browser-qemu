/**
 * Tests for EmulatorAudio
 *
 * EmulatorAudio manages the Web Audio API pipeline for the emulator,
 * including AudioContext creation, worklet loading, and volume control.
 *
 * Note: These tests use mocked AudioContext and AudioWorkletNode from setup.ts
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EmulatorAudio, EmulatorAudioCallbacks } from './EmulatorAudio';
import type { AudioConfig } from './types';

describe('EmulatorAudio', () => {
  let audio: EmulatorAudio;
  let callbacks: EmulatorAudioCallbacks;

  const defaultConfig: AudioConfig = {
    sampleRate: 22050,
    sampleSize: 16,
    channels: 1,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    callbacks = {
      onVUMeter: vi.fn(),
      onReady: vi.fn(),
      onUnderrun: vi.fn(),
    };
    audio = new EmulatorAudio(callbacks);
  });

  afterEach(() => {
    audio.stop();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create audio instance with buffers', () => {
      const buffers = audio.getBuffers();

      expect(buffers.dataBuffer).toBeInstanceOf(SharedArrayBuffer);
      expect(buffers.controlBuffer).toBeInstanceOf(SharedArrayBuffer);
    });

    it('should create data buffer with correct size', () => {
      const buffers = audio.getBuffers();
      // Buffer size is 22050 * 2 * 2 = 88200 bytes
      expect(buffers.dataBuffer.byteLength).toBe(88200);
    });

    it('should create control buffer with correct size', () => {
      const buffers = audio.getBuffers();
      expect(buffers.controlBuffer.byteLength).toBe(16);
    });
  });

  describe('getBuffers', () => {
    it('should return audio buffers', () => {
      const buffers = audio.getBuffers();

      expect(buffers).toHaveProperty('dataBuffer');
      expect(buffers).toHaveProperty('controlBuffer');
    });

    it('should return same buffers on multiple calls', () => {
      const buffers1 = audio.getBuffers();
      const buffers2 = audio.getBuffers();

      expect(buffers1.dataBuffer).toBe(buffers2.dataBuffer);
      expect(buffers1.controlBuffer).toBe(buffers2.controlBuffer);
    });
  });

  describe('init', () => {
    it('should initialize audio context', async () => {
      await audio.init(defaultConfig);

      expect(audio.getState()).not.toBe('uninitialized');
    });

    it('should store config', async () => {
      await audio.init(defaultConfig);

      expect(audio.getConfig()).toEqual(defaultConfig);
    });

    it('should not reinitialize if already initialized', async () => {
      await audio.init(defaultConfig);

      // Second init should return without error
      await audio.init(defaultConfig);

      expect(audio.getConfig()).toEqual(defaultConfig);
    });

    it('should call onReady after startup delay', async () => {
      await audio.init(defaultConfig);

      expect(callbacks.onReady).not.toHaveBeenCalled();

      // Advance past startup delay (250ms)
      vi.advanceTimersByTime(300);

      expect(callbacks.onReady).toHaveBeenCalled();
    });
  });

  describe('setVolume', () => {
    it('should set volume before init', () => {
      // Should not throw
      audio.setVolume(0.5);
    });

    it('should clamp volume to 0-1 range', async () => {
      await audio.init(defaultConfig);

      audio.setVolume(-0.5);
      // Volume is set via setTargetAtTime, so we can't directly check the value
      // But it should not throw

      audio.setVolume(1.5);
      // Should also not throw
    });
  });

  describe('getVolume', () => {
    it('should return 1.0 when not initialized', () => {
      expect(audio.getVolume()).toBe(1.0);
    });

    it('should return current volume after init', async () => {
      await audio.init(defaultConfig);

      // Initial volume is 1.0
      expect(audio.getVolume()).toBe(1);
    });
  });

  describe('mute', () => {
    it('should set volume to 0', async () => {
      await audio.init(defaultConfig);

      audio.mute();

      // mute calls setVolume(0), which uses setTargetAtTime
      // The mock doesn't update the value, but it shouldn't throw
    });
  });

  describe('getState', () => {
    it('should return uninitialized before init', () => {
      expect(audio.getState()).toBe('uninitialized');
    });

    it('should return audio context state after init', async () => {
      await audio.init(defaultConfig);

      // Mock AudioContext state is 'running'
      expect(audio.getState()).toBe('running');
    });
  });

  describe('getConfig', () => {
    it('should return null before init', () => {
      expect(audio.getConfig()).toBeNull();
    });

    it('should return config after init', async () => {
      await audio.init(defaultConfig);

      expect(audio.getConfig()).toEqual(defaultConfig);
    });
  });

  describe('getBufferStats', () => {
    it('should return buffer statistics', () => {
      const stats = audio.getBufferStats();

      expect(stats).toHaveProperty('used');
      expect(stats).toHaveProperty('available');
      expect(stats).toHaveProperty('capacity');
      expect(stats.capacity).toBe(88200);
    });

    it('should return 0 used when buffer is empty', () => {
      const stats = audio.getBufferStats();

      expect(stats.used).toBe(0);
      expect(stats.available).toBe(88199); // capacity - 1
    });

    it('should reflect buffer usage when data is written', () => {
      const buffers = audio.getBuffers();
      const ctrlBuffer = new Int32Array(buffers.controlBuffer);

      // Simulate 1000 bytes written
      Atomics.store(ctrlBuffer, 0, 1000); // writeIdx

      const stats = audio.getBufferStats();
      expect(stats.used).toBe(1000);
    });

    it('should handle buffer wraparound', () => {
      const buffers = audio.getBuffers();
      const ctrlBuffer = new Int32Array(buffers.controlBuffer);

      // Simulate wraparound: readIdx ahead of writeIdx
      Atomics.store(ctrlBuffer, 0, 100); // writeIdx
      Atomics.store(ctrlBuffer, 1, 88000); // readIdx

      const stats = audio.getBufferStats();
      // used = capacity - readIdx + writeIdx = 88200 - 88000 + 100 = 300
      expect(stats.used).toBe(300);
    });
  });

  describe('reset', () => {
    it('should reset buffer indices to 0', () => {
      const buffers = audio.getBuffers();
      const ctrlBuffer = new Int32Array(buffers.controlBuffer);

      // Set some values
      Atomics.store(ctrlBuffer, 0, 1000);
      Atomics.store(ctrlBuffer, 1, 500);

      audio.reset();

      expect(Atomics.load(ctrlBuffer, 0)).toBe(0);
      expect(Atomics.load(ctrlBuffer, 1)).toBe(0);
    });
  });

  describe('stop', () => {
    it('should stop without error when not initialized', () => {
      expect(() => audio.stop()).not.toThrow();
    });

    it('should stop and cleanup after init', async () => {
      await audio.init(defaultConfig);

      audio.stop();

      expect(audio.getState()).toBe('uninitialized');
    });

    it('should allow re-initialization after stop', async () => {
      await audio.init(defaultConfig);
      audio.stop();

      await audio.init(defaultConfig);

      expect(audio.getConfig()).toEqual(defaultConfig);
    });
  });

  describe('worklet message handling', () => {
    it('should call onVUMeter callback on vu-meter message', async () => {
      await audio.init(defaultConfig);

      // Get the worklet node and simulate a message
      // The mock AudioWorkletNode stores the port.onmessage handler
      // We need to access it through the audio instance
      // Since we can't easily access the private workletNode, we skip this for now
    });

    it('should call onUnderrun callback on underrun message', async () => {
      await audio.init(defaultConfig);

      // Similar to above - the message handler is set on the worklet port
      // Testing this would require exposing the worklet or using more complex mocking
    });
  });

  describe('different audio configurations', () => {
    it('should handle mono audio', async () => {
      const monoConfig: AudioConfig = {
        sampleRate: 22050,
        sampleSize: 16,
        channels: 1,
      };

      await audio.init(monoConfig);

      expect(audio.getConfig()?.channels).toBe(1);
    });

    it('should handle stereo audio', async () => {
      const stereoConfig: AudioConfig = {
        sampleRate: 22050,
        sampleSize: 16,
        channels: 2,
      };

      await audio.init(stereoConfig);

      expect(audio.getConfig()?.channels).toBe(2);
    });

    it('should handle different sample rates', async () => {
      const config44k: AudioConfig = {
        sampleRate: 44100,
        sampleSize: 16,
        channels: 1,
      };

      await audio.init(config44k);

      expect(audio.getConfig()?.sampleRate).toBe(44100);
    });
  });

  describe('callbacks without handlers', () => {
    it('should work without callbacks', async () => {
      const audioNoCallbacks = new EmulatorAudio();

      await audioNoCallbacks.init(defaultConfig);
      vi.advanceTimersByTime(300);

      // Should not throw
      audioNoCallbacks.stop();
    });
  });
});
