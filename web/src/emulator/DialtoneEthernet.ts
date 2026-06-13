/**
 * DialtoneEthernet - Ethernet networking for Classic Mac emulators
 *
 * Provides TCP/IP connectivity through the Dialtone slirp bridge.
 * The emulator sends/receives raw Ethernet frames, while the relay
 * handles protocol translation to real TCP connections.
 *
 * Network configuration (slirp NAT):
 * - Gateway: 10.0.2.2 (MAC: 52:54:00:12:34:56)
 * - Client: 10.0.2.15 (assigned to emulator)
 * - DNS: 10.0.2.3
 */

import { logger } from './logger';

export interface DialtoneEthernetConfig {
  relayUrl: string
  zone?: string // Optional: join a shared zone (e.g., "party-room") for LAN play
  onPacketReceived?: (packet: Uint8Array) => void
  onStatusChange?: (status: ConnectionStatus) => void
  onError?: (error: Error) => void
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// Gateway constants (must match slirp.go configuration)
// Using 10.68.0.x subnet - a tribute to the 68k!
export const GATEWAY_MAC = '52:54:00:12:34:56'
export const GATEWAY_IP = [10, 68, 0, 1] as const
export const CLIENT_IP = [10, 68, 0, 2] as const
export const DNS_IP = [10, 68, 0, 1] as const  // Same as gateway for simplicity

/**
 * Default relay URL: same-origin WebSocket at `${BASE_URL}ethernet`.
 * - Works locally (vite proxy) and behind a reverse proxy.
 * - Uses Vite's `import.meta.env.BASE_URL` when available.
 */
export function defaultRelayUrl(): string {
  // Optional override for deployments that expose the relay on a dedicated host/port.
  // Example: VITE_RELAY_URL=wss://dialtone.live:8166/ethernet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = (import.meta as any)?.env?.VITE_RELAY_URL
  if (typeof override === 'string' && override.length) {
    return override
  }
  const baseUrl =
    // Vite injects BASE_URL into import.meta.env
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any)?.env?.BASE_URL || '/'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = (baseUrl.endsWith('/') ? baseUrl : baseUrl + '/') + 'ethernet'
  return `${proto}//${window.location.host}${path}`
}

/**
 * Default HTTP relay URL for disk and other REST APIs.
 * - Works locally (vite proxy) and behind a reverse proxy.
 */
export function defaultHttpRelayUrl(): string {
  // Optional override for deployments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = (import.meta as any)?.env?.VITE_HTTP_RELAY_URL
  if (typeof override === 'string' && override.length) {
    return override
  }
  const baseUrl =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any)?.env?.BASE_URL || '/'
  const proto = window.location.protocol
  // Remove trailing slash for clean URL construction
  const path = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${proto}//${window.location.host}${path}`
}

/**
 * Generate a random locally-administered MAC address
 */
export function generateMacAddress(): string {
  const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  // 02:xx:xx:xx:xx:xx - locally administered, unicast
  return `02:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`
}

/**
 * Parse MAC address string to bytes
 */
export function parseMac(mac: string): Uint8Array {
  return new Uint8Array(mac.split(':').map(h => parseInt(h, 16)))
}

/**
 * Compute IP/ICMP/TCP checksum
 */
export function computeChecksum(data: Uint8Array): number {
  let sum = 0
  const length = data.length % 2 === 0 ? data.length : data.length + 1

  for (let i = 0; i < length; i += 2) {
    const high = data[i]
    const low = i + 1 < data.length ? data[i + 1] : 0
    sum += (high << 8) | low
  }

  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >> 16)
  }

  return (~sum) & 0xffff
}

/**
 * DialtoneEthernet - Manages Ethernet connectivity for an emulator
 */
export class DialtoneEthernet {
  private ws: WebSocket | null = null
  private macAddress: string
  private status: ConnectionStatus = 'disconnected'
  private config: DialtoneEthernetConfig
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5

  constructor(config: DialtoneEthernetConfig) {
    this.config = config
    this.macAddress = generateMacAddress()
  }

  get currentStatus(): ConnectionStatus {
    return this.status
  }

  get mac(): string {
    return this.macAddress
  }

  /**
   * Set the MAC address (call before connect to use emulator's MAC)
   */
  setMac(mac: string): void {
    this.macAddress = mac
  }

  /**
   * Connect to the Dialtone relay
   */
  connect(): void {
    if (this.ws) {
      this.ws.close()
    }

    this.setStatus('connecting')

    try {
      this.ws = new WebSocket(this.config.relayUrl)

      this.ws.onopen = () => {
        logger.log('[DialtoneEthernet] Connected to relay')
        this.reconnectAttempts = 0

        // Send init with our MAC address and optional zone
        const initMsg: { type: string; macAddress: string; zone?: string } = {
          type: 'init',
          macAddress: this.macAddress,
        }
        if (this.config.zone) {
          initMsg.zone = this.config.zone
        }
        this.ws?.send(JSON.stringify(initMsg))

        this.setStatus('connected')
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          logger.log('[DialtoneEthernet] Received message:', data.type, data.packetArray ? `(${typeof data.packetArray === 'string' ? data.packetArray.length : data.packetArray.length} bytes)` : '')
          if (data.type === 'receive' && data.packetArray) {
            // packetArray comes as base64 string from Go
            let packet: Uint8Array
            if (typeof data.packetArray === 'string') {
              // Base64 decode
              const binary = atob(data.packetArray)
              packet = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i++) {
                packet[i] = binary.charCodeAt(i)
              }
            } else {
              packet = new Uint8Array(data.packetArray)
            }

            logger.log('[DialtoneEthernet] Forwarding packet to emulator:', packet.length, 'bytes')
            this.config.onPacketReceived?.(packet)
          }
        } catch (err) {
          console.error('[DialtoneEthernet] Message parse error:', err)
        }
      }

      this.ws.onerror = (err) => {
        console.error('[DialtoneEthernet] WebSocket error:', err)
        this.config.onError?.(new Error('WebSocket error'))
      }

      this.ws.onclose = () => {
        logger.log('[DialtoneEthernet] Disconnected')
        this.ws = null
        this.setStatus('disconnected')
        this.scheduleReconnect()
      }
    } catch (err) {
      console.error('[DialtoneEthernet] Connection failed:', err)
      this.setStatus('error')
      this.config.onError?.(err as Error)
    }
  }

  /**
   * Disconnect from the relay
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.send(JSON.stringify({ type: 'close' }))
      this.ws.close()
      this.ws = null
    }

    this.setStatus('disconnected')
  }

  /**
   * Send an Ethernet frame
   */
  sendPacket(packet: Uint8Array, destination = '*'): boolean {
    if (!this.ws || this.status !== 'connected') {
      return false
    }

    this.ws.send(JSON.stringify({
      type: 'send',
      destination,
      packetArray: Array.from(packet),
    }))

    return true
  }

  /**
   * Build and send an ARP request for the gateway
   */
  sendArpRequest(): boolean {
    const packet = new Uint8Array(42)
    const srcMac = parseMac(this.macAddress)

    // Ethernet header
    // Destination: broadcast
    packet.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0)
    // Source MAC
    packet.set(srcMac, 6)
    // EtherType: ARP
    packet[12] = 0x08
    packet[13] = 0x06

    // ARP header
    packet[14] = 0x00; packet[15] = 0x01  // Hardware type: Ethernet
    packet[16] = 0x08; packet[17] = 0x00  // Protocol type: IPv4
    packet[18] = 0x06                      // Hardware size
    packet[19] = 0x04                      // Protocol size
    packet[20] = 0x00; packet[21] = 0x01  // Opcode: Request
    packet.set(srcMac, 22)                 // Sender MAC
    packet.set(new Uint8Array(CLIENT_IP), 28)  // Sender IP
    packet.set([0, 0, 0, 0, 0, 0], 32)    // Target MAC (unknown)
    packet.set(new Uint8Array(GATEWAY_IP), 38) // Target IP

    return this.sendPacket(packet, '*')
  }

  /**
   * Build and send an ICMP Echo Request (ping) to the gateway
   */
  sendPing(): boolean {
    const packet = new Uint8Array(50) // 14 + 20 + 16
    const srcMac = parseMac(this.macAddress)
    const dstMac = parseMac(GATEWAY_MAC)

    // Ethernet header
    packet.set(dstMac, 0)
    packet.set(srcMac, 6)
    packet[12] = 0x08; packet[13] = 0x00 // IPv4

    // IP header
    packet[14] = 0x45  // Version 4, IHL 5
    packet[15] = 0x00  // DSCP/ECN
    packet[16] = 0x00; packet[17] = 36  // Total length
    packet[18] = 0x00; packet[19] = 0x01 // ID
    packet[20] = 0x00; packet[21] = 0x00 // Flags/Fragment
    packet[22] = 64    // TTL
    packet[23] = 1     // Protocol: ICMP
    packet[24] = 0x00; packet[25] = 0x00 // Checksum (placeholder)
    packet.set(new Uint8Array(CLIENT_IP), 26)
    packet.set(new Uint8Array(GATEWAY_IP), 30)

    // Compute IP checksum
    const ipChecksum = computeChecksum(packet.subarray(14, 34))
    packet[24] = (ipChecksum >> 8) & 0xff
    packet[25] = ipChecksum & 0xff

    // ICMP header
    packet[34] = 8     // Type: Echo Request
    packet[35] = 0     // Code
    packet[36] = 0x00; packet[37] = 0x00 // Checksum (placeholder)
    packet[38] = 0x00; packet[39] = 0x01 // Identifier
    packet[40] = 0x00; packet[41] = 0x01 // Sequence
    // Data
    packet.set([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68], 42)

    // Compute ICMP checksum
    const icmpChecksum = computeChecksum(packet.subarray(34))
    packet[36] = (icmpChecksum >> 8) & 0xff
    packet[37] = icmpChecksum & 0xff

    return this.sendPacket(packet, GATEWAY_MAC)
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    this.config.onStatusChange?.(status)
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.log('[DialtoneEthernet] Max reconnect attempts reached')
      this.setStatus('error')
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    logger.log(`[DialtoneEthernet] Reconnecting in ${delay}ms...`)

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempts++
      this.connect()
    }, delay)
  }
}

/**
 * Analyze an Ethernet packet and return a human-readable description
 */
export function describePacket(packet: Uint8Array): string {
  if (packet.length < 14) return 'Too short'

  const etherType = (packet[12] << 8) | packet[13]

  if (etherType === 0x0806 && packet.length >= 42) {
    const opcode = (packet[20] << 8) | packet[21]
    if (opcode === 1) {
      const targetIP = `${packet[38]}.${packet[39]}.${packet[40]}.${packet[41]}`
      return `ARP Request: Who has ${targetIP}?`
    } else if (opcode === 2) {
      const senderMAC = Array.from(packet.subarray(22, 28))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(':')
      return `ARP Reply: ${senderMAC}`
    }
    return 'ARP'
  }

  if (etherType === 0x0800 && packet.length >= 34) {
    const protocol = packet[23]
    const srcIP = `${packet[26]}.${packet[27]}.${packet[28]}.${packet[29]}`
    const dstIP = `${packet[30]}.${packet[31]}.${packet[32]}.${packet[33]}`

    if (protocol === 1 && packet.length >= 42) {
      const icmpType = packet[34]
      if (icmpType === 0) return `ICMP Echo Reply from ${srcIP}`
      if (icmpType === 8) return `ICMP Echo Request to ${dstIP}`
      return `ICMP type ${icmpType}`
    }

    if (protocol === 6 && packet.length >= 54) {
      const srcPort = (packet[34] << 8) | packet[35]
      const dstPort = (packet[36] << 8) | packet[37]
      const flags = packet[47]
      const flagStr = []
      if (flags & 0x02) flagStr.push('SYN')
      if (flags & 0x10) flagStr.push('ACK')
      if (flags & 0x01) flagStr.push('FIN')
      if (flags & 0x04) flagStr.push('RST')
      return `TCP ${srcIP}:${srcPort} -> ${dstIP}:${dstPort} [${flagStr.join(',')}]`
    }

    if (protocol === 17 && packet.length >= 42) {
      const srcPort = (packet[34] << 8) | packet[35]
      const dstPort = (packet[36] << 8) | packet[37]
      return `UDP ${srcIP}:${srcPort} -> ${dstIP}:${dstPort}`
    }

    return `IPv4 ${srcIP} -> ${dstIP}`
  }

  return `Unknown EtherType 0x${etherType.toString(16)}`
}
