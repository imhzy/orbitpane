import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { apiFetch } from '../lib/api'
import { Lock, AlertCircle, ArrowRight } from 'lucide-react'
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
      <div className="login-bg-mesh">
        <div className="login-orb login-orb-1" />
        <div className="login-orb login-orb-2" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="login-card-enhanced"
      >
        <div className="login-header">
          <motion.div 
            className="login-logo-wrapper"
            whileHover={{ scale: 1.05, rotate: 5 }}
            transition={{ type: "spring", stiffness: 400, damping: 10 }}
          >
            <LogoIcon size={32} />
          </motion.div>
          
          <div className="login-header-text">
            <h1 className="login-brand-title">
              <span>OrbitPane</span>
            </h1>
            <div className="login-brand-tagline">Self-hosted Agent Workspace</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="login-form-area">
          <div className="login-input-group">
            <label className="login-input-label">Access PIN</label>
            <div className="login-input-wrapper">
              <input 
                type="password"
                value={pin}
                onChange={e => { setPin(e.target.value); setError(false); }}
                placeholder="Enter your PIN"
                className={`login-input ${error ? 'login-input-error' : ''}`}
                autoFocus
                disabled={loading}
                aria-label="Enter access PIN"
              />
              <Lock className="login-input-icon" size={18} strokeWidth={2.5} />
            </div>
            
            <AnimatePresence>
              {error && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 4 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  className="login-error-message"
                >
                  <AlertCircle size={14} />
                  <span>Incorrect PIN, please try again.</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <motion.button 
            type="submit" 
            disabled={loading || !pin.trim()} 
            className="login-submit-btn"
            aria-label={loading ? 'Authenticating' : 'Submit PIN'}
            whileTap={(!loading && pin.trim()) ? { scale: 0.98 } : undefined}
          >
            {loading ? (
              <div className="login-spinner" />
            ) : (
              <>
                Continue
                <ArrowRight size={18} />
              </>
            )}
          </motion.button>
        </form>

        <div className="login-footer">
          OrbitPane Workspace v1.0
        </div>
      </motion.div>
    </div>
  )
}
