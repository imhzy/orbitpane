import React, { useEffect } from 'react'
import { Square, Send, CornerDownLeft } from 'lucide-react'
import { ModelSelector } from './ModelSelector'
import { playSendSound, playClickSound } from '../lib/sound'
import type { Conversation } from '../lib/types'

interface ChatInputProps {
  activeConv: Conversation | null
  input: string
  handleInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  sendMessage: () => void
  isAgentThinking: boolean
  isConnected: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  isNearBottom: () => boolean
  scrollToBottom: (smooth: boolean) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  models: string[]
  formatModelName: (modelId: string) => string
  loadModels: () => void
  socketRef: React.MutableRefObject<WebSocket | null>
  connectWebSocket: (conv: Conversation, isManual?: boolean) => void
  showToast: (msg: string) => void
  setIsDrawerOpen: (open: boolean) => void
}

export function ChatInput({
  activeConv,
  input,
  handleInput,
  handleKeyDown,
  sendMessage,
  isAgentThinking,
  isConnected,
  textareaRef,
  isNearBottom,
  scrollToBottom,
  selectedModel,
  setSelectedModel,
  models,
  formatModelName,
  loadModels,
  socketRef,
  connectWebSocket,
  showToast,
  setIsDrawerOpen
}: ChatInputProps) {
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 400)}px`
    }
  }, [input, textareaRef])

  const handleSendClick = () => {
    if (!activeConv) {
      showToast('请先选择或新建一个工作区会话')
      setIsDrawerOpen(true)
      return
    }
    if (!isConnected) {
      showToast('服务未连接，已为你发起重连...')
      connectWebSocket(activeConv, true)
      return
    }
    if (isAgentThinking) {
      playClickSound()
      socketRef.current?.send(JSON.stringify({ action: 'interrupt' }))
      return
    }
    if (input.trim()) {
      playSendSound()
      sendMessage()
    }
  }

  return (
    <div className="input-area">
      <div
        className={`input-box ${input.trim() ? 'has-text' : ''} ${isAgentThinking ? 'thinking-state' : ''}`}
        onClick={() => {
          if (!activeConv) {
            setIsDrawerOpen(true)
          }
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isAgentThinking && input.trim()) {
              playSendSound()
            }
            handleKeyDown(e)
          }}
          onFocus={() => {
            window.scrollTo(0, 0)
            setTimeout(() => {
              window.scrollTo(0, 0)
              if (isNearBottom()) {
                scrollToBottom(true)
              }
            }, 100)
          }}
          disabled={!activeConv}
          placeholder={!activeConv ? "选择工程工作区后开启对话..." : "向 OrbitPane 描述需求..."}
          aria-label="消息输入框"
          rows={1}
          className="input-textarea"
        />
        
        <div className="input-bottom-bar">
          <div className="input-bottom-left">
            <ModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              models={models}
              formatModelName={formatModelName}
              position="input"
              onOpen={loadModels}
            />
            {input.trim().length > 0 && (
              <span className="input-char-count">{input.length} 字</span>
            )}
          </div>

          <div className="input-bottom-right">
            <div className="input-hint-badge hide-on-mobile">
              <CornerDownLeft size={11} />
              <span>发送</span>
            </div>
            <button
              className={`send-btn ${isAgentThinking ? 'interrupt' : ''}`}
              onClick={handleSendClick}
              disabled={!isAgentThinking && !input.trim()}
              title={!activeConv ? '请先选择工作区' : !isConnected ? '未连接' : isAgentThinking ? '中断生成' : '发送消息 (Enter)'}
              aria-label={isAgentThinking ? '中断生成' : '发送消息'}
            >
              {isAgentThinking ? <Square size={14} fill="currentColor" /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
