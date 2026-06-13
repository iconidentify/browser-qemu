/**
 * Emulator Bridge - WebSocket client for Dialtone Relay
 *
 * Provides network shim API for the WASM emulator:
 *   net_open(host, port) -> connId
 *   net_write(connId, bytes)
 *   net_close(connId)
 *   net_onData(connId, callback)
 *
 * Also provides Ethernet-level bridging via DialtoneEthernetProvider.
 */

// Re-export DialtoneEthernetProvider for Ethernet-level networking
export {
  DialtoneEthernetProvider,
  createDialtoneEthernetProvider,
  type EthernetProvider,
  type EthernetProviderDelegate,
} from './DialtoneEthernetProvider'

import {
  FrameType,
  encodeFrame,
  decodeFrame,
  encodeOpenPayload,
  decodeErrorPayload,
  type OpenPayload,
  type ErrorPayload,
} from '@68k-web/relay-proto-ts'

export type DataCallback = (data: Uint8Array) => void
export type ErrorCallback = (error: ErrorPayload) => void
export type CloseCallback = (reason?: string) => void

interface PendingOpen {
  resolve: (connId: number) => void
  reject: (error: Error) => void
}

interface ConnectionState {
  onData?: DataCallback
  onError?: ErrorCallback
  onClose?: CloseCallback
}

export class RelayClient {
  private ws: WebSocket | null = null
  private connections = new Map<number, ConnectionState>()
  private pendingOpens = new Map<number, PendingOpen>()
  private nextRequestId = 1
  private connected = false

  constructor(private wsUrl: string, private token: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, [`dialtone-relay.v1`, this.token])

      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        this.connected = true
        resolve()
      }

      this.ws.onerror = (e) => {
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = () => {
        this.connected = false
        // Notify all connections of closure
        for (const [connId, state] of this.connections) {
          state.onClose?.('session_closed')
        }
        this.connections.clear()
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(new Uint8Array(event.data as ArrayBuffer))
      }
    })
  }

  private handleMessage(data: Uint8Array): void {
    const frame = decodeFrame(data)
    if (!frame) return

    switch (frame.type) {
      case FrameType.OPEN_ACK: {
        // Frame payload contains the assigned connId for this connection
        const pending = this.pendingOpens.get(frame.connId)
        if (pending) {
          // The actual connId is in the payload (first 4 bytes)
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset)
          const assignedConnId = view.getUint32(0, true)
          pending.resolve(assignedConnId)
          this.pendingOpens.delete(frame.connId)
        }
        break
      }

      case FrameType.DATA: {
        const state = this.connections.get(frame.connId)
        state?.onData?.(frame.payload)
        break
      }

      case FrameType.CLOSE: {
        const state = this.connections.get(frame.connId)
        state?.onClose?.()
        this.connections.delete(frame.connId)
        break
      }

      case FrameType.ERROR: {
        const error = decodeErrorPayload(frame.payload)
        const state = this.connections.get(frame.connId)
        state?.onError?.(error)

        // Check for pending opens
        const pending = this.pendingOpens.get(frame.connId)
        if (pending) {
          pending.reject(new Error(error.message))
          this.pendingOpens.delete(frame.connId)
        }
        break
      }

      case FrameType.PONG:
        // Keepalive response, no action needed
        break
    }
  }

  async open(host: string, port: number, timeoutMs = 5000): Promise<number> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to relay')
    }

    const requestId = this.nextRequestId++
    const payload: OpenPayload = { host, port, connectTimeoutMs: timeoutMs }

    return new Promise((resolve, reject) => {
      this.pendingOpens.set(requestId, { resolve, reject })

      const frame = encodeFrame(FrameType.OPEN, requestId, encodeOpenPayload(payload))
      this.ws!.send(frame)

      // Timeout
      setTimeout(() => {
        if (this.pendingOpens.has(requestId)) {
          this.pendingOpens.delete(requestId)
          reject(new Error('Connection timeout'))
        }
      }, timeoutMs + 1000)
    })
  }

  write(connId: number, data: Uint8Array): void {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to relay')
    }

    const frame = encodeFrame(FrameType.DATA, connId, data)
    this.ws.send(frame)
  }

  close(connId: number, reason?: string): void {
    if (!this.connected || !this.ws) return

    const payload = reason ? new TextEncoder().encode(JSON.stringify({ reason })) : new Uint8Array(0)
    const frame = encodeFrame(FrameType.CLOSE, connId, payload)
    this.ws.send(frame)
    this.connections.delete(connId)
  }

  onData(connId: number, callback: DataCallback): void {
    const state = this.connections.get(connId) ?? {}
    state.onData = callback
    this.connections.set(connId, state)
  }

  onError(connId: number, callback: ErrorCallback): void {
    const state = this.connections.get(connId) ?? {}
    state.onError = callback
    this.connections.set(connId, state)
  }

  onClose(connId: number, callback: CloseCallback): void {
    const state = this.connections.get(connId) ?? {}
    state.onClose = callback
    this.connections.set(connId, state)
  }

  disconnect(): void {
    this.ws?.close()
    this.ws = null
    this.connected = false
  }
}
