import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker } from './registerServiceWorker.js'
import { startPatientNativePushNavigation } from './lib/patientNativePushNavigation.js'

// On Android, settle the initial auth snapshot before exposing the login UI.
// A later manual login must never be mistaken for restoration of a launch tap.
const nativePushBootstrap = startPatientNativePushNavigation()
const root = createRoot(document.getElementById('root'))
root.render(
  <main className="app-route-loading" role="status" aria-live="polite">
    <span aria-hidden="true" />
    <p>Loading your workspace...</p>
  </main>,
)

void nativePushBootstrap.then(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})

if (window.isSecureContext) {
  registerServiceWorker()
}
