/**
 * Emulator integration module
 *
 * Provides Ethernet networking for Classic Mac emulators
 * running in WebAssembly (Basilisk II, SheepShaver, etc.)
 */

export {
  DialtoneEthernet,
  type DialtoneEthernetConfig,
  type ConnectionStatus,
  GATEWAY_MAC,
  GATEWAY_IP,
  CLIENT_IP,
  DNS_IP,
  generateMacAddress,
  parseMac,
  computeChecksum,
  describePacket,
} from './DialtoneEthernet'

export {
  useDialtoneEthernet,
  type UseDialtoneEthernetOptions,
  type UseDialtoneEthernetResult,
  type PacketLog,
} from './useDialtoneEthernet'

export {
  EmulatorCanvas,
  type EmulatorCanvasProps,
  type EmulatorStatus,
} from './EmulatorCanvas'

export {
  EmulatorShell,
} from './EmulatorShell'

export {
  LaptopShell,
} from './LaptopShell'

// Theme system
export {
  ThemeProvider,
  useTheme,
  useThemeStyles,
  themes,
  DEFAULT_THEME_ID,
  type MacTheme,
  type ThemeId,
  type ThemeColors,
  type NetworkActivityState,
} from './themes'

// Components
export { SettingsModal } from './components'
