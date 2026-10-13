import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Loader2, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'
import { apiFetch, describeApiError } from '../lib/api'
import { BACKGROUND_REFRESH_MS, emitTaskChange, TASK_CHANGE_EVENT } from '../lib/appEvents'
import { taskStatusLabel } from '../lib/taskStatus'
import type { ScheduleRecord, ScheduleSpec, TaskRecord } from '../lib/types'
import { Checkbox, Input, NumberInput, Select, Textarea, TimeInput } from './FormControls'
import './SchedulePanel.css'

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles']

function describeRule(spec: ScheduleSpec): string {
  if (spec.kind === 'interval') return `每 ${spec.interval} ${spec.unit === 'hours' ? '小时' : '分钟'}`
  const prefix = spec.kind === 'weekly' ? spec.weekdays.map(day => DAYS[day]).join('、') : '每天'
  return `${prefix} ${spec.times.join('、')}`
}

function formatTime(value: string | null, zone: string): string {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))
  } catch { return '—' }
}

interface SchedulePanelProps { conversationId: number }

export function SchedulePanel({ conversationId }: SchedulePanelProps) {
  const { showToast, requestConfirm } = useAppContext()
  const base = `/api/conversations/${conversationId}/schedules`
  const [items, setItems] = useState<ScheduleRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ScheduleRecord | 'new' | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<ScheduleSpec['kind']>('interval')
  const [interval, setIntervalValue] = useState('30')
  const [unit, setUnit] = useState<'minutes' | 'hours'>('minutes')
  const [times, setTimes] = useState(['09:00'])
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4])
  const [zone, setZone] = useState('Asia/Shanghai')
  const [compact, setCompact] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [formError, setFormError] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const runRequests = useRef(new Map<number, string>())

  const load = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const data = await apiFetch<{ items: ScheduleRecord[] }>(base, { signal: controller.signal })
      if (!mountedRef.current || controller.signal.aborted) return
      setItems(data.items)
      setError('')
    } catch (failure) {
      if (mountedRef.current && !controller.signal.aborted) setError(describeApiError(failure, '定时任务加载失败'))
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false)
    }
  }, [base])

  useEffect(() => {
    mountedRef.current = true
    void load()
    const refresh = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener(TASK_CHANGE_EVENT, refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, BACKGROUND_REFRESH_MS)
    return () => {
      mountedRef.current = false
      requestRef.current?.abort()
      window.clearInterval(timer)
      window.removeEventListener(TASK_CHANGE_EVENT, refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  const edit = (item: ScheduleRecord | 'new') => {
    setEditing(item)
    setName(item === 'new' ? '' : item.name)
    setPrompt(item === 'new' ? '' : item.prompt)
    setKind(item === 'new' ? 'interval' : item.spec.kind)
    setIntervalValue(String(item === 'new' ? 30 : item.spec.interval || 30))
    setUnit(item === 'new' ? 'minutes' : item.spec.unit || 'minutes')
    setTimes(item === 'new' || !item.spec.times.length ? ['09:00'] : item.spec.times)
    setWeekdays(item === 'new' || !item.spec.weekdays.length ? [0, 1, 2, 3, 4] : item.spec.weekdays)
    setZone(item === 'new' ? 'Asia/Shanghai' : item.spec.timezone)
    setCompact(item === 'new' ? false : item.compact_before)
    setFormError('')
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing || saving) return
    if (!name.trim() || !prompt.trim()) { setFormError('请填写任务名称和命令。'); return }
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: zone }) }
    catch { setFormError('请输入有效时区，例如 Asia/Shanghai。'); return }
    const count = Number(interval)
    if (kind === 'interval' && (!Number.isInteger(count) || count < 1 || count > (unit === 'hours' ? 8760 : 525600))) {
      setFormError('间隔须为正整数，且不能超过一年。'); return
    }
    if (kind !== 'interval' && (times.some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(times).size !== times.length)) {
      setFormError('请填写有效的执行时间，且时间不能重复。'); return
    }
    if (kind === 'weekly' && !weekdays.length) { setFormError('请至少选择一天。'); return }
    const spec: ScheduleSpec = { kind, timezone: zone, times: kind === 'interval' ? [] : [...times].sort(),
      weekdays: kind === 'weekly' ? [...weekdays].sort() : [],
      ...(kind === 'interval' ? { interval: count, unit } : {}) }
    setSaving(true)
    setFormError('')
    try {
      await apiFetch(editing === 'new' ? base : `${base}/${editing.id}`, {
        method: editing === 'new' ? 'POST' : 'PATCH',
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim(), spec, compact_before: compact,
          ...(editing !== 'new' ? { version: editing.version } : {}) }),
      })
      if (!mountedRef.current) return
      setEditing(null)
      showToast(editing === 'new' ? '定时任务已创建' : '定时任务已更新', 'success')
      emitTaskChange()
      void load()
    } catch (failure) {
      if (mountedRef.current) setFormError(describeApiError(failure, '保存失败'))
    } finally { if (mountedRef.current) setSaving(false) }
  }

  const change = async (item: ScheduleRecord, action: 'toggle' | 'run' | 'delete') => {
    if (busyId !== null) return
    setBusyId(item.id)
    try {
      if (action === 'run') {
        const requestId = runRequests.current.get(item.id) || crypto.randomUUID()
        runRequests.current.set(item.id, requestId)
        const result = await apiFetch<TaskRecord>(`${base}/${item.id}/run`, {
          method: 'POST', body: JSON.stringify({ request_id: requestId }),
        })
        runRequests.current.delete(item.id)
        if (result.status === 'failed') showToast(result.error || '定时任务启动失败', 'error')
        else showToast(result.status === 'queued' ? '命令已加入当前聊天的队列' : '命令已开始执行', 'success')
      } else if (action === 'delete') {
        await apiFetch(`${base}/${item.id}`, { method: 'DELETE' })
        showToast('定时任务已删除', 'info')
      } else {
        await apiFetch(`${base}/${item.id}`, { method: 'PATCH',
          body: JSON.stringify({ enabled: !item.enabled, version: item.version }) })
        showToast(item.enabled ? '已暂停后续触发，已排队的命令会继续执行' : '定时任务已恢复', 'info')
      }
      if (mountedRef.current) { emitTaskChange(); void load() }
    } catch (failure) { showToast(describeApiError(failure, '操作失败'), 'error') }
    finally { if (mountedRef.current) setBusyId(null) }
  }

  return <section className="schedule-panel" aria-label="当前聊天的定时任务">
    <div className="schedule-panel-heading">
      <span><Clock size={15} />定时任务 <b>{items.length}</b></span>
      <button type="button" className="icon-btn" title="刷新定时任务" aria-label="刷新定时任务" onClick={() => void load()}><RefreshCw size={14} /></button>
      <button type="button" className="schedule-add" onClick={() => edit('new')} disabled={saving || editing !== null}><Plus size={14} />新增</button>
    </div>
    <p className="schedule-panel-note">命令发送到当前聊天，按触发顺序排队。关闭页面仍会执行，服务停机期间错过的触发会跳过。</p>
    {error && <div className="schedule-error" role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></div>}
    {editing && <form className="schedule-form" onSubmit={event => void save(event)}>
      <div className="schedule-form-heading"><strong>{editing === 'new' ? '新增定时任务' : '编辑定时任务'}</strong>
        <button type="button" className="icon-btn" aria-label="关闭任务编辑" disabled={saving} onClick={() => setEditing(null)}><X size={15} /></button></div>
      <label>任务名称<Input autoFocus value={name} maxLength={120} required onChange={event => setName(event.target.value)} placeholder="例如：每日项目检查" /></label>
      <label>Agent 命令<Textarea value={prompt} required maxLength={200000} rows={4} onChange={event => setPrompt(event.target.value)} placeholder="填写你希望发送到当前聊天的内容…" /></label>
      <div className="schedule-field"><label htmlFor={`schedule-kind-${conversationId}`}>执行周期</label>
        <Select id={`schedule-kind-${conversationId}`} aria-label="执行周期" value={kind} onChange={value => setKind(value as ScheduleSpec['kind'])}
          options={[{ value: 'interval', label: '固定间隔' }, { value: 'daily', label: '每天定时' }, { value: 'weekly', label: '每周定时' }]} />
      </div>
      {kind === 'interval' ? <div className="schedule-interval-fields">
        <div className="schedule-field"><label htmlFor={`schedule-interval-${conversationId}`}>间隔</label>
          <NumberInput id={`schedule-interval-${conversationId}`} aria-label="间隔" min={1} max={unit === 'hours' ? 8760 : 525600} step={1} value={interval} required onChange={setIntervalValue} />
        </div>
        <div className="schedule-field"><label htmlFor={`schedule-unit-${conversationId}`}>单位</label>
          <Select id={`schedule-unit-${conversationId}`} aria-label="单位" value={unit} onChange={value => setUnit(value as 'minutes' | 'hours')}
            options={[{ value: 'minutes', label: '分钟' }, { value: 'hours', label: '小时' }]} />
        </div>
      </div> : <fieldset><legend>执行时间</legend>
        <div className="schedule-times">{times.map((time, index) => <div key={index}>
          <TimeInput value={time} required aria-label={`执行时间 ${index + 1}`} onChange={next => setTimes(values => values.map((value, i) => i === index ? next : value))} />
          <button type="button" className="icon-btn" aria-label={`删除执行时间 ${index + 1}`} disabled={times.length === 1} onClick={() => setTimes(values => values.filter((_, i) => i !== index))}><X size={13} /></button>
        </div>)}</div>
        <button type="button" className="schedule-text-button" disabled={times.length >= 24} onClick={() => setTimes(values => [...values, '18:00'])}><Plus size={12} />添加时间</button>
      </fieldset>}
      {kind === 'weekly' && <fieldset><legend>执行日期</legend><div className="schedule-weekdays">
        {DAYS.map((day, index) => <label key={day} className={weekdays.includes(index) ? 'selected' : ''}>
          <Checkbox checked={weekdays.includes(index)} onChange={event => setWeekdays(values => event.target.checked ? [...values, index] : values.filter(value => value !== index))} />{day}
        </label>)}
      </div></fieldset>}
      <div className="schedule-field"><label htmlFor={`schedule-zone-${conversationId}`}>时区</label>
        <Select id={`schedule-zone-${conversationId}`} editable aria-label="时区" value={zone} maxLength={100} required
          onChange={value => setZone(value.trim())} options={ZONES.map(value => ({ value, label: value }))} />
      </div>
      <label className="schedule-compact"><Checkbox checked={compact} onChange={event => setCompact(event.target.checked)} /><span>执行前压缩上下文<small>保留原始聊天记录；压缩失败则停止本次命令。</small></span></label>
      <p className="schedule-form-hint">{kind === 'interval' ? '创建、调整周期或恢复后，首次在一个完整周期后触发。' : '按照所选时区执行。夏令时中不存在的时刻跳过，重复时刻仅触发一次。'}沿用当前聊天的 Agent、模型和权限设置。</p>
      {formError && <p className="schedule-error" role="alert">{formError}</p>}
      <div className="schedule-form-actions"><button type="button" disabled={saving} onClick={() => setEditing(null)}>取消</button><button type="submit" disabled={saving}>{saving && <Loader2 size={13} className="animate-spin" />}{saving ? '保存中…' : '保存任务'}</button></div>
    </form>}
    {loading && <div className="inspector-loading" role="status"><Loader2 size={16} className="animate-spin" />正在加载定时任务…</div>}
    {!loading && !error && !items.length && !editing && <div className="schedule-empty"><Clock size={24} /><strong>让 Agent 按时帮你处理工作</strong><p>为这个聊天添加命令，每个任务都可以使用不同的周期。</p><button type="button" className="schedule-add" onClick={() => edit('new')}><Plus size={14} />创建第一个任务</button></div>}
    <div className="schedule-list">{items.map(item => <article key={item.id} className={`schedule-card ${item.enabled ? '' : 'paused'}`}>
      <div className="schedule-card-title"><strong>{item.name}</strong><span className={`schedule-status ${item.enabled ? 'enabled' : ''}`}>{item.enabled ? '已启用' : '已暂停'}</span></div>
      <div className="schedule-rule"><Clock size={12} />{describeRule(item.spec)}</div>
      <small className="schedule-timezone">{item.spec.timezone}{item.compact_before ? ' · 执行前压缩' : ''}</small>
      <p className="schedule-prompt">{item.prompt}</p>
      <dl className="schedule-details"><div><dt>下次执行</dt><dd>{item.enabled ? formatTime(item.next_run_at, item.spec.timezone) : '已暂停'}</dd></div>
        <div><dt>最近执行</dt><dd>{item.last_status ? `${taskStatusLabel(item.last_status)} · ${formatTime(item.last_run_at, item.spec.timezone)}` : '尚未执行'}</dd></div>
        {item.pending_count > 0 && <div><dt>等待执行</dt><dd>{item.pending_count} 次</dd></div>}
      </dl>
      {item.last_status === 'failed' && item.last_error && <details className="schedule-last-error"><summary>查看失败原因</summary><p>{item.last_error}</p></details>}
      <div className="schedule-card-actions">
        <button type="button" disabled={busyId !== null || saving} onClick={() => void change(item, 'run')}><Play size={12} />立即执行</button>
        <button type="button" disabled={busyId !== null || saving} onClick={() => void change(item, 'toggle')}>{item.enabled ? <Pause size={12} /> : <Play size={12} />}{item.enabled ? '暂停' : '恢复'}</button>
        <button type="button" disabled={busyId !== null || saving || editing !== null} onClick={() => edit(item)}><Pencil size={12} />编辑</button>
        <button type="button" className="destructive" aria-label={`删除定时任务 ${item.name}`} disabled={busyId !== null || saving} onClick={() => requestConfirm({
          id: `delete-schedule-${item.id}`, title: '删除定时任务', description: `删除「${item.name}」并取消它尚未开始的命令。正在执行的命令会继续完成。`,
          confirmText: '删除', variant: 'destructive', onConfirm: () => { void change(item, 'delete') },
        })}><Trash2 size={12} /></button>
      </div>
    </article>)}</div>
  </section>
}
