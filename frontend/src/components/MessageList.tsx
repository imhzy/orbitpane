import React, { Suspense, lazy } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Info, FileText, User, Check, Copy, ThumbsUp, ThumbsDown, RotateCcw, Clock, ListTodo, Gauge, ChevronDown, ChevronUp, History, Sparkles } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { Message } from '../lib/types'
import { haptic } from '../lib/nativeFeedback'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

function messageKey(message: Message, index: number): string {
  return message.id
    ? `message-${message.id}`
    : `${message.role}-${message.run_id ?? message.timestamp ?? index}`
}

interface MessageListProps {
  messages: Message[]
  copiedMsgIdx: number | null
  feedbackState: Record<number, 'up' | 'down'>
  isAgentThinking: boolean
  copyMessageText: (text: string, idx: number) => void
  handleFeedback: (idx: number, type: 'up' | 'down') => void
  regenerateLastResponse: () => void
  formatModelName: (modelId: string) => string
  formatTimestamp: (ts?: string | number) => string
  messagesEndRef: React.RefObject<HTMLDivElement | null>
}

export function MessageList({
  messages,
  copiedMsgIdx,
  feedbackState,
  copyMessageText,
  handleFeedback,
  regenerateLastResponse,
  formatModelName,
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
  const [contextMessageIndex, setContextMessageIndex] = React.useState<number | null>(null)
  const longPressRef = React.useRef<{ timer: number; x: number; y: number } | null>(null)
  const isHistoryExpanded = latestSummaryKey !== null && expandedHistoryKey === latestSummaryKey
  const summarizedMessageCount = latestSummaryIndex > 0
    ? messages.slice(0, latestSummaryIndex).filter(message => message.role !== 'system').length
    : 0

  const cancelLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }

  const beginLongPress = (event: React.PointerEvent, index: number) => {
    if (event.pointerType !== 'touch') return
    cancelLongPress()
    longPressRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        haptic('light')
        setContextMessageIndex(index)
        longPressRef.current = null
      }, 460),
    }
  }

  const moveLongPress = (event: React.PointerEvent) => {
    const pending = longPressRef.current
    if (!pending) return
    if (Math.abs(event.clientX - pending.x) > 10 || Math.abs(event.clientY - pending.y) > 10) {
      cancelLongPress()
    }
  }

  return (
    <>
      {messages.map((m, i) => {
        if (latestSummaryIndex >= 0 && i < latestSummaryIndex && !isHistoryExpanded) {
          return null
        }

        if (m.role === 'system') {
          return (
            <div key={i} className={`system-msg ${m.isError ? 'error' : ''}`}>
              {m.isError ? <AlertCircle size={14} /> : <Info size={14} />}
              <span>{m.content}</span>
            </div>
          )
        }

        const key = messageKey(m, i)
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
                    <button
                      type="button"
                      onClick={() => copyMessageText(m.content, i)}
                    >
                      {copiedMsgIdx === i ? <Check size={12} /> : <Copy size={12} />}
                      {copiedMsgIdx === i ? '已复制' : '复制总结'}
                    </button>
                  </div>
                </div>
              )}
              <div className="summary-boundary-rule" aria-hidden="true" />
            </motion.section>
          )
        }

        const isLastAgentMessage = m.role === 'agent' && i === messages.length - 1

        return (
          <motion.div 
            key={key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`message-row ${m.role}`}
            data-turn={Math.floor(i / 2) + 1}
            data-message-id={m.id}
            onPointerDown={event => beginLongPress(event, i)}
            onPointerMove={moveLongPress}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onContextMenu={event => {
              if (!window.matchMedia('(pointer: coarse)').matches) return
              event.preventDefault()
              haptic('light')
              setContextMessageIndex(i)
            }}
          >
            <div className="message-header">
              <div className="message-author">
                {m.role === 'agent' ? (
                  <div className="avatar agent-avatar">
                    <LogoIcon size={16} />
                  </div>
                ) : m.role === 'summary' ? (
                  <div className="avatar summary-avatar">
                    <FileText size={15} />
                  </div>
                ) : (
                  <div className="avatar user-avatar">
                    <User size={14} />
                  </div>
                )}
                <span className="author-name">
                  {m.role === 'agent' ? 'OrbitPane' : (m.role === 'summary' ? '对话总结 (Summary)' : '你')}
                </span>
                {(m.role === 'agent' || m.role === 'summary') && m.model && (
                  <span className="model-pill">{formatModelName(m.model)}</span>
                )}
              </div>
            </div>

            <div className="message-bubble" aria-live={m.isThinking ? 'polite' : undefined}>
              {(m.role === 'agent' || m.role === 'summary') ? (
                <div className="agent-container">
                  {m.isQueued && (
                    <div className="queued-task-banner">
                      <ListTodo size={14} />
                      <span>任务已排队{m.queuePosition ? ` · 第 ${m.queuePosition} 位` : ''}</span>
                    </div>
                  )}
                  <AgentExecutionTimeline 
                    thought={m.thought || ''} 
                    isThinking={!!m.isThinking} 
                    duration={m.thinkingDuration ?? m.duration}
                    elapsedSoFar={m.elapsedSoFar}
                  />

                  {m.content ? (
                    <div className="markdown-body">
                      <Suspense fallback={<div className="message-loading-placeholder">{m.content}</div>}>
                        <MarkdownContent
                          content={m.content}
                          enableCodeBlocks
                        />
                      </Suspense>
                    </div>
                  ) : null}

                  {m.isThinking && m.content && (
                    <span className="streaming-cursor" />
                  )}

                  {!m.isThinking && m.content && (
                    <div className="message-toolbar">
                      {(m.context_chars || m.output_chars || m.thinkingDuration) && (
                        <span className="message-resource-meta" title="本次运行资源">
                          <Gauge size={12} />
                          {m.context_chars ? `${Math.round(m.context_chars / 1000)}k 上下文` : ''}
                          {m.output_chars ? ` · ${m.output_chars} 字输出` : ''}
                          {m.thinkingDuration ? ` · ${m.thinkingDuration.toFixed(1)} 秒` : ''}
                        </span>
                      )}
                      <button 
                        className={`toolbar-btn ${copiedMsgIdx === i ? 'copied' : ''}`}
                        title={copiedMsgIdx === i ? '已复制' : '复制全文'}
                        onClick={() => copyMessageText(m.content, i)}
                      >
                        {copiedMsgIdx === i ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                        <span className="toolbar-btn-text">{copiedMsgIdx === i ? '已复制' : '复制'}</span>
                      </button>

                      <button 
                        className={`toolbar-btn ${feedbackState[i] === 'up' ? 'active-up' : ''}`}
                        title="觉得不错"
                        onClick={() => handleFeedback(i, 'up')}
                      >
                        <ThumbsUp size={14} />
                      </button>

                      <button 
                        className={`toolbar-btn ${feedbackState[i] === 'down' ? 'active-down' : ''}`}
                        title="尚需改进"
                        onClick={() => handleFeedback(i, 'down')}
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
                  <div className="user-text-content">{m.content}</div>
                  <button 
                    className="user-copy-btn"
                    title="复制发送内容"
                    onClick={() => copyMessageText(m.content, i)}
                  >
                    {copiedMsgIdx === i ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              )}
            </div>
            {m.timestamp && (
              <span className="message-time message-time-footer">
                <Clock size={11} />
                {formatTimestamp(m.timestamp)}
              </span>
            )}
          </motion.div>
        )
      })}
      {contextMessageIndex !== null && messages[contextMessageIndex] && (
        <>
          <motion.button
            type="button"
            className="mobile-sheet-backdrop message-actions-backdrop"
            aria-label="关闭消息操作"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setContextMessageIndex(null)}
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
              if (info.offset.y > 90 || info.velocity.y > 500) setContextMessageIndex(null)
            }}
            initial={{ y: 800 }}
            animate={{ y: 0 }}
            exit={{ y: 800 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          >
            <div className="mobile-sheet-grabber" aria-hidden="true" />
            <div className="mobile-sheet-title">消息操作</div>
            <button type="button" role="menuitem" onClick={() => {
              copyMessageText(messages[contextMessageIndex].content, contextMessageIndex)
              setContextMessageIndex(null)
            }}><Copy size={17} />复制内容</button>
            {messages[contextMessageIndex].role === 'agent' && (
              <>
                <button type="button" role="menuitem" onClick={() => {
                  handleFeedback(contextMessageIndex, 'up')
                  haptic('success')
                  setContextMessageIndex(null)
                }}><ThumbsUp size={17} />回答有帮助</button>
                <button type="button" role="menuitem" onClick={() => {
                  handleFeedback(contextMessageIndex, 'down')
                  haptic('warning')
                  setContextMessageIndex(null)
                }}><ThumbsDown size={17} />回答需改进</button>
                {contextMessageIndex === messages.length - 1 && (
                  <button type="button" role="menuitem" onClick={() => {
                    regenerateLastResponse()
                    setContextMessageIndex(null)
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
