import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker, unregisterServiceWorkers } from './registerServiceWorker.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.env.PROD) {
  registerServiceWorker()
} else {
  unregisterServiceWorkers({ reloadControlledPage: true })
}
