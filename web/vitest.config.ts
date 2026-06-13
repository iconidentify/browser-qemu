import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/emulator/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/types/*.ts',
        'src/test/**',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        // Exclude WASM workers (require integration testing)
        'src/emulator/**/*-worker.ts',
        // Exclude AudioWorklet (runs in different context)
        'src/emulator/audio/audio-worklet.ts',
        // Exclude React components (require integration testing)
        'src/emulator/*.tsx',
        'src/emulator/components/**',
        // Exclude theme definitions (static data)
        'src/emulator/themes/**',
        // Exclude re-export index files
        'src/emulator/**/index.ts',
        // Exclude React hooks (require component testing)
        'src/emulator/**/use*.ts',
        // Exclude DiskManager (higher-level orchestration)
        'src/emulator/services/DiskManager.ts',
      ],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});
