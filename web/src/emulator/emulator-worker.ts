/**
 * Emulator Worker
 *
 * Web Worker that runs the BasiliskII WASM emulator.
 * This is a simplified version focused on Dialtone networking.
 *
 * For the full implementation, we need to:
 * 1. Load the BasiliskII.wasm module
 * 2. Set up the Emscripten environment
 * 3. Initialize video, audio, input, and ethernet subsystems
 * 4. Run the main emulator loop
 *
 * This is a placeholder that will be replaced with the full
 * Infinite Mac worker integration.
 */

import { logger } from './logger';

interface EmulatorConfig {
  rom: number[]
  disk: number[]
  screenWidth: number
  screenHeight: number
}

// Ethernet packet interface for future use
export interface EthernetPacket {
  destination: string
  packet: number[]
}

// Global state (some unused until full implementation)
let _config: EmulatorConfig | null = null
let macAddress: string | null = null
let running = false

// Emscripten module reference (will be populated when WASM loads)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Module: unknown = null

// Queue for ethernet packets to send to emulator
const ethernetReceiveQueue: Uint8Array[] = []

/**
 * Initialize the emulator with the provided configuration
 */
async function initEmulator(cfg: EmulatorConfig) {
  _config = cfg

  try {
    // Load the WASM module
    // In production, this would be:
    // const response = await fetch('/emulator/BasiliskII.wasm')
    // const wasmBinary = await response.arrayBuffer()
    // Module = await loadEmscriptenModule(wasmBinary, cfg)

    // For now, post a placeholder ready message
    // The full implementation requires the Emscripten JS glue code

    // Generate a MAC address for this instance
    macAddress = generateMacAddress()

    // Notify main thread we're ready
    postMessage({ type: 'ready' })

    // Initialize ethernet
    postMessage({ type: 'ethernet_init', macAddress })

    // Start the emulation loop (placeholder)
    running = true
    emulationLoop()

  } catch (err) {
    postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * Generate a locally-administered MAC address
 * Format: 02:XX:XX:XX:XX:XX (locally administered, unicast)
 */
function generateMacAddress(): string {
  const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return `02:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`
}

/**
 * Main emulation loop (placeholder)
 *
 * In a full implementation, this would:
 * 1. Run CPU instructions
 * 2. Handle video refresh
 * 3. Process input events
 * 4. Handle ethernet I/O
 */
function emulationLoop() {
  if (!running) return

  // Process any pending ethernet packets
  while (ethernetReceiveQueue.length > 0) {
    const packet = ethernetReceiveQueue.shift()
    if (packet) {
      handleEthernetReceive(packet)
    }
  }

  // In a real implementation, the WASM module would:
  // - Execute CPU cycles
  // - Render video frames
  // - Generate audio samples
  // - Poll for input

  // For now, just schedule the next iteration
  // The actual emulator uses requestAnimationFrame or a tight loop
  setTimeout(emulationLoop, 16) // ~60fps
}

/**
 * Handle ethernet packet received from the network
 */
function handleEthernetReceive(packet: Uint8Array) {
  // In a full implementation, this would:
  // 1. Write the packet to the emulator's ethernet buffer
  // 2. Trigger an ethernet interrupt in the guest

  // The WASM module exposes etherRead() for the guest to read packets
  logger.log(`[Worker] Received ethernet packet: ${packet.length} bytes`)
}

/**
 * Send ethernet packet from the emulator to the network
 * Called by the WASM module when the guest sends a packet
 */
function _sendEthernetPacket(destination: string, packet: Uint8Array) {
  postMessage({
    type: 'ethernet_write',
    destination,
    packet: Array.from(packet)
  })
}

/**
 * Handle keyboard input
 */
function handleKeyDown(code: string, _key: string) {
  // Convert to ADB keycode and send to emulator
  // The mapping is in Infinite Mac's key-codes.ts
  logger.log(`[Worker] Key down: ${code}`)
}

function handleKeyUp(code: string, _key: string) {
  logger.log(`[Worker] Key up: ${code}`)
}

/**
 * Handle mouse input
 */
function handleMouseMove(_x: number, _y: number) {
  // Send to emulator's input subsystem
}

function handleMouseDown(button: number) {
  logger.log(`[Worker] Mouse down: ${button}`)
}

function handleMouseUp(button: number) {
  logger.log(`[Worker] Mouse up: ${button}`)
}

// Message handler
self.onmessage = (e: MessageEvent) => {
  const { type, ...data } = e.data

  switch (type) {
    case 'start':
      initEmulator(data.config)
      break

    case 'stop':
      running = false
      break

    case 'ethernet_receive':
      ethernetReceiveQueue.push(new Uint8Array(data.packet))
      break

    case 'keydown':
      handleKeyDown(data.code, data.key)
      break

    case 'keyup':
      handleKeyUp(data.code, data.key)
      break

    case 'mousemove':
      handleMouseMove(data.x, data.y)
      break

    case 'mousedown':
      handleMouseDown(data.button)
      break

    case 'mouseup':
      handleMouseUp(data.button)
      break

    default:
      logger.warn(`[Worker] Unknown message type: ${type}`)
  }
}

// Export for WASM module to call
// These would be registered with Emscripten's addFunction or via Module exports
export const workerApi = {
  // Called by WASM when ethernet is initialized
  etherInit: (macAddr: string) => {
    macAddress = macAddr
    postMessage({ type: 'ethernet_init', macAddress: macAddr })
  },

  // Called by WASM to send ethernet packet
  etherWrite: (_destination: string, _packetPtr: number, _packetLength: number) => {
    // In full implementation: read from WASM memory
    // const packet = _Module.HEAPU8.slice(_packetPtr, _packetPtr + _packetLength)
    // _sendEthernetPacket(_destination, packet)
  },

  // Called by WASM to read ethernet packet
  etherRead: (_packetPtr: number, maxLength: number): number => {
    if (ethernetReceiveQueue.length === 0) {
      return 0
    }
    const packet = ethernetReceiveQueue.shift()!
    // In full implementation: write to WASM memory
    // Module.HEAPU8.set(packet.subarray(0, maxLength), packetPtr)
    return Math.min(packet.length, maxLength)
  },

  // Called by WASM to generate random MAC seed
  etherSeed: (): number => {
    return Math.floor(Math.random() * 0xFFFFFFFF)
  },

  // Video blit callback
  blit: (_bufPtr: number, _bufSize: number) => {
    // In full implementation: read from WASM memory and post to main thread
    // const imageData = _Module.HEAPU8.slice(_bufPtr, _bufPtr + _bufSize)
    // postMessage({ type: 'blit', imageData }, [imageData.buffer])
  },
}

// Log initialization - referencing placeholders for TS
logger.log('[Worker] Emulator worker initialized', {
  configReady: _config !== null,
  moduleReady: _Module !== null,
  sendFn: typeof _sendEthernetPacket,
})
