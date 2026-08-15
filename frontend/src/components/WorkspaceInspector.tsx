import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Bell,
  BellRing,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileDiff,
  GitBranch,
  ListChecks,
  Loader2,
  Pencil,
  Save,
  ShieldAlert,
  ShieldCheck,
  Star,
  X,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import {
  BACKGROUND_REFRESH_MS,
  CLOSE_INSPECTOR_EVENT,
  OPEN_INSPECTOR_EVENT,
  TASK_CHANGE_EVENT,
} from '../lib/appEvents'
import { describeTaskStatus, isTaskActive, taskStatusLabel } from '../lib/taskStatus'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import type {
  ConversationStats,
  TaskRecord,
  WorkspaceStatus,
} from '../lib/types'
import { useAppContext } from '../contexts/AppContext'

type InspectorTab = 'mission' | 'tasks'

/** Below this width the inspector is an overlay rather than a docked column. */
const DOCKED_BREAKPOINT = 1280

const EMPTY_STATS: ConversationStats = {
  message_count: 0,
  duration: 0,
  input_chars: 0,
  output_chars: 0,
  context_chars: 0,
  summary_count: 0,
  context_limit: 120_000,
}

const EMPTY_WORKSPACE: WorkspaceStatus = {
  is_git: false,
  branch: '',
  files: [],
  counts: {},
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

interface WorkspaceInspectorProps {
  onActiveTaskCountChange?: (count: number) => void
}

export function WorkspaceInspector({ onActiveTaskCountChange }: WorkspaceInspectorProps) {
  const {
    activeConv,
    isConnected,
    isReconnecting,
    updateConversation,
    loadConversations,
    showToast,
  } = useAppContext()
  const initialPanel = new URLSearchParams(window.location.search).get('panel')
  const [tab, setTab] = useState<InspectorTab>(initialPanel === 'tasks' ? 'tasks' : 'mission')
  const [overlayOpen, setOverlayOpen] = useState(initialPanel === 'tasks')
  const [stats, setStats] = useState<ConversationStats>(EMPTY_STATS)
  const [workspace, setWorkspace] = useState<WorkspaceStatus>(EMPTY_WORKSPACE)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskContent, setTaskContent] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => (
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  ))
  const inspectorRequestRef = useRef(0)

  const activeConversationId = activeConv?.id ?? null
  const connectionState = !activeConv
    ? 'idle'
    : isConnected
      ? 'online'
      : isReconnecting
        ? 'connecting'
        : 'offline'

  const loadInspector = useCallback(async (quiet = false) => {
    const requestId = ++inspectorRequestRef.current
    if (!quiet) setLoading(true)
    if (!activeConversationId) {
      setTasks([])
      if (requestId === inspectorRequestRef.current) setLoading(false)
      return
    }
    try {
      const [taskResponse, nextStats, nextWorkspace] = await Promise.all([
        apiFetch<{ items: TaskRecord[] }>(`/api/conversations/${activeConversationId}/tasks`),
        apiFetch<ConversationStats>(`/api/conversations/${activeConversationId}/stats`),
        apiFetch<WorkspaceStatus>(`/api/conversations/${activeConversationId}/workspace-status`),
      ])
      if (requestId !== inspectorRequestRef.current) return
      setTasks(taskResponse.items)
      setStats(nextStats)
      setWorkspace(nextWorkspace)
    } catch (error) {
      console.error(error)
    } finally {
      if (requestId === inspectorRequestRef.current) setLoading(false)
    }
  }, [activeConversationId])

  useEffect(() => {
    setStats(EMPTY_STATS)
    setWorkspace(EMPTY_WORKSPACE)
    setTasks([])
    void loadInspector()
  }, [activeConversationId, loadInspector])

  useEffect(() => {
    // Driven by task events; the timer is a slow fallback, not the mechanism.
    const refresh = () => void loadInspector(true)
    window.addEventListener(TASK_CHANGE_EVENT, refresh)
    const timer = window.setInterval(refresh, BACKGROUND_REFRESH_MS)
    return () => {
      window.removeEventListener(TASK_CHANGE_EVENT, refresh)
      window.clearInterval(timer)
    }
  }, [loadInspector])

  useEffect(() => {
    const openInspector = (event: Event) => {
      const requestedTab = (event as CustomEvent<InspectorTab>).detail
      if (requestedTab === 'mission' || requestedTab === 'tasks') {
        setTab(requestedTab)
      }
      setOverlayOpen(true)
    }
    window.addEventListener(OPEN_INSPECTOR_EVENT, openInspector)
    const closeInspector = () => {
      setOverlayOpen(false)
    }
    window.addEventListener(CLOSE_INSPECTOR_EVENT, closeInspector)
    return () => {
      window.removeEventListener(OPEN_INSPECTOR_EVENT, openInspector)
      window.removeEventListener(CLOSE_INSPECTOR_EVENT, closeInspector)
    }
  }, [])

  useEffect(() => {
    const syncPanelFromHistory = () => {
      const requestedPanel = new URLSearchParams(window.location.search).get('panel')
      if (requestedPanel === 'tasks') {
        setTab('tasks')
        setOverlayOpen(true)
      } else if (window.innerWidth < DOCKED_BREAKPOINT) {
        setOverlayOpen(false)
      }
    }
    window.addEventListener('popstate', syncPanelFromHistory)
    return () => window.removeEventListener('popstate', syncPanelFromHistory)
  }, [])

  const closeOverlay = useCallback(() => {
    setOverlayOpen(false)
    if (window.history.state?.orbitpanePanel === 'tasks') {
      window.history.back()
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('panel')
    window.history.replaceState({}, '', url.toString())
  }, [])

  /* Docked at wide widths, an overlay below that. Tracking the viewport rather
     than assuming "mobile" is what closes the 769-1279px gap where the panel
     was unreachable in either form. */
  const [isDocked, setIsDocked] = useState(() => window.innerWidth >= DOCKED_BREAKPOINT)
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DOCKED_BREAKPOINT}px)`)
    const sync = () => setIsDocked(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const isOverlay = overlayOpen && !isDocked
  const panelRef = useFocusTrap<HTMLElement>(isOverlay)

  // Only the topmost overlay reacts to Escape; the stack decides who that is.
  useEscapeLayer(isOverlay, closeOverlay)

  // The page behind an overlay must not scroll under it.
  useEffect(() => {
    if (!isOverlay) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [isOverlay])

  const activeTasks = useMemo(
    () => tasks.filter(task => isTaskActive(task.status)),
    [tasks],
  )

  useEffect(() => {
    onActiveTaskCountChange?.(activeTasks.length)
  }, [activeTasks.length, onActiveTaskCountChange])
  const contextPercent = Math.min(
    100,
    Math.round((stats.context_chars / Math.max(1, stats.context_limit || 120_000)) * 100),
  )

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showToast('当前浏览器不支持系统通知', 'warning')
      return
    }
    const permission = await Notification.requestPermission()
    setNotificationsEnabled(permission === 'granted')
    showToast(
      permission === 'granted' ? '任务完成通知已开启' : '未获得通知权限',
      permission === 'granted' ? 'success' : 'warning',
    )
  }

  const setPermissionMode = (permissionMode: 'workspace' | 'unrestricted') => {
    if (!activeConv || activeConv.permission_mode === permissionMode) return
    void updateConversation(activeConv.id, { permission_mode: permissionMode })
      .then(updated => {
        if (updated) {
          showToast(permissionMode === 'workspace' ? '已启用受限工作区' : '已启用完全访问', permissionMode === 'workspace' ? 'success' : 'warning')
        }
      })
  }

  const cancelTask = (task: TaskRecord) => {
    void apiFetch(`/api/conversations/${task.conversation_id}/queue/${task.run_id}`, {
      method: 'DELETE',
    }).then(() => {
      showToast('已取消排队任务', 'info')
      void loadInspector(true)
    }).catch(error => {
      console.error(error)
      showToast('取消任务失败', 'error')
    })
  }

  const saveTask = (task: TaskRecord) => {
    const content = taskContent.trim()
    if (!content) {
      showToast('任务内容不能为空', 'warning')
      return
    }
    void apiFetch(`/api/conversations/${task.conversation_id}/queue/${task.run_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }).then(() => {
      setEditingTaskId(null)
      showToast('排队任务已更新')
      void loadInspector(true)
    }).catch(error => {
      console.error(error)
      showToast('更新排队任务失败', 'error')
    })
  }

  const moveTask = (task: TaskRecord, direction: -1 | 1) => {
    const queue = tasks
      .filter(item => item.conversation_id === task.conversation_id && item.status === 'queued')
      .sort((left, right) => (left.position || 0) - (right.position || 0))
    const index = queue.findIndex(item => item.run_id === task.run_id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= queue.length) return
    const reordered = [...queue]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    void apiFetch(`/api/conversations/${task.conversation_id}/queue`, {
      method: 'PUT',
      body: JSON.stringify({ run_ids: reordered.map(item => item.run_id) }),
    }).then(() => {
      showToast('任务顺序已调整', 'info')
      void loadInspector(true)
    }).catch(error => {
      console.error(error)
      showToast('调整任务顺序失败', 'error')
    })
  }

  return (
    <>
      {isOverlay && (
        <button
          type="button"
          className="inspector-scrim open"
          aria-label="关闭任务面板"
          onClick={closeOverlay}
        />
      )}
      <aside
        ref={panelRef}
        className={`workspace-inspector ${overlayOpen ? 'mobile-open' : ''}`}
        aria-label="任务与上下文面板"
        role={isOverlay ? 'dialog' : undefined}
        aria-modal={isOverlay ? true : undefined}
      >
      <div className="inspector-header">
        <div>
          <span className="inspector-eyebrow">ORBIT CONTROL</span>
          <h2>任务与上下文</h2>
        </div>
        <div className="inspector-header-actions">
          <button
            className={`icon-btn ${notificationsEnabled ? 'notification-enabled' : ''}`}
            onClick={requestNotifications}
            title="任务完成通知"
            aria-label="设置任务完成通知"
          >
            {notificationsEnabled ? <BellRing size={15} /> : <Bell size={15} />}
          </button>
          <button className="icon-btn inspector-mobile-close" onClick={closeOverlay} aria-label="关闭任务面板">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'mission'}
          className={tab === 'mission' ? 'active' : ''}
          onClick={() => setTab('mission')}
        >
          <CircleDot size={13} />概览
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tasks'}
          className={tab === 'tasks' ? 'active' : ''}
          onClick={() => setTab('tasks')}
        >
          <ListChecks size={13} />队列{activeTasks.length > 0 && <b>{activeTasks.length}</b>}
        </button>
      </div>

      <div className="inspector-body">
        {loading && <div className="inspector-loading"><Loader2 className="animate-spin" size={18} />同步任务状态…</div>}

        {!loading && tab === 'mission' && (
          <>
            <section className="inspector-card mission-status-card">
              <div className="inspector-card-title">
                <span><Bot size={14} />当前项目</span>
                <span className={`connection-chip ${connectionState}`}>
                  {connectionState === 'online' ? '已连接' : connectionState === 'connecting' ? '连接中' : connectionState === 'offline' ? '连接断开' : '待连接'}
                </span>
              </div>
              {activeConv ? (
                <>
                  <strong className="mission-project-name">{activeConv.name}</strong>
                  <span className="mission-project-path">{activeConv.path}</span>
                  <div className="project-organize-row">
                    <button
                      className={activeConv.is_pinned ? 'active' : ''}
                      onClick={() => void updateConversation(activeConv.id, { is_pinned: !activeConv.is_pinned })}
                    ><Star size={12} fill={activeConv.is_pinned ? 'currentColor' : 'none'} />星标</button>
                    <button
                      onClick={() => void updateConversation(activeConv.id, { is_archived: true }).then(() => {
                        void loadConversations(false)
                      })}
                    ><Archive size={12} />归档</button>
                  </div>
                  <div className="project-permission-setting">
                    <span>文件系统权限</span>
                    <div role="radiogroup" aria-label="当前项目文件系统权限">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={activeConv.permission_mode === 'workspace'}
                        className={activeConv.permission_mode === 'workspace' ? 'active' : ''}
                        disabled={activeTasks.length > 0}
                        onClick={() => setPermissionMode('workspace')}
                      ><ShieldCheck size={11} />受限</button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={activeConv.permission_mode === 'unrestricted'}
                        className={`danger ${activeConv.permission_mode === 'unrestricted' ? 'active' : ''}`}
                        disabled={activeTasks.length > 0}
                        onClick={() => setPermissionMode('unrestricted')}
                      ><ShieldAlert size={11} />完全访问</button>
                    </div>
                    {activeTasks.length > 0 && <small>任务运行或排队时不能修改</small>}
                  </div>
                </>
              ) : <p className="inspector-empty">选择项目后显示上下文。</p>}
            </section>

            {activeConv && (
              <section className="inspector-card context-halo-card">
                <div className="context-halo" style={{ background: `conic-gradient(var(--accent-color) ${contextPercent}%, var(--bg-surface-hover) 0)` }}>
                  <div><strong>{contextPercent}%</strong><span>上下文</span></div>
                </div>
                <div className="context-metrics">
                  <div><span>当前上下文</span><strong>{formatCompact(stats.context_chars)} 字</strong></div>
                  <div><span>累计输出</span><strong>{formatCompact(stats.output_chars)} 字</strong></div>
                  <div><span>执行耗时</span><strong>{stats.duration.toFixed(1)} 秒</strong></div>
                  <div><span>消息 / 总结</span><strong>{stats.message_count} / {stats.summary_count}</strong></div>
                </div>
              </section>
            )}

            {activeConv && (
              <section className="inspector-card change-radar-card">
                <div className="inspector-card-title">
                  <span><FileDiff size={14} />变更雷达</span>
                  {workspace.is_git && <span className="branch-chip"><GitBranch size={11} />{workspace.branch || 'detached'}</span>}
                </div>
                {!workspace.is_git ? (
                  <p className="inspector-empty">当前目录不是 Git 工作区。</p>
                ) : workspace.files.length === 0 ? (
                  <div className="clean-worktree"><CheckCircle2 size={16} />工作树干净</div>
                ) : (
                  <div className="change-file-list">
                    {workspace.files.slice(0, 12).map(file => (
                      <div key={`${file.code}-${file.path}`} className={`change-file ${file.status}`}>
                        <span className="change-code">{file.code}</span>
                        <span title={file.path}>{file.path}</span>
                      </div>
                    ))}
                    {workspace.files.length > 12 && <small>另有 {workspace.files.length - 12} 个变更文件</small>}
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {!loading && tab === 'tasks' && (
          <section className="task-center-list">
            {!activeConv ? <p className="inspector-empty">选择项目后显示该项目的任务队列。</p> : tasks.length === 0 ? <p className="inspector-empty">当前项目还没有任务记录。</p> : tasks.slice(0, 30).map(task => (
              <article key={task.run_id} className={`task-center-item ${task.status}`}>
                <div className="task-state-icon">
                  {(() => {
                    const { Icon, animated } = describeTaskStatus(task.status)
                    return <Icon size={14} className={animated ? 'animate-spin' : undefined} />
                  })()}
                </div>
                <div className="task-center-copy">
                  <div><strong>{task.conversation_name}</strong><span>{taskStatusLabel(task.status)}</span></div>
                  {editingTaskId === task.run_id ? (
                    <textarea
                      className="task-edit-input"
                      value={taskContent}
                      onChange={event => setTaskContent(event.target.value)}
                      aria-label="编辑排队任务"
                    />
                  ) : <p>{task.is_summary ? '生成对话总结' : task.prompt}</p>}
                  <small>{task.model} · {task.duration ? `${task.duration.toFixed(1)} 秒` : '等待执行'}</small>
                </div>
                {task.status === 'queued' && (
                  <div className="task-queue-actions">
                    {editingTaskId === task.run_id ? (
                      <button onClick={() => saveTask(task)} title="保存任务"><Save size={12} /></button>
                    ) : (
                      <button onClick={() => { setEditingTaskId(task.run_id); setTaskContent(task.prompt) }} title="编辑任务"><Pencil size={12} /></button>
                    )}
                    <button onClick={() => moveTask(task, -1)} disabled={task.position === 1} title="任务前移"><ChevronUp size={12} /></button>
                    <button
                      onClick={() => moveTask(task, 1)}
                      disabled={task.position === tasks.filter(item => item.conversation_id === task.conversation_id && item.status === 'queued').length}
                      title="任务后移"
                    ><ChevronDown size={12} /></button>
                    <button className="task-cancel-btn" onClick={() => cancelTask(task)} title="取消排队"><X size={13} /></button>
                  </div>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
      </aside>
    </>
  )
}
