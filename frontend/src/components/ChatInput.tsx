import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Square, Send, CornerDownLeft } from 'lucide-react'
import { ModelSelector } from './ModelSelector'
import { FileMentionPicker } from './FileMentionPicker'
import { apiFetch } from '../lib/api'
import { playSendSound, playClickSound } from '../lib/sound'
import type { Conversation, FileSearchItem, FileSearchResponse } from '../lib/types'

interface FileMention {
  start: number
  end: number
  query: string
}

function findFileMention(value: string, caretPosition: number): FileMention | null {
  const prefix = value.slice(0, caretPosition)
  const start = prefix.lastIndexOf('@')
  if (start < 0) return null
  const query = prefix.slice(start + 1)
  const allowedPrecedingCharacters = ' \t\n\r([{"\'`'
  if ((start > 0 && !allowedPrecedingCharacters.includes(prefix[start - 1])) || /\s/u.test(query)) {
    return null
  }
  return {
    start,
    end: caretPosition,
    query,
  }
}

interface ChatInputProps {
  activeConv: Conversation | null
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
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
  setInput,
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
  const activeConversationId = activeConv?.id
  const inputBoxRef = useRef<HTMLDivElement>(null)
  const searchRequestRef = useRef(0)
  const isComposingRef = useRef(false)
  const [mention, setMention] = useState<FileMention | null>(null)
  const [fileResults, setFileResults] = useState<FileSearchItem[]>([])
  const [recentFiles, setRecentFiles] = useState<FileSearchItem[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const [isFileSearchLoading, setIsFileSearchLoading] = useState(false)

  const visibleFileResults = mention && !mention.query && recentFiles.length > 0
    ? recentFiles
    : fileResults

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 400)}px`
    }
  }, [input, textareaRef])

  useEffect(() => {
    setMention(null)
    setFileResults([])
    setActiveFileIndex(0)
    if (activeConversationId === undefined) {
      setRecentFiles([])
      return
    }
    try {
      const stored = JSON.parse(
        localStorage.getItem(`orbitpane_recent_files_${activeConversationId}`) || '[]',
      )
      setRecentFiles(Array.isArray(stored) ? stored.slice(0, 5) : [])
    } catch {
      setRecentFiles([])
    }
  }, [activeConversationId])

  useEffect(() => {
    if (!mention || activeConversationId === undefined) return
    const requestId = ++searchRequestRef.current
    setIsFileSearchLoading(true)
    const timeout = window.setTimeout(() => {
      apiFetch<FileSearchResponse>(
        `/api/conversations/${activeConversationId}/files?q=${encodeURIComponent(mention.query)}&limit=50`,
      )
        .then(data => {
          if (requestId !== searchRequestRef.current) return
          setFileResults(data.items)
          setActiveFileIndex(0)
        })
        .catch(error => {
          if (requestId !== searchRequestRef.current) return
          console.error(error)
          setFileResults([])
        })
        .finally(() => {
          if (requestId === searchRequestRef.current) setIsFileSearchLoading(false)
        })
    }, 120)

    return () => {
      window.clearTimeout(timeout)
      searchRequestRef.current += 1
    }
  }, [activeConversationId, mention])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (inputBoxRef.current && !inputBoxRef.current.contains(event.target as Node)) {
        setMention(null)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const updateMentionFromTextarea = useCallback((textarea: HTMLTextAreaElement) => {
    if (isComposingRef.current || activeConversationId === undefined) return
    const nextMention = findFileMention(textarea.value, textarea.selectionStart)
    setMention(nextMention)
    if (nextMention) setActiveFileIndex(0)
  }, [activeConversationId])

  const selectFile = useCallback((item: FileSearchItem) => {
    if (!mention || activeConversationId === undefined) return
    const insertedPath = /\s/u.test(item.path) ? `"${item.path}"` : item.path
    const before = input.slice(0, mention.start)
    const after = input.slice(mention.end)
    const separator = after.length === 0 || !/^\s/u.test(after) ? ' ' : ''
    const nextInput = `${before}${insertedPath}${separator}${after}`
    const nextCaret = before.length + insertedPath.length + separator.length

    setInput(nextInput)
    setMention(null)
    setRecentFiles(previous => {
      const next = [item, ...previous.filter(recent => recent.path !== item.path)].slice(0, 5)
      localStorage.setItem(`orbitpane_recent_files_${activeConversationId}`, JSON.stringify(next))
      return next
    })
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }, [activeConversationId, input, mention, setInput, textareaRef])

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
        ref={inputBoxRef}
        className={`input-box ${input.trim() ? 'has-text' : ''} ${isAgentThinking ? 'thinking-state' : ''}`}
        onClick={() => {
          if (!activeConv) {
            setIsDrawerOpen(true)
          }
        }}
      >
        {mention && activeConv && (
          <FileMentionPicker
            items={visibleFileResults}
            loading={isFileSearchLoading && visibleFileResults.length === 0}
            query={mention.query}
            activeIndex={activeFileIndex}
            workspacePath={activeConv.path}
            showingRecent={!mention.query && recentFiles.length > 0}
            onSelect={selectFile}
          />
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => {
            handleInput(event)
            updateMentionFromTextarea(event.currentTarget)
          }}
          onKeyDown={(e) => {
            if (mention) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const direction = e.key === 'ArrowDown' ? 1 : -1
                setActiveFileIndex(current => {
                  if (visibleFileResults.length === 0) return 0
                  return (current + direction + visibleFileResults.length) % visibleFileResults.length
                })
                return
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && visibleFileResults.length > 0) {
                e.preventDefault()
                selectFile(visibleFileResults[activeFileIndex])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !isAgentThinking && input.trim()) {
              playSendSound()
            }
            handleKeyDown(e)
          }}
          onSelect={event => updateMentionFromTextarea(event.currentTarget)}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onCompositionEnd={event => {
            isComposingRef.current = false
            updateMentionFromTextarea(event.currentTarget)
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
          aria-autocomplete="list"
          aria-controls={mention ? 'file-mention-results' : undefined}
          aria-expanded={!!mention}
          aria-activedescendant={mention && visibleFileResults.length > 0
            ? `file-mention-option-${activeFileIndex}`
            : undefined}
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
