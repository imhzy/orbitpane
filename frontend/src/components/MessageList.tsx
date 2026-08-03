import React, { Suspense, lazy } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Sparkles, User, Check, Copy, ThumbsUp, ThumbsDown, RotateCcw, Clock } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { AgentExecutionTimeline } from './AgentExecutionTimeline'
import type { Message } from '../lib/types'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

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
  return (
    <>
      {messages.map((m, i) => {
        if (m.role === 'system') {
          return (
            <div key={i} className={`system-msg ${m.isError ? 'error' : ''}`}>
              {m.isError ? <AlertCircle size={14} /> : <Sparkles size={14} />}
              <span>{m.content}</span>
            </div>
          )
        }

        const isLastAgentMessage = m.role === 'agent' && i === messages.length - 1

        return (
          <motion.div 
            key={i} 
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`message-row ${m.role}`}
          >
            <div className="message-header">
              <div className="message-author">
                {m.role === 'agent' ? (
                  <div className="avatar agent-avatar">
                    <LogoIcon size={16} />
                  </div>
                ) : (
                  <div className="avatar user-avatar">
                    <User size={14} />
                  </div>
                )}
                <span className="author-name">
                  {m.role === 'agent' ? 'Antigravity AI' : '你'}
                </span>
                {m.role === 'agent' && m.model && (
                  <span className="model-pill">{formatModelName(m.model)}</span>
                )}
              </div>
              {m.timestamp && (
                <span className="message-time">
                  <Clock size={11} style={{ marginRight: 3, opacity: 0.6 }} />
                  {formatTimestamp(m.timestamp)}
                </span>
              )}
            </div>

            <div className="message-bubble">
              {m.role === 'agent' ? (
                <div className="agent-container">
                  <AgentExecutionTimeline 
                    thought={m.thought || ''} 
                    isThinking={!!m.isThinking} 
                    duration={m.thinkingDuration || m.duration}
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
                    {copiedMsgIdx === i ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )
      })}
      <div ref={messagesEndRef} />
    </>
  )
}
