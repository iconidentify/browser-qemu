import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// HTTPS certs for local development (enables SharedArrayBuffer on LAN)
const httpsConfig = fs.existsSync('./localhost+2.pem') ? {
  key: fs.readFileSync('./localhost+2-key.pem'),
  cert: fs.readFileSync('./localhost+2.pem'),
} : undefined;

export default defineConfig({
  // For reverse-proxied deployments under a path prefix, set VITE_BASE_URL at build time,
  // e.g. VITE_BASE_URL=/my/prefix/ npm run build
  base: process.env.VITE_BASE_URL || '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@dialtone/emulator-bridge': path.resolve(__dirname, 'vendor/emulator-bridge/src'),
    },
  },
  server: {
    port: 3000,
    https: httpsConfig,
    host: true, // Listen on all interfaces for LAN access
    headers: {
      // Required for SharedArrayBuffer (used for emulator input)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
      },
      '/ethernet': {
        target: 'ws://localhost:8081',
        ws: true,
      },
      '/disk': {
        target: 'http://localhost:8081',
        changeOrigin: true,
      },
      '/automation': {
        target: 'ws://localhost:8081',
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@68k-web/emulator-bridge'],
  },
})
