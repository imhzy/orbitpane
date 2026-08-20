import React, { Suspense, lazy } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Info, FileText, Check, Copy, ThumbsUp, ThumbsDown, RotateCcw, Clock, ListTodo, Gauge, ChevronDown, ChevronUp, History, Sparkles } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { Message } from '../lib/types'
import { haptic } from '../lib/nativeFeedback'
import { messageKey } from '../lib/messageIdentity'
import { formatModelName } from '../lib/providers'

interface MessageListProps {
  messages: Message[]
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
  isLastAgentMessage: boolean
  copyMessageText: (text: string, messageKey: string) => void
  handleFeedback: (messageId: number | undefined, type: 'up' | 'down') => void
  regenerateLastResponse: () => void
  formatTimestamp: (ts?: string | number) => string
  onLongPressStart: (event: React.PointerEvent, rowKey: string) => void
  onLongPressMove: (event: React.PointerEvent) => void
  onLongPressCancel: () => void
  onContextMenu: (event: React.SyntheticEvent, rowKey: string) => void
}

const MarkdownContent = lazy(() => import('./MarkdownContent'))

/**
 * Memoised so a token arriving for the streaming turn does not re-render every
 * finished message above it. Without this, a long conversation re-rendered its
 * entire markdown tree on every chunk.
 */
const MessageRow = React.memo(function MessageRow({
  message,
  rowKey,
  isCopied,
  isLastAgentMessage,
  copyMessageText,
  handleFeedback,
  regenerateLastResponse,
  formatTimestamp,
  onLongPressStart,
  onLongPressMove,
  onLongPressCancel,
  onContextMenu,
}: MessageRowProps) {
  const isAgentLike = message.role === 'agent' || message.role === 'summary'
  const feedback = message.feedback ?? ''

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`message-row ${message.role}`}
      data-message-id={message.id}
      onPointerDown={event => onLongPressStart(event, rowKey)}
      onPointerMove={onLongPressMove}
      onPointerUp={onLongPressCancel}
      onPointerCancel={onLongPressCancel}
      onContextMenu={event => onContextMenu(event, rowKey)}
    >
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
            />

            {message.content ? (
              <div className="markdown-body">
                <Suspense fallback={<div className="message-loading-placeholder">{message.content}</div>}>
                  <MarkdownContent content={message.content} enableCodeBlocks />
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
  const [expandedHistoryKey, setExpandedHistoryKey] = React.useState<string | null>(null)
  const [expandedSummaryKey, setExpandedSummaryKey] = React.useState<string | null>(null)
  const [contextMessageKey, setContextMessageKey] = React.useState<string | null>(null)
  const longPressRef = React.useRef<{
    timer: number
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const isHistoryExpanded = latestSummaryKey !== null && expandedHistoryKey === latestSummaryKey
  const summarizedMessageCount = latestSummaryIndex > 0
    ? messages.slice(0, latestSummaryIndex).filter(message => message.role !== 'system').length
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
      const lastAgent = [...messages].reverse().find(message => message.role === 'agent')
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

  const cancelLongPress = React.useCallback(() => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }, [])

  const beginLongPress = React.useCallback((event: React.PointerEvent, rowKey: string) => {
    if (event.pointerType !== 'touch' || isDrawerSwiping) return
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        haptic('light')
        setContextMessageKey(rowKey)
        longPressRef.current = null
      }, 460),
    }
  }, [isDrawerSwiping])

  const moveLongPress = React.useCallback((event: React.PointerEvent) => {
    const pending = longPressRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    if (Math.abs(event.clientX - pending.x) > 10 || Math.abs(event.clientY - pending.y) > 10) {
      cancelLongPress()
    }
  }, [cancelLongPress])

  const handleContextMenu = React.useCallback((event: React.SyntheticEvent, rowKey: string) => {
    if (!window.matchMedia('(pointer: coarse)').matches) return
    event.preventDefault()
    if (isDrawerSwiping) return
    haptic('light')
    setContextMessageKey(rowKey)
  }, [isDrawerSwiping])

  React.useEffect(() => cancelLongPress, [cancelLongPress])
  React.useEffect(() => {
    // The message viewport captures touch pointers so the drawer remains
    // continuous when its scrim mounts. Captured events no longer target the
    // message row, but they still bubble to window, where the long-press timer
    // can be cancelled without weakening the drawer gesture.
    const handlePointerMove = (event: PointerEvent) => {
      const pending = longPressRef.current
      if (!pending || pending.pointerId !== event.pointerId) return
      if (Math.abs(event.clientX - pending.x) > 10 || Math.abs(event.clientY - pending.y) > 10) {
        cancelLongPress()
      }
    }
    const handlePointerEnd = (event: PointerEvent) => {
      if (longPressRef.current?.pointerId === event.pointerId) cancelLongPress()
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    window.addEventListener('pointerup', handlePointerEnd, { passive: true })
    window.addEventListener('pointercancel', handlePointerEnd, { passive: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }, [cancelLongPress])
  React.useEffect(() => {
    if (!isDrawerSwiping) return
    cancelLongPress()
    setContextMessageKey(null)
  }, [cancelLongPress, isDrawerSwiping])

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      {messages.map((m, i) => {
        if (latestSummaryIndex >= 0 && i < latestSummaryIndex && !isHistoryExpanded) {
          return null
        }

        const key = messageKey(m, i)

        if (m.role === 'system') {
          return (
            <div key={key} className={`system-msg ${m.isError ? 'error' : ''}`}>
              {m.isError ? <AlertCircle size={14} /> : <Info size={14} />}
              <span>{m.content}</span>
            </div>
          )
        }

        const isCompletedSummary = m.role === 'summary' && !m.isThinking && Boolean(m.content)
        if (isCompletedSummary) {
          const isLatestSummary = i === latestSummaryIndex
          const isSummaryExpanded = expandedSummaryKey === key
          return (
            <motion.section
              key={key}
              initial={{ opacity: 0, y: 6 }}
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
                  <strong>{isLatestSummary ? '此前对话已总结' : '历史总结检查点'}</strong>
                  <span>
                    {isLatestSummary
                      ? `${summarizedMessageCount} 条历史消息已收起，可随时展开查看`
                      : '这段历史曾在这里生成总结'}
                  </span>
                </div>
                <div className="summary-boundary-actions">
                  <button
                    type="button"
                    aria-expanded={isSummaryExpanded}
                    onClick={() => setExpandedSummaryKey(isSummaryExpanded ? null : key)}
                  >
                    <FileText size={13} />
                    {isSummaryExpanded ? '收起总结' : '查看总结'}
                    {isSummaryExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {isLatestSummary && summarizedMessageCount > 0 && (
                    <button
                      type="button"
                      className="summary-history-toggle"
                      aria-expanded={isHistoryExpanded}
                      onClick={() => setExpandedHistoryKey(isHistoryExpanded ? null : key)}
                    >
                      <History size={13} />
                      {isHistoryExpanded ? '收起上方对话' : '展开上方对话'}
                      {isHistoryExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                  )}
                </div>
              </div>
              {isSummaryExpanded && (
                <div className="summary-boundary-content">
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
            isLastAgentMessage={key === lastAgentKey}
            copyMessageText={copyMessageText}
            handleFeedback={handleFeedback}
            regenerateLastResponse={regenerateLastResponse}
            formatTimestamp={formatTimestamp}
            onLongPressStart={beginLongPress}
            onLongPressMove={moveLongPress}
            onLongPressCancel={cancelLongPress}
            onContextMenu={handleContextMenu}
          />
        )
      })}
      {contextMessage && (
        <>
          <motion.button
            type="button"
            className="mobile-sheet-backdrop message-actions-backdrop"
            aria-label="关闭消息操作"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setContextMessageKey(null)}
          />
          <motion.div
            className="mobile-bottom-sheet message-actions-sheet"
            role="menu"
            drag="y"
            dragDirectionLock={true}
            dragConstraints={{ top: 0, bottom: 800 }}
            dragElastic={0.08}
            dragMomentum={false}
            onDragEnd={(_event, info) => {
              if (info.offset.y > 90 || info.velocity.y > 500) setContextMessageKey(null)
            }}
            initial={{ y: 800 }}
            animate={{ y: 0 }}
            exit={{ y: 800 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          >
            <div className="mobile-sheet-grabber" aria-hidden="true" />
            <div className="mobile-sheet-title">消息操作</div>
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
          </motion.div>
        </>
      )}
      <div ref={messagesEndRef} />
    </>
  )
}
