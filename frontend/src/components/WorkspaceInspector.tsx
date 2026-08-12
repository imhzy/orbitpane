import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Bell,
  BellRing,
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  FileDiff,
  GitBranch,
  ListChecks,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  Tags,
  X,
  XCircle,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import type {
  ConversationStats,
  SummaryCheckpoint,
  TaskRecord,
  WorkspaceStatus,
} from '../lib/types'
import { useAppContext } from '../contexts/AppContext'

type InspectorTab = 'mission' | 'tasks' | 'memory'

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

function taskLabel(status: TaskRecord['status']): string {
  return {
    queued: '等待中',
    starting: '启动中',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
    canceled: '已取消',
  }[status]
}

export function WorkspaceInspector() {
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
  const [mobileOpen, setMobileOpen] = useState(initialPanel === 'tasks')
  const [stats, setStats] = useState<ConversationStats>(EMPTY_STATS)
  const [workspace, setWorkspace] = useState<WorkspaceStatus>(EMPTY_WORKSPACE)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [summaries, setSummaries] = useState<SummaryCheckpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [tagText, setTagText] = useState('')
  const [editingSummaryId, setEditingSummaryId] = useState<number | null>(null)
  const [summaryTitle, setSummaryTitle] = useState('')
  const [summaryContent, setSummaryContent] = useState('')
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskContent, setTaskContent] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => (
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  ))
  const inspectorRequestRef = useRef(0)

  const activeConversationId = activeConv?.id ?? null
  const activeTagSignature = activeConv?.tags.join(', ') ?? ''
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
      const [taskResponse, nextStats, nextWorkspace, nextSummaries] = await Promise.all([
        apiFetch<{ items: TaskRecord[] }>(`/api/conversations/${activeConversationId}/tasks`),
        apiFetch<ConversationStats>(`/api/conversations/${activeConversationId}/stats`),
        apiFetch<WorkspaceStatus>(`/api/conversations/${activeConversationId}/workspace-status`),
        apiFetch<SummaryCheckpoint[]>(`/api/conversations/${activeConversationId}/summaries`),
      ])
      if (requestId !== inspectorRequestRef.current) return
      setTasks(taskResponse.items)
      setStats(nextStats)
      setWorkspace(nextWorkspace)
      setSummaries(nextSummaries)
    } catch (error) {
      console.error(error)
    } finally {
      if (requestId === inspectorRequestRef.current) setLoading(false)
    }
  }, [activeConversationId])

  useEffect(() => {
    setTagText(activeTagSignature)
    setStats(EMPTY_STATS)
    setWorkspace(EMPTY_WORKSPACE)
    setTasks([])
    setSummaries([])
    setEditingSummaryId(null)
    void loadInspector()
  }, [activeConversationId, activeTagSignature, loadInspector])

  useEffect(() => {
    const refresh = () => void loadInspector(true)
    window.addEventListener('orbitpane-task-change', refresh)
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      window.removeEventListener('orbitpane-task-change', refresh)
      window.clearInterval(timer)
    }
  }, [loadInspector])

  useEffect(() => {
    const openInspector = (event: Event) => {
      const requestedTab = (event as CustomEvent<InspectorTab>).detail
      if (requestedTab === 'mission' || requestedTab === 'tasks' || requestedTab === 'memory') {
        setTab(requestedTab)
      }
      setMobileOpen(true)
    }
    window.addEventListener('orbitpane-open-inspector', openInspector)
    return () => window.removeEventListener('orbitpane-open-inspector', openInspector)
  }, [])

  const closeMobileInspector = () => {
    setMobileOpen(false)
    const url = new URL(window.location.href)
    url.searchParams.delete('panel')
    window.history.replaceState({}, '', url.toString())
  }

  const activeTasks = useMemo(() => tasks.filter(task => (
    ['queued', 'starting', 'running'].includes(task.status)
  )), [tasks])
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

  const saveTags = () => {
    if (!activeConv) return
    const tags = tagText.split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 20)
    if (tags.join('|') === activeConv.tags.join('|')) return
    void updateConversation(activeConv.id, { tags })
      .then(updated => {
        if (updated) showToast('项目标签已保存')
      })
  }

  const updateSummary = (
    summary: SummaryCheckpoint,
    values: Partial<Pick<SummaryCheckpoint, 'active' | 'title' | 'content'>>,
  ) => {
    void apiFetch<SummaryCheckpoint>(
      `/api/conversations/${summary.conversation_id}/summaries/${summary.id}`,
      { method: 'PATCH', body: JSON.stringify(values) },
    ).then(() => {
      showToast(values.active === false ? '已恢复完整历史上下文' : '记忆检查点已更新')
      void loadInspector(true)
      void loadConversations(false)
    }).catch(error => {
      console.error(error)
      showToast('记忆检查点更新失败', 'error')
    })
  }

  const beginSummaryEdit = (summary: SummaryCheckpoint) => {
    setEditingSummaryId(summary.id)
    setSummaryTitle(summary.title)
    setSummaryContent(summary.content)
  }

  const saveSummary = (summary: SummaryCheckpoint) => {
    const title = summaryTitle.trim()
    const content = summaryContent.trim()
    if (!title || !content) {
      showToast('标题和记忆内容不能为空', 'warning')
      return
    }
    updateSummary(summary, { title, content })
    setEditingSummaryId(null)
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
    <aside className={`workspace-inspector ${mobileOpen ? 'mobile-open' : ''}`} aria-label="任务与上下文面板">
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
          <button className="icon-btn inspector-mobile-close" onClick={closeMobileInspector} aria-label="关闭任务中心">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-tabs" role="tablist">
        <button className={tab === 'mission' ? 'active' : ''} onClick={() => setTab('mission')}>
          <CircleDot size={13} />任务舱
        </button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          <ListChecks size={13} />队列{activeTasks.length > 0 && <b>{activeTasks.length}</b>}
        </button>
        <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
          <Braces size={13} />记忆
        </button>
      </div>

      <div className="inspector-body">
        {loading && <div className="inspector-loading"><Loader2 className="animate-spin" size={18} />同步任务状态…</div>}

        {!loading && tab === 'mission' && (
          <>
            <section className="inspector-card mission-status-card">
              <div className="inspector-card-title">
                <span><Bot size={14} />当前任务舱</span>
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
                  <label className="tag-editor">
                    <Tags size={12} />
                    <input
                      value={tagText}
                      onChange={event => setTagText(event.target.value)}
                      onBlur={saveTags}
                      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
                      placeholder="标签，以逗号分隔"
                    />
                  </label>
                </>
              ) : <p className="inspector-empty">选择项目后显示任务上下文。</p>}
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
                  <div><span>消息 / 记忆</span><strong>{stats.message_count} / {stats.summary_count}</strong></div>
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
                  {['running', 'starting'].includes(task.status) && <Loader2 className="animate-spin" size={14} />}
                  {task.status === 'queued' && <Clock3 size={14} />}
                  {task.status === 'completed' && <CheckCircle2 size={14} />}
                  {['failed', 'interrupted', 'canceled'].includes(task.status) && <XCircle size={14} />}
                </div>
                <div className="task-center-copy">
                  <div><strong>{task.conversation_name}</strong><span>{taskLabel(task.status)}</span></div>
                  {editingTaskId === task.run_id ? (
                    <textarea
                      className="task-edit-input"
                      value={taskContent}
                      onChange={event => setTaskContent(event.target.value)}
                      aria-label="编辑排队任务"
                    />
                  ) : <p>{task.is_summary ? '生成记忆检查点' : task.prompt}</p>}
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

        {!loading && tab === 'memory' && (
          <section className="memory-checkpoints">
            {!activeConv ? <p className="inspector-empty">选择项目后管理记忆。</p> : summaries.length === 0 ? (
              <div className="inspector-empty memory-empty">
                <Sparkles size={20} />
                <span>尚未生成记忆检查点</span>
                <small>在顶部操作中选择“总结”即可创建。</small>
              </div>
            ) : summaries.map(summary => (
              <article key={summary.id} className={`memory-card ${summary.active ? 'active' : ''}`}>
                <div className="memory-card-head">
                  <div>
                    {editingSummaryId === summary.id ? (
                      <input
                        className="memory-title-input"
                        value={summaryTitle}
                        onChange={event => setSummaryTitle(event.target.value)}
                        aria-label="记忆检查点标题"
                      />
                    ) : <strong>{summary.title}</strong>}
                    <small>覆盖至消息 #{summary.covered_through_id}</small>
                  </div>
                  <span>{summary.active ? '使用中' : '已保留'}</span>
                </div>
                {editingSummaryId === summary.id ? (
                  <textarea
                    className="memory-content-input"
                    value={summaryContent}
                    onChange={event => setSummaryContent(event.target.value)}
                    aria-label="记忆检查点内容"
                  />
                ) : <p>{summary.content}</p>}
                <div className="memory-card-actions">
                  {editingSummaryId === summary.id ? (
                    <button onClick={() => saveSummary(summary)}><Save size={12} />保存记忆</button>
                  ) : (
                    <button onClick={() => beginSummaryEdit(summary)}><Pencil size={12} />编辑</button>
                  )}
                  <button onClick={() => updateSummary(summary, { active: !summary.active })}>
                    <RotateCcw size={12} />{summary.active ? '恢复完整历史' : '启用'}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}
