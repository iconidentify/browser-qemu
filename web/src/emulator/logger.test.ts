/**
 * Tests for logger utility
 *
 * The logger is silent in production builds (import.meta.env.PROD=true)
 * and logs to console in development (import.meta.env.PROD=false).
 * Errors always log regardless of environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from './logger';

describe('logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('in development mode (default test environment)', () => {
    // Note: The test environment has import.meta.env.PROD = false

    it('should pass log calls through to console.log', () => {
      logger.log('test message');

      expect(consoleLogSpy).toHaveBeenCalledWith('test message');
    });

    it('should pass warn calls through to console.warn', () => {
      logger.warn('warning message');

      expect(consoleWarnSpy).toHaveBeenCalledWith('warning message');
    });

    it('should pass info calls through to console.info', () => {
      logger.info('info message');

      expect(consoleInfoSpy).toHaveBeenCalledWith('info message');
    });

    it('should pass debug calls through to console.debug', () => {
      logger.debug('debug message');

      expect(consoleDebugSpy).toHaveBeenCalledWith('debug message');
    });

    it('should pass multiple arguments to console', () => {
      logger.log('message', { data: 123 }, [1, 2, 3]);

      expect(consoleLogSpy).toHaveBeenCalledWith('message', { data: 123 }, [1, 2, 3]);
    });
  });

  describe('error logging', () => {
    it('should always log errors regardless of environment', () => {
      logger.error('error message');

      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });

    it('should pass multiple arguments to console.error', () => {
      const error = new Error('test error');
      logger.error('Error occurred:', error);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error occurred:', error);
    });
  });

  describe('logger interface', () => {
    it('should expose log method', () => {
      expect(typeof logger.log).toBe('function');
    });

    it('should expose warn method', () => {
      expect(typeof logger.warn).toBe('function');
    });

    it('should expose info method', () => {
      expect(typeof logger.info).toBe('function');
    });

    it('should expose debug method', () => {
      expect(typeof logger.debug).toBe('function');
    });

    it('should expose error method', () => {
      expect(typeof logger.error).toBe('function');
    });
  });
});
