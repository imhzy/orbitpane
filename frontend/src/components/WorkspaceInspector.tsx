import { PanelResizeHandle } from './PanelResizeHandle'
import { usePanelWidth } from '../hooks/usePanelWidth'
import { WorkspaceDiff } from './WorkspaceDiff'
import { ReaderDialog } from './ReaderDialog'
import MarkdownContent from './MarkdownContent'
import { readJson, writeJson } from '../lib/storage'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
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
  ShieldCheck,
  X,
  Clock,
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
import { Textarea } from './FormControls'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import type {
  ConversationStats,
  TaskRecord,
  WorkspaceStatus,
} from '../lib/types'
import { useAppContext } from '../contexts/AppContext'
import { SchedulePanel } from './SchedulePanel'

type InspectorTab = 'mission' | 'tasks' | 'schedules'

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
    openSettings,
    settingsSection,
    showToast, messages, drawerMode, isDrawerOpen,
  } = useAppContext()
  const panel = usePanelWidth('orbitpane_inspector_width', 340, 300, 480)
  const [collapsed, setCollapsed] = useState(() => new URLSearchParams(window.location.search).has('panel') ? false : readJson('orbitpane_inspector_collapsed', false))
  const [showSchedules, setShowSchedules] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [workspaceError, setWorkspaceError] = useState(false)
  const [syncError, setSyncError] = useState(false)
  const initialPanel = new URLSearchParams(window.location.search).get('panel')
  const [tab, setTab] = useState<InspectorTab>(initialPanel === 'schedules' ? 'schedules' : initialPanel === 'tasks' ? 'tasks' : 'mission')
  const [overlayOpen, setOverlayOpen] = useState(initialPanel === 'tasks' || initialPanel === 'schedules')
  const [stats, setStats] = useState<ConversationStats>(EMPTY_STATS)
  /** `null` until this project's git status has answered. */
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskContent, setTaskContent] = useState('')
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
    const isCurrent = () => requestId === inspectorRequestRef.current
    if (!quiet) setLoading(true)
    if (!activeConversationId) {
      setTasks([])
      if (isCurrent()) setLoading(false)
      return
    }
    const base = `/api/conversations/${activeConversationId}`
    // Git status shells out to `git`, which can take seconds on a large
    // repository. Awaited together with the other two, it kept the whole panel
    // on its spinner until git finished, and a git failure threw the task list
    // and the stats away with it. It now lands on its own, into its own card.
    void apiFetch<WorkspaceStatus>(`${base}/workspace-status`)
      .then(next => { if (isCurrent()) { setWorkspace(next); setWorkspaceError(false) } })
      .catch(error => {
        console.error(error)
        if (isCurrent()) setWorkspaceError(true)
      })
    const results = await Promise.allSettled([
      apiFetch<{ items: TaskRecord[] }>(`${base}/tasks`)
        .then(response => { if (isCurrent()) setTasks(response.items) }),
      apiFetch<ConversationStats>(`${base}/stats`)
        .then(next => { if (isCurrent()) setStats(next) }),
    ])
    if (isCurrent()) setSyncError(results.some(result => result.status === 'rejected'))
    for (const result of results) {
      if (result.status === 'rejected') console.error(result.reason)
    }
    if (isCurrent()) setLoading(false)
  }, [activeConversationId])

  useEffect(() => {
    setStats(EMPTY_STATS)
    setWorkspace(null)
    setWorkspaceError(false)
    setShowSchedules(false)
    setShowDiff(false)
    setShowResult(false)
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
      if (requestedTab === 'mission' || requestedTab === 'tasks' || requestedTab === 'schedules') {
        setTab(requestedTab)
      }
      setCollapsed(false)
      writeJson('orbitpane_inspector_collapsed', false)
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
      if (requestedPanel === 'tasks' || requestedPanel === 'schedules' || requestedPanel === 'mission') {
        setTab(requestedPanel)
        setCollapsed(false)
      writeJson('orbitpane_inspector_collapsed', false)
      setOverlayOpen(true)
      } else if (window.innerWidth < DOCKED_BREAKPOINT) {
        setOverlayOpen(false)
      }
    }
    window.addEventListener('popstate', syncPanelFromHistory)
    return () => window.removeEventListener('popstate', syncPanelFromHistory)
  }, [])

  const closeOverlay = useCallback(() => {
    setCollapsed(true)
    writeJson('orbitpane_inspector_collapsed', true)
    setOverlayOpen(false)
    if (['tasks', 'schedules', 'mission'].includes(window.history.state?.orbitpanePanel)) {
      window.history.back()
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('panel')
    window.history.replaceState({}, '', url.toString())
  }, [])

  const selectTab = (next: InspectorTab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (url.searchParams.has('panel')) {
      url.searchParams.set('panel', next)
      window.history.replaceState(window.history.state, '', url.toString())
    }
  }

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

  const isOverlay = overlayOpen && !isDocked && !settingsSection
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
      {/* The docked column has nothing to show before a project is open, and a
          460px panel whose only content is "选择项目后显示上下文。" made the
          landing view read as a layout waiting for data rather than a screen. */}
      <aside
        ref={panelRef}
        className={`workspace-inspector ${overlayOpen ? 'mobile-open' : ''} ${activeConv ? '' : 'inspector-idle'} ${collapsed ? 'inspector-collapsed' : ''}`}
        id="task-inspector"
        style={{ '--inspector-width': `${panel.width}px` } as React.CSSProperties}
        inert={isDrawerOpen && drawerMode === 'create'}
        aria-label="任务与上下文面板"
        role={isOverlay ? 'dialog' : undefined}
        aria-modal={isOverlay ? true : undefined}
      >
      <PanelResizeHandle panel={panel} label="任务面板宽度" controls="task-inspector" reverse onCollapse={closeOverlay} />
      <div className="inspector-header">
        <div>
          <h2>会话任务</h2>
        </div>
        <div className="inspector-header-actions">
          <button className="icon-btn inspector-mobile-close" onClick={closeOverlay} aria-label="关闭任务面板">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="会话任务分类" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
        buttons[next]?.click()
      }}>
        <button
          role="tab" id="inspector-mission" aria-controls="inspector-content" tabIndex={tab === 'mission' ? 0 : -1}
          aria-selected={tab === 'mission'}
          className={tab === 'mission' ? 'active' : ''}
          onClick={() => selectTab('mission')}
        >
          <CircleDot size={13} />进展与结果
        </button>
        <button
          role="tab" id="inspector-tasks" aria-controls="inspector-content" tabIndex={tab === 'tasks' ? 0 : -1}
          aria-selected={tab === 'tasks'}
          className={tab === 'tasks' ? 'active' : ''}
          onClick={() => selectTab('tasks')}
        >
          <ListChecks size={13} />任务记录{activeTasks.length > 0 && <b>{activeTasks.length}</b>}
        </button>
        <button role="tab" id="inspector-schedules" aria-controls="inspector-content" tabIndex={tab === 'schedules' ? 0 : -1} aria-selected={tab === 'schedules'} className={tab === 'schedules' ? 'active' : ''}
          onClick={() => selectTab('schedules')}><Clock size={13} />定时</button>
      </div>

      <div className="inspector-body" id="inspector-content" role="tabpanel" aria-labelledby={`inspector-${tab}`} tabIndex={0}>
        {syncError && <div role="status" className="inspector-sync-error">部分状态同步失败。<button className="ui-btn ghost" onClick={() => void loadInspector()}>重试</button></div>}
        {loading && tab !== 'schedules' && <div className="inspector-loading"><Loader2 className="animate-spin" size={18} />同步任务状态…</div>}

        {tab === 'schedules' && (activeConv ? <><button className="ui-btn secondary" onClick={() => setShowSchedules(true)}>展开定时任务管理</button>{!showSchedules && <SchedulePanel key={activeConv.id} conversationId={activeConv.id} />}</> : <p className="inspector-empty">选择聊天后管理它的定时任务。</p>)}

        {!loading && tab === 'mission' && (
          <>
            <section className="inspector-card task-outcome-card">
              <h3>{activeTasks.length > 0 ? '当前执行' : '最近结果'}</h3>
              <p>{(activeTasks[0] || tasks[0])?.prompt || '发送消息，开始第一个任务。'}</p>
              {(activeTasks[0] || tasks[0]) && <strong>{taskStatusLabel((activeTasks[0] || tasks[0]).status)}</strong>}
              {(activeTasks[0] || tasks[0])?.error && <p className="home-task-error">{(activeTasks[0] || tasks[0]).error}</p>}
              <div className="outcome-actions"><button className="ui-btn secondary" onClick={() => selectTab('tasks')}>查看任务记录</button>
                <button className="ui-btn secondary" disabled={!messages.some(message => message.role === 'agent' && !message.isThinking && message.content)} onClick={() => setShowResult(true)}>阅读最近回复</button></div>
              <small>执行完成表示 Agent 已结束运行；测试与验收结论以回复中的实际记录为准。</small>
            </section>
            <section className="inspector-card mission-status-card">
              <div className="inspector-card-title">
                <span><Bot size={14} />当前会话</span>
                <span className={`connection-chip ${connectionState}`}>
                  {connectionState === 'online' ? '已连接' : connectionState === 'connecting' ? '连接中' : connectionState === 'offline' ? '连接断开' : '待连接'}
                </span>
              </div>
              {activeConv ? (
                <>
                  <strong className="mission-project-name">{activeConv.name}</strong>
                  <span className="mission-project-path">{activeConv.path}</span>
                  <button type="button" className="inspector-project-settings" onClick={() => openSettings('project', activeConv.id)}>
                    <ShieldCheck size={13} />{activeConv.permission_mode === 'workspace' ? '受限工作区' : '完全访问'}<span>会话设置 →</span>
                  </button>
                </>
              ) : <p className="inspector-empty">选择项目后显示上下文。</p>}
            </section>

            {activeConv && (
              <section className="inspector-card context-card">
                {/* An 80px conic-gradient dial was the largest thing in this
                    panel and spent all of it on one percentage that normally
                    reads in single digits. A meter states the same value in a
                    tenth of the space and lines up with the figures below. */}
                <div className="context-meter">
                  <div className="context-meter-label">
                    <span>上下文用量</span>
                    <strong>{contextPercent}%</strong>
                  </div>
                  <div
                    className="context-meter-track"
                    role="progressbar"
                    aria-valuenow={contextPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="上下文用量"
                  >
                    <i style={{ width: `${Math.max(contextPercent, 1)}%` }} />
                  </div>
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
                  <span><FileDiff size={14} />未提交改动</span>
                  {workspace?.is_git && <span className="branch-chip"><GitBranch size={11} />{workspace.branch || 'detached'}</span>}
                </div>
                {workspaceError ? <p role="status">Git 状态读取失败。<button className="ui-btn ghost" onClick={() => void loadInspector(true)}>重试</button></p> : workspace === null ? (
                  <p className="inspector-empty">正在读取 Git 状态…</p>
                ) : !workspace.is_git ? (
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
                {workspace?.is_git && <button className="ui-btn secondary" onClick={() => setShowDiff(true)}>展开文件差异</button>}
                <small className="reader-note">当前工作区改动，可能来自多个会话或手动编辑。</small>
              </section>
            )}
          </>
        )}

        {!loading && tab === 'tasks' && (
          <section className="task-center-list">
            {!activeConv ? <p className="inspector-empty">选择会话后显示它的任务记录。</p> : tasks.length === 0 ? <p className="inspector-empty">当前会话还没有任务记录。</p> : tasks.slice(0, 30).map(task => (
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
                    <Textarea
                      className="task-edit-input"
                      value={taskContent}
                      onChange={event => setTaskContent(event.target.value)}
                      aria-label="编辑排队任务"
                    />
                  ) : <p>{task.schedule_name && <span className="schedule-message-badge"><Clock size={11} />{task.schedule_name}</span>}{task.is_summary ? '生成对话总结' : task.prompt}</p>}
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
      {showSchedules && activeConv && <ReaderDialog title="定时任务管理" onClose={() => setShowSchedules(false)}><SchedulePanel conversationId={activeConv.id} /></ReaderDialog>}
      {showDiff && activeConv && <WorkspaceDiff conversationId={activeConv.id} onClose={() => setShowDiff(false)} />}
      {showResult && <ReaderDialog title="最近 Agent 回复" onClose={() => setShowResult(false)}><div className="markdown-body result-reader"><MarkdownContent content={messages.findLast(message => message.role === 'agent' && !message.isThinking && message.content)?.content || ''} enableCodeBlocks /></div><p className="reader-note">来自当前已加载的会话记录。</p></ReaderDialog>}
    </>
  )
}
