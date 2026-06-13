/**
 * Tests for MockBufferWriter.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockBufferWriter } from './MockBufferWriter';
import { InputEventPriority } from '../queue/types';

describe('MockBufferWriter', () => {
  let writer: MockBufferWriter;

  beforeEach(() => {
    writer = new MockBufferWriter();
  });

  describe('writeBatch', () => {
    it('should write mouse move events', () => {
      const result = writer.writeBatch([
        {
          type: 'mousemove',
          x: 100,
          y: 200,
          priority: InputEventPriority.NORMAL,
          timestamp: 0,
        },
      ]);

      expect(result.written).toBe(1);
      expect(result.remaining).toHaveLength(0);
      expect(writer.getMousePosition()).toEqual({ x: 100, y: 200 });
    });

    it('should write mouse button events', () => {
      const result = writer.writeBatch([
        {
          type: 'mousedown',
          button: 0,
          pressed: true,
          priority: InputEventPriority.HIGH,
          timestamp: 0,
        },
      ]);

      expect(result.written).toBe(1);
      expect(writer.getButtonState(0)).toBe(true);
    });

    it('should write only one key event per batch', () => {
      const result = writer.writeBatch([
        {
          type: 'keydown',
          keyCode: 0x00,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
        {
          type: 'keydown',
          keyCode: 0x01,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
      ]);

      expect(result.written).toBe(1);
      expect(result.remaining).toHaveLength(1);
      expect(writer.getKeyState(0x00)).toBe(true);
      expect(writer.getKeyState(0x01)).toBe(false);
    });

    it('should write mixed event types', () => {
      const result = writer.writeBatch([
        {
          type: 'mousemove',
          x: 100,
          y: 200,
          priority: InputEventPriority.NORMAL,
          timestamp: 0,
        },
        {
          type: 'mousedown',
          button: 0,
          pressed: true,
          priority: InputEventPriority.HIGH,
          timestamp: 0,
        },
        {
          type: 'keydown',
          keyCode: 0x00,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
      ]);

      expect(result.written).toBe(3);
      expect(result.remaining).toHaveLength(0);
    });
  });

  describe('getWrites', () => {
    it('should return all recorded writes', () => {
      writer.writeBatch([
        {
          type: 'mousemove',
          x: 100,
          y: 200,
          priority: InputEventPriority.NORMAL,
          timestamp: 0,
        },
        {
          type: 'keydown',
          keyCode: 0x00,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
      ]);

      const writes = writer.getWrites();
      expect(writes).toHaveLength(2);
    });
  });

  describe('getKeyWrites', () => {
    it('should return only key events', () => {
      writer.writeBatch([
        {
          type: 'mousemove',
          x: 100,
          y: 200,
          priority: InputEventPriority.NORMAL,
          timestamp: 0,
        },
        {
          type: 'keydown',
          keyCode: 0x00,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
      ]);

      const keyWrites = writer.getKeyWrites();
      expect(keyWrites).toHaveLength(1);
      expect(keyWrites[0].keyCode).toBe(0x00);
    });
  });

  describe('clear', () => {
    it('should clear all state', () => {
      writer.writeBatch([
        {
          type: 'mousemove',
          x: 100,
          y: 200,
          priority: InputEventPriority.NORMAL,
          timestamp: 0,
        },
        {
          type: 'keydown',
          keyCode: 0x00,
          modifiers: 0,
          priority: InputEventPriority.CRITICAL,
          timestamp: 0,
        },
      ]);

      writer.clear();

      expect(writer.getWrites()).toHaveLength(0);
      expect(writer.getMousePosition()).toBeNull();
      expect(writer.getKeyState(0x00)).toBe(false);
    });
  });
});
