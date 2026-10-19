import { RefreshCw } from 'lucide-react'
import { useProviderUsage } from '../hooks/useProviderUsage'
import { openInspectorPanel } from '../lib/appEvents'
import type { ProviderUsage, UsageWindow } from '../lib/types'
import './ProviderUsage.css'

function tone(remaining: number) {
  return remaining < 15 ? 'low' : remaining < 40 ? 'warn' : 'ok'
}
function title(usage?: ProviderUsage) {
  return usage ? `${usage.provider_name}${usage.plan ? ` · ${usage.plan}` : ''}` : '用量'
}
function resetLabel(reset: number | null) {
  if (reset === null) return null
  const minutes = (reset * 1000 - Date.now()) / 60_000
  if (minutes <= 0) return '即将重置'
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟后重置`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} 小时后重置`
  return `${Math.round(minutes / 1440)} 天后重置`
}
function shortLabel(window: UsageWindow) {
  const minutes = window.window_minutes
  if (minutes === 10080) return '周'
  if (minutes && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`
  return window.label.replace(/\s/g, '')
}

export function ProviderUsageChip({ provider }: { provider: string }) {
  const { usage } = useProviderUsage(provider)
  const window = usage?.windows.reduce<UsageWindow | undefined>((lowest, item) =>
    !lowest || item.remaining_percent < lowest.remaining_percent ? item : lowest, undefined)
  if (!usage || !window) return null
  const description = `${window.group ? `${window.group} · ` : ''}${window.label}还剩 ${window.remaining_percent}%`
  return <button type="button" className={`usage-chip ${tone(window.remaining_percent)}`}
    aria-label={`${usage.provider_name} 用量，${description}${usage.stale ? '，缓存数据' : ''}`}
    title={`${title(usage)}：${description}${usage.stale ? '（缓存）' : ''}`}
    onClick={() => openInspectorPanel('mission')}>
    {window.group && <span className="usage-chip-group">{window.group}</span>}
    <span>{shortLabel(window)} {window.remaining_percent}%{usage.stale && <span aria-hidden="true"> ·</span>}</span>
  </button>
}

export function ProviderUsageCard({ provider }: { provider?: string }) {
  const { usage, loading, refresh } = useProviderUsage(provider)
  if (!loading && (!usage || (!usage.available && !usage.error && !usage.windows.length))) return null
  const groups = new Map<string, UsageWindow[]>()
  for (const window of usage?.windows ?? []) {
    const group = window.group ?? ''
    groups.set(group, [...(groups.get(group) ?? []), window])
  }
  return <section className="inspector-card usage-card" aria-label="账号用量">
    <div className="inspector-card-title">
      <span>{title(usage)}</span>
      <button type="button" className="icon-btn" title="刷新用量" aria-label="刷新用量"
        disabled={loading} onClick={() => void refresh()}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
      </button>
    </div>
    <p className="usage-caption">服务器账号额度 · 所有项目共享</p>
    {!usage ? <p className="usage-note" role="status">正在读取用量…</p> : <>
      {usage.windows.length ? [...groups].map(([group, windows]) => <div className="usage-group" key={group}>
        {group && <h3 className="usage-group-title">{group}</h3>}
        {windows.map(window => <div className={`usage-window ${tone(window.remaining_percent)}`} key={window.id}>
        <div className="usage-window-label"><span>{window.label}</span><strong>还剩 {window.remaining_percent}%</strong></div>
        <div className="usage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={window.remaining_percent} aria-label={`${window.group ? `${window.group} · ` : ''}${window.label}还剩 ${window.remaining_percent}%`}>
          <i style={{ width: `${Math.max(window.remaining_percent, 1)}%` }} />
        </div>
        {window.resets_at !== null && <small>{resetLabel(window.resets_at)}</small>}
      </div>)}
      </div>) : <p className="usage-note" role="status">{usage.error || '当前未返回用量窗口'}</p>}
      {usage.stale && usage.error && <p className="usage-note" role="status">上次读取失败，显示缓存</p>}
      {usage.limit_reached && <p className="usage-note low" role="status">当前窗口已达上限</p>}
    </>}
  </section>
}
