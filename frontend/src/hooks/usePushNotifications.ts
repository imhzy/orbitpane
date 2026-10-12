import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { disablePush, enablePush, pushUnavailableReason, syncPushSubscription } from '../lib/push'
import type { PushConfig } from '../lib/push'
import type { ToastKind } from '../lib/types'

/** Keep subscription renewal alive even when the settings page is closed. */
export function usePushNotifications(authenticated: boolean, showToast: (message: string, kind?: ToastKind) => void) {
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!authenticated) {
      setConfig(null)
      setEnabled(false)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const next = await apiFetch<PushConfig>('/api/push/config')
        if (cancelled) return
        setConfig(next)
        const active = await syncPushSubscription(next)
        if (!cancelled) setEnabled(active)
      } catch { /* A user-triggered retry reports failures. */ }
    }
    void refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible) }
  }, [authenticated])

  const toggle = useCallback(async () => {
    if (busy) return
    const reason = pushUnavailableReason()
    if (reason && !enabled) { showToast(reason, 'error'); return }
    if (!enabled && !config?.enabled) {
      try {
        setConfig(await apiFetch<PushConfig>('/api/push/config'))
        showToast('请确认服务器已配置推送，然后再次点击开启通知。', 'info')
      } catch { showToast('无法读取推送设置，请稍后重试。', 'error') }
      return
    }
    // iOS requires the permission request directly in the click gesture.
    const permission = !enabled ? Notification.requestPermission() : null
    setBusy(true)
    try {
      if (enabled) await disablePush()
      else await enablePush(config!, permission!)
      setEnabled(!enabled)
      showToast(enabled ? '此设备已关闭后台通知' : '已开启后台通知，关闭应用后也可接收')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '通知设置失败，请重试。', 'error')
    } finally { setBusy(false) }
  }, [busy, config, enabled, showToast])

  return { enabled, busy, toggle }
}
