import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { activatePwaUpdate, configurePwaUpdate, consumeManualUpdateRequest } from './lib/pwaUpdate'
import { OFFLINE_READY_EVENT, UPDATE_READY_EVENT } from './lib/appEvents'

const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (consumeManualUpdateRequest()) {
      void activatePwaUpdate()
      return
    }
    window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT, {
      detail: () => void activatePwaUpdate(),
    }))
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent(OFFLINE_READY_EVENT))
  },
  onRegisteredSW(_swScriptUrl, registration) {
    configurePwaUpdate({ registration })
  },
})

configurePwaUpdate({
  activateWaitingWorker: () => updateServiceWorker(true),
})

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught Error in OrbitPane:", error, errorInfo)
    
    // Fallback for dynamic import failures if vite:preloadError doesn't catch it
    const errorMsg = error?.message || '';
    if (errorMsg.includes("Failed to fetch dynamically imported module") || errorMsg.includes("Importing a module script failed")) {
      const reloaded = sessionStorage.getItem('chunk-load-error-reloaded');
      if (!reloaded) {
        sessionStorage.setItem('chunk-load-error-reloaded', 'true');
        window.location.reload();
      }
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: '#09090b',
          color: '#f4f4f5',
          fontFamily: 'sans-serif',
          padding: 24,
          textAlign: 'center'
        }}>
          <div style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 12,
            padding: 32,
            maxWidth: 480
          }}>
            <h2 style={{ fontSize: 20, marginBottom: 12, color: '#EF4444' }}>页面遇到了意料之外的问题</h2>
            <p style={{ fontSize: 14, color: '#a1a1aa', marginBottom: 20, lineHeight: 1.6 }}>
              {this.state.error?.message || "组件渲染出现异常，请尝试点击下方按钮重试。"}
            </p>
            <button 
              onClick={() => {
                this.setState({ hasError: false, error: null })
                window.location.reload()
              }}
              style={{
                background: '#2563eb',
                border: 'none',
                color: '#FFF',
                padding: '10px 20px',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              重新加载应用
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Handle dynamic import failures (e.g. after a new deployment)
window.addEventListener('vite:preloadError', (event) => {
  console.warn('vite:preloadError, reloading page...', event)
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {/* The CSS `prefers-reduced-motion` block only silences CSS animations.
          Drawers, sheets, dialogs and message entry are all framer-motion, so
          they need this to honour the same preference. */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
)
