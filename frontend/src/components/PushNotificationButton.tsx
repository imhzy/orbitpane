import { Bell, BellOff } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'

export function PushNotificationButton() {
  const { pushNotifications: { enabled, busy, toggle } } = useAppContext()
  return <button type="button" className="settings-button" disabled={busy}
    aria-pressed={enabled} onClick={() => void toggle()}
    title={enabled ? '关闭此设备的后台推送' : '开启此设备的后台推送'}>
    {enabled ? <Bell size={15} /> : <BellOff size={15} />}
    <span>{busy ? '正在设置…' : enabled ? '关闭后台推送' : '开启后台推送'}</span>
  </button>
}
