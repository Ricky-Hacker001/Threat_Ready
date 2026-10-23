import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// IBM Plex is bundled with the app (no third-party font requests).
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import './index.css'
import App from './App.tsx'
import { migrateLegacyKeys, platformUser, setStorageNamespace } from './platform'
import { LEGACY_STORAGE_KEYS } from './state/storageKeys'

const root = createRoot(document.getElementById('root')!)
// Inside ThreatReady, progress is kept per signed-in account; the namespace must be known before the store first
// reads it. The lookup times out after a few seconds; standalone it resolves at once with no user.
root.render(<div className="tr-boot" role="status">Loading ThreatReady Firewall…</div>)
void platformUser().then((user) => {
  if (user) {
    setStorageNamespace(user.id)
    migrateLegacyKeys(LEGACY_STORAGE_KEYS)
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
