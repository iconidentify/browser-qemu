/**
 * React hook for Dialtone Ethernet connectivity
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  DialtoneEthernet,
  DialtoneEthernetConfig,
  ConnectionStatus,
  describePacket,
  defaultRelayUrl,
} from './DialtoneEthernet'

export interface PacketLog {
  time: string
  direction: 'sent' | 'received'
  size: number
  description: string
  data?: Uint8Array
}

export interface UseDialtoneEthernetOptions {
  relayUrl?: string
  autoConnect?: boolean
  maxLogEntries?: number
}

export interface UseDialtoneEthernetResult {
  status: ConnectionStatus
  macAddress: string
  packets: PacketLog[]
  connect: () => void
  disconnect: () => void
  sendPacket: (packet: Uint8Array, destination?: string) => boolean
  sendArpRequest: () => boolean
  sendPing: () => boolean
  clearPackets: () => void
}

const DEFAULT_RELAY_URL = defaultRelayUrl()

export function useDialtoneEthernet(
  options: UseDialtoneEthernetOptions = {}
): UseDialtoneEthernetResult {
  const {
    relayUrl = DEFAULT_RELAY_URL,
    autoConnect = false,
    maxLogEntries = 100,
  } = options

  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [macAddress, setMacAddress] = useState('')
  const [packets, setPackets] = useState<PacketLog[]>([])

  const ethernetRef = useRef<DialtoneEthernet | null>(null)

  // Initialize ethernet instance
  useEffect(() => {
    const config: DialtoneEthernetConfig = {
      relayUrl,
      onStatusChange: setStatus,
      onPacketReceived: (packet) => {
        const log: PacketLog = {
          time: new Date().toLocaleTimeString(),
          direction: 'received',
          size: packet.length,
          description: describePacket(packet),
          data: packet,
        }
        setPackets(prev => [...prev.slice(-maxLogEntries + 1), log])
      },
      onError: (error) => {
        console.error('[useDialtoneEthernet] Error:', error)
      },
    }

    const ethernet = new DialtoneEthernet(config)
    ethernetRef.current = ethernet
    setMacAddress(ethernet.mac)

    if (autoConnect) {
      ethernet.connect()
    }

    return () => {
      ethernet.disconnect()
    }
  }, [relayUrl, autoConnect, maxLogEntries])

  const connect = useCallback(() => {
    ethernetRef.current?.connect()
  }, [])

  const disconnect = useCallback(() => {
    ethernetRef.current?.disconnect()
  }, [])

  const sendPacket = useCallback((packet: Uint8Array, destination = '*'): boolean => {
    const success = ethernetRef.current?.sendPacket(packet, destination) ?? false
    if (success) {
      const log: PacketLog = {
        time: new Date().toLocaleTimeString(),
        direction: 'sent',
        size: packet.length,
        description: describePacket(packet),
        data: packet,
      }
      setPackets(prev => [...prev.slice(-maxLogEntries + 1), log])
    }
    return success
  }, [maxLogEntries])

  const sendArpRequest = useCallback((): boolean => {
    const success = ethernetRef.current?.sendArpRequest() ?? false
    if (success) {
      const log: PacketLog = {
        time: new Date().toLocaleTimeString(),
        direction: 'sent',
        size: 42,
        description: 'ARP Request: Who has 10.0.2.2?',
      }
      setPackets(prev => [...prev.slice(-maxLogEntries + 1), log])
    }
    return success
  }, [maxLogEntries])

  const sendPing = useCallback((): boolean => {
    const success = ethernetRef.current?.sendPing() ?? false
    if (success) {
      const log: PacketLog = {
        time: new Date().toLocaleTimeString(),
        direction: 'sent',
        size: 50,
        description: 'ICMP Echo Request to 10.0.2.2',
      }
      setPackets(prev => [...prev.slice(-maxLogEntries + 1), log])
    }
    return success
  }, [maxLogEntries])

  const clearPackets = useCallback(() => {
    setPackets([])
  }, [])

  return {
    status,
    macAddress,
    packets,
    connect,
    disconnect,
    sendPacket,
    sendArpRequest,
    sendPing,
    clearPackets,
  }
}
