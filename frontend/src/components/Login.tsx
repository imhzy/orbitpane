import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { Sparkles } from 'lucide-react'
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
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        localStorage.setItem('agy-token', data.token)
        onLogin()
      } else {
        throw new Error('Invalid PIN')
      }
    } catch (err) {
      setError(true)
      setPin('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-screen">
      {/* Animated background orbs */}
      <div className="login-bg-effects">
        <div className="login-orb login-orb-1" />
        <div className="login-orb login-orb-2" />
        <div className="login-orb login-orb-3" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.92, y: 20 }}
        animate={error ? { x: [-10, 10, -10, 10, 0], opacity: 1, scale: 1, y: 0 } : { opacity: 1, scale: 1, y: 0, x: 0 }}
        transition={error ? { duration: 0.4 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="login-card-enhanced"
      >
        <div className="login-logo-area">
          <motion.div 
            className="login-logo-ring"
            initial={{ rotate: 0 }}
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          >
            <div className="login-logo-ring-inner" />
          </motion.div>
          <div className="login-logo-icon">
            <LogoIcon size={40} />
          </div>
        </div>

        <div className="login-brand-section">
          <h2 className="login-brand-title">
            ANTIGRAVITY
            <span className="login-brand-badge">STUDIO</span>
          </h2>
          <div className="login-brand-tagline">
            <Sparkles size={12} style={{ opacity: 0.7 }} />
            <span>Next-Gen AI Pair Programmer</span>
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
            {loading ? '验证中...' : '立即解锁验证'}
          </button>
        </form>

        <div className="login-footer">
          Powered by Antigravity AI Engine
        </div>
      </motion.div>
    </div>
  )
}
