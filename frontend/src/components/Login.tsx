import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { apiFetch } from '../lib/api'
import { Lock, AlertCircle } from 'lucide-react'
import './Login.css'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /* The screen sizes itself to the visual viewport, so the field is normally
     already inside the strip the keyboard leaves. It is not on a short phone
     in landscape, where the column is taller than that strip and starts at the
     top of it — and iOS will not scroll a position:fixed page to the caret.
     Nudging the field into view covers that case, and is a no-op when the card
     fits, which is the common one. */
  const revealInput = useCallback(() => {
    if (document.activeElement !== inputRef.current) return
    inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    viewport.addEventListener('resize', revealInput)
    return () => viewport.removeEventListener('resize', revealInput)
  }, [revealInput])

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
      <div className="login-scroll">
        <div className="login-card">
          <div className="login-header">
            <div className="login-brand-row">
              <LogoIcon size={44} />
              <h1 className="login-brand-title">OrbitPane</h1>
            </div>
            {/* One line of orientation. The card previously showed a name and a
                field with nothing to say what this machine is. */}
            <p className="login-brand-sub">自托管的编码 Agent 工作台</p>
          </div>

          <form onSubmit={handleSubmit} className="login-form-area">
            <div className="login-input-group">
              <label className="login-input-label">访问 PIN</label>
              <div className="login-input-wrapper">
                <input 
                  ref={inputRef}
                  type="password"
                  value={pin}
                  onChange={e => { setPin(e.target.value); setError(false); }}
                  // The resize listener catches the keyboard opening; this catches
                  // a re-focus while it is already up, when no resize fires.
                  onFocus={() => window.setTimeout(revealInput, 300)}
                  placeholder="输入访问 PIN"
                  className={`login-input ${error ? 'login-input-error' : ''}`}
                  autoFocus
                  disabled={loading}
                  aria-label="输入访问 PIN"
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
                    <span>PIN 不正确，请重试。</span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              type="submit"
              disabled={loading || !pin.trim()}
              className="login-submit-btn"
              aria-label={loading ? '正在验证' : '提交 PIN'}
            >
              {loading ? <div className="login-spinner" /> : '登录'}
            </button>
          </form>

        </div>
      </div>
      {/* Fine print belongs to the screen, not inside the card: a build number
          centred under the primary action read as part of the form. */}
      <div className="login-footer">OrbitPane v2.1</div>
    </div>
  )
}
