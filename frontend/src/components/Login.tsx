import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { LogoIcon } from '../LogoIcon'
import { apiFetch, ApiError } from '../lib/api'
import { loginWithPasskey, passkeyError, supportsPasskeys } from '../lib/passkeys'
import { readText, writeText } from '../lib/storage'
import { Lock, AlertCircle, UserRoundKey } from 'lucide-react'
import './Login.css'
import { Input } from './FormControls'

type LoginMethod = 'pin' | 'passkey'
const LOGIN_METHOD_KEY = 'orbitpane_last_login_method'

export function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<{ method: LoginMethod; message: string } | null>(null)
  const passkeysSupported = supportsPasskeys()
  const [usePin, setUsePin] = useState(() => !passkeysSupported || readText(LOGIN_METHOD_KEY) === 'pin')
  const [loadingMethod, setLoadingMethod] = useState<LoginMethod | null>(null)
  const loading = loadingMethod !== null
  const pinError = error?.method === 'pin'
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
    if (loading || !pin.trim()) return
    setLoadingMethod('pin')
    setError(null)

    try {
      const data = await apiFetch<{ success: boolean }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ pin })
      })
      if (data.success) {
        writeText(LOGIN_METHOD_KEY, 'pin')
        onLogin()
      } else {
        throw new Error('Invalid PIN')
      }
    } catch (error) {
      setError({ method: 'pin', message: error instanceof ApiError && error.status === 401 ? 'PIN 不正确，请重试。'
        : error instanceof ApiError && error.status === 429 ? '尝试次数过多，请稍后重试。' : '登录失败，请检查网络后重试。' })
      setPin('')
    } finally {
      setLoadingMethod(null)
    }
  }

  const handlePasskey = async () => {
    if (loading) return
    setLoadingMethod('passkey')
    setError(null)
    try {
      await loginWithPasskey()
      writeText(LOGIN_METHOD_KEY, 'passkey')
      onLogin()
    } catch (error) {
      setError({ method: 'passkey', message: passkeyError(error) })
    } finally {
      setLoadingMethod(null)
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

          <div className="login-form-area">
            {usePin && <form onSubmit={handleSubmit} className="login-form-area">
              <div className="login-input-group">
                <label htmlFor="login-pin" className="login-input-label">访问 PIN</label>
                <div className="login-input-wrapper">
                  <Input
                    id="login-pin"
                    ref={inputRef}
                    type="password"
                    autoComplete="current-password"
                    value={pin}
                    onChange={e => { setPin(e.target.value); setError(null); }}
                    // The resize listener catches the keyboard opening; this catches
                    // a re-focus while it is already up, when no resize fires.
                    onFocus={() => window.setTimeout(revealInput, 300)}
                    placeholder="输入访问 PIN"
                    className={`login-input ${pinError ? 'login-input-error' : ''}`}
                    autoFocus
                    disabled={loading}
                    aria-label="输入访问 PIN"
                    aria-invalid={pinError}
                    aria-describedby={pinError ? 'login-error' : undefined}
                  />
                  <Lock className="login-input-icon" size={18} strokeWidth={2.5} aria-hidden="true" />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !pin.trim()}
                className={`login-submit-btn${passkeysSupported ? ' login-pin-submit' : ''}`}
                aria-busy={loadingMethod === 'pin'}
                aria-label={loadingMethod === 'pin' ? '正在使用 PIN 登录' : '使用 PIN 登录'}
              >
                {loadingMethod === 'pin' && <span className="login-spinner" aria-hidden="true" />}
                <span>使用 PIN 登录</span>
              </button>
            </form>}
            {usePin && passkeysSupported && <div className="login-method-divider" aria-hidden="true" />}
            {passkeysSupported && <button
              type="button"
              className="login-submit-btn login-passkey-btn"
              disabled={loading}
              onClick={handlePasskey}
              aria-busy={loadingMethod === 'passkey'}
              aria-label={loadingMethod === 'passkey' ? '正在使用通行密钥登录' : '使用通行密钥登录'}
            >
              {loadingMethod === 'passkey'
                ? <span className="login-spinner" aria-hidden="true" />
                : <UserRoundKey size={20} aria-hidden="true" />}
              <span>使用通行密钥登录</span>
            </button>}
            <AnimatePresence>
              {error && <motion.div id="login-error" role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="login-error-message">
                <AlertCircle size={14} aria-hidden="true" /><span>{error.message}</span>
              </motion.div>}
            </AnimatePresence>
            {passkeysSupported && !usePin && (
              <button type="button" className="login-switch-btn" disabled={loading} onClick={() => { setUsePin(true); setError(null); setPin('') }}>
                使用 PIN 登录
              </button>
            )}
          </div>

        </div>
      </div>
      {/* Fine print belongs to the screen, not inside the card: a build number
          centred under the primary action read as part of the form. */}
      <div className="login-footer">OrbitPane v2.1</div>
    </div>
  )
}
