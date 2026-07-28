import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Menu, X, MessageSquare, Plus, Trash2, Folder,
  ChevronRight, Send, Compass, FolderPlus, Sun, Moon,
  Check, ChevronDown, Sparkles, Copy, Layers, HardDrive, Eraser, Pencil,
  User, RotateCcw, ThumbsUp, ThumbsDown, AlertCircle, Square, RefreshCw,
  FolderGit2, Cpu
} from 'lucide-react'
import { LogoIcon } from './LogoIcon'
import './App.css'
import { apiFetch } from './lib/api'
import { AUTH_EXPIRED_EVENT, clearLegacyAuthState } from './lib/auth'
import type {
  Conversation,
  DirItem,
  Message,
  ModelsResponse,
  AgentsResponse,
  Provider,
} from './lib/types'

function formatTimestamp(ts?: string | number) {
  if (!ts) return ''
  const d = new Date(ts.toString().includes(' ') ? ts + ' UTC' : ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

import { ThinkingBlock } from './components/ThinkingBlock'

import { Login } from './components/Login'
import { ConfirmDialog } from './components/ConfirmDialog'

const MarkdownContent = lazy(() => import('./components/MarkdownContent'))

interface ModelSelectorProps {
  selectedModel: string
  setSelectedModel: (model: string) => void
  models: string[]
  formatModelName: (modelId: string) => string
  position: 'header' | 'input'
  onOpen?: () => void
}

function ModelSelector({ selectedModel, setSelectedModel, models, formatModelName, position, onOpen }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleToggle = () => {
    const nextState = !isOpen
    setIsOpen(nextState)
    if (nextState && onOpen) {
      onOpen()
    }
  }

  const isInput = position === 'input'

  return (
    <div
      className={`model-selector-container ${isInput ? 'input-position mobile-only-model-selector' : 'header-position desktop-only-model-selector'}`}
      ref={dropdownRef}
    >
      <button
        className={`model-selector-btn ${isInput ? 'input-btn' : ''}`}
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="选择 AI 模型"
      >
        {isInput && <Sparkles size={13} className="model-btn-sparkle" />}
        <span className="model-selector-text">{formatModelName(selectedModel)}</span>
        <ChevronDown size={14} className={`model-selector-chevron ${isOpen ? 'open' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: isInput ? 6 : -5, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: isInput ? 6 : -5, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className={`model-dropdown-menu ${isInput ? 'input-menu' : ''}`}
            role="listbox"
            aria-label="AI 模型列表"
          >
            {models.map(m => (
              <button
                key={m}
                role="option"
                aria-selected={selectedModel === m}
                className={`model-dropdown-item ${selectedModel === m ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedModel(m)
                  setIsOpen(false)
                }}
              >
                <div className="model-item-icon">
                  {selectedModel === m ? <Check size={14} /> : <div style={{ width: 14 }} />}
                </div>
                <span className="model-item-name">{formatModelName(m)}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.6-flash-high')

  const [providers, setProviders] = useState<Provider[]>([])
  const [defaultProvider, setDefaultProvider] = useState<string>('agy')

  const loadProviders = () => {
    apiFetch<AgentsResponse>('/api/agents')
      .then(data => {
        if (data.providers) {
          setProviders(data.providers)
        }
        if (data.default_provider) {
          setDefaultProvider(data.default_provider)
          setSelectedProvider(prev => prev || data.default_provider)
        }
      })
      .catch(console.error)
  }

  const loadModels = (providerId?: string) => {
    const p = typeof providerId === 'string' ? providerId : (activeConvRef.current?.provider || defaultProvider || 'agy')
    apiFetch<ModelsResponse>(`/api/models?provider=${p}`)
      .then(data => {
        if (data.models && data.models.length > 0) {
          setModels(data.models)
          setSelectedModel(prev => data.models.includes(prev) ? prev : data.models[0])
        } else {
          setModels([])
        }
      })
      .catch(console.error)
  }

  const formatModelName = (id: string) => {
    if (id === 'gemini-3.6-flash-high') return 'Gemini 3.6 Flash (High)'
    if (id === 'gemini-3.6-flash-medium') return 'Gemini 3.6 Flash (Medium)'
    if (id === 'gemini-3.6-flash-low') return 'Gemini 3.6 Flash (Low)'
    if (id === 'gemini-3.5-flash-high') return 'Gemini 3.5 Flash (High)'
    if (id === 'gemini-3.5-flash-medium') return 'Gemini 3.5 Flash (Medium)'
    if (id === 'gemini-3.5-flash-low') return 'Gemini 3.5 Flash (Low)'
    if (id === 'gemini-3.1-pro-high') return 'Gemini 3.1 Pro (High)'
    if (id === 'gemini-3.1-pro-low') return 'Gemini 3.1 Pro (Low)'
    if (id === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6'
    if (id === 'claude-opus-4-6-thinking') return 'Claude Opus 4.6 (Thinking)'
    if (id === 'gpt-oss-120b-medium') return 'GPT-OSS 120B (Medium)'
    if (id === 'gpt-5.6-sol') return 'GPT-5.6 Sol (Default)'
    if (id === 'gpt-5.6-terra') return 'GPT-5.6 Terra'
    if (id === 'gpt-5.6-luna') return 'GPT-5.6 Luna'
    if (id === 'gpt-5.5') return 'GPT-5.5'
    if (id === 'gpt-5.4') return 'GPT-5.4'
    if (id === 'gpt-5.4-mini') return 'GPT-5.4 Mini'
    return id.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  }

  const getProviderBadge = (providerId?: string, providersCatalog: Provider[] = []) => {
    const pid = (providerId || 'agy').toLowerCase()
    if (pid === 'codex' || pid.includes('codex')) {
      return {
        text: 'ChatGPT Codex',
        type: 'codex',
        className: 'badge-codex',
        Icon: Cpu,
      }
    }
    if (pid === 'agy' || pid === 'gemini' || pid.includes('gemini') || pid.includes('google')) {
      return {
        text: 'Google Gemini',
        type: 'gemini',
        className: 'badge-gemini',
        Icon: Sparkles,
      }
    }
    const matched = providersCatalog.find(p => p.id === providerId)
    return {
      text: matched?.name || providerId || 'Google Gemini',
      type: 'other',
      className: 'badge-default',
      Icon: MessageSquare,
    }
  }

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [isConversationsLoading, setIsConversationsLoading] = useState(true)
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [drawerMode, setDrawerMode] = useState<'sessions' | 'create'>('sessions')
  
  // Create Session State
  const [currentPath, setCurrentPath] = useState<string>('/root')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('/root')
  const [newConvName, setNewConvName] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('')

  // Edit Workspace Name State
  const [editingConvId, setEditingConvId] = useState<number | null>(null)
  const [editingConvName, setEditingConvName] = useState<string>('')

  // Toast notification
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean
    title: string
    description: string
    onConfirm: () => void
  }>({ isOpen: false, title: '', description: '', onConfirm: () => {} })

  const getBreadcrumbParts = (pathStr: string) => {
    const segments = pathStr.split('/').filter(Boolean)
    let result: { name: string; fullPath: string }[] = [{ name: '/', fullPath: '/' }]
    let acc = ''
    segments.forEach(seg => {
      acc += '/' + seg
      result.push({ name: seg, fullPath: acc })
    })
    if (result.length > 5) {
      const first = result[0]
      const second = result[1]
      const ellipsis = { name: '...', fullPath: result[result.length - 3].fullPath }
      const secondLast = result[result.length - 2]
      const last = result[result.length - 1]
      result = [first, second, ellipsis, secondLast, last]
    }
    return result
  }
  
  // Chat State
  const [input, setInput] = useState('')
  const [copiedMsgIdx, setCopiedMsgIdx] = useState<number | null>(null)
  const [feedbackState, setFeedbackState] = useState<Record<number, 'up' | 'down'>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const reconnectTimerRef = useRef<any>(null)
  const reconnectAttemptRef = useRef<number>(0)
  const loadConversationsRef = useRef<(isInitial?: boolean) => void>(() => {})
  const connectWebSocketRef = useRef<(conv: Conversation, isManual?: boolean) => void>(() => {})
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return true
    return container.scrollHeight - container.scrollTop - container.clientHeight < 150
  }, [])

  const scrollToBottom = useCallback((smooth = true) => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      })
    }
  }, [])

  const isAgentThinking = messages.length > 0 && messages[messages.length - 1].role === 'agent' && messages[messages.length - 1].isThinking;

  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null)

  useEffect(() => {
    const handleExpiredAuth = () => {
      setIsLoggedIn(false)
      socketRef.current?.close()
      socketRef.current = null
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpiredAuth)
    clearLegacyAuthState()
    apiFetch<{ authenticated: boolean }>('/api/session')
      .then(() => setIsLoggedIn(true))
      .catch(() => setIsLoggedIn(false))
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpiredAuth)
  }, [])

  useKeyboardShortcuts({
    onEscape: () => {
      setIsDrawerOpen(false)
    },
    onFocusInput: () => {
      textareaRef.current?.focus()
    }
  })

  const triggerVibration = () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(50)
    }
  }

  // Fluid Spring Configuration
  const springConfig = { type: "spring" as const, damping: 25, stiffness: 250, mass: 1 }

  useEffect(() => {
    const updateAppHeight = () => {
      const vv = window.visualViewport
      const h = vv ? vv.height : window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${h}px`)
      window.scrollTo(0, 0)
    }
    updateAppHeight()

    const handleResize = () => {
      updateAppHeight()
      window.scrollTo(0, 0)
      if (isNearBottom()) {
        scrollToBottom(false)
      }
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize)
      window.visualViewport.addEventListener('scroll', handleResize)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize)
        window.visualViewport.removeEventListener('scroll', handleResize)
      }
      window.removeEventListener('resize', handleResize)
    }
  }, [isNearBottom, scrollToBottom])

  const activeConvRef = useRef<Conversation | null>(activeConv)
  useEffect(() => {
    activeConvRef.current = activeConv
  }, [activeConv])

  const isAgentThinkingRef = useRef<boolean>(isAgentThinking)
  useEffect(() => {
    isAgentThinkingRef.current = isAgentThinking
  }, [isAgentThinking])

  const pendingSendMessageRef = useRef<{ content: string; model: string; provider: string } | null>(null)

  // Initial data loading on login
  useEffect(() => {
    if (isLoggedIn) {
      loadConversationsRef.current(true)
      loadProviders()
      loadModels()
    }
  }, [isLoggedIn])

  // Dynamic loading when sidebar drawer is open or mode changes, plus auto-refresh polling while drawer is open
  useEffect(() => {
    if (!isDrawerOpen || !isLoggedIn) return

    if (drawerMode === 'sessions') {
      loadConversationsRef.current(false)
      const timer = setInterval(() => {
        loadConversationsRef.current(false)
      }, 5000)
      return () => clearInterval(timer)
    } else if (drawerMode === 'create') {
      loadDir(currentPath)
    }
  }, [isDrawerOpen, drawerMode, isLoggedIn, currentPath])


  // Window focus & tab visibility change & network online auto-reconnecting
  useEffect(() => {
    const handleFocusOrVisibility = () => {
      if (document.visibilityState === 'visible' && isLoggedIn) {
        loadConversationsRef.current(false)
        loadProviders()
        loadModels()
        if (activeConvRef.current) {
          if (!isAgentThinkingRef.current) {
            loadHistory(activeConvRef.current.id)
          }
          if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
            connectWebSocketRef.current(activeConvRef.current, false)
          }
        }
        if (isDrawerOpen && drawerMode === 'create') {
          loadDir(currentPath)
        }
      }
    }

    const handleOnline = () => {
      if (isLoggedIn && activeConvRef.current) {
        showToast('网络已连接，正在主动重连 AI agent...')
        connectWebSocketRef.current(activeConvRef.current, true)
      }
    }

    window.addEventListener('focus', handleFocusOrVisibility)
    document.addEventListener('visibilitychange', handleFocusOrVisibility)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('focus', handleFocusOrVisibility)
      document.removeEventListener('visibilitychange', handleFocusOrVisibility)
      window.removeEventListener('online', handleOnline)
    }
  }, [isLoggedIn, isDrawerOpen, drawerMode, currentPath])

  // Active connection health check & background auto-reconnect polling
  useEffect(() => {
    if (!isLoggedIn) return

    const timer = setInterval(() => {
      if (activeConvRef.current) {
        const currentWs = socketRef.current
        if (!currentWs || currentWs.readyState === WebSocket.CLOSED) {
          console.log('[WS Health Monitor] Connection closed, actively triggering reconnection...')
          connectWebSocketRef.current(activeConvRef.current, false)
        }
      }
    }, 4000)

    return () => clearInterval(timer)
  }, [isLoggedIn])

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      scrollToBottom(true)
    }
  }, [messages, scrollToBottom])

  const loadConversations = (isInitial = false) => {
    setIsConversationsLoading(true)
    apiFetch<Conversation[]>('/api/conversations')
      .then((data: Conversation[]) => {
        setConversations(data)
        if (isInitial) {
          const params = new URLSearchParams(window.location.search)
          const convId = params.get('id')
          if (convId) {
            const found = data.find(c => c.id === Number(convId))
            if (found) {
              selectConversation(found)
            }
          }
        } else if (activeConvRef.current) {
          const updated = data.find(c => c.id === activeConvRef.current?.id)
          if (updated) {
            setActiveConv(updated)
          }
        }
      })
      .catch(err => console.error(err))
      .finally(() => setIsConversationsLoading(false))
  }
  loadConversationsRef.current = loadConversations

  const loadDir = (path: string) => {
    apiFetch<{ items: DirItem[] }>(`/api/ls?path=${encodeURIComponent(path)}`)
      .then(data => {
        if (data && Array.isArray(data.items)) {
          setItems(data.items)
        } else {
          setItems([])
        }
      })
      .catch(err => console.error(err))
  }

  const loadHistory = (convId: number) => {
    apiFetch<Message[]>(`/api/history/${convId}`)
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(data)
        }
      })
      .catch(err => console.error(err))
  }

  const connectWebSocket = useCallback((conv: Conversation, isManual = false) => {
    if (!conv) return

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const currentWs = socketRef.current
    if (currentWs && currentWs.readyState === WebSocket.OPEN && !isManual) {
      setIsConnected(true)
      setIsReconnecting(false)
      return
    }

    if (currentWs) {
      currentWs.onopen = null
      currentWs.onmessage = null
      currentWs.onerror = null
      currentWs.onclose = null
      try { currentWs.close() } catch {}
      socketRef.current = null
    }

    setIsConnected(false)
    setIsReconnecting(true)

    if (isManual) {
      showToast('正在尝试连接 AI 后台 agent...')
    }

    const loc = window.location
    const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${loc.host}/api/chat`

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      console.error("WS construction error:", err)
      setIsReconnecting(false)
      return
    }

    ws.onopen = () => {
      if (socketRef.current !== ws) return
      setIsConnected(true)
      setIsReconnecting(false)
      reconnectAttemptRef.current = 0
      if (isManual) {
        showToast('已成功连接后台 AI agent')
      }
      ws.send(JSON.stringify({
        conversation_id: conv.id,
      }))
      if (pendingSendMessageRef.current) {
        const pending = pendingSendMessageRef.current
        pendingSendMessageRef.current = null
        ws.send(JSON.stringify(pending))
      }
    }

    ws.onmessage = (e) => {
      if (socketRef.current !== ws) return
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'start') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (!lastMsg || lastMsg.role !== 'agent') {
              newMsgs.push({ role: 'agent', content: '', thought: '', isThinking: true, elapsedSoFar: data.elapsed || 0, model: data.model })
            } else {
              newMsgs[newMsgs.length - 1] = { ...lastMsg, isThinking: true, elapsedSoFar: data.elapsed || 0, ...(data.model ? { model: data.model } : {}) }
            }
            return newMsgs
          })
        } else if (data.type === 'sync_state') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (!lastMsg || lastMsg.role !== 'agent') {
              newMsgs.push({ role: 'agent', content: data.content || '', thought: data.thought || '', isThinking: data.in_thought || true, elapsedSoFar: data.elapsed || 0, model: data.model })
            } else {
              newMsgs[newMsgs.length - 1] = { ...lastMsg, content: data.content || '', thought: data.thought || '', isThinking: data.in_thought || true, elapsedSoFar: data.elapsed || 0, ...(data.model ? { model: data.model } : {}) }
            }
            return newMsgs
          })
        } else if (data.type === 'thought') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              newMsgs[newMsgs.length - 1] = { ...lastMsg, thought: (lastMsg.thought || '') + data.content, isThinking: true }
            } else {
              newMsgs.push({ role: 'agent', content: '', thought: data.content, isThinking: true })
            }
            return newMsgs
          })
        } else if (data.type === 'token' || data.type === 'answer') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              newMsgs[newMsgs.length - 1] = { ...lastMsg, content: lastMsg.content + data.content }
            } else {
              newMsgs.push({ role: 'agent', content: data.content })
            }
            return newMsgs
          })
        } else if (data.type === 'done' || data.type === 'thought_done') {
          if (data.type === 'done') {
            loadConversationsRef.current(false)
          }
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              const updates: any = { isThinking: false }
              if (data.type === 'done') {
                updates.timestamp = new Date().toISOString()
              }
              if (data.duration) {
                updates.thinkingDuration = data.duration
              }
              newMsgs[newMsgs.length - 1] = { ...lastMsg, ...updates }
            }
            return newMsgs
          })
        } else if (data.type === 'error') {
          if (data.code === 'unauthorized') {
            window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
            return
          }
          setMessages(prev => {
            const newMsgs = [...prev]
            const lastIdx = newMsgs.length - 1
            if (lastIdx >= 0 && newMsgs[lastIdx].role === 'agent') {
              if (!newMsgs[lastIdx].content && !newMsgs[lastIdx].thought) {
                newMsgs.pop()
              } else {
                newMsgs[lastIdx].isThinking = false
              }
            }
            newMsgs.push({ role: 'system', content: `处理异常: ${data.content}`, isError: true })
            return newMsgs
          })
        }
      } catch (err) {
        console.error("WS message parse error:", err)
      }
    }

    ws.onerror = (err) => {
      console.error("WS error:", err)
    }

    ws.onclose = (e) => {
      if (socketRef.current === ws) {
        setIsConnected(false)
        setIsReconnecting(false)
        socketRef.current = null

        const attempt = reconnectAttemptRef.current
        reconnectAttemptRef.current = attempt + 1
        const delay = Math.min(1000 * Math.pow(1.5, Math.min(attempt, 6)), 10000)

        console.log(`[WS] Disconnected (code ${e.code}). Auto-reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`)

        reconnectTimerRef.current = setTimeout(() => {
          if (!socketRef.current && activeConvRef.current && activeConvRef.current.id === conv.id) {
            connectWebSocket(activeConvRef.current, false)
          }
        }, delay)
      }
    }

    socketRef.current = ws
  }, [])
  connectWebSocketRef.current = connectWebSocket

  const selectConversation = (conv: Conversation) => {
    shouldAutoScrollRef.current = true
    setActiveConv(conv)
    setIsDrawerOpen(false)
    loadModels(conv.provider)
    
    const url = new URL(window.location.href)
    url.searchParams.set('id', conv.id.toString())
    window.history.pushState({}, '', url.toString())

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    if (socketRef.current) {
      socketRef.current.onclose = null
      socketRef.current.close()
      socketRef.current = null
    }

    apiFetch<Message[]>(`/api/history/${conv.id}`)
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(data)
        } else {
          setMessages([])
        }
        setTimeout(() => scrollToBottom(false), 100)
      })
      .catch(err => {
        console.error(err)
        setMessages([])
      })

    connectWebSocket(conv, false)
  }

  const createConversation = () => {
    triggerVibration()
    if (!selectedDir || !newConvName.trim()) return
    apiFetch<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        name: newConvName,
        path: selectedDir,
        provider: selectedProvider || defaultProvider,
      })
    })
    .then(data => {
      loadConversations()
      setDrawerMode('sessions')
      setNewConvName('')
      setCurrentPath('/root')
      setSelectedDir('/root')
      setSelectedProvider(defaultProvider)
      selectConversation(data)
    })
    .catch(err => {
      console.error(err)
      showToast('创建工作区失败')
    })
  }

  const deleteConversation = (e: React.MouseEvent, convId: number) => {
    e.stopPropagation()
    setConfirmState({
      isOpen: true,
      title: '删除会话',
      description: '此操作不可撤销，确定要删除该会话记录吗？',
      onConfirm: () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        apiFetch<{ status: string }>(`/api/conversations/${convId}`, { method: 'DELETE' })
          .then(() => {
            loadConversations()
            if (activeConv?.id === convId) {
              setActiveConv(null)
              setMessages([])
              if (socketRef.current) socketRef.current.close()
              const url = new URL(window.location.href)
              url.searchParams.delete('id')
              window.history.pushState({}, '', url.toString())
            }
          })
          .catch(err => {
            console.error(err)
            showToast('删除工作区失败')
          })
      }
    })
  }

  const startEditingConv = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    setEditingConvId(conv.id)
    setEditingConvName(conv.name)
  }

  const saveConvName = (convId: number) => {
    const trimmed = editingConvName.trim()
    if (!trimmed) {
      setEditingConvId(null)
      return
    }
    apiFetch<Conversation>(`/api/conversations/${convId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: trimmed })
    })
    .then(() => {
      setConversations(prev => prev.map(c => c.id === convId ? { ...c, name: trimmed } : c))
      if (activeConv?.id === convId) {
        setActiveConv(prev => prev ? { ...prev, name: trimmed } : null)
      }
      setEditingConvId(null)
      showToast('工作区名称已更新')
    })
    .catch(err => {
      console.error(err)
      showToast('更新失败')
      setEditingConvId(null)
    })
  }

  const sendMessage = (customText?: string) => {
    triggerVibration()
    const textToSend = typeof customText === 'string' ? customText : input
    if (!textToSend.trim()) return
    if (isAgentThinkingRef.current) {
      showToast('Agent 正在处理当前任务，请先中断或等待完成')
      return
    }

    if (!activeConvRef.current) {
      showToast('请先选择一个工作区会话')
      return
    }

    setInput('')
    shouldAutoScrollRef.current = true
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setMessages(prev => [...prev, { role: 'user', content: textToSend.trim(), timestamp: new Date().toISOString() }])
    
    const payload = {
      content: textToSend.trim(),
      model: selectedModel,
      provider: activeConvRef.current.provider,
    }

    const currentSocket = socketRef.current
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      pendingSendMessageRef.current = payload
      showToast('连接中，重连成功后将自动发送...')
      connectWebSocket(activeConvRef.current, true)
      return
    }

    currentSocket.send(JSON.stringify(payload))
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }

  const clearMessages = () => {
    if (!activeConv) return
    setConfirmState({
      isOpen: true,
      title: '清空会话消息',
      description: '确定要清空当前会话的所有消息吗？此操作不可逆。',
      onConfirm: () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        apiFetch<{ status: string }>(`/api/history/${activeConv.id}`, { method: 'DELETE' })
          .then(() => {
            setMessages([])
          })
          .catch(err => {
            console.error(err)
            showToast('清空消息失败')
          })
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isAgentThinking) {
        showToast('Agent 正在处理当前任务')
        return
      }
      sendMessage()
    }
  }

  const copyMessageText = (text: string, msgIndex: number) => {
    navigator.clipboard.writeText(text)
    setCopiedMsgIdx(msgIndex)
    showToast('已复制到剪贴板')
    setTimeout(() => setCopiedMsgIdx(null), 2000)
  }

  const handleFeedback = (idx: number, type: 'up' | 'down') => {
    setFeedbackState(prev => ({
      ...prev,
      [idx]: prev[idx] === type ? (undefined as any) : type
    }))
    showToast(type === 'up' ? '感谢你的好评反馈！' : '已收到反馈，我们将持续优化')
  }

  const regenerateLastResponse = () => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (!lastUserMsg) return

    if (!isConnected && activeConvRef.current) {
      showToast('AI 后台未连接，正在发起重连...')
      connectWebSocket(activeConvRef.current, true)
      return
    }

    if (lastUserMsg && isConnected) {
      sendMessage(lastUserMsg.content)
      showToast('正在重新生成回复...')
    } else {
      showToast('无法重新生成，请检查连接状态')
    }
  }

  const handleLogin = () => {
    setIsLoggedIn(true)
  }

  if (isLoggedIn === null) {
    return <div className="app-container" aria-label="正在验证登录状态" />
  }

  if (!isLoggedIn) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app-container">
      {/* Sidebar Drawer Scrim */}
      <AnimatePresence>
        {isDrawerOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="drawer-scrim" 
            onClick={() => {
              if (drawerMode === 'create' && (newConvName.trim() || currentPath !== '/root')) {
                setConfirmState({
                  isOpen: true,
                  title: '放弃修改',
                  description: '有未保存的信息，确定要关闭吗？',
                  onConfirm: () => {
                    setConfirmState(prev => ({ ...prev, isOpen: false }))
                    setIsDrawerOpen(false)
                  }
                })
              } else {
                setIsDrawerOpen(false)
              }
            }} 
          />
        )}
      </AnimatePresence>

      {/* Sidebar Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <motion.div 
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
            transition={springConfig}
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="工作区菜单"
            drag="x"
            dragConstraints={{ left: -340, right: 0 }}
            dragElastic={0.1}
            onDragEnd={(_e, { offset, velocity }) => {
              if (offset.x < -100 || velocity.x < -300) {
                setIsDrawerOpen(false)
              }
            }}
          >
            <div className="drawer-header">
              <div className="drawer-brand">
                <LogoIcon size={24} />
                <div className="brand-title-group">
                  <span className="brand-main-name">ANTIGRAVITY</span>
                  <span className="brand-badge-sm">STUDIO</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <button 
                  className="icon-btn" 
                  title="刷新数据" 
                  onClick={() => {
                    loadConversations(false)
                    if (drawerMode === 'create') loadDir(currentPath)
                    showToast('最新数据已刷新')
                  }}
                >
                  <RefreshCw size={16} className={isConversationsLoading ? 'animate-spin' : ''} />
                </button>
                <button className="icon-btn" onClick={() => setIsDrawerOpen(false)}>
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="drawer-tabs">
              <button 
                className={`drawer-tab-btn ${drawerMode === 'sessions' ? 'active' : ''}`}
                onClick={() => setDrawerMode('sessions')}
              >
                <MessageSquare size={14} />
                <span>会话列表</span>
              </button>
              <button 
                className={`drawer-tab-btn ${drawerMode === 'create' ? 'active' : ''}`}
                onClick={() => setDrawerMode('create')}
              >
                <Plus size={14} />
                <span>新建工作区</span>
              </button>
            </div>

            {/* Sessions Mode */}
            {drawerMode === 'sessions' && (
              <div className="drawer-content">
                {isConversationsLoading ? (
                  <div className="flex flex-col gap-2 p-2">
                    {[1, 2, 3].map(i => (
                      <div key={i} className="h-14 bg-[var(--bg-surface-hover)] rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 opacity-70">
                    <Compass size={48} className="text-[var(--accent-color)] mb-4 opacity-50" />
                    <div className="text-center text-[var(--text-secondary)] text-[14px] font-medium">
                      暂无工作区
                    </div>
                    <div className="text-center text-[var(--text-tertiary)] text-[12px] mt-1 mb-4">
                      点击下方按钮创建您的第一个智能工作区
                    </div>
                    <button 
                      className="icon-btn" 
                      onClick={() => setDrawerMode('create')}
                      style={{ background: 'var(--accent-subtle-bg)', color: 'var(--accent-text)', border: '1px solid var(--accent-border)' }}
                    >
                      <Plus size={14} style={{ marginRight: 4 }} /> 立即创建
                    </button>
                  </div>
                ) : (
                  conversations.map(conv => {
                    const isEditing = editingConvId === conv.id
                    const badge = getProviderBadge(conv.provider, providers)
                    const ProviderIcon = badge.Icon
                    return (
                      <div 
                        key={conv.id} 
                        className={`list-item ${activeConv?.id === conv.id ? 'selected' : ''}`}
                        onClick={() => {
                          if (!isEditing) selectConversation(conv)
                        }}
                      >
                        <div className={`item-icon ${badge.type}`}>
                          <ProviderIcon size={16} />
                        </div>
                        <div className="item-content">
                          {isEditing ? (
                            <input
                              type="text"
                              className="cw-input"
                              style={{ padding: '2px 6px', fontSize: '13px', height: '26px' }}
                              value={editingConvName}
                              autoFocus
                              onClick={e => e.stopPropagation()}
                              onChange={e => setEditingConvName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveConvName(conv.id)
                                if (e.key === 'Escape') setEditingConvId(null)
                              }}
                              onBlur={() => saveConvName(conv.id)}
                            />
                          ) : (
                            <>
                              <span className="item-title" title={conv.name}>{conv.name}</span>
                              <div className="item-badge-row">
                                <span className={`conv-provider-tag ${badge.className}`}>
                                  {badge.text}
                                </span>
                              </div>
                              <span className="item-subtitle" title={conv.path}>{conv.path}</span>
                            </>
                          )}
                        </div>
                        <div className="item-actions" style={{ display: 'flex', gap: '4px', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                          {isEditing ? (
                            <button
                              className="icon-btn"
                              title="保存名称"
                              onClick={() => saveConvName(conv.id)}
                            >
                              <Check size={14} />
                            </button>
                          ) : (
                            <>
                              <button 
                                className="icon-btn" 
                                title="重命名工作区"
                                onClick={(e) => startEditingConv(e, conv)}
                              >
                                <Pencil size={13} />
                              </button>
                              <button 
                                className="icon-btn destructive" 
                                title="删除会话"
                                onClick={(e) => deleteConversation(e, conv.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            )}

            {/* Create Workspace Mode */}
            {drawerMode === 'create' && (
              <div className="drawer-content cw-content">
                <div className="cw-header">
                  <h3 className="cw-title">配置新工作区</h3>
                  <p className="cw-subtitle">设定工作区名称并选择项目所在的本地目录</p>
                </div>

                <div className="cw-form">
                  <div className="cw-field-group">
                    <label className="cw-label">工作区名称</label>
                    <div className="cw-input-wrapper">
                      <Layers size={14} className="cw-icon" />
                      <input 
                        type="text" 
                        value={newConvName}
                        onChange={e => setNewConvName(e.target.value)}
                        className="cw-input"
                        aria-label="工作区名称"
                      />
                    </div>
                  </div>

                  <div className="cw-field-group">
                    <label className="cw-label">项目路径</label>
                    <div className="cw-input-wrapper">
                      <Folder size={14} className="cw-icon" />
                      <input
                        type="text"
                        placeholder="输入绝对路径或从下方选择"
                        value={selectedDir}
                        onChange={e => {
                          setSelectedDir(e.target.value)
                          if (e.target.value.startsWith('/')) {
                            setCurrentPath(e.target.value)
                          }
                        }}
                        className="cw-input font-mono"
                        aria-label="项目路径"
                      />
                    </div>
                  </div>

                  <div className="cw-field-group">
                    <label className="cw-label">Agent 接入方式 (Provider)</label>
                    <div className="cw-input-wrapper">
                      <Cpu size={14} className="cw-icon" />
                      <select
                        value={selectedProvider || defaultProvider}
                        onChange={e => setSelectedProvider(e.target.value)}
                        className="cw-input"
                        aria-label="Agent Provider"
                        style={{ appearance: 'auto' }}
                      >
                        {providers.map(p => (
                          <option key={p.id} value={p.id} disabled={!p.available}>
                            {p.name} {p.available ? '' : '(不可用)'}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="cw-browser-section">
                  <div className="cw-browser-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="cw-browser-title">目录浏览</span>
                    <button 
                      className="icon-btn" 
                      title="刷新目录"
                      onClick={() => {
                        loadDir(currentPath)
                        showToast('目录结构已刷新')
                      }}
                      style={{ padding: 3, width: 24, height: 24 }}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  <div className="cw-browser">
                    <div className="cw-crumbs">
                      {getBreadcrumbParts(currentPath).map((part, idx, arr) => (
                        <div key={part.fullPath} className="cw-crumb-item">
                          <button
                            className={`cw-crumb ${idx === arr.length - 1 ? 'active' : ''}`}
                            onClick={() => {
                              setCurrentPath(part.fullPath)
                              setSelectedDir(part.fullPath)
                            }}
                          >
                            {part.name === '/' ? <HardDrive size={12} /> : part.name}
                          </button>
                          {idx < arr.length - 1 && <ChevronRight size={10} className="cw-crumb-sep" />}
                        </div>
                      ))}
                    </div>

                    <div className="cw-list">
                      {(() => {
                        const filtered = items.filter(item => item.is_dir)

                        if (filtered.length === 0) {
                          return (
                            <div className="cw-empty">
                              <FolderPlus size={20} />
                              <span>该目录下无子文件夹</span>
                            </div>
                          )
                        }

                        return filtered.map(item => {
                          const isSelected = selectedDir === item.path
                          return (
                            <button 
                              key={item.path}
                              className={`cw-item ${isSelected ? 'selected' : ''}`}
                              onClick={() => setSelectedDir(item.path)}
                            >
                              <Folder size={14} className="cw-item-icon" />
                              <span className="cw-item-name">{item.name}</span>
                              {isSelected && (
                                <motion.span 
                                  initial={{ scale: 0 }} 
                                  animate={{ scale: 1 }} 
                                  className="cw-check"
                                >
                                  <Check size={10} strokeWidth={3} />
                                </motion.span>
                              )}
                              <span
                                className="cw-enter"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCurrentPath(item.path)
                                  setSelectedDir(item.path)
                                }}
                                role="button"
                                tabIndex={0}
                                title="进入该目录"
                              >
                                <ChevronRight size={14} />
                              </span>
                            </button>
                          )
                        })
                      })()}
                    </div>
                  </div>
                </div>

                <div className="cw-action">
                  <button 
                    className="cw-create-btn"
                    disabled={!selectedDir.trim() || !newConvName.trim()}
                    onClick={createConversation}
                  >
                    <Plus size={16} strokeWidth={2.5} />
                    <span>创建工作区</span>
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <div className="chat-main">
        <div className="chat-header">
          <div className="header-brand">
            <motion.button 
              whileTap={{ scale: 0.95 }}
              className="icon-btn" 
              onClick={() => setIsDrawerOpen(true)}
              title="展开工作区菜单"
            >
              <Menu size={18} />
            </motion.button>

            <LogoIcon size={26} />

            <ModelSelector
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              models={models}
              formatModelName={formatModelName}
              position="header"
              onOpen={loadModels}
            />

            <div className="header-title-wrapper">
              <div className="header-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {activeConv ? (
                  editingConvId === activeConv.id ? (
                    <input
                      type="text"
                      className="cw-input"
                      style={{ padding: '2px 8px', fontSize: '15px', fontWeight: 600, height: '28px', maxWidth: '240px' }}
                      value={editingConvName}
                      autoFocus
                      onChange={e => setEditingConvName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveConvName(activeConv.id)
                        if (e.key === 'Escape') setEditingConvId(null)
                      }}
                      onBlur={() => saveConvName(activeConv.id)}
                    />
                  ) : (
                    <>
                      <span>{activeConv.name}</span>
                      <span className={`conv-provider-tag ${getProviderBadge(activeConv.provider, providers).className}`}>
                        {getProviderBadge(activeConv.provider, providers).text}
                      </span>
                      <button
                        className="icon-btn edit-title-btn"
                        title="修改工作区名称"
                        onClick={(e) => startEditingConv(e, activeConv)}
                        style={{ padding: 2, width: 22, height: 22, opacity: 0.6 }}
                      >
                        <Pencil size={12} />
                      </button>
                    </>
                  )
                ) : (
                  <div className="brand-title-group compact">
                    <span className="brand-main-name">ANTIGRAVITY</span>
                    <span className="brand-badge-sm">STUDIO</span>
                  </div>
                )}
              </div>
              {activeConv && (
                <div className="header-path">{activeConv.path}</div>
              )}
            </div>
          </div>

          <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              className="icon-btn theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {activeConv ? (
              <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <motion.button 
                  whileTap={{ scale: 0.95 }}
                  className="icon-btn"
                  title="清空会话"
                  onClick={clearMessages}
                >
                  <Eraser size={16} />
                </motion.button>
                <div 
                  className={`status-indicator ${!isConnected ? 'clickable' : ''}`}
                  onClick={() => {
                    if (!isConnected && activeConvRef.current) {
                      connectWebSocket(activeConvRef.current, true)
                    }
                  }}
                  title={isConnected ? 'AI agent 已在线连接' : isReconnecting ? '正在尝试重新连接...' : '未连接，点击主动发起重连'}
                  style={{ cursor: isConnected ? 'default' : 'pointer' }}
                >
                  <div className={`status-dot ${isConnected ? 'online' : isReconnecting ? 'connecting' : 'offline'}`} />
                  <span>{isConnected ? '在线已连接' : isReconnecting ? '正在重连...' : '未连接 (点击重连)'}</span>
                </div>
              </div>
            ) : (
              <button className="icon-btn" onClick={() => setIsDrawerOpen(true)}>
                <Plus size={16} style={{ marginRight: 4 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>新建工作区</span>
              </button>
            )}
          </div>
        </div>

        <div
          className="chat-messages"
          ref={messagesContainerRef}
          onScroll={() => {
            shouldAutoScrollRef.current = isNearBottom()
          }}
        >
          {!activeConv && (
            <motion.div 
              initial={{ opacity: 0, y: 15 }} 
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="welcome-container"
            >
              <div className="welcome-hero-wrapper">
                <div className="welcome-hero-icon">
                  <LogoIcon size={52} />
                </div>
                <h1 className="welcome-hero-title">
                  ANTIGRAVITY <span className="title-highlight">STUDIO</span>
                </h1>
                <div className="welcome-hero-badge">
                  <Sparkles size={13} className="badge-sparkle" />
                  <span>NEXT-GEN AI PAIR PROGRAMMER</span>
                </div>
              </div>
              <p className="welcome-subtitle">
                下一代 AI 结对编程与智能工作区
              </p>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="cw-create-btn"
                style={{ marginTop: 4, padding: '12px 24px', fontSize: '14px', borderRadius: '12px' }}
                onClick={() => setIsDrawerOpen(true)}
              >
                <Plus size={16} strokeWidth={2.5} />
                <span>选择或新建工作区</span>
              </motion.button>
            </motion.div>
          )}

          {activeConv && messages.filter(m => m.role !== 'system').length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="welcome-container session-empty-container"
            >
              <div className="session-hero-wrapper">
                <div className="session-hero-icon">
                  <FolderGit2 size={32} />
                </div>
                <h2 className="session-hero-title">
                  {activeConv.name}
                </h2>
                <div className="session-path-badge">
                  <Folder size={12} />
                  <span className="font-mono">{activeConv.path}</span>
                </div>
              </div>
            </motion.div>
          )}

          {messages.map((m, i) => {
            if (m.role === 'system') {
              return (
                <div key={i} className={`system-msg ${m.isError ? 'error' : ''}`}>
                  {m.isError ? <AlertCircle size={14} /> : <Sparkles size={14} />}
                  <span>{m.content}</span>
                </div>
              )
            }

            const isLastAgentMessage = m.role === 'agent' && i === messages.length - 1;

            return (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 14, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={springConfig}
                className={`message-row ${m.role}`}
              >
                <div className="message-header">
                  <div className="message-author">
                    {m.role === 'agent' ? (
                      <div className="avatar agent-avatar">
                        <LogoIcon size={16} />
                        <span className="avatar-pulse-ring" />
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
                    <span className="message-time">{formatTimestamp(m.timestamp)}</span>
                  )}
                </div>

                <div className="message-bubble">
                  {m.role === 'agent' ? (
                    <div className="agent-container">
                      <ThinkingBlock 
                        thought={m.thought || ''} 
                        isThinking={!!m.isThinking} 
                        duration={m.thinkingDuration} 
                        elapsedSoFar={m.elapsedSoFar}
                      />

                      {m.content ? (
                        <div className="markdown-body">
                          <Suspense fallback={<div>{m.content}</div>}>
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
                            title="好评"
                            onClick={() => handleFeedback(i, 'up')}
                          >
                            <ThumbsUp size={14} />
                          </button>

                          <button 
                            className={`toolbar-btn ${feedbackState[i] === 'down' ? 'active-down' : ''}`}
                            title="差评"
                            onClick={() => handleFeedback(i, 'down')}
                          >
                            <ThumbsDown size={14} />
                          </button>

                          {isLastAgentMessage && (
                            <button 
                              className="toolbar-btn regenerate-btn"
                              title="重新生成"
                              onClick={regenerateLastResponse}
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
        </div>

        <div className="input-area">
          <div
            className="input-box"
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
              onKeyDown={handleKeyDown}
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
              placeholder={!activeConv ? "选择工作区后开始" : "向 Antigravity 描述需求，或输入开发指令..."}
              aria-label="消息输入框"
              rows={1}
              className="input-textarea"
            />
            
            <div className="input-bottom-bar">
              <ModelSelector
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                models={models}
                formatModelName={formatModelName}
                position="input"
                onOpen={loadModels}
              />

              <div className="input-bottom-right">
                <button
                  className={`send-btn ${isAgentThinking ? 'interrupt' : ''}`}
                  onClick={() => {
                    if (!activeConv) { showToast('请先选择一个工作区会话'); return }
                    if (!isConnected) {
                      showToast('AI 后台未连接，已为你发起重连...')
                      connectWebSocket(activeConv, true)
                      return
                    }
                    if (isAgentThinking) {
                      socketRef.current?.send(JSON.stringify({ action: "interrupt" }))
                      return
                    }
                    sendMessage()
                  }}
                  disabled={!isAgentThinking && !input.trim()}
                  title={!activeConv ? '请先选择工作区' : !isConnected ? '未连接' : isAgentThinking ? '中断生成' : '发送消息'}
                  aria-label={isAgentThinking ? '中断生成' : '发送消息'}
                >
                  {isAgentThinking ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className="toast-container"
          >
            <div className="toast">
              <Check size={14} style={{ color: '#10B981' }} />
              {toast}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        description={confirmState.description}
        confirmText="确认"
        cancelText="取消"
        variant="destructive"
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  )
}
