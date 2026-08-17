import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Pin,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { BACKGROUND_REFRESH_MS, TASK_CHANGE_EVENT } from '../lib/appEvents'
import { describeTaskStatus, isTaskRunning, taskStatusLabel } from '../lib/taskStatus'
import { hasProviderChoice } from '../lib/providers'
import { useAppContext } from '../contexts/AppContext'
import type { Conversation, TaskRecord } from '../lib/types'

interface MissionControlProps {
  conversations: Conversation[]
  onSelect: (conversation: Conversation) => void
  /** Opens the create-project drawer. This panel is the app's landing view, so
   *  the primary action lives in its header rather than in a separate hero. */
  onCreate?: () => void
}

type MissionFilter = 'all' | 'running' | 'queued' | 'attention'

const VISIBLE_PROJECT_LIMIT = 6

const MISSION_FILTERS: ReadonlyArray<{ id: MissionFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: taskStatusLabel('running') },
  { id: 'queued', label: taskStatusLabel('queued') },
  { id: 'attention', label: taskStatusLabel('failed') },
]

function taskTimestamp(task?: TaskRecord): string | undefined {
  return task?.completed_at || task?.started_at || task?.queued_at
}

function formatRelativeTime(value?: string): string {
  if (!value) return '暂无任务记录'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return '最近有活动'

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚更新'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp)
}

export function MissionControl({ conversations, onSelect, onCreate }: MissionControlProps) {
  const { providers, getProviderBadge } = useAppContext()
  /** Provider display name; the raw id ("antigravity") is an internal detail. */
  const providerName = (id?: string) => getProviderBadge(id, providers).text
  const showProvider = hasProviderChoice(providers)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [activeFilter, setActiveFilter] = useState<MissionFilter>('all')
  const [isExpanded, setIsExpanded] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [syncFailed, setSyncFailed] = useState(false)
  const mountedRef = useRef(true)
  const requestInFlightRef = useRef(false)

  const loadTasks = useCallback(async () => {
    if (requestInFlightRef.current) return
    requestInFlightRef.current = true
    if (mountedRef.current) setIsRefreshing(true)
    try {
      const data = await apiFetch<{ items: TaskRecord[] }>('/api/tasks?limit=80')
      if (mountedRef.current) {
        setTasks(data.items)
        setSyncFailed(false)
      }
    } catch (error) {
      console.error(error)
      if (mountedRef.current) setSyncFailed(true)
    } finally {
      requestInFlightRef.current = false
      if (mountedRef.current) setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadTasks()
    // Task events drive this; the interval is only a safety net for changes
    // that happen without a socket event reaching this tab.
    const timer = window.setInterval(() => void loadTasks(), BACKGROUND_REFRESH_MS)
    const handleTaskChange = () => void loadTasks()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void loadTasks()
    }
    window.addEventListener(TASK_CHANGE_EVENT, handleTaskChange)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
      window.removeEventListener(TASK_CHANGE_EVENT, handleTaskChange)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadTasks])

  const recentTasks = useMemo(() => {
    const latest = new Map<number, TaskRecord>()
    tasks.forEach(task => {
      if (!latest.has(task.conversation_id)) latest.set(task.conversation_id, task)
    })
    return latest
  }, [tasks])

  const projects = useMemo(() => conversations
    .filter(conversation => !conversation.is_archived)
    .sort((left, right) => {
      const statusPriority = (conversation: Conversation) => {
        const status = recentTasks.get(conversation.id)?.status
        if (status === 'failed') return 0
        if (isTaskRunning(status)) return 1
        if (status === 'queued') return 2
        if (status === 'completed') return 3
        if (status === 'interrupted' || status === 'canceled') return 4
        return 5
      }
      const priorityDifference = statusPriority(left) - statusPriority(right)
      if (priorityDifference !== 0) return priorityDifference
      if (left.is_pinned !== right.is_pinned) return left.is_pinned ? -1 : 1
      const leftActivity = taskTimestamp(recentTasks.get(left.id)) || left.created_at
      const rightActivity = taskTimestamp(recentTasks.get(right.id)) || right.created_at
      return new Date(rightActivity).getTime() - new Date(leftActivity).getTime()
    }), [conversations, recentTasks])

  if (projects.length === 0) return null

  const runningCount = projects.filter(conversation => {
    return isTaskRunning(recentTasks.get(conversation.id)?.status)
  }).length
  const queuedCount = projects.filter(conversation => recentTasks.get(conversation.id)?.status === 'queued').length
  const attentionCount = projects.filter(conversation => recentTasks.get(conversation.id)?.status === 'failed').length
  const filterCounts: Record<MissionFilter, number> = {
    all: projects.length,
    running: runningCount,
    queued: queuedCount,
    attention: attentionCount,
  }

  const filteredProjects = projects.filter(conversation => {
    const status = recentTasks.get(conversation.id)?.status
    if (activeFilter === 'running') return isTaskRunning(status)
    if (activeFilter === 'queued') return status === 'queued'
    if (activeFilter === 'attention') return status === 'failed'
    return true
  })
  const visibleProjects = isExpanded
    ? filteredProjects
    : filteredProjects.slice(0, VISIBLE_PROJECT_LIMIT)
  const hiddenProjectCount = filteredProjects.length - visibleProjects.length

  const selectFilter = (filter: MissionFilter) => {
    setActiveFilter(filter)
    setIsExpanded(false)
  }

  const statusIcon = (status?: TaskRecord['status']) => {
    const { Icon, animated } = describeTaskStatus(status)
    return <Icon size={14} className={animated ? 'animate-spin' : undefined} />
  }

  return (
    <section className="mission-control" aria-label="项目任务总览">
      {/* A screen with no top of its hierarchy reads as a fragment. The
          masthead is the one place on this view that gets display type, and
          the one filled button on it is the action the view exists for. */}
      <header className="mission-masthead">
        <div className="mission-masthead-copy">
          <h1 className="mission-masthead-title">项目</h1>
          <p className="mission-masthead-sub">
            <span>{projects.length} 个工作区</span>
            <span className="mission-sub-sep" aria-hidden="true" />
            <span className={`mission-sync-state ${syncFailed ? 'failed' : ''}`}>
              <i />{syncFailed ? '同步失败' : isRefreshing ? '同步中' : '实时同步'}
            </span>
          </p>
        </div>
        <div className="mission-masthead-actions">
          <button
            type="button"
            className="ui-btn ghost icon-only"
            onClick={() => void loadTasks()}
            disabled={isRefreshing}
            aria-label="刷新项目任务状态"
            title="刷新状态"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          {onCreate && (
            <button type="button" className="ui-btn primary" onClick={onCreate}>
              <Plus size={14} />新建项目
            </button>
          )}
        </div>
      </header>

      {/* These are filters, and they were dressed as a four-tile KPI strip:
          three of the four normally read zero, each in its own tinted colour,
          on a landing screen whose real content is the project list below. As
          chips they say the same thing in one line and stop competing with it. */}
      <div className="mission-filters" role="group" aria-label="按任务状态筛选项目">
        {MISSION_FILTERS.map(({ id, label }) => {
          const count = filterCounts[id]
          return (
            <button
              key={id}
              type="button"
              aria-pressed={activeFilter === id}
              className={`${activeFilter === id ? 'active ' : ''}${id === 'attention' && count > 0 ? 'attention' : ''}`}
              onClick={() => selectFilter(id)}
            >
              {label}
              <b>{count}</b>
            </button>
          )
        })}
      </div>

      {/* One row per project, one row height, one alignment grid. The previous
          two-column card deck gave every project a box of its own, so four
          projects produced eight vertical edges the eye had to resolve before
          it could read a single name. */}
      <div className="mission-project-list">
        {visibleProjects.map(conversation => {
          const task = recentTasks.get(conversation.id)
          const status = task?.status
          return (
            <button
              type="button"
              key={conversation.id}
              className={`mission-project-row ${status || 'idle'}`}
              onClick={() => onSelect(conversation)}
              aria-label={`打开项目 ${conversation.name}，${taskStatusLabel(status)}`}
            >
              <span className="mission-row-status" aria-hidden="true">{statusIcon(status)}</span>
              <span className="mission-row-identity">
                <span className="mission-row-name">
                  <strong>{conversation.name}</strong>
                  {conversation.is_pinned && <Pin size={11} aria-label="已置顶" />}
                </span>
                <span className="mission-row-path" title={conversation.path}>{conversation.path}</span>
              </span>
              <span className="mission-row-meta">
                <span className={`mission-status-label ${status || 'idle'}`}>{taskStatusLabel(status)}</span>
                <small>
                  {showProvider && `${providerName(task?.provider || conversation.provider)} · `}
                  {formatRelativeTime(taskTimestamp(task))}
                </small>
              </span>
              <span className="mission-row-open" aria-hidden="true"><ArrowUpRight size={15} /></span>
            </button>
          )
        })}

        {filteredProjects.length === 0 && (
          <div className="mission-empty-state">
            <CheckCircle2 size={18} />
            <span><strong>这个队列目前是空的</strong><small>没有项目处于该状态</small></span>
            <button type="button" className="ui-btn ghost" onClick={() => selectFilter('all')}>查看全部</button>
          </div>
        )}
      </div>

      {filteredProjects.length > VISIBLE_PROJECT_LIMIT && (
        <button type="button" className="mission-expand-button" onClick={() => setIsExpanded(value => !value)}>
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {isExpanded ? '收起项目' : `再显示 ${hiddenProjectCount} 个项目`}
        </button>
      )}
    </section>
  )
}
