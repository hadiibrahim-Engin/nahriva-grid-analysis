import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import UiConfigProvider from './config/UiConfigProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UiConfigProvider>
      <App />
    </UiConfigProvider>
  </StrictMode>,
)
