import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught Error in Antigravity App:", error, errorInfo)
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
          background: '#0B0B12',
          color: '#F3F4F6',
          fontFamily: 'sans-serif',
          padding: 24,
          textAlign: 'center'
        }}>
          <div style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 16,
            padding: 32,
            maxWidth: 480
          }}>
            <h2 style={{ fontSize: 20, marginBottom: 12, color: '#EF4444' }}>页面遇到了意料之外的问题</h2>
            <p style={{ fontSize: 14, color: '#9CA3AF', marginBottom: 20, lineHeight: 1.6 }}>
              {this.state.error?.message || "组件渲染出现异常，请尝试点击下方按钮重试。"}
            </p>
            <button 
              onClick={() => {
                this.setState({ hasError: false, error: null })
                window.location.reload()
              }}
              style={{
                background: 'linear-gradient(135deg, #6366F1, #8B5CF6)',
                border: 'none',
                color: '#FFF',
                padding: '12px 24px',
                borderRadius: 10,
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
