/**
 * Dialtone Ethernet Provider
 *
 * Connects to our Dialtone relay for Ethernet packet bridging.
 * Compatible with the Infinite Mac EmulatorEthernetProvider interface.
 *
 * Protocol (JSON over WebSocket):
 * - {type: "init", macAddress: string}
 * - {type: "send", destination: string, packetArray: number[]}
 * - {type: "receive", packetArray: number[]} (server -> client)
 * - {type: "close"}
 */

export interface EthernetProviderDelegate {
  receive(packet: Uint8Array): void
}

export interface EthernetProvider {
  description(): string
  init(macAddress: string): void
  close(): void
  send(destination: string, packet: Uint8Array): void
  setDelegate(delegate: EthernetProviderDelegate): void
}

type ConnectionState = 'connecting' | 'connected' | 'closed'

interface InitMessage {
  type: 'init'
  macAddress: string
}

interface SendMessage {
  type: 'send'
  destination: string
  packetArray: number[]
}

interface CloseMessage {
  type: 'close'
}

interface ReceiveMessage {
  type: 'receive'
  packetArray: number[]
}

type OutboundMessage = InitMessage | SendMessage | CloseMessage
type InboundMessage = ReceiveMessage

export class DialtoneEthernetProvider implements EthernetProvider {
  private wsUrl: string
  private macAddress?: string
  private webSocket: WebSocket | null = null
  private delegate?: EthernetProviderDelegate
  private state: ConnectionState = 'connecting'
  private bufferedMessages: string[] = []
  private reconnectTimeout?: number
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl
    this.connect()
  }

  description(): string {
    return `Dialtone Relay (${this.wsUrl})`
  }

  private connect(): void {
    console.log(`[DialtoneEthernet] Connecting to ${this.wsUrl}`)

    this.webSocket = new WebSocket(this.wsUrl)
    this.webSocket.addEventListener('open', this.handleOpen)
    this.webSocket.addEventListener('close', this.handleClose)
    this.webSocket.addEventListener('error', this.handleError)
    this.webSocket.addEventListener('message', this.handleMessage)
  }

  private reconnect(): void {
    if (this.state === 'closed') {
      return
    }

    if (this.webSocket) {
      this.webSocket.removeEventListener('open', this.handleOpen)
      this.webSocket.removeEventListener('close', this.handleClose)
      this.webSocket.removeEventListener('error', this.handleError)
      this.webSocket.removeEventListener('message', this.handleMessage)
    }

    this.state = 'connecting'
    this.reconnectAttempts++

    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error('[DialtoneEthernet] Max reconnect attempts reached')
      this.state = 'closed'
      return
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
    console.log(`[DialtoneEthernet] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimeout = window.setTimeout(() => {
      this.connect()
    }, delay)
  }

  init(macAddress: string): void {
    this.macAddress = macAddress
    this.send_message({ type: 'init', macAddress })
    console.log(`[DialtoneEthernet] Initialized with MAC ${macAddress}`)
  }

  close(): void {
    this.state = 'closed'
    this.send_message({ type: 'close' })
    this.webSocket?.close()
    console.log('[DialtoneEthernet] Closed')
  }

  send(destination: string, packet: Uint8Array): void {
    this.send_message({
      type: 'send',
      destination,
      packetArray: Array.from(packet),
    })
  }

  private send_message(message: OutboundMessage): void {
    const json = JSON.stringify(message)

    if (this.state === 'connected' && this.webSocket) {
      this.webSocket.send(json)
    } else {
      this.bufferedMessages.push(json)
    }
  }

  setDelegate(delegate: EthernetProviderDelegate): void {
    this.delegate = delegate
  }

  private handleOpen = (): void => {
    console.log('[DialtoneEthernet] Connected')
    this.state = 'connected'
    this.reconnectAttempts = 0

    // Send buffered messages
    const buffered = this.bufferedMessages
    this.bufferedMessages = []
    for (const message of buffered) {
      this.webSocket?.send(message)
    }

    // Re-init if we had a MAC address
    if (this.macAddress) {
      this.init(this.macAddress)
    }
  }

  private handleClose = (): void => {
    if (this.state === 'closed') {
      return
    }
    console.log('[DialtoneEthernet] Connection closed, reconnecting...')
    this.reconnect()
  }

  private handleError = (event: Event): void => {
    console.error('[DialtoneEthernet] WebSocket error', event)
    this.reconnect()
  }

  private handleMessage = (event: MessageEvent): void => {
    try {
      const data: InboundMessage = JSON.parse(event.data)

      switch (data.type) {
        case 'receive': {
          const packet = new Uint8Array(data.packetArray)
          this.delegate?.receive(packet)
          break
        }
        default:
          console.log('[DialtoneEthernet] Unknown message type:', data)
      }
    } catch (err) {
      console.error('[DialtoneEthernet] Failed to parse message:', err)
    }
  }
}

// Helper to create provider with relay URL
export function createDialtoneEthernetProvider(relayHost?: string): DialtoneEthernetProvider {
  const host = relayHost || window.location.host
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${host}/ethernet`

  return new DialtoneEthernetProvider(wsUrl)
}
