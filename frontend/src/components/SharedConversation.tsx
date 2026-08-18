import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Clock3, FileText, Link2Off, Lock, Moon, Sun, TimerOff } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import MarkdownContent from './MarkdownContent'
import { ApiError, apiFetch, describeApiError } from '../lib/api'
import { normalizeSharedSnapshot } from '../lib/normalize'
import { formatModelName } from '../lib/providers'
import { readText, writeText } from '../lib/storage'
import type { SharedMessage, SharedSnapshot } from '../lib/types'
import '../App.css'
import '../Workspace.css'
import './SharedConversation.css'

/* Most snapshots are published without the execution transcript, so the
   timeline and its stylesheet only load for the ones that carry one. */
const AgentExecutionTimeline = lazy(() =>
  import('./AgentExecutionTimeline').then(module => ({
    default: module.AgentExecutionTimeline,
  })),
)

interface SharedConversationProps {
  token: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: SharedSnapshot }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

function formatDateTime(value?: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatTime(value?: string): string {
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function SharedMessageRow({ message }: { message: SharedMessage }) {
  const isAgentLike = message.role === 'agent' || message.role === 'summary'

  return (
    <div className={`message-row ${message.role}`}>
      {isAgentLike && (
        <div className="message-header">
          <div className="message-author">
            {message.role === 'agent' ? (
              <div className="avatar agent-avatar">
                <LogoIcon size={16} />
              </div>
            ) : (
              <div className="avatar summary-avatar">
                <FileText size={15} />
              </div>
            )}
            <span className="author-name">
              {message.role === 'agent' ? 'OrbitPane' : '对话总结'}
            </span>
            {message.model && (
              <span className="model-pill">{formatModelName(message.model)}</span>
            )}
          </div>
        </div>
      )}

      <div className="message-bubble">
        {isAgentLike ? (
          <div className="agent-container">
            {message.thought && (
              <Suspense fallback={null}>
                <AgentExecutionTimeline
                  thought={message.thought}
                  isThinking={false}
                  duration={message.duration}
                />
              </Suspense>
            )}
            <div className="markdown-body">
              <MarkdownContent content={message.content} enableCodeBlocks />
            </div>
          </div>
        ) : (
          <div className="user-content-wrapper">
            <div className="user-text-content">{message.content}</div>
          </div>
        )}
      </div>
      {message.timestamp && (
        <span className="message-time message-time-footer">
          {formatTime(message.timestamp)}
        </span>
      )}
    </div>
  )
}

/**
 * The read-only page behind a share link.
 *
 * Everything it shows comes from one unauthenticated GET, and everything the
 * chat can *do* is absent by construction rather than disabled: no socket, no
 * composer, no feedback, no project list. The route is mounted from `main.tsx`
 * before the app is even imported, so a visitor holding a link never loads —
 * and can never be prompted by — the private application.
 */
export function SharedConversation({ token }: SharedConversationProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = readText('theme')
    if (stored === 'light' || stored === 'dark') return stored
    // A visitor arriving from a link has no stored preference, so follow the
    // one their system already expresses instead of forcing the app default.
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    writeText('theme', theme)
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
      meta.setAttribute('content', theme === 'dark' ? '#09090b' : '#ffffff')
    })
  }, [theme])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    apiFetch<unknown>(`/api/shared/${encodeURIComponent(token)}`)
      .then(payload => {
        if (cancelled) return
        const snapshot = normalizeSharedSnapshot(payload)
        setState(
          snapshot
            ? { status: 'ready', snapshot }
            : { status: 'error', message: '这个分享内容无法解析' },
        )
      })
      .catch(error => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'missing' })
        } else if (error instanceof ApiError && error.status === 410) {
          setState({ status: 'expired' })
        } else {
          setState({ status: 'error', message: describeApiError(error, '加载分享内容失败') })
        }
      })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    document.title =
      state.status === 'ready' ? `${state.snapshot.title} · OrbitPane` : 'OrbitPane 分享'
  }, [state])

  const snapshot = state.status === 'ready' ? state.snapshot : null

  /* The chat collapses history behind its most recent summary checkpoint; a
     snapshot of that conversation opens the same way, so the link shows what
     the sender was looking at rather than silently unfolding everything. */
  const latestSummaryIndex = useMemo(() => {
    if (!snapshot) return -1
    return snapshot.messages.reduce(
      (latest, message, index) => (message.role === 'summary' ? index : latest),
      -1,
    )
  }, [snapshot])

  const hiddenCount = latestSummaryIndex > 0 ? latestSummaryIndex : 0

  return (
    <div className="shared-page">
      <header className="shared-header">
        <div className="shared-brand">
          <LogoIcon size={20} />
          <span className="brand-wordmark">OrbitPane</span>
        </div>
        <div className="shared-header-actions">
          <span className="shared-readonly-pill">
            <Lock size={11} />
            只读快照
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
            aria-label={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      <main className="shared-scroll">
        {state.status === 'loading' && (
          <div className="shared-content" aria-label="正在加载分享内容">
            <div className="chat-history-loading">
              <div className="history-skeleton history-skeleton-agent skeleton-shimmer" />
              <div className="history-skeleton history-skeleton-user skeleton-shimmer" />
              <div className="history-skeleton history-skeleton-agent short skeleton-shimmer" />
            </div>
          </div>
        )}

        {(state.status === 'missing' || state.status === 'expired' || state.status === 'error') && (
          <div className="shared-content">
            <div className="shared-empty-card" role="status">
              <div className="shared-empty-icon" aria-hidden="true">
                {state.status === 'expired' ? <TimerOff size={22} /> : <Link2Off size={22} />}
              </div>
              <h1>
                {state.status === 'expired'
                  ? '这个分享链接已过期'
                  : state.status === 'missing'
                    ? '这个分享链接无法打开'
                    : '暂时无法加载'}
              </h1>
              <p>
                {state.status === 'expired'
                  ? '链接已经到期，内容也已从服务器移除。请向分享者索取新的链接。'
                  : state.status === 'missing'
                    ? '链接可能不完整，或者分享者已经撤销了它。请向分享者确认。'
                    : state.message}
              </p>
            </div>
          </div>
        )}

        {snapshot && (
          <div className="shared-content">
            <div className="shared-title-block">
              <h1>{snapshot.title}</h1>
              <div className="shared-meta">
                <span>
                  <Clock3 size={12} />
                  分享于 {formatDateTime(snapshot.shared_at)}
                </span>
                <span>{snapshot.messages.length} 条消息</span>
                {snapshot.expires_at && (
                  <span>{formatDateTime(snapshot.expires_at)} 到期</span>
                )}
              </div>
            </div>

            {hiddenCount > 0 && (
              <button
                type="button"
                className="shared-history-toggle"
                aria-expanded={isHistoryExpanded}
                onClick={() => setIsHistoryExpanded(value => !value)}
              >
                {isHistoryExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {isHistoryExpanded
                  ? '收起总结之前的对话'
                  : `展开总结之前的 ${hiddenCount} 条对话`}
              </button>
            )}

            <div className="chat-message-list shared-message-list">
              {snapshot.messages.map((message, index) =>
                !isHistoryExpanded && index < latestSummaryIndex ? null : (
                  <SharedMessageRow key={message.id ?? index} message={message} />
                ),
              )}
            </div>

            <footer className="shared-footer">
              <p>
                这是对话在 {formatDateTime(snapshot.shared_at)} 的快照，不会随后续对话更新。
              </p>
              <p className="shared-footer-brand">
                <LogoIcon size={13} />
                由 OrbitPane 生成
              </p>
            </footer>
          </div>
        )}
      </main>
    </div>
  )
}

export default SharedConversation
