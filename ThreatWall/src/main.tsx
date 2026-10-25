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
import { inPlatform, migrateLegacyKeys, platformUser, setSessionOnlyStorage, setStorageNamespace, waitText } from './platform'
import { LEGACY_DISCARD_KEYS, LEGACY_STORAGE_KEYS } from './state/storageKeys'

const root = createRoot(document.getElementById('root')!)
// Inside ThreatReady, progress is kept per signed-in account; the namespace must be known before the store first
// reads it. The lookup times out after a few seconds (one short retry if ThreatReady is busy); standalone it resolves
// at once with no user. If the account can't be confirmed, progress is kept for this tab only and the lab says so.
const boot = (text: string) => root.render(<div className="tr-boot" role="status">{text}</div>)
boot('Loading ThreatReady Firewall…')
void platformUser((seconds) => boot(`ThreatReady is busy. Trying again in ${waitText(seconds)}…`)).then((user) => {
  if (user) {
    setStorageNamespace(user.id)
    migrateLegacyKeys(LEGACY_STORAGE_KEYS, LEGACY_DISCARD_KEYS)
  } else if (inPlatform) setSessionOnlyStorage()
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
