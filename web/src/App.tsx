import { useEffect, useState } from 'react'
import { EmulatorShell } from './emulator'
import { LaptopShell } from './emulator/LaptopShell'
import { ThemeProvider } from './emulator/themes'
import { DiskSettingsProvider } from './emulator/settings'
import { defaultRelayUrl, defaultHttpRelayUrl } from './emulator/DialtoneEthernet'
import { useMobileDetection } from './emulator/hooks/useMobileDetection'
import { storageManager } from './emulator/services/StorageManager'

export function App() {
  const [storageReady, setStorageReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)

  // Initialize storage before rendering emulator
  // This clears OPFS cache on fresh page loads (ephemeral mode)
  useEffect(() => {
    storageManager
      .initializeForSession()
      .then(() => setStorageReady(true))
      .catch((err) => {
        console.error('[App] Storage initialization failed:', err)
        setStorageError(err instanceof Error ? err.message : 'Storage init failed')
        // Still proceed - emulator can work without cache
        setStorageReady(true)
      })
  }, [])

  const wsRelayUrl = defaultRelayUrl()
  const httpRelayUrl = defaultHttpRelayUrl()
  const { isMobile, preferredResolution } = useMobileDetection()

  // Show loading state until storage is initialized
  if (!storageReady) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: '#1a1a1a',
        color: '#888',
        fontFamily: 'system-ui, sans-serif',
      }}>
        Initializing...
      </div>
    )
  }

  return (
    <ThemeProvider>
      <DiskSettingsProvider relayUrl={httpRelayUrl}>
        {storageError && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            padding: '8px',
            backgroundColor: '#442200',
            color: '#ffaa00',
            fontSize: '12px',
            textAlign: 'center',
            zIndex: 9999,
          }}>
            Storage warning: {storageError}
          </div>
        )}
        {isMobile ? (
          <LaptopShell
            relayUrl={wsRelayUrl}
            width={preferredResolution.width}
            height={preferredResolution.height}
          />
        ) : (
          <EmulatorShell relayUrl={wsRelayUrl} />
        )}
      </DiskSettingsProvider>
    </ThemeProvider>
  )
}
