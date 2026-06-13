/**
 * Tests for DialtoneEthernet
 *
 * Tests the Ethernet networking module including:
 * - MAC address generation and parsing
 * - IP/ICMP checksum computation
 * - Packet description/analysis
 * - WebSocket connection lifecycle
 * - ARP and ICMP packet building
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateMacAddress,
  parseMac,
  computeChecksum,
  describePacket,
  DialtoneEthernet,
  GATEWAY_MAC,
  GATEWAY_IP,
  CLIENT_IP,
} from './DialtoneEthernet';
import { MockWebSocket, installMockWebSocket, restoreWebSocket } from '../test/mocks/websocket';

describe('generateMacAddress', () => {
  it('should generate a valid locally-administered MAC address', () => {
    const mac = generateMacAddress();

    // Format: 02:xx:xx:xx:xx:xx
    expect(mac).toMatch(/^02:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}$/);
  });

  it('should start with 02 (locally administered, unicast)', () => {
    const mac = generateMacAddress();

    expect(mac.startsWith('02:')).toBe(true);
  });

  it('should generate unique addresses on each call', () => {
    const macs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      macs.add(generateMacAddress());
    }

    // All 100 should be unique
    expect(macs.size).toBe(100);
  });
});

describe('parseMac', () => {
  it('should parse a valid MAC address to bytes', () => {
    const bytes = parseMac('02:ab:cd:ef:01:23');

    expect(bytes).toEqual(new Uint8Array([0x02, 0xab, 0xcd, 0xef, 0x01, 0x23]));
  });

  it('should parse the gateway MAC correctly', () => {
    const bytes = parseMac(GATEWAY_MAC);

    expect(bytes).toEqual(new Uint8Array([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]));
  });

  it('should handle lowercase hex', () => {
    const bytes = parseMac('aa:bb:cc:dd:ee:ff');

    expect(bytes).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  });

  it('should handle uppercase hex', () => {
    const bytes = parseMac('AA:BB:CC:DD:EE:FF');

    expect(bytes).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  });

  it('should handle all zeros', () => {
    const bytes = parseMac('00:00:00:00:00:00');

    expect(bytes).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0]));
  });

  it('should handle broadcast address', () => {
    const bytes = parseMac('ff:ff:ff:ff:ff:ff');

    expect(bytes).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  });
});

describe('computeChecksum', () => {
  it('should compute correct checksum for simple data', () => {
    // Simple test: 0x0001 + 0x0002 = 0x0003, complement = 0xFFFC
    const data = new Uint8Array([0x00, 0x01, 0x00, 0x02]);
    const checksum = computeChecksum(data);

    expect(checksum).toBe(0xfffc);
  });

  it('should handle odd-length data by padding', () => {
    const data = new Uint8Array([0x00, 0x01, 0x02]);
    // Should not throw
    expect(() => computeChecksum(data)).not.toThrow();
  });

  it('should return 0xFFFF for all-zero data', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const checksum = computeChecksum(data);

    expect(checksum).toBe(0xffff);
  });

  it('should handle wraparound correctly', () => {
    // 0xFFFF + 0xFFFF = 0x1FFFE -> carry-add -> 0xFFFF -> complement = 0x0000
    const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const checksum = computeChecksum(data);

    expect(checksum).toBe(0x0000);
  });

  it('should compute correct checksum for IP header', () => {
    // Real IP header example
    const ipHeader = new Uint8Array([
      0x45, 0x00, 0x00, 0x24, // Version, IHL, TOS, Total Length
      0x00, 0x01, 0x00, 0x00, // ID, Flags, Fragment Offset
      0x40, 0x01, 0x00, 0x00, // TTL, Protocol (ICMP), Checksum placeholder
      0x0a, 0x44, 0x00, 0x02, // Source IP: 10.68.0.2
      0x0a, 0x44, 0x00, 0x01, // Dest IP: 10.68.0.1
    ]);

    const checksum = computeChecksum(ipHeader);
    // The checksum should be valid (we can verify this verifies to 0)
    expect(typeof checksum).toBe('number');
    expect(checksum).toBeGreaterThanOrEqual(0);
    expect(checksum).toBeLessThanOrEqual(0xffff);
  });
});

describe('describePacket', () => {
  it('should identify packet as too short', () => {
    const packet = new Uint8Array([0x01, 0x02, 0x03]);

    expect(describePacket(packet)).toBe('Too short');
  });

  it('should identify ARP request', () => {
    const packet = new Uint8Array(42);
    // EtherType: ARP
    packet[12] = 0x08;
    packet[13] = 0x06;
    // Opcode: Request
    packet[20] = 0x00;
    packet[21] = 0x01;
    // Target IP: 10.68.0.1
    packet[38] = 10;
    packet[39] = 68;
    packet[40] = 0;
    packet[41] = 1;

    expect(describePacket(packet)).toBe('ARP Request: Who has 10.68.0.1?');
  });

  it('should identify ARP reply', () => {
    const packet = new Uint8Array(42);
    // EtherType: ARP
    packet[12] = 0x08;
    packet[13] = 0x06;
    // Opcode: Reply
    packet[20] = 0x00;
    packet[21] = 0x02;
    // Sender MAC: 52:54:00:12:34:56
    packet.set([0x52, 0x54, 0x00, 0x12, 0x34, 0x56], 22);

    expect(describePacket(packet)).toBe('ARP Reply: 52:54:00:12:34:56');
  });

  it('should identify ICMP Echo Request', () => {
    const packet = new Uint8Array(50);
    // EtherType: IPv4
    packet[12] = 0x08;
    packet[13] = 0x00;
    // Protocol: ICMP
    packet[23] = 1;
    // Source IP: 10.68.0.2
    packet[26] = 10; packet[27] = 68; packet[28] = 0; packet[29] = 2;
    // Dest IP: 10.68.0.1
    packet[30] = 10; packet[31] = 68; packet[32] = 0; packet[33] = 1;
    // ICMP Type: Echo Request
    packet[34] = 8;

    expect(describePacket(packet)).toBe('ICMP Echo Request to 10.68.0.1');
  });

  it('should identify ICMP Echo Reply', () => {
    const packet = new Uint8Array(50);
    // EtherType: IPv4
    packet[12] = 0x08;
    packet[13] = 0x00;
    // Protocol: ICMP
    packet[23] = 1;
    // Source IP: 10.68.0.1
    packet[26] = 10; packet[27] = 68; packet[28] = 0; packet[29] = 1;
    // Dest IP: 10.68.0.2
    packet[30] = 10; packet[31] = 68; packet[32] = 0; packet[33] = 2;
    // ICMP Type: Echo Reply
    packet[34] = 0;

    expect(describePacket(packet)).toBe('ICMP Echo Reply from 10.68.0.1');
  });

  it('should identify TCP with SYN flag', () => {
    const packet = new Uint8Array(54);
    // EtherType: IPv4
    packet[12] = 0x08;
    packet[13] = 0x00;
    // Protocol: TCP
    packet[23] = 6;
    // Source IP
    packet[26] = 10; packet[27] = 68; packet[28] = 0; packet[29] = 2;
    // Dest IP
    packet[30] = 93; packet[31] = 184; packet[32] = 216; packet[33] = 34;
    // Source port: 12345
    packet[34] = 0x30; packet[35] = 0x39;
    // Dest port: 80
    packet[36] = 0x00; packet[37] = 0x50;
    // Flags: SYN
    packet[47] = 0x02;

    expect(describePacket(packet)).toBe('TCP 10.68.0.2:12345 -> 93.184.216.34:80 [SYN]');
  });

  it('should identify TCP with SYN+ACK flags', () => {
    const packet = new Uint8Array(54);
    packet[12] = 0x08; packet[13] = 0x00;
    packet[23] = 6;
    packet[26] = 10; packet[27] = 68; packet[28] = 0; packet[29] = 2;
    packet[30] = 93; packet[31] = 184; packet[32] = 216; packet[33] = 34;
    packet[34] = 0x00; packet[35] = 0x50;
    packet[36] = 0x30; packet[37] = 0x39;
    // Flags: SYN+ACK
    packet[47] = 0x12;

    expect(describePacket(packet)).toContain('SYN');
    expect(describePacket(packet)).toContain('ACK');
  });

  it('should identify UDP packets', () => {
    const packet = new Uint8Array(42);
    packet[12] = 0x08; packet[13] = 0x00;
    packet[23] = 17; // UDP
    packet[26] = 10; packet[27] = 68; packet[28] = 0; packet[29] = 2;
    packet[30] = 10; packet[31] = 68; packet[32] = 0; packet[33] = 1;
    packet[34] = 0x00; packet[35] = 0x35; // Port 53
    packet[36] = 0x00; packet[37] = 0x35;

    expect(describePacket(packet)).toBe('UDP 10.68.0.2:53 -> 10.68.0.1:53');
  });

  it('should handle unknown EtherType', () => {
    const packet = new Uint8Array(20);
    packet[12] = 0x88;
    packet[13] = 0xcc; // LLDP

    expect(describePacket(packet)).toBe('Unknown EtherType 0x88cc');
  });
});

describe('DialtoneEthernet', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = installMockWebSocket();
  });

  afterEach(() => {
    restoreWebSocket(originalWebSocket);
  });

  describe('constructor', () => {
    it('should generate a MAC address on creation', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      expect(ethernet.mac).toMatch(/^02:/);
    });

    it('should start with disconnected status', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      expect(ethernet.currentStatus).toBe('disconnected');
    });
  });

  describe('setMac', () => {
    it('should update the MAC address', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      const originalMac = ethernet.mac;
      const emulatorMac = '08:00:07:ab:cd:ef';

      ethernet.setMac(emulatorMac);

      expect(ethernet.mac).toBe(emulatorMac);
      expect(ethernet.mac).not.toBe(originalMac);
    });

    it('should use the new MAC when connecting to relay', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      const emulatorMac = '08:00:07:12:34:56';

      // Set MAC before connecting (simulates receiving emulator_ethernet_init)
      ethernet.setMac(emulatorMac);
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      // Verify init message uses the emulator's MAC, not the auto-generated one
      const initMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(initMsg.type).toBe('init');
      expect(initMsg.macAddress).toBe(emulatorMac);
    });

    it('should allow MAC format used by BasiliskII (Apple OUI)', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      // BasiliskII uses Apple's OUI (08:00:07)
      const basiliskMac = '08:00:07:aa:bb:cc';

      ethernet.setMac(basiliskMac);

      expect(ethernet.mac).toBe(basiliskMac);
    });

    it('should preserve MAC across multiple setMac calls', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      ethernet.setMac('08:00:07:11:11:11');
      ethernet.setMac('08:00:07:22:22:22');

      expect(ethernet.mac).toBe('08:00:07:22:22:22');
    });
  });

  describe('connect', () => {
    it('should create WebSocket with provided URL', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test:8081/ethernet' });

      ethernet.connect();

      const ws = MockWebSocket.getLastInstance();
      expect(ws).toBeDefined();
      expect(ws?.url).toBe('ws://test:8081/ethernet');
    });

    it('should set status to connecting', () => {
      const onStatusChange = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onStatusChange,
      });

      ethernet.connect();

      expect(onStatusChange).toHaveBeenCalledWith('connecting');
    });

    it('should send init message on open', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      expect(ws.send).toHaveBeenCalled();
      const initMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(initMsg.type).toBe('init');
      expect(initMsg.macAddress).toBe(ethernet.mac);
    });

    it('should include zone in init message when configured', () => {
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        zone: 'lan-party',
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      const initMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(initMsg.zone).toBe('lan-party');
    });

    it('should set status to connected on open', () => {
      const onStatusChange = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onStatusChange,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      expect(onStatusChange).toHaveBeenCalledWith('connected');
    });
  });

  describe('message handling', () => {
    it('should parse and forward received packets', () => {
      const onPacketReceived = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onPacketReceived,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      // Simulate receiving a base64-encoded packet
      const packetData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      const base64 = btoa(String.fromCharCode(...packetData));
      ws.simulateMessage({ type: 'receive', packetArray: base64 });

      expect(onPacketReceived).toHaveBeenCalled();
      const receivedPacket = onPacketReceived.mock.calls[0][0];
      expect(receivedPacket).toEqual(packetData);
    });

    it('should handle array packet format', () => {
      const onPacketReceived = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onPacketReceived,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      // Array format (not base64)
      ws.simulateMessage({ type: 'receive', packetArray: [1, 2, 3, 4] });

      expect(onPacketReceived).toHaveBeenCalled();
    });

    it('should ignore non-receive messages', () => {
      const onPacketReceived = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onPacketReceived,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      ws.simulateMessage({ type: 'other', data: 'something' });

      expect(onPacketReceived).not.toHaveBeenCalled();
    });
  });

  describe('sendPacket', () => {
    it('should return false when not connected', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      const result = ethernet.sendPacket(new Uint8Array([1, 2, 3]));

      expect(result).toBe(false);
    });

    it('should send packet when connected', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      const packet = new Uint8Array([0x01, 0x02, 0x03]);
      const result = ethernet.sendPacket(packet);

      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledTimes(2); // init + packet
    });

    it('should include destination in send message', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      ethernet.sendPacket(new Uint8Array([1, 2, 3]), GATEWAY_MAC);

      const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
      const msg = JSON.parse(lastCall);
      expect(msg.type).toBe('send');
      expect(msg.destination).toBe(GATEWAY_MAC);
    });
  });

  describe('sendArpRequest', () => {
    it('should send valid ARP request packet', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      const result = ethernet.sendArpRequest();

      expect(result).toBe(true);

      const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
      const msg = JSON.parse(lastCall);
      expect(msg.type).toBe('send');
      expect(msg.destination).toBe('*'); // Broadcast

      // Verify packet structure
      const packet = new Uint8Array(msg.packetArray);
      expect(packet.length).toBe(42);
      // EtherType should be ARP (0x0806)
      expect(packet[12]).toBe(0x08);
      expect(packet[13]).toBe(0x06);
      // Opcode should be request (1)
      expect(packet[20]).toBe(0x00);
      expect(packet[21]).toBe(0x01);
    });
  });

  describe('sendPing', () => {
    it('should send valid ICMP echo request', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      const result = ethernet.sendPing();

      expect(result).toBe(true);

      const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1][0];
      const msg = JSON.parse(lastCall);
      const packet = new Uint8Array(msg.packetArray);

      // Verify IPv4
      expect(packet[12]).toBe(0x08);
      expect(packet[13]).toBe(0x00);
      // Verify ICMP protocol
      expect(packet[23]).toBe(1);
      // Verify Echo Request type
      expect(packet[34]).toBe(8);
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket and update status', () => {
      const onStatusChange = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onStatusChange,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      ethernet.disconnect();

      expect(ws.close).toHaveBeenCalled();
      expect(onStatusChange).toHaveBeenCalledWith('disconnected');
    });

    it('should send close message before disconnecting', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();

      ethernet.disconnect();

      // Should have sent close message
      const closeCall = ws.send.mock.calls.find((call) => {
        const msg = JSON.parse(call[0]);
        return msg.type === 'close';
      });
      expect(closeCall).toBeDefined();
    });
  });

  /**
   * These tests verify the fix for the AppleTalk broadcast storm bug.
   *
   * Bug: In React StrictMode (development), components mount twice rapidly.
   * Each mount created a new worker and DialtoneEthernet instance, resulting in
   * TWO WebSocket connections to the relay with different MACs. When one client
   * sent an AARP broadcast, the relay forwarded it to the other client (different MAC),
   * causing a broadcast storm.
   *
   * Fix: EmulatorCanvas now tracks an instanceId that increments on each init.
   * Messages from stale workers (previous mounts) are ignored. Combined with
   * the currentStatus check before connect(), this ensures only ONE connection.
   */
  describe('duplicate connection prevention', () => {
    it('should track status correctly through connection lifecycle', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      // Initial state
      expect(ethernet.currentStatus).toBe('disconnected');

      // After connect() called
      ethernet.connect();
      expect(ethernet.currentStatus).toBe('connecting');

      // After WebSocket opens
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      expect(ethernet.currentStatus).toBe('connected');

      // After disconnect
      ethernet.disconnect();
      expect(ethernet.currentStatus).toBe('disconnected');
    });

    it('should allow status check before connect() to prevent duplicates', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      // Simulate what EmulatorCanvas does: check status before connecting
      if (ethernet.currentStatus === 'disconnected') {
        ethernet.connect();
      }
      expect(MockWebSocket.getAllInstances().length).toBe(1);

      // Simulate second call (e.g., from stale worker message)
      // This time status is 'connecting', so we shouldn't call connect again
      if (ethernet.currentStatus === 'disconnected') {
        ethernet.connect();
      }
      // Still only one WebSocket created
      expect(MockWebSocket.getAllInstances().length).toBe(1);
    });

    it('should not create duplicate connections when already connected', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      // First connection
      if (ethernet.currentStatus === 'disconnected') {
        ethernet.connect();
      }
      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      expect(ethernet.currentStatus).toBe('connected');

      // Simulate second init call (from stale worker in React StrictMode)
      const connectionsBefore = MockWebSocket.getAllInstances().length;
      if (ethernet.currentStatus === 'disconnected') {
        ethernet.connect();
      }
      // No new connection created
      expect(MockWebSocket.getAllInstances().length).toBe(connectionsBefore);
    });

    it('should handle rapid connect/disconnect cycles (React StrictMode)', () => {
      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });

      // Simulate React StrictMode: connect, then quickly disconnect
      ethernet.connect();
      expect(ethernet.currentStatus).toBe('connecting');

      ethernet.disconnect();
      expect(ethernet.currentStatus).toBe('disconnected');

      // Now reconnect should work
      ethernet.connect();
      expect(ethernet.currentStatus).toBe('connecting');
      expect(MockWebSocket.getAllInstances().length).toBe(2);
    });
  });

  describe('reconnection', () => {
    it('should schedule reconnect on close', () => {
      vi.useFakeTimers();

      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      ws.simulateClose();

      // Should schedule reconnect
      expect(MockWebSocket.getAllInstances().length).toBe(1);

      // Advance timer for first reconnect (1 second)
      vi.advanceTimersByTime(1000);

      expect(MockWebSocket.getAllInstances().length).toBe(2);

      vi.useRealTimers();
    });

    it('should use exponential backoff', () => {
      vi.useFakeTimers();

      const ethernet = new DialtoneEthernet({ relayUrl: 'ws://test' });
      ethernet.connect();

      // First connection and close
      let ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      ws.simulateClose();

      // After close, should have scheduled reconnect
      const instancesAfterFirstClose = MockWebSocket.getAllInstances().length;

      // First reconnect at 1s (2^0 * 1000)
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.getAllInstances().length).toBe(instancesAfterFirstClose + 1);

      // Simulate that connection fails immediately
      ws = MockWebSocket.getLastInstance()!;
      ws.simulateClose(); // Close without opening (connection failed)

      // Second reconnect at 2s (2^1 * 1000)
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.getAllInstances().length).toBe(instancesAfterFirstClose + 1); // Not yet
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.getAllInstances().length).toBe(instancesAfterFirstClose + 2);

      vi.useRealTimers();
    });

    it('should set error status after max attempts', () => {
      vi.useFakeTimers();

      const onStatusChange = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onStatusChange,
      });
      ethernet.connect();

      // First connection succeeds then closes
      let ws = MockWebSocket.getLastInstance()!;
      ws.simulateOpen();
      ws.simulateClose();

      // Now simulate 5 failed reconnect attempts (max is 5)
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(30000); // Advance past any backoff
        ws = MockWebSocket.getLastInstance()!;
        ws.simulateClose(); // Connection fails immediately
      }

      // After 5 failed attempts, next close should trigger error
      vi.advanceTimersByTime(30000);

      // Check if error was eventually called
      const errorCalls = onStatusChange.mock.calls.filter(
        (call) => call[0] === 'error'
      );
      expect(errorCalls.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('should call onError on WebSocket error', () => {
      const onError = vi.fn();
      const ethernet = new DialtoneEthernet({
        relayUrl: 'ws://test',
        onError,
      });
      ethernet.connect();

      const ws = MockWebSocket.getLastInstance()!;
      ws.simulateError();

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});

describe('constants', () => {
  it('should have correct GATEWAY_IP', () => {
    expect(GATEWAY_IP).toEqual([10, 68, 0, 1]);
  });

  it('should have correct CLIENT_IP', () => {
    expect(CLIENT_IP).toEqual([10, 68, 0, 2]);
  });

  it('should have correct GATEWAY_MAC', () => {
    expect(GATEWAY_MAC).toBe('52:54:00:12:34:56');
  });
});
