import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Share, PlusSquare, X, Check, Apple, Smartphone, Download, Info } from 'lucide-react'
import {
  clearPwaInstallPrompt,
  getPwaInstallPrompt,
  subscribeToPwaInstallPrompt,
  type PwaInstallPromptEvent,
} from '../lib/pwaInstall'
import './PwaInstallPrompt.css'

interface PwaInstallPromptProps {
  showToast?: (msg: string, kind?: 'success' | 'error' | 'warning' | 'info') => void
}

export function PwaInstallPrompt({ showToast }: PwaInstallPromptProps) {
  const [deferredPrompt, setDeferredPrompt] = useState<PwaInstallPromptEvent | null>(getPwaInstallPrompt)
  const [isStandalone, setIsStandalone] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true ||
      document.referrer.includes('android-app://')
    )
  })

  const [promptBannerOpen, setPromptBannerOpen] = useState<boolean>(false)
  const [guideModalOpen, setGuideModalOpen] = useState<boolean>(false)

  const isIOS = typeof window !== 'undefined' && (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )

  const isAndroid = typeof window !== 'undefined' && /Android/i.test(navigator.userAgent)

  const isAndroidChrome = typeof window !== 'undefined' && (
    isAndroid &&
    /Chrome\/\d+/i.test(navigator.userAgent) &&
    !/\bwv\b/i.test(navigator.userAgent)
  )

  useEffect(() => {
    if (typeof window === 'undefined' || isStandalone) return

    const handleAppInstalled = () => {
      setIsStandalone(true)
      setPromptBannerOpen(false)
      setGuideModalOpen(false)
      setDeferredPrompt(null)
      if (showToast) {
        showToast('OrbitPane 已成功安装！', 'success')
      }
    }

    window.addEventListener('appinstalled', handleAppInstalled)

    // The event is captured at bundle startup, even if login/auth means this
    // component mounts later. Only advertise one-tap installation when Chrome
    // has actually made its native prompt available.
    const unsubscribeFromInstallPrompt = subscribeToPwaInstallPrompt(prompt => {
      setDeferredPrompt(prompt)
      if (prompt) setPromptBannerOpen(true)
    })

    // Check display mode changes
    const mediaQuery = window.matchMedia('(display-mode: standalone)')
    const handleDisplayChange = (evt: MediaQueryListEvent) => {
      if (evt.matches) setIsStandalone(true)
    }
    mediaQuery.addEventListener?.('change', handleDisplayChange)

    // iOS and Android WebViews do not expose Chrome's native prompt, so those
    // environments retain the manual installation guide. Android Chrome waits
    // for beforeinstallprompt instead of showing a misleading early CTA.
    const dismissedTime = localStorage.getItem('orbitpane_pwa_dismissed')
    const COOLDOWN = 12 * 60 * 60 * 1000 // 12 hours cooldown if closed
    let timer: number | undefined

    if (
      !isAndroidChrome &&
      (isIOS || isAndroid) &&
      (!dismissedTime || (Date.now() - parseInt(dismissedTime, 10)) > COOLDOWN)
    ) {
      timer = window.setTimeout(() => {
        setPromptBannerOpen(true)
      }, 1000)
    }

    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      unsubscribeFromInstallPrompt()
      window.removeEventListener('appinstalled', handleAppInstalled)
      mediaQuery.removeEventListener?.('change', handleDisplayChange)
    }
  }, [isAndroid, isAndroidChrome, isIOS, isStandalone, showToast])

  const handleDismiss = () => {
    setPromptBannerOpen(false)
    localStorage.setItem('orbitpane_pwa_dismissed', Date.now().toString())
  }

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      try {
        // Must be triggered inside user click gesture for Chrome Android to allow native prompt
        await deferredPrompt.prompt()
        const choiceResult = await deferredPrompt.userChoice
        if (choiceResult?.outcome === 'accepted') {
          if (showToast) showToast('正在为您安装 OrbitPane 应用...', 'info')
          setPromptBannerOpen(false)
        } else {
          handleDismiss()
        }
      } catch (err) {
        console.warn('Native prompt error:', err)
        setGuideModalOpen(true)
      }
      clearPwaInstallPrompt()
      setDeferredPrompt(null)
    } else {
      // If native deferred prompt is not supported directly (e.g. iOS Safari / WeChat / UC Browser)
      setGuideModalOpen(true)
    }
  }

  if (isStandalone) {
    return null
  }

  return (
    <>
      {/* Direct Installation Prompt Banner on Page Open */}
      <AnimatePresence>
        {promptBannerOpen && !guideModalOpen && (
          <div className="pwa-install-banner-wrapper">
            <motion.div
              className="pwa-install-banner"
              initial={{ opacity: 0, y: 50, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 30, scale: 0.95 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            >
              <button 
                className="pwa-banner-close-btn"
                onClick={handleDismiss}
                title="暂不安装"
                aria-label="关闭"
              >
                <X size={16} />
              </button>

              <div className="pwa-banner-content">
                <div className="pwa-banner-icon-box">
                  <img src="/pwa-192x192.png" alt="OrbitPane Icon" className="pwa-app-icon" />
                  <span className="pwa-badge-pulse" />
                </div>

                <div className="pwa-banner-info">
                  <div className="pwa-banner-header-row">
                    <span className="pwa-banner-title">安装 OrbitPane 到手机</span>
                    <span className="pwa-chip">{isIOS ? 'iOS App' : isAndroid ? 'Android App' : 'PWA 应用'}</span>
                  </div>
                  <p className="pwa-banner-desc">
                    全屏独立运行，离线极速缓存，脱离浏览器工具栏
                  </p>
                </div>
              </div>

              <div className="pwa-banner-actions">
                <button className="pwa-install-btn-primary" onClick={handleInstallClick}>
                  {isIOS ? <Share size={16} /> : <Download size={16} />}
                  <span>{isIOS ? '添加到主屏幕' : '立即安装到手机'}</span>
                </button>

                <button className="pwa-install-btn-secondary" onClick={handleDismiss}>
                  稍后再说
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Manual Step Guide Modal (for iOS / WebViews where native prompt isn't supported) */}
      <AnimatePresence>
        {guideModalOpen && (
          <div className="pwa-guide-overlay" onClick={() => setGuideModalOpen(false)}>
            <motion.div
              className="pwa-guide-modal"
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.2 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="pwa-guide-header">
                <div className="pwa-guide-title-group">
                  {isIOS ? <Apple size={20} className="pwa-guide-os-icon" /> : <Smartphone size={20} className="pwa-guide-os-icon" />}
                  <h3>{isIOS ? 'iPhone / iPad 安装指引' : '安卓手机浏览器安装指引'}</h3>
                </div>
                <button 
                  className="pwa-guide-close-btn" 
                  onClick={() => setGuideModalOpen(false)}
                  aria-label="关闭指引"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="pwa-guide-body">
                <div className="pwa-guide-app-preview">
                  <img src="/pwa-192x192.png" alt="OrbitPane" className="pwa-preview-icon" />
                  <div>
                    <div className="pwa-preview-name">OrbitPane</div>
                    <div className="pwa-preview-sub">智能 Agent 协作工作区 (PWA)</div>
                  </div>
                </div>

                <div className="pwa-steps-list">
                  {isIOS ? (
                    <>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">1</div>
                        <div className="pwa-step-text">
                          在 Safari 浏览器底栏点击 <strong>分享按钮</strong> 
                          <span className="pwa-step-icon-badge"><Share size={15} /></span>
                        </div>
                      </div>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">2</div>
                        <div className="pwa-step-text">
                          在弹出菜单中选择 <strong>「添加到主屏幕」</strong>
                          <span className="pwa-step-icon-badge"><PlusSquare size={15} /></span>
                        </div>
                      </div>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">3</div>
                        <div className="pwa-step-text">
                          点击右上角 <strong>「添加」</strong>，即可像原生 App 一样直接启动！
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">1</div>
                        <div className="pwa-step-text">
                          点击浏览器右上角菜单按钮 <strong>「⋮」</strong>
                        </div>
                      </div>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">2</div>
                        <div className="pwa-step-text">
                          选择 <strong>「安装应用」</strong> 或 <strong>「添加到主屏幕」</strong>
                          <span className="pwa-step-icon-badge"><Download size={15} /></span>
                        </div>
                      </div>
                      <div className="pwa-step-item">
                        <div className="pwa-step-number">3</div>
                        <div className="pwa-step-text">
                          确认后，OrbitPane 将生成独立应用图标并添加至手机桌面。
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="pwa-guide-tip">
                  <Info size={14} />
                  <span>添加至主屏幕后，每次打开均可享全屏体验与极速网络响应。</span>
                </div>
              </div>

              <div className="pwa-guide-footer">
                <button 
                  className="pwa-guide-done-btn"
                  onClick={() => setGuideModalOpen(false)}
                >
                  <Check size={16} />
                  <span>我知道了</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
