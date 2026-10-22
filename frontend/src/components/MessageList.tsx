import React, { Suspense, lazy } from 'react'
import { motion } from 'framer-motion'
import { MoreHorizontal, AlertCircle, Info, FileText, Check, Copy, ThumbsUp, ThumbsDown, RotateCcw, Clock, ListTodo, Gauge, ChevronDown, ChevronUp, History, Sparkles, ShieldAlert } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { Message } from '../lib/types'
import { haptic } from '../lib/nativeFeedback'
import { messageKey } from '../lib/messageIdentity'
import { OPEN_INSPECTOR_EVENT, openInspectorPanel } from '../lib/appEvents'
import './SchedulePanel.css'
import { formatModelName } from '../lib/providers'
import { VirtualMessage } from './VirtualMessage'
import { MobileBottomSheet } from './MobileBottomSheet'

interface MessageListProps {
  messages: Message[]
  renderAll?: boolean
  focusedMessageId?: number
  /** Stable key of the message whose copy button is showing its tick. */
  copiedMessageKey: string | null
  isAgentThinking: boolean
  isDrawerSwiping: boolean
  copyMessageText: (text: string, messageKey: string) => void
  handleFeedback: (messageId: number | undefined, type: 'up' | 'down') => void
  regenerateLastResponse: () => void
  formatTimestamp: (ts?: string | number) => string
  messagesEndRef: React.RefObject<HTMLDivElement | null>
}

interface MessageRowProps {
  message: Message
  rowKey: string
  isCopied: boolean
  /** False for the rows already present when the transcript first rendered. */
  animateEntry: boolean
  isLastAgentMessage: boolean
  copyMessageText: (text: string, messageKey: string) => void
  handleFeedback: (messageId: number | undefined, type: 'up' | 'down') => void
  regenerateLastResponse: () => void
  formatTimestamp: (ts?: string | number) => string
  onOpenActions: (event: React.SyntheticEvent, rowKey: string) => void
}

const MarkdownContent = lazy(() => import('./MarkdownContent'))

/** Title per failure class, so the first line says what kind of problem it is. */
const ERROR_TITLES: Record<string, string> = {
  permission_required: 'Agent 权限被拒绝，未生成回答',
  invalid_request: '请求未被接受',
  not_found: '项目不存在',
  busy: '当前项目有任务正在执行',
  internal_error: '服务内部错误',
  provider_error: 'Agent 执行失败',
  schedule_failed: '定时任务执行失败',
  compaction_failed: '上下文压缩失败，定时命令未执行',
}

function ScheduleBadge({ message }: { message: Message }) {
  if (!message.schedule_name) return null
  return <button type="button" className="schedule-message-badge"
    title={message.scheduled_for ? `计划触发：${new Date(message.scheduled_for).toLocaleString('zh-CN')}` : '查看定时任务'}
    onClick={() => openInspectorPanel('schedules')}>
    <Clock size={12} aria-hidden="true" /><span>定时 · {message.schedule_name}</span>
  </button>
}

/**
 * A failed turn, with the control that fixes it.
 *
 * These failures are usually a project setting rather than a fault — most
 * often a tool call that the restricted permission mode auto-denied — and the
 * remedy is two panels away, so the notice offers it directly instead of
 * dropping a raw provider string into the transcript and leaving the reader to
 * work out where to go.
 */
function SystemErrorNotice({ message }: { message: Message }) {
  const code = message.errorCode || 'provider_error'
  return (
    <div className="system-error" role="alert">
      <AlertCircle size={15} aria-hidden="true" />
      <div className="system-error-body">
        <ScheduleBadge message={message} />
        <strong>{ERROR_TITLES[code] || ERROR_TITLES.provider_error}</strong>
        <p>{message.content}</p>
        {message.errorDetail && (
          <details className="system-error-detail">
            <summary>Agent 原始输出</summary>
            <pre>{message.errorDetail}</pre>
          </details>
        )}
        {code === 'permission_required' && (
          <button
            type="button"
            className="system-error-action"
            onClick={() => {
              haptic('light')
              window.dispatchEvent(
                new CustomEvent(OPEN_INSPECTOR_EVENT, { detail: 'mission' }),
              )
            }}
          >
            <ShieldAlert size={12} />打开项目权限设置
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Memoised so a token arriving for the streaming turn does not re-render every
 * finished message above it. Without this, a long conversation re-rendered its
 * entire markdown tree on every chunk.
 */
const MessageRow = React.memo(function MessageRow({
  message,
  rowKey,
  isCopied,
  animateEntry,
  isLastAgentMessage,
  copyMessageText,
  handleFeedback,
  regenerateLastResponse,
  formatTimestamp,
  onOpenActions,
}: MessageRowProps) {
  const isAgentLike = message.role === 'agent' || message.role === 'summary'
  const feedback = message.feedback ?? ''

  return (
    <motion.div
      initial={animateEntry ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`message-row ${message.role}${message.schedule_name ? ' scheduled-message' : ''}`}
      data-message-id={message.id}
    >
      <button type="button" className="message-more-btn" aria-label="消息操作" onClick={event => onOpenActions(event, rowKey)}><MoreHorizontal size={17} /></button>
      {/* Only the agent is introduced. A right-aligned bubble is already the
          universal sign for "you said this"; labelling it 你 with an avatar —
          and left-aligning that label above a right-aligned bubble — put a
          second, contradictory alignment on every turn the user takes. */}
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
        <ScheduleBadge message={message} />
        {isAgentLike ? (
          <div className="agent-container">
            {message.isQueued && (
              <div className="queued-task-banner">
                <ListTodo size={14} />
                <span>任务已排队{message.queuePosition ? ` · 第 ${message.queuePosition} 位` : ''}</span>
              </div>
            )}
            <AgentExecutionTimeline
              thought={message.thought || ''}
              isThinking={!!message.isThinking}
              duration={message.thinkingDuration ?? message.duration}
              elapsedSoFar={message.elapsedSoFar}
              inactiveSeconds={message.inactiveSeconds}
              healthStatus={message.healthStatus}
              statusMessage={message.statusMessage}
            />

            {message.content ? (
              <div className="markdown-body">
                <Suspense fallback={<div className="message-loading-placeholder">{message.content}</div>}>
                  <MarkdownContent content={message.content} enableCodeBlocks isStreaming={!!message.isThinking} />
                </Suspense>
              </div>
            ) : null}

            {message.isThinking && message.content && <span className="streaming-cursor" />}

            {!message.isThinking && message.content && (
              <div className="message-toolbar">
                {(message.context_chars || message.output_chars || message.thinkingDuration) && (
                  <span className="message-resource-meta" title="本次运行资源">
                    <Gauge size={12} />
                    {message.context_chars ? `${Math.round(message.context_chars / 1000)}k 上下文` : ''}
                    {message.output_chars ? ` · ${message.output_chars} 字输出` : ''}
                    {message.thinkingDuration ? ` · ${message.thinkingDuration.toFixed(1)} 秒` : ''}
                  </span>
                )}
                <button
                  className={`toolbar-btn ${isCopied ? 'copied' : ''}`}
                  title={isCopied ? '已复制' : '复制全文'}
                  onClick={() => copyMessageText(message.content, rowKey)}
                >
                  {isCopied ? <Check size={14} className="icon-success" /> : <Copy size={14} />}
                  <span className="toolbar-btn-text">{isCopied ? '已复制' : '复制'}</span>
                </button>

                <button
                  className={`toolbar-btn ${feedback === 'up' ? 'active-up' : ''}`}
                  title="回答有帮助"
                  aria-pressed={feedback === 'up'}
                  onClick={() => handleFeedback(message.id, 'up')}
                >
                  <ThumbsUp size={14} />
                </button>

                <button
                  className={`toolbar-btn ${feedback === 'down' ? 'active-down' : ''}`}
                  title="回答需改进"
                  aria-pressed={feedback === 'down'}
                  onClick={() => handleFeedback(message.id, 'down')}
                >
                  <ThumbsDown size={14} />
                </button>

                {isLastAgentMessage && (
                  <button
                    className="toolbar-btn regenerate-btn"
                    title="重新生成回答"
                    onClick={() => regenerateLastResponse()}
                  >
                    <RotateCcw size={14} />
                    <span className="toolbar-btn-text">重新生成</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="user-content-wrapper">
            <div className="user-text-content">{message.content}</div>
            {message.deliveryFailed && <span role="status">发送失败，内容已保留；可复制后重新发送</span>}
            <button
              className="user-copy-btn"
              title="复制发送内容"
              aria-label="复制发送内容"
              onClick={() => copyMessageText(message.content, rowKey)}
            >
              {isCopied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        )}
      </div>
      {message.timestamp && (
        <span className="message-time message-time-footer">
          {formatTimestamp(message.timestamp)}
        </span>
      )}
    </motion.div>
  )
})

export function MessageList({
  messages,
  renderAll = false,
  focusedMessageId,
  copiedMessageKey,
  isDrawerSwiping,
  copyMessageText,
  handleFeedback,
  regenerateLastResponse,
  formatTimestamp,
  messagesEndRef
}: MessageListProps) {
  const latestSummaryIndex = messages.reduce((latest, message, index) => (
    message.role === 'summary' && !message.isThinking && Boolean(message.content)
      ? index
      : latest
  ), -1)
  const latestSummaryKey = latestSummaryIndex >= 0
    ? messageKey(messages[latestSummaryIndex], latestSummaryIndex)
    : null
  /**
   * Whether a row mounting now is arriving into a transcript already on screen.
   *
   * Opening a long conversation mounts every message at once, and giving each
   * of them an entry animation meant hundreds of simultaneous animations
   * competing for the first frames after the switch. A transcript that is
   * already there should simply be there; only what arrives afterwards is
   * worth animating in.
   */
  const hasRenderedRef = React.useRef(false)
  React.useEffect(() => {
    hasRenderedRef.current = true
  }, [])
  const [expandedHistoryKey, setExpandedHistoryKey] = React.useState<string | null>(null)
  const [expandedSummaryKey, setExpandedSummaryKey] = React.useState<string | null>(null)
  const [contextMessageKey, setContextMessageKey] = React.useState<string | null>(null)
  const isSummarizedSectionExpanded = (
    renderAll || (latestSummaryKey !== null && expandedHistoryKey === latestSummaryKey)
  )
  const revealedMessageRef = React.useRef<number | undefined>(undefined)
  React.useEffect(() => {
    if (focusedMessageId === undefined || revealedMessageRef.current === focusedMessageId) return
    const index = messages.findIndex(message => message.id === focusedMessageId)
    if (index < 0) return
    revealedMessageRef.current = focusedMessageId
    if (index < latestSummaryIndex) setExpandedHistoryKey(latestSummaryKey)
  }, [focusedMessageId, messages, latestSummaryIndex, latestSummaryKey])
  const summarizedMessageCount = latestSummaryIndex > 0
    ? messages.slice(0, latestSummaryIndex).filter(message => (
        message.role === 'user' || message.role === 'agent'
      )).length
    : 0

  const lastAgentKey = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'agent') return messageKey(messages[index], index)
    }
    return null
  }, [messages])

  const contextMessage = React.useMemo(() => (
    contextMessageKey === null
      ? null
      : messages.find((message, index) => messageKey(message, index) === contextMessageKey) ?? null
  ), [contextMessageKey, messages])

  /**
   * Screen-reader announcement for streamed answers.
   *
   * The bubble itself used to be the live region, so every token re-announced
   * the whole reply. Only the completion of a turn is announced now, and only
   * as a summary.
   */
  const [liveAnnouncement, setLiveAnnouncement] = React.useState('')
  const wasThinkingRef = React.useRef(false)
  React.useEffect(() => {
    const isThinking = messages.some(message => message.role === 'agent' && message.isThinking)
    if (wasThinkingRef.current && !isThinking) {
      const lastAgent = messages.findLast(message => message.role === 'agent')
      setLiveAnnouncement(
        lastAgent?.content
          ? `回答已生成，共 ${lastAgent.content.length} 字`
          : '回答已结束',
      )
    } else if (!wasThinkingRef.current && isThinking) {
      setLiveAnnouncement('Agent 正在处理')
    }
    wasThinkingRef.current = isThinking
  }, [messages])

  // Native long-press belongs to text selection. Message actions have an
  // explicit button so opening a sheet never steals the browser's selection.
  const handleOpenActions = React.useCallback((event: React.SyntheticEvent, rowKey: string) => {
    event.preventDefault()
    if (isDrawerSwiping) return
    haptic('light')
    setContextMessageKey(rowKey)
  }, [isDrawerSwiping])

  React.useEffect(() => {
    if (isDrawerSwiping) setContextMessageKey(null)
  }, [isDrawerSwiping])

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      {isSummarizedSectionExpanded && summarizedMessageCount > 0 && (
        <div className="summarized-originals-heading" role="heading" aria-level={3}>
          <History size={14} aria-hidden="true" />
          <span>
            <strong>原始消息</strong>
            <small>以下 {summarizedMessageCount} 条消息已被本段总结覆盖</small>
          </span>
        </div>
      )}
      {messages.map((m, i) => {
        if (
          latestSummaryIndex >= 0
          && i < latestSummaryIndex
          && !isSummarizedSectionExpanded
        ) {
          return null
        }

        const key = messageKey(m, i)

        const renderMessage = () => {
        if (m.role === 'system') {
          if (m.isError) return <SystemErrorNotice key={key} message={m} />
          return (
            <div key={key} className="system-msg">
              <Info size={14} />
              <span>{m.content}</span>
            </div>
          )
        }

        const isCompletedSummary = m.role === 'summary' && !m.isThinking && Boolean(m.content)
        if (isCompletedSummary) {
          const isLatestSummary = i === latestSummaryIndex
          const isSummaryExpanded = isLatestSummary
            ? isSummarizedSectionExpanded
            : renderAll || expandedSummaryKey === key
          return (
            <motion.section
              key={key}
              initial={hasRenderedRef.current ? { opacity: 0, y: 6 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`conversation-summary-boundary ${isLatestSummary ? 'latest' : ''}`}
              aria-label="对话总结分隔"
              data-message-id={m.id}
            >
              <div className="summary-boundary-rule" aria-hidden="true" />
              <div className="summary-boundary-card">
                <div className="summary-boundary-icon" aria-hidden="true">
                  <Sparkles size={16} />
                </div>
                <div className="summary-boundary-copy">
                  <ScheduleBadge message={m} />
                  <strong>{isLatestSummary ? '此前对话已总结' : '历史总结检查点'}</strong>
                  <span>
                    {isLatestSummary
                      ? summarizedMessageCount > 0
                        ? `${summarizedMessageCount} 条原始消息与总结内容已${isSummarizedSectionExpanded ? '展开' : '收起'}`
                        : `总结内容已${isSummarizedSectionExpanded ? '展开' : '收起'}`
                      : '这段历史曾在这里生成总结'}
                  </span>
                </div>
                <div className="summary-boundary-actions">
                  {isLatestSummary ? (
                    <button
                      type="button"
                      className="summary-history-toggle"
                      aria-expanded={isSummarizedSectionExpanded}
                      onClick={() => setExpandedHistoryKey(
                        isSummarizedSectionExpanded ? null : key,
                      )}
                    >
                      <History size={13} />
                      {isSummarizedSectionExpanded ? '收起已总结内容' : '展开已总结内容'}
                      {isSummarizedSectionExpanded
                        ? <ChevronUp size={13} />
                        : <ChevronDown size={13} />}
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={isSummaryExpanded}
                      onClick={() => setExpandedSummaryKey(isSummaryExpanded ? null : key)}
                    >
                      <FileText size={13} />
                      {isSummaryExpanded ? '收起总结' : '查看总结'}
                      {isSummaryExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                  )}
                </div>
              </div>
              {isSummaryExpanded && (
                <div className="summary-boundary-content">
                  <div className="summary-content-heading" role="heading" aria-level={3}>
                    <Sparkles size={14} aria-hidden="true" />
                    <span>
                      <strong>总结内容</strong>
                      <small>由 OrbitPane 基于上方原始消息生成</small>
                    </span>
                  </div>
                  <div className="markdown-body">
                    <Suspense fallback={<div className="message-loading-placeholder">{m.content}</div>}>
                      <MarkdownContent content={m.content} enableCodeBlocks />
                    </Suspense>
                  </div>
                  <div className="summary-boundary-meta">
                    {m.timestamp && <span><Clock size={11} />{formatTimestamp(m.timestamp)}</span>}
                    <button type="button" onClick={() => copyMessageText(m.content, key)}>
                      {copiedMessageKey === key ? <Check size={12} /> : <Copy size={12} />}
                      {copiedMessageKey === key ? '已复制' : '复制总结'}
                    </button>
                  </div>
                </div>
              )}
              <div className="summary-boundary-rule" aria-hidden="true" />
            </motion.section>
          )
        }

        return (
          <MessageRow
            key={key}
            rowKey={key}
            message={m}
            isCopied={copiedMessageKey === key}
            animateEntry={hasRenderedRef.current}
            isLastAgentMessage={key === lastAgentKey}
            copyMessageText={copyMessageText}
            handleFeedback={handleFeedback}
            regenerateLastResponse={regenerateLastResponse}
            formatTimestamp={formatTimestamp}
            onOpenActions={handleOpenActions}
          />
        )
        }
        return <VirtualMessage key={key} messageId={m.id}
          initialVisible={i >= messages.length - 8}
          forceVisible={renderAll || m.isThinking === true || (focusedMessageId !== undefined && m.id === focusedMessageId)}>
          {renderMessage()}
        </VirtualMessage>
      })}
      <MobileBottomSheet
        open={contextMessage !== null}
        onClose={() => setContextMessageKey(null)}
        title="消息操作"
        className="message-actions-sheet"
        backdropClassName="message-actions-backdrop"
        role="menu"
      >
        {contextMessage && (
          <>
            <button type="button" role="menuitem" onClick={() => {
              copyMessageText(contextMessage.content, contextMessageKey!)
              setContextMessageKey(null)
            }}><Copy size={17} />复制内容</button>
            {contextMessage.role === 'agent' && (
              <>
                <button type="button" role="menuitem" onClick={() => {
                  handleFeedback(contextMessage.id, 'up')
                  haptic('success')
                  setContextMessageKey(null)
                }}><ThumbsUp size={17} />回答有帮助</button>
                <button type="button" role="menuitem" onClick={() => {
                  handleFeedback(contextMessage.id, 'down')
                  haptic('warning')
                  setContextMessageKey(null)
                }}><ThumbsDown size={17} />回答需改进</button>
                {contextMessageKey === lastAgentKey && (
                  <button type="button" role="menuitem" onClick={() => {
                    regenerateLastResponse()
                    setContextMessageKey(null)
                  }}><RotateCcw size={17} />重新生成</button>
                )}
              </>
            )}
          </>
        )}
      </MobileBottomSheet>
      <div ref={messagesEndRef} />
    </>
  )
}
