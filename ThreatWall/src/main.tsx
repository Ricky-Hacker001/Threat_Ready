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
import { initStorageNamespace } from './lib/storage'

// Inside ThreatReady, lab state is kept per signed-in account; the namespace must be known before
// the store first reads localStorage (standalone this resolves at once as 'local').
void initStorageNamespace().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
