import { useState, useEffect, useRef, useCallback } from 'react'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useConversations } from './hooks/useConversations'
import { useWebSocket } from './hooks/useWebSocket'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, ArrowDown, Cpu, MessageSquare, Loader2 } from 'lucide-react'
import './App.css'
import { apiFetch } from './lib/api'
import { AUTH_EXPIRED_EVENT, clearLegacyAuthState } from './lib/auth'
import type { Conversation, Provider } from './lib/types'

import { Login } from './components/Login'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { WelcomeScreen } from './components/WelcomeScreen'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { CommandPalette } from './components/CommandPalette'
import { AppContext } from './contexts/AppContext'
import type { AppContextType } from './contexts/AppContext'


function formatTimestamp(ts?: string | number) {
  if (!ts) return ''
  const d = new Date(ts.toString().includes(' ') ? ts + ' UTC' : ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      // Use #ffffff for light mode to seamlessly blend with the white header
      // and #09090b for dark mode.
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#09090b' : '#ffffff')
    }
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))
  }

  // Toast Notification state
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
    }
    setToast(msg)
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 2200)
  }, [])

  // Login State
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null)

  // Custom Hooks
  const {
    conversations,
    isConversationsLoading,
    activeConv,
    setActiveConv,
    activeConvRef,
    providers,
    defaultProvider,
    models,
    selectedModel,
    setSelectedModel,
    currentPath,
    setCurrentPath,
    items,
    selectedDir,
    setSelectedDir,
    newConvName,
    setNewConvName,
    selectedProvider,
    setSelectedProvider,
    editingConvId,
    setEditingConvId,
    editingConvName,
    setEditingConvName,
    loadProviders,
    loadModels,
    loadConversations,
    loadDir,
    startEditingConv,
    saveConvName,
  } = useConversations(showToast)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
      const target = Math.max(0, container.scrollHeight - container.clientHeight)
      shouldAutoScrollRef.current = true
      pendingAutoScrollTopRef.current = target
      if (smooth) {
        container.scrollTo({ top: target, behavior: 'smooth' })
      } else {
        container.scrollTop = target
      }
    }
  }, [])

  const {
    messages,
    setMessages,
    isHistoryLoading,
    isConnected,
    isReconnecting,
    socketRef,
    socketConversationIdRef,
    isAgentThinking,
    isAgentThinkingRef,
    pendingSendMessagesRef,
    historyRequestRef,
    loadHistory,
    connectWebSocket,
    disconnectCurrentSocket,
  } = useWebSocket(activeConv, showToast, loadConversations, scrollToBottom)

  // Drawer state
  const isDesktopRef = useRef(window.innerWidth >= 1024)
  const [isDrawerOpen, setIsDrawerOpen] = useState(isDesktopRef.current)
  const [drawerMode, setDrawerMode] = useState<'sessions' | 'create'>('sessions')

  useEffect(() => {
    const handleResize = () => {
      const isDesktop = window.innerWidth >= 1024

      // Mobile browsers fire resize events when the software keyboard opens.
      // Only change drawer state when the responsive breakpoint is crossed.
      if (isDesktop === isDesktopRef.current) return

      isDesktopRef.current = isDesktop
      setIsDrawerOpen(isDesktop)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])


  // Command Palette State
  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false)

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean
    title: string
    description: string
    onConfirm: () => void
  }>({ isOpen: false, title: '', description: '', onConfirm: () => {} })

  // Interactive feedback states
  const [input, setInput] = useState('')
  const [copiedMsgIdx, setCopiedMsgIdx] = useState<number | null>(null)
  const [feedbackState, setFeedbackState] = useState<Record<number, 'up' | 'down'>>({})
  const [isExporting, setIsExporting] = useState(false)
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false)

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
    const pid = (providerId || 'antigravity').toLowerCase()
    if (pid === 'codex' || pid.includes('codex')) {
      return {
        text: 'ChatGPT Codex',
        type: 'codex',
        className: 'badge-codex',
        Icon: Cpu,
      }
    }
    if (pid === 'antigravity' || pid === 'gemini' || pid.includes('gemini') || pid.includes('google')) {
      return {
        text: 'Google Gemini',
        type: 'gemini',
        className: 'badge-gemini',
        Icon: Cpu,
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

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const pendingTarget = pendingAutoScrollTopRef.current
    if (pendingTarget !== null) {
      const latestTarget = Math.max(0, container.scrollHeight - container.clientHeight)
      if (Math.abs(container.scrollTop - latestTarget) < 2) {
        pendingAutoScrollTopRef.current = null
        shouldAutoScrollRef.current = true
        setShowScrollBottomBtn(false)
      } else if (Math.abs(container.scrollTop - pendingTarget) < 2) {
        // The stream grew while a smooth scroll was still in flight. Follow the
        // new bottom instead of treating the old programmatic target as user input.
        scrollToBottom(false)
      }
      return
    }

    const nearBottom = isNearBottom()
    shouldAutoScrollRef.current = nearBottom
    setShowScrollBottomBtn(!nearBottom)
  }, [isNearBottom, scrollToBottom])

  const handleMessagesScrollIntent = useCallback(() => {
    // Wheel, touch, pointer and keyboard input should be allowed to interrupt an
    // in-flight smooth scroll. The next scroll event decides whether to keep
    // following based on the user's resulting position.
    pendingAutoScrollTopRef.current = null
  }, [])

  const scheduleScrollToBottom = useCallback(() => {
    if (!shouldAutoScrollRef.current || scrollAnimationFrameRef.current !== null) return

    scrollAnimationFrameRef.current = requestAnimationFrame(() => {
      scrollAnimationFrameRef.current = null
      if (shouldAutoScrollRef.current) {
        scrollToBottom(false)
      }
    })
  }, [scrollToBottom])

  // Authentication status check
  useEffect(() => {
    const handleExpiredAuth = () => {
      setIsLoggedIn(false)
      disconnectCurrentSocket()
      pendingSendMessagesRef.current.clear()
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpiredAuth)
    clearLegacyAuthState()
    apiFetch<{ authenticated: boolean }>('/api/session')
      .then(() => setIsLoggedIn(true))
      .catch(() => setIsLoggedIn(false))
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpiredAuth)
  }, [disconnectCurrentSocket, pendingSendMessagesRef])

  // Keyboard Shortcuts
  useKeyboardShortcuts({
    onEscape: () => {
      if (isCmdPaletteOpen) {
        setIsCmdPaletteOpen(false)
      } else if (isAgentThinkingRef.current) {
        socketRef.current?.send(JSON.stringify({ action: 'interrupt' }))
        showToast('已中断 Agent 生成')
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

  // Dynamic Viewport Height for Mobile Browser / PWA Keyboard
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

  // Initial data load when logged in
  useEffect(() => {
    if (isLoggedIn) {
      loadConversations(true)?.then((conv: Conversation | null) => {
        if (conv) {
          loadHistory(conv.id)?.then(msgs => {
            if (msgs) {
              const last = [...msgs].reverse().find(m => m.model)
              if (last?.model) setSelectedModel(last.model)
            }
          })
          connectWebSocket(conv, false)
        }
      })
      loadProviders()
      loadModels()
    }
  }, [isLoggedIn, loadConversations, loadProviders, loadModels, loadHistory, connectWebSocket, setSelectedModel])

  // Dynamic data polling when drawer is open
  useEffect(() => {
    if (!isDrawerOpen || !isLoggedIn) return

    if (drawerMode === 'sessions') {
      loadConversations(false)
      const timer = setInterval(() => {
        loadConversations(false)
      }, 5000)
      return () => clearInterval(timer)
    } else if (drawerMode === 'create') {
      loadDir(currentPath)
    }
  }, [isDrawerOpen, drawerMode, isLoggedIn, currentPath, loadConversations, loadDir])

  // Visibility and reconnection listener
  useEffect(() => {
    const handleFocusOrVisibility = () => {
      if (document.visibilityState === 'visible' && isLoggedIn) {
        loadConversations(false)
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
  }, [isLoggedIn, loadConversations, loadProviders, activeConvRef, socketRef, connectWebSocket])

  // ResizeObserver for message list auto-scrolling
  useEffect(() => {
    if (!isLoggedIn) return
    const container = messagesContainerRef.current
    const content = messagesContentRef.current
    if (!container || !content) return

    const observer = new ResizeObserver(() => {
      scheduleScrollToBottom()
    })

    observer.observe(content)
    scheduleScrollToBottom()

    return () => {
      observer.disconnect()
      if (scrollAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimationFrameRef.current)
        scrollAnimationFrameRef.current = null
      }
    }
  }, [isLoggedIn, scheduleScrollToBottom])

  // ResizeObserver covers layout/animation changes; this explicit trigger also
  // covers every streamed thought/token render, even when its box size has not
  // changed yet or React has batched several chunks together.
  useEffect(() => {
    if (!isLoggedIn || messages.length === 0) return
    scheduleScrollToBottom()
  }, [isLoggedIn, messages, scheduleScrollToBottom])

  const selectConversation = (conv: Conversation) => {
    triggerVibration()
    const isDifferentConversation = activeConvRef.current?.id !== conv.id
    activeConvRef.current = conv
    setActiveConv(conv)
    shouldAutoScrollRef.current = true
    historyRequestRef.current += 1
    if (isDifferentConversation) {
      isAgentThinkingRef.current = false
      setMessages([])
      setCopiedMsgIdx(null)
      setFeedbackState({})
    }
    if (window.innerWidth < 1024) setIsDrawerOpen(false)
    loadModels(conv.provider)

    const url = new URL(window.location.href)
    url.searchParams.set('id', conv.id.toString())
    window.history.pushState({}, '', url.toString())

    loadHistory(conv.id)?.then(msgs => {
      if (msgs) {
        const last = [...msgs].reverse().find(m => m.model)
        if (last?.model) setSelectedModel(last.model)
      }
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
            pendingSendMessagesRef.current.delete(convId)
            if (activeConvRef.current?.id === convId) {
              activeConvRef.current = null
              setActiveConv(null)
              setMessages([])
              isAgentThinkingRef.current = false
              historyRequestRef.current += 1
              disconnectCurrentSocket()
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

  const sendMessage = (customText?: string) => {
    triggerVibration()
    const textToSend = typeof customText === 'string' ? customText : input
    if (!textToSend.trim()) return
    if (isAgentThinkingRef.current) {
      showToast('Agent 正在处理当前任务，请先中断或等待完成')
      return
    }

    const conversation = activeConvRef.current
    if (!conversation) {
      showToast('请先选择一个工作区会话')
      return
    }

    setInput('')
    shouldAutoScrollRef.current = true
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    isAgentThinkingRef.current = true
    setMessages(prev => [
      ...prev,
      {
        role: 'user',
        content: textToSend.trim(),
        timestamp: new Date().toISOString(),
        provider: conversation.provider,
        isOptimistic: true,
      },
      {
        role: 'agent',
        content: '',
        thought: '',
        isThinking: true,
        elapsedSoFar: 0,
        model: selectedModel,
        provider: conversation.provider,
        isOptimistic: true,
      },
    ])
    
    const payload = {
      content: textToSend.trim(),
      model: selectedModel,
      provider: conversation.provider,
    }

    const currentSocket = socketRef.current
    if (
      !currentSocket
      || currentSocket.readyState !== WebSocket.OPEN
      || socketConversationIdRef.current === undefined
    ) {
      pendingSendMessagesRef.current.set(conversation.id, payload)
      showToast('连接中，重连成功后将自动发送...')
      connectWebSocket(conversation, true)
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
    const conversationId = activeConv.id
    setConfirmState({
      isOpen: true,
      title: '清空会话消息',
      description: '确定要清空当前会话的所有消息吗？此操作不可逆。',
      onConfirm: () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        apiFetch<{ status: string }>(`/api/history/${conversationId}`, { method: 'DELETE' })
          .then(() => {
            if (activeConvRef.current?.id === conversationId) {
              historyRequestRef.current += 1
              pendingSendMessagesRef.current.delete(conversationId)
              setMessages([])
            }
          })
          .catch(err => {
            console.error(err)
            showToast('清空消息失败')
          })
      }
    })
  }

  const summarizeMessages = () => {
    if (!activeConv) return
    const conversationId = activeConv.id
    apiFetch<{ status: string }>(`/api/conversations/${conversationId}/summarize`, { method: 'POST' })
      .then(() => {
        showToast('已发起总结请求')
      })
      .catch(err => {
        console.error(err)
        showToast('发起总结失败')
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
    const targetElement = messagesContentRef.current || messagesContainerRef.current
    const hasConversationMessages = messages.some(message => message.role !== 'system')
    if (!activeConv || !targetElement || !hasConversationMessages || isExporting) return

    setIsExporting(true)
    const modifiedElements: Array<{ el: HTMLElement; style: string | null }> = []

    const setTempStyle = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>) => {
      modifiedElements.push({ el, style: el.getAttribute('style') })
      Object.assign(el.style, styles)
    }

    try {
      const { toBlob } = await import('html-to-image')
      
      const backgroundColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary')
        .trim() || '#09090b'

      // 1. Temporarily expand the target message list container so its width fits the actual contents cleanly
      // Use a fixed width (current width or at least 800px, max 1000px) so text can wrap properly instead of 'max-content'
      const baseWidth = Math.min(Math.max(targetElement.offsetWidth, 800), 1000)
      setTempStyle(targetElement, {
        maxWidth: 'none',
        width: `${baseWidth}px`,
        margin: '0',
        padding: '32px 28px',
        boxSizing: 'border-box',
        background: backgroundColor
      })

      // 2. Expand all message rows and bubbles
      const messageRows = targetElement.querySelectorAll('.message-row')
      messageRows.forEach(r => {
        setTempStyle(r as HTMLElement, {
          maxWidth: 'none',
          width: '100%'
        })
      })

      const messageBubbles = targetElement.querySelectorAll('.message-bubble')
      messageBubbles.forEach(b => {
        const el = b as HTMLElement
        const row = el.closest('.message-row')
        if (row?.classList.contains('agent') || row?.classList.contains('summary')) {
          setTempStyle(el, {
            maxWidth: 'none',
            width: '100%'
          })
        }
      })

      const markdownBodies = targetElement.querySelectorAll('.markdown-body')
      markdownBodies.forEach(mb => {
        setTempStyle(mb as HTMLElement, {
          maxWidth: 'none',
          width: '100%'
        })
      })

      // 3. Expand tables from display:block to display:table so columns stretch naturally instead of horizontal scrollbars
      const tables = targetElement.querySelectorAll('.markdown-body table')
      tables.forEach(t => {
        setTempStyle(t as HTMLElement, {
          maxWidth: 'none',
          width: 'auto',
          display: 'table',
          overflowX: 'visible',
          overflowY: 'visible',
          whiteSpace: 'normal'
        })
      })

      // 4. Wrap code blocks and syntax highlighters so long code lines don't stretch the image
      const codeContainers = targetElement.querySelectorAll('.code-block-container, pre, code')
      codeContainers.forEach(c => {
        setTempStyle(c as HTMLElement, {
          maxWidth: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'hidden',
          overflowY: 'visible'
        })
      })

      // 5. Measure actual required content dimensions
      const rect = targetElement.getBoundingClientRect()
      const scrollWidth = targetElement.scrollWidth
      const scrollHeight = targetElement.scrollHeight

      const exportWidth = Math.min(Math.ceil(Math.max(rect.width, scrollWidth)), 1000)
      const exportHeight = Math.ceil(Math.max(rect.height, scrollHeight))

      // 6. Render PNG blob targeted specifically at targetElement
      const blob = await toBlob(targetElement, {
        width: exportWidth,
        height: exportHeight,
        backgroundColor,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        style: {
          flex: 'none',
          height: `${exportHeight}px`,
          maxHeight: 'none',
          overflow: 'visible',
          width: `${exportWidth}px`,
          margin: '0',
          padding: '32px 28px',
          boxSizing: 'border-box',
          background: backgroundColor
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
      // Cleanly restore all original inline styles
      for (let i = modifiedElements.length - 1; i >= 0; i--) {
        const { el, style } = modifiedElements[i]
        if (style !== null) {
          el.setAttribute('style', style)
        } else {
          el.removeAttribute('style')
        }
      }
    }
  }

  const handleFeedback = (idx: number, type: 'up' | 'down') => {
    setFeedbackState(prev => {
      const copy = { ...prev }
      if (copy[idx] === type) {
        delete copy[idx]
      } else {
        copy[idx] = type
      }
      return copy
    })
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

  const contextValue: AppContextType = {
    theme, toggleTheme, toast, showToast, isDrawerOpen, setIsDrawerOpen,
    drawerMode, setDrawerMode, isCmdPaletteOpen, setIsCmdPaletteOpen,
    conversations, isConversationsLoading, activeConv, setActiveConv,
    deleteConversation, createConversation, loadConversations, selectConversation,
    editingConvId, setEditingConvId, editingConvName, setEditingConvName,
    startEditingConv, saveConvName, providers, defaultProvider,
    selectedProvider, setSelectedProvider, models, selectedModel,
    setSelectedModel, loadModels, loadProviders, getProviderBadge,
    formatModelName, currentPath, setCurrentPath, items, selectedDir,
    setSelectedDir, newConvName, setNewConvName, loadDir,
    getBreadcrumbParts, messages, setMessages, clearMessages, summarizeMessages,
    isConnected, isReconnecting, connectWebSocket, disconnectCurrentSocket,
    activeConvRef, isExporting, exportConversationAsImage, historyRequestRef,
    isAgentThinking, isAgentThinkingRef, pendingSendMessagesRef, loadHistory,
    socketRef, socketConversationIdRef, isHistoryLoading
  };

  return (
    <AppContext.Provider value={contextValue}>
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
      <Sidebar />

      {/* Main Chat Area */}
      <div className="chat-main">
        <ChatHeader />

        <div
          className="chat-messages"
          data-conversation-export
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={handleMessagesScrollIntent}
          onTouchStart={handleMessagesScrollIntent}
          onPointerDown={handleMessagesScrollIntent}
          onKeyDownCapture={handleMessagesScrollIntent}
        >
          <div className="chat-message-list" ref={messagesContentRef}>
            {(isHistoryLoading && (!activeConv || messages.filter(m => m.role !== 'system').length === 0)) ? (
              <div className="chat-history-loading">
                <Loader2 className="spinner-icon" size={32} />
                <p>正在加载对话...</p>
              </div>
            ) : (!activeConv || messages.filter(m => m.role !== 'system').length === 0) ? (
              <WelcomeScreen
                activeConv={activeConv}
                messages={messages}
                setIsDrawerOpen={setIsDrawerOpen}
                setDrawerMode={setDrawerMode}
                conversations={conversations}
                selectConversation={selectConversation}
                onQuickPrompt={(prompt) => {
                  setInput(prompt)
                  setTimeout(() => textareaRef.current?.focus(), 50)
                }}
              />
            ) : (
              <MessageList
                key={activeConv.id}
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

        <div className="chat-footer-wrapper">
          <AnimatePresence>
            {showScrollBottomBtn && activeConv && messages.length > 0 && (
              <motion.button
                initial={{ opacity: 0, y: 10, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.9 }}
                transition={{ duration: 0.15 }}
                className="floating-scroll-bottom-btn"
                onClick={() => scrollToBottom(true)}
                title="回到底部"
              >
                <ArrowDown size={16} />
                {isAgentThinking && <span className="scroll-btn-pulse" />}
              </motion.button>
            )}
          </AnimatePresence>

          <ChatInput
            activeConv={activeConv}
            input={input}
            setInput={setInput}
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
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
            className="toast-container"
            role="status"
            aria-live="polite"
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
    </AppContext.Provider>
  )
}
