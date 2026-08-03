import { useState, useEffect, useRef, useCallback } from 'react'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { motion, AnimatePresence } from 'framer-motion'
import { Check } from 'lucide-react'
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

import { Login } from './components/Login'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { WelcomeScreen } from './components/WelcomeScreen'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { CommandPalette } from './components/CommandPalette'
import { Cpu, Sparkles, MessageSquare } from 'lucide-react'

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
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.1-pro-high')

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
  
  const [isDrawerOpen, setIsDrawerOpen] = useState(window.innerWidth >= 1024)
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

  // Command Palette State
  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false)

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
  const [isExporting, setIsExporting] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const reconnectTimerRef = useRef<any>(null)
  const reconnectAttemptRef = useRef<number>(0)
  const loadConversationsRef = useRef<(isInitial?: boolean) => void>(() => {})
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const scrollAnimationFrameRef = useRef<number | null>(null)
  const pendingAutoScrollTopRef = useRef<number | null>(null)

  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return true
    return container.scrollHeight - container.scrollTop - container.clientHeight < 150
  }, [])

  const scrollToBottom = useCallback((smooth = true) => {
    const container = messagesContainerRef.current
    if (container) {
      if (smooth) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      } else {
        const target = Math.max(0, container.scrollHeight - container.clientHeight)
        pendingAutoScrollTopRef.current = target
        container.scrollTop = target
      }
    }
  }, [])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const pendingTarget = pendingAutoScrollTopRef.current
    pendingAutoScrollTopRef.current = null
    if (pendingTarget !== null && Math.abs(container.scrollTop - pendingTarget) < 2) {
      shouldAutoScrollRef.current = true
      return
    }

    shouldAutoScrollRef.current = isNearBottom()
  }, [isNearBottom])

  const scheduleScrollToBottom = useCallback(() => {
    if (!shouldAutoScrollRef.current || scrollAnimationFrameRef.current !== null) return

    scrollAnimationFrameRef.current = requestAnimationFrame(() => {
      scrollAnimationFrameRef.current = null
      if (shouldAutoScrollRef.current) {
        scrollToBottom(false)
      }
    })
  }, [scrollToBottom])

  const isAgentThinking = messages.length > 0 && messages[messages.length - 1].role === 'agent' && messages[messages.length - 1].isThinking

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
      if (isCmdPaletteOpen) {
        setIsCmdPaletteOpen(false)
      } else {
        setIsDrawerOpen(false)
      }
    },
    onFocusInput: () => {
      textareaRef.current?.focus()
    },
    onCmdPalette: () => {
      setIsCmdPaletteOpen(prev => !prev)
    },
    onToggleSidebar: () => {
      setIsDrawerOpen(prev => !prev)
    },
    onNewWorkspace: () => {
      setIsDrawerOpen(true)
      setDrawerMode('create')
    }
  })

  const triggerVibration = () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(50)
    }
  }

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

  const isAgentThinkingRef = useRef<boolean>(!!isAgentThinking)
  useEffect(() => {
    isAgentThinkingRef.current = !!isAgentThinking
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

  // Dynamic loading when sidebar drawer is open or mode changes
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
      }
    }

    const handleOnline = () => {
      if (isLoggedIn && activeConvRef.current && !socketRef.current) {
        connectWebSocket(activeConvRef.current, false)
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
  }, [isLoggedIn])

  // Auto-scroll effect
  useEffect(() => {
    if (!isLoggedIn) return
    const container = messagesContainerRef.current
    const content = messagesContentRef.current
    if (!container || !content) return

    const observer = new ResizeObserver(() => {
      scheduleScrollToBottom()
    })

    const mutationObserver = new MutationObserver(() => {
      scheduleScrollToBottom()
    })

    observer.observe(content)
    mutationObserver.observe(content, { childList: true, subtree: true, characterData: true })

    scheduleScrollToBottom()

    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
      if (scrollAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimationFrameRef.current)
        scrollAnimationFrameRef.current = null
      }
    }
  }, [isLoggedIn, scheduleScrollToBottom])

  const loadConversations = (isInitial = false) => {
    if (isInitial) {
      setIsConversationsLoading(true)
    }
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
      .finally(() => {
        setIsConversationsLoading(false)
      })
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
        } else {
          setMessages([])
        }
        setTimeout(() => scrollToBottom(false), 100)
      })
      .catch(err => {
        console.error(err)
        setMessages([])
      })
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
  }, [loadModels])

  const selectConversation = (conv: Conversation) => {
    triggerVibration()
    setActiveConv(conv)
    if (window.innerWidth < 1024) {
      setIsDrawerOpen(false)
    }
    loadModels(conv.provider)
    const url = new URL(window.location.href)
    url.searchParams.set('id', conv.id.toString())
    window.history.pushState({}, '', url.toString())
    loadHistory(conv.id)
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

  const exportConversationAsImage = async () => {
    const container = messagesContainerRef.current
    const hasConversationMessages = messages.some(message => message.role !== 'system')
    if (!activeConv || !container || !hasConversationMessages || isExporting) return

    setIsExporting(true)

    try {
      const { toBlob } = await import('html-to-image')
      const width = container.clientWidth
      const height = container.scrollHeight
      const backgroundColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary')
        .trim() || '#0b0b12'

      const blob = await toBlob(container, {
        width,
        height,
        backgroundColor,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        style: {
          flex: 'none',
          height: `${height}px`,
          maxHeight: 'none',
          overflow: 'visible',
          width: `${width}px`
        },
        filter: (node: any) => {
          if (node?.classList) {
            const classes = node.classList
            if (classes.contains('message-toolbar') || 
                classes.contains('user-copy-btn') || 
                classes.contains('streaming-cursor')) {
              return false
            }
          }
          return true
        }
      })
      if (!blob) throw new Error('无法生成图片文件')
      const filename = `${activeConv.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'conversation'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('当前对话已导出为图片')
    } catch (error) {
      console.error('Conversation image export failed:', error)
      showToast('导出图片失败，请重试')
    } finally {
      setIsExporting(false)
    }
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
      <Sidebar
        isDrawerOpen={isDrawerOpen}
        setIsDrawerOpen={setIsDrawerOpen}
        drawerMode={drawerMode}
        setDrawerMode={setDrawerMode}
        conversations={conversations}
        isConversationsLoading={isConversationsLoading}
        activeConv={activeConv}
        selectConversation={selectConversation}
        editingConvId={editingConvId}
        editingConvName={editingConvName}
        setEditingConvName={setEditingConvName}
        saveConvName={saveConvName}
        startEditingConv={startEditingConv}
        setEditingConvId={setEditingConvId}
        deleteConversation={deleteConversation}
        getProviderBadge={getProviderBadge}
        providers={providers}
        newConvName={newConvName}
        setNewConvName={setNewConvName}
        selectedDir={selectedDir}
        setSelectedDir={setSelectedDir}
        currentPath={currentPath}
        setCurrentPath={setCurrentPath}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
        defaultProvider={defaultProvider}
        items={items}
        loadDir={loadDir}
        getBreadcrumbParts={getBreadcrumbParts}
        createConversation={createConversation}
        loadConversations={loadConversations}
        showToast={showToast}
      />

      {/* Main Chat Area */}
      <div className="chat-main">
        <ChatHeader
          activeConv={activeConv}
          editingConvId={editingConvId}
          setEditingConvId={setEditingConvId}
          editingConvName={editingConvName}
          setEditingConvName={setEditingConvName}
          saveConvName={saveConvName}
          startEditingConv={startEditingConv}
          getProviderBadge={getProviderBadge}
          providers={providers}
          isDrawerOpen={isDrawerOpen}
          setIsDrawerOpen={setIsDrawerOpen}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          formatModelName={formatModelName}
          loadModels={loadModels}
          theme={theme}
          toggleTheme={toggleTheme}
          onOpenCmdPalette={() => setIsCmdPaletteOpen(true)}
          isConnected={isConnected}
          isReconnecting={isReconnecting}
          connectWebSocket={connectWebSocket}
          activeConvRef={activeConvRef}
          isExporting={isExporting}
          exportConversationAsImage={exportConversationAsImage}
          messages={messages}
          clearMessages={clearMessages}
        />

        <div
          className="chat-messages"
          data-conversation-export
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
        >
          <div className="chat-message-list" ref={messagesContentRef}>
            {(!activeConv || messages.filter(m => m.role !== 'system').length === 0) ? (
              <WelcomeScreen
                activeConv={activeConv}
                messages={messages}
                setIsDrawerOpen={setIsDrawerOpen}
                onQuickPrompt={(prompt) => {
                  setInput(prompt)
                  setTimeout(() => textareaRef.current?.focus(), 50)
                }}
              />
            ) : (
              <MessageList
                messages={messages}
                copiedMsgIdx={copiedMsgIdx}
                feedbackState={feedbackState}
                isAgentThinking={!!isAgentThinking}
                copyMessageText={copyMessageText}
                handleFeedback={handleFeedback}
                regenerateLastResponse={regenerateLastResponse}
                formatModelName={formatModelName}
                formatTimestamp={formatTimestamp}
                messagesEndRef={messagesEndRef}
              />
            )}
          </div>
        </div>

        <ChatInput
          activeConv={activeConv}
          input={input}
          handleInput={handleInput}
          handleKeyDown={handleKeyDown}
          sendMessage={sendMessage}
          isAgentThinking={!!isAgentThinking}
          isConnected={isConnected}
          textareaRef={textareaRef}
          isNearBottom={isNearBottom}
          scrollToBottom={scrollToBottom}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          formatModelName={formatModelName}
          loadModels={loadModels}
          socketRef={socketRef}
          connectWebSocket={connectWebSocket}
          showToast={showToast}
          setIsDrawerOpen={setIsDrawerOpen}
        />
      </div>

      {/* Command Palette */}
      <CommandPalette
        isOpen={isCmdPaletteOpen}
        onClose={() => setIsCmdPaletteOpen(false)}
        onNewWorkspace={() => {
          setIsDrawerOpen(true)
          setDrawerMode('create')
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
        onClearMessages={clearMessages}
        onExportImage={exportConversationAsImage}
        onSelectConv={(id) => {
          const found = conversations.find(c => c.id === id)
          if (found) selectConversation(found)
        }}
        conversations={conversations}
      />

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
