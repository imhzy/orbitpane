import { useCallback, useState } from 'react'
import { requestPwaUpdate } from '../lib/pwaUpdate'
import type { ToastKind } from '../lib/types'

/**
 * Manual "check for update", shared by the mobile action sheet and the command
 * palette. It used to live only in the mobile-only dropdown, which meant desktop
 * users had no way to pull a new build short of a hard refresh.
 */
export function useUpdateCheck(showToast: (msg: string, kind?: ToastKind) => void) {
  const [isChecking, setIsChecking] = useState(false)

  const checkForUpdate = useCallback(async () => {
    if (isChecking) return
    setIsChecking(true)
    showToast('正在检查更新…', 'info')
    try {
      const result = await requestPwaUpdate()
      if (result === 'current') showToast('当前已是最新版本')
      if (result === 'updating') showToast('新版本已获取，正在安装…', 'info')
      if (result === 'reloading') showToast('正在切换到最新版本…', 'info')
    } catch {
      showToast('更新检查失败，请确认网络连接', 'error')
    } finally {
      setIsChecking(false)
    }
  }, [isChecking, showToast])

  return { isChecking, checkForUpdate }
}
