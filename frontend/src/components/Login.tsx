import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { apiFetch } from '../lib/api'
import './Login.css'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pin) return
    setLoading(true)
    setError(false)
    
    try {
      const data = await apiFetch<{ success: boolean }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ pin })
      })
      if (data.success) {
        onLogin()
      } else {
        throw new Error('Invalid PIN')
      }
    } catch {
      setError(true)
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      <motion.div 
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={error ? { x: [-8, 8, -8, 8, 0], opacity: 1, scale: 1, y: 0 } : { opacity: 1, scale: 1, y: 0, x: 0 }}
        transition={error ? { duration: 0.3 } : { duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="login-card-enhanced"
      >
        <div className="login-logo-area">
          <div className="login-logo-icon">
            <LogoIcon size={36} />
          </div>
        </div>

        <div className="login-brand-section">
          <h2 className="login-brand-title">
            ORBIT
            <span className="login-brand-badge">PANE</span>
          </h2>
          <div className="login-brand-tagline">
            <span>Self-hosted Agent Workspace</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="login-form-area">
          <div className="login-input-group">
            <label className="login-input-label">访问密码</label>
            <input 
              type="password"
              value={pin}
              onChange={e => { setPin(e.target.value); setError(false); }}
              placeholder="输入 PIN 访问码"
              className={`login-input ${error ? 'login-input-error' : ''}`}
              autoFocus
              disabled={loading}
              aria-label="输入访问密码"
            />
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="login-error-text"
              >
                密码错误，请重新输入
              </motion.div>
            )}
          </div>

          <button 
            type="submit" 
            disabled={loading || !pin.trim()} 
            className="login-submit-btn"
            aria-label={loading ? '验证中' : '提交密码验证'}
          >
            {loading ? '验证中...' : '验证并进入'}
          </button>
        </form>

        <div className="login-footer">
          OrbitPane Workspace v1.0
        </div>
      </motion.div>
    </div>
  )
}
