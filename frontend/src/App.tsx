import { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useConversations } from './hooks/useConversations'
import { useWebSocket } from './hooks/useWebSocket'
import { useToasts } from './hooks/useToasts'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowDown, WifiOff, RefreshCw } from 'lucide-react'
import './App.css'
import './Workspace.css'
import { apiFetch, describeApiError } from './lib/api'
import { AUTH_EXPIRED_EVENT, clearLegacyAuthState } from './lib/auth'
import {
  BACKGROUND_REFRESH_MS,
  CLOSE_INSPECTOR_EVENT,
  CONVERSATIONS_CHANGED_EVENT,
  OFFLINE_READY_EVENT,
  REQUEST_INTERRUPT_EVENT,
  TASK_CHANGE_EVENT,
  UPDATE_READY_EVENT,
  emitConversationsChanged,
  emitTaskChange,
  subscribeToOtherTabs,
} from './lib/appEvents'
import { formatModelName, getProviderBadge } from './lib/providers'
import { nextLocalId } from './lib/messageIdentity'
import { forgetConversation, readJson, readText, remove, writeText } from './lib/storage'
import type { Conversation, MessageFeedback } from './lib/types'

import { Login } from './components/Login'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastStack } from './components/Toast'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { WelcomeScreen } from './components/WelcomeScreen'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { AppContext } from './contexts/AppContext'
import type { AppContextType, ConfirmRequest } from './contexts/AppContext'
import { haptic, updateAppBadge } from './lib/nativeFeedback'

const CommandPalette = lazy(() => import('./components/CommandPalette').then(module => ({ default: module.CommandPalette })))
const WorkspaceInspector = lazy(() => import('./components/WorkspaceInspector').then(module => ({ default: module.WorkspaceInspector })))
const PwaInstallPrompt = lazy(() => import('./components/PwaInstallPrompt').then(module => ({ default: module.PwaInstallPrompt })))


function formatTimestamp(ts?: string | number) {
  if (!ts) return ''
  const d = new Date(ts.toString().includes(' ') ? ts + ' UTC' : ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (
    readText('theme') === 'light' ? 'light' : 'dark'
  ))

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    writeText('theme', theme)
    const metaThemeColors = document.querySelectorAll('meta[name="theme-color"]')
    metaThemeColors.forEach(metaThemeColor => {
      // Use #ffffff for light mode to seamlessly blend with the white header
      // and #09090b for dark mode.
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#09090b' : '#ffffff')
    })
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'))
  }

  const { toasts, showToast, dismissToast, runWithUndo } = useToasts()

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
    workspaceRoots,
    defaultWorkspaceRoot,
    loadWorkspaceRoots,
    currentPath,
    setCurrentPath,
    items,
    selectedDir,
    setSelectedDir,
    newConvName,
    setNewConvName,
    selectedProvider,
    setSelectedProvider,
    selectedPermissionMode,
    setSelectedPermissionMode,
    editingConvId,
    setEditingConvId,
    editingConvName,
    setEditingConvName,
    loadProviders,
    loadModels,
    loadConversations,
    loadDir,
    updateConversation,
    startEditingConv,
    saveConvName,
  } = useConversations(showToast)
  const activeConversationId = activeConv?.id ?? null
  const activeConversationDraft = activeConv?.draft ?? ''

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const viewportBaselineRef = useRef({
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  })

  const shouldAutoScrollRef = useRef(true)
  const scrollAnimationFrameRef = useRef<number | null>(null)
  const pendingAutoScrollTopRef = useRef<number | null>(null)
  const conversationScrollPositionsRef = useRef(new Map<number, number>())
  const pullStartYRef = useRef<number | null>(null)
  const [pullDistance, setPullDistance] = useState(0)
  const [isPullRefreshing, setIsPullRefreshing] = useState(false)

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

  /**
   * One dialog at a time, queued.
   *
   * Two independent <ConfirmDialog> instances used to be mounted side by side;
   * when a PWA update landed while a delete confirmation was open, both were
   * visible and a single keypress reached both handlers.
   */
  const [confirmQueue, setConfirmQueue] = useState<ConfirmRequest[]>([])
  const activeConfirm = confirmQueue[0] ?? null

  const requestConfirm = useCallback((request: ConfirmRequest) => {
    setConfirmQueue(queue => (
      // Re-requesting the same dialog (double click, repeated shortcut) must not
      // stack duplicates the user has to dismiss twice.
      queue.some(existing => existing.id === request.id)
        ? queue
        : [...queue, request]
    ))
  }, [])

  const closeActiveConfirm = useCallback(() => {
    setConfirmQueue(queue => queue.slice(1))
  }, [])

  // Interactive feedback states
  const [input, setInput] = useState('')
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftConversationIdRef = useRef<number | null>(null)
  const shareHandledRef = useRef(false)
  /* Keyed by the message's stable local id, never by array index: the history
     reload after every turn re-orders the array, which used to move the copy
     tick and the thumbs rating onto whichever message landed at that index. */
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false)
  const [mobileTaskCount, setMobileTaskCount] = useState(0)
  /* Projects hidden by an open undo window. They are still on the server, so
     they must not reappear when the list refreshes mid-countdown. */
  const [pendingDeletionIds, setPendingDeletionIds] = useState<number[]>([])

  const getBreadcrumbParts = (pathStr: string) => {
    const normalizedPath = pathStr.replace(/\/+$/, '') || '/'
    const baseRoot = [...workspaceRoots]
      .sort((left, right) => right.length - left.length)
      .find(root => normalizedPath === root || normalizedPath.startsWith(`${root.replace(/\/+$/, '')}/`))
    const initialPath = baseRoot || '/'
    const relativePath = baseRoot
      ? normalizedPath.slice(baseRoot.length)
      : normalizedPath
    const segments = relativePath.split('/').filter(Boolean)
    let result: { name: string; fullPath: string }[] = [{
      name: initialPath === '/' ? '/' : initialPath.split('/').filter(Boolean).at(-1) || initialPath,
      fullPath: initialPath,
    }]
    let acc = initialPath === '/' ? '' : initialPath
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

  const handlePullStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const container = messagesContainerRef.current
    if (!container || container.scrollTop > 0 || event.touches.length !== 1) return
    pullStartYRef.current = event.touches[0].clientY
  }, [])

  const handlePullMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (pullStartYRef.current === null || event.touches.length !== 1) return
    const distance = Math.max(0, event.touches[0].clientY - pullStartYRef.current)
    setPullDistance(Math.min(92, distance * 0.48))
  }, [])

  const handlePullEnd = useCallback(() => {
    const shouldRefresh = pullDistance >= 54 && !!activeConvRef.current && !isPullRefreshing
    pullStartYRef.current = null
    setPullDistance(0)
    if (!shouldRefresh || !activeConvRef.current) return
    setIsPullRefreshing(true)
    haptic('light')
    Promise.resolve(loadHistory(activeConvRef.current.id, true))
      .then(() => {
        haptic('success')
        showToast('对话已刷新')
      })
      .finally(() => setIsPullRefreshing(false))
  }, [activeConvRef, isPullRefreshing, loadHistory, pullDistance, showToast])

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

  const interruptAgent = useCallback(() => {
    if (!isAgentThinkingRef.current) return false
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast('未连接 Agent，无法中断', 'warning')
      return false
    }
    haptic('warning')
    socket.send(JSON.stringify({ action: 'interrupt' }))
    showToast('正在中断当前任务…', 'warning')
    return true
  }, [isAgentThinkingRef, showToast, socketRef])

  useEffect(() => {
    const handleRequest = () => { interruptAgent() }
    window.addEventListener(REQUEST_INTERRUPT_EVENT, handleRequest)
    return () => window.removeEventListener(REQUEST_INTERRUPT_EVENT, handleRequest)
  }, [interruptAgent])

  // Keyboard Shortcuts
  useKeyboardShortcuts({
    /* Escape belongs entirely to the overlay layer stack (useEscapeLayer), so
       there is no global handler here. It used to double as "interrupt the
       agent", which meant closing a rename field or the @-file picker — neither
       of which stops the event — killed a running task. */
    // Interrupting is destructive, so it gets its own deliberate chord.
    onInterrupt: interruptAgent,
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

  const triggerVibration = () => haptic('light')

  useEffect(() => {
    void updateAppBadge(mobileTaskCount)
  }, [mobileTaskCount])

  useEffect(() => {
    let edgeStart: { x: number; y: number } | null = null
    const onPointerDown = (event: PointerEvent) => {
      if (window.innerWidth >= 769 || event.pointerType !== 'touch' || event.clientX > 24 || isDrawerOpen) return
      edgeStart = { x: event.clientX, y: event.clientY }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!edgeStart) return
      const horizontalDistance = event.clientX - edgeStart.x
      const verticalDistance = Math.abs(event.clientY - edgeStart.y)
      edgeStart = null
      if (horizontalDistance > 72 && verticalDistance < 60) {
        haptic('light')
        setDrawerMode('sessions')
        setIsDrawerOpen(true)
      }
    }
    const cancel = () => { edgeStart = null }
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', cancel, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [isDrawerOpen])

  // Dynamic Viewport Height for Mobile Browser / PWA Keyboard
  useEffect(() => {
    const updateAppHeight = () => {
      const viewport = window.visualViewport
      const viewportHeight = viewport?.height ?? window.innerHeight
      const viewportWidth = viewport?.width ?? window.innerWidth
      const viewportOffsetTop = viewport?.offsetTop ?? 0
      const baseline = viewportBaselineRef.current

      // A large width change means the device rotated. Start a fresh height
      // baseline so the new orientation is not mistaken for an open keyboard.
      if (Math.abs(viewportWidth - baseline.width) > 80) {
        baseline.width = viewportWidth
        baseline.height = viewportHeight
      } else {
        baseline.height = Math.max(baseline.height, viewportHeight)
      }

      const keyboardOpen = baseline.height - viewportHeight > 120
      document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`)
      // iOS pans the visual viewport as well as shrinking it for the keyboard.
      // Compensate for that pan so the fixed app shell remains aligned with the
      // actually visible rectangle instead of leaving the composer above it.
      document.documentElement.style.setProperty('--viewport-offset-top', `${viewportOffsetTop}px`)
      document.documentElement.classList.toggle('keyboard-open', keyboardOpen)
    }
    updateAppHeight()

    let animationFrame = 0
    let settleTimer = 0

    const handleResize = () => {
      updateAppHeight()
      // WebKit can publish offsetTop a frame (or two) after the resize event.
      // Re-read it after layout and once more after the keyboard animation.
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimer)
      animationFrame = window.requestAnimationFrame(updateAppHeight)
      settleTimer = window.setTimeout(updateAppHeight, 100)
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
      window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(settleTimer)
      document.documentElement.classList.remove('keyboard-open')
      document.documentElement.style.removeProperty('--app-height')
      document.documentElement.style.removeProperty('--viewport-offset-top')
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
              if (conv.preferred_model) setSelectedModel(conv.preferred_model)
              else if (last?.model) setSelectedModel(last.model)
            }
          })
          connectWebSocket(conv, false)
        }
      })
      loadProviders()
      loadModels()
      loadWorkspaceRoots()
    }
  }, [isLoggedIn, loadConversations, loadProviders, loadModels, loadWorkspaceRoots, loadHistory, connectWebSocket, setSelectedModel])

  useEffect(() => {
    const handleOnlineState = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', handleOnlineState)
    window.addEventListener('offline', handleOnlineState)
    return () => {
      window.removeEventListener('online', handleOnlineState)
      window.removeEventListener('offline', handleOnlineState)
    }
  }, [])

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const applyUpdate = (event as CustomEvent<() => void>).detail
      requestConfirm({
        id: 'pwa-update',
        title: '发现新版本',
        description: '新版本已准备就绪。更新会重新加载应用，当前草稿会自动保留。',
        confirmText: '立即更新',
        cancelText: '稍后',
        onConfirm: () => applyUpdate(),
      })
    }
    const handleOfflineReady = () => showToast('离线应用外壳已就绪', 'info')
    window.addEventListener(UPDATE_READY_EVENT, handleUpdate)
    window.addEventListener(OFFLINE_READY_EVENT, handleOfflineReady)
    return () => {
      window.removeEventListener(UPDATE_READY_EVENT, handleUpdate)
      window.removeEventListener(OFFLINE_READY_EVENT, handleOfflineReady)
    }
  }, [requestConfirm, showToast])

  useEffect(() => {
    if (!isLoggedIn) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('action') === 'new-project') {
      setIsDrawerOpen(true)
      setDrawerMode('create')
    }
  }, [isLoggedIn])

  useEffect(() => {
    if (!isLoggedIn || !activeConversationId || shareHandledRef.current) return
    const url = new URL(window.location.href)
    if (url.searchParams.get('action') !== 'share') return
    const sharedText = [
      url.searchParams.get('title'),
      url.searchParams.get('text'),
      url.searchParams.get('url'),
    ].filter(Boolean).join('\n')
    if (!sharedText) return
    shareHandledRef.current = true
    setInput(previous => previous ? `${previous}\n${sharedText}` : sharedText)
    for (const key of ['action', 'title', 'text', 'url']) url.searchParams.delete(key)
    window.history.replaceState({}, '', url.toString())
    window.requestAnimationFrame(() => textareaRef.current?.focus())
    showToast('分享内容已放入输入框', 'info')
  }, [activeConversationId, isLoggedIn, showToast])

  useEffect(() => (
    subscribeToOtherTabs(message => {
      if (message.type === 'task-done' || message.type === 'conversations-changed') {
        void loadConversations(false)
      }
    })
  ), [loadConversations])

  useEffect(() => {
    const refresh = () => void loadConversations(false)
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh)
  }, [loadConversations])

  useEffect(() => {
    const conversationId = activeConversationId
    if (draftConversationIdRef.current === conversationId) return
    draftConversationIdRef.current = conversationId
    if (!conversationId) {
      setInput('')
      return
    }
    const localDraft = readJson<string | null>(`orbitpane_draft_${conversationId}`, null)
    setInput(localDraft ?? activeConversationDraft)
  }, [activeConversationDraft, activeConversationId])

  useEffect(() => {
    if (!activeConversationId) return
    writeText(`orbitpane_draft_${activeConversationId}`, JSON.stringify(input))
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => {
      void updateConversation(activeConversationId, { draft: input }, { silent: true })
    }, 700)
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    }
  }, [activeConversationId, input, updateConversation])

  /* The open drawer stays fresh from task events, with a slow poll only as a
     safety net. It used to refetch the whole project list every 5 seconds for
     as long as it was open, on top of two other panels doing the same. */
  useEffect(() => {
    if (!isDrawerOpen || !isLoggedIn) return

    if (drawerMode === 'create') {
      loadDir(currentPath)
      return
    }

    const refresh = () => void loadConversations(false)
    refresh()
    window.addEventListener(TASK_CHANGE_EVENT, refresh)
    const timer = window.setInterval(refresh, BACKGROUND_REFRESH_MS)
    return () => {
      window.removeEventListener(TASK_CHANGE_EVENT, refresh)
      window.clearInterval(timer)
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

  const selectConversation = (conv: Conversation, updateUrl = true) => {
    triggerVibration()
    const isDifferentConversation = activeConvRef.current?.id !== conv.id
    const previousConversationId = activeConvRef.current?.id
    if (previousConversationId && messagesContainerRef.current) {
      conversationScrollPositionsRef.current.set(previousConversationId, messagesContainerRef.current.scrollTop)
    }
    activeConvRef.current = conv
    setActiveConv(conv)
    shouldAutoScrollRef.current = true
    historyRequestRef.current += 1
    if (isDifferentConversation) {
      isAgentThinkingRef.current = false
      setMessages([])
      setCopiedMessageKey(null)
    }
    if (window.innerWidth < 1024) setIsDrawerOpen(false)
    loadModels(conv.provider)

    if (updateUrl) {
      const url = new URL(window.location.href)
      url.searchParams.set('id', conv.id.toString())
      window.history.pushState({}, '', url.toString())
    }

    loadHistory(conv.id)?.then(msgs => {
      if (msgs) {
        const last = [...msgs].reverse().find(m => m.model)
        if (conv.preferred_model) setSelectedModel(conv.preferred_model)
        else if (last?.model) setSelectedModel(last.model)
        window.requestAnimationFrame(() => {
          const savedPosition = conversationScrollPositionsRef.current.get(conv.id)
          if (messagesContainerRef.current && savedPosition !== undefined) {
            shouldAutoScrollRef.current = false
            messagesContainerRef.current.scrollTop = savedPosition
          } else {
            scrollToBottom(false)
          }
        })
      }
    })
    connectWebSocket(conv, false)
  }

  useEffect(() => {
    const handlePopState = () => {
      const conversationId = Number(new URLSearchParams(window.location.search).get('id'))
      if (!conversationId) {
        activeConvRef.current = null
        setActiveConv(null)
        setMessages([])
        disconnectCurrentSocket()
        return
      }
      const conversation = conversations.find(item => item.id === conversationId)
      if (conversation && activeConvRef.current?.id !== conversation.id) {
        selectConversation(conversation, false)
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  })

  const createConversation = () => {
    triggerVibration()
    if (!selectedDir || !newConvName.trim()) return
    apiFetch<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({
        name: newConvName,
        path: selectedDir,
        provider: selectedProvider || defaultProvider,
        permission_mode: selectedPermissionMode,
      })
    })
      .then(data => {
        loadConversations()
        setDrawerMode('sessions')
        setNewConvName('')
        setCurrentPath(defaultWorkspaceRoot)
        setSelectedDir(defaultWorkspaceRoot)
        setSelectedProvider(defaultProvider)
        setSelectedPermissionMode('workspace')
        selectConversation(data)
      })
      .catch(err => {
        console.error(err)
        showToast(describeApiError(err, '创建项目失败'), 'error')
      })
  }

  const deleteConversation = (e: React.MouseEvent, convId: number) => {
    e.stopPropagation()
    const conversation = conversations.find(item => item.id === convId)
    requestConfirm({
      id: `delete-conversation-${convId}`,
      title: '删除项目',
      description: `确定要删除「${conversation?.name ?? '该项目'}」及其全部任务记录吗？删除后有 6 秒可以撤销。`,
      confirmText: '删除',
      variant: 'destructive',
      onConfirm: () => {
        closeActiveConfirm()
        // Optimistically leave the project, but hold the DELETE until the undo
        // window closes so "undo" is a real restore rather than a re-create.
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
        setPendingDeletionIds(previous => [...previous, convId])

        runWithUndo({
          message: `已删除「${conversation?.name ?? '项目'}」`,
          onUndo: () => {
            setPendingDeletionIds(previous => previous.filter(id => id !== convId))
            showToast('已恢复该项目')
          },
          perform: () => {
            setPendingDeletionIds(previous => previous.filter(id => id !== convId))
            apiFetch<{ status: string }>(`/api/conversations/${convId}`, { method: 'DELETE' })
              .then(() => {
                pendingSendMessagesRef.current.delete(convId)
                forgetConversation(convId)
                emitConversationsChanged()
              })
              .catch(err => {
                console.error(err)
                showToast(describeApiError(err, '删除项目失败'), 'error')
                loadConversations()
              })
          },
        })
      }
    })
  }

  const sendMessage = (customText?: string) => {
    triggerVibration()
    const textToSend = typeof customText === 'string' ? customText : input
    if (!textToSend.trim()) return
    const conversation = activeConvRef.current
    if (!conversation) {
      showToast('请先选择一个项目', 'warning')
      return
    }

    setInput('')
    shouldAutoScrollRef.current = true
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const willQueue = isAgentThinkingRef.current
    if (!willQueue) isAgentThinkingRef.current = true
    setMessages(prev => [
      ...prev,
      {
        localId: nextLocalId(),
        role: 'user',
        content: textToSend.trim(),
        timestamp: new Date().toISOString(),
        provider: conversation.provider,
        isOptimistic: true,
      },
      {
        localId: nextLocalId(),
        role: 'agent',
        content: '',
        thought: '',
        isThinking: !willQueue,
        isQueued: willQueue,
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
      || socketConversationIdRef.current !== conversation.id
    ) {
      const pending = pendingSendMessagesRef.current.get(conversation.id) || []
      pendingSendMessagesRef.current.set(conversation.id, [...pending, payload])
      showToast('连接中，重连成功后将自动发送…', 'info')
      connectWebSocket(conversation, true)
      return
    }

    currentSocket.send(JSON.stringify(payload))
    if (willQueue) showToast('任务已加入队列', 'info')
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
    const snapshot = messages
    requestConfirm({
      id: `clear-history-${conversationId}`,
      title: '清空对话记录',
      description: '将删除该项目的全部消息、总结与排队任务。清空后有 6 秒可以撤销。',
      confirmText: '清空',
      variant: 'destructive',
      onConfirm: () => {
        closeActiveConfirm()
        // Empty the view immediately, but only tell the server once the undo
        // window closes — the rows are gone for good after that.
        if (activeConvRef.current?.id === conversationId) {
          historyRequestRef.current += 1
          isAgentThinkingRef.current = false
          setMessages([])
        }

        runWithUndo({
          message: '对话记录已清空',
          onUndo: () => {
            if (activeConvRef.current?.id === conversationId) {
              setMessages(snapshot)
            }
            showToast('已恢复对话记录')
          },
          perform: () => {
            apiFetch<{ status: string }>(`/api/history/${conversationId}`, { method: 'DELETE' })
              .then(() => {
                pendingSendMessagesRef.current.delete(conversationId)
                remove(`orbitpane_history_${conversationId}`)
                emitTaskChange()
              })
              .catch(err => {
                console.error(err)
                showToast(describeApiError(err, '清空失败，正在恢复'), 'error')
                void loadHistory(conversationId)
              })
          },
        })
      }
    })
  }

  const summarizeMessages = () => {
    if (!activeConv) return
    const conversationId = activeConv.id
    apiFetch<{ status: string }>(`/api/conversations/${conversationId}/summarize`, { method: 'POST' })
      .then(() => {
        showToast('对话总结任务已提交', 'info')
      })
      .catch(err => {
        console.error(err)
        showToast(describeApiError(err, '生成总结失败'), 'error')
      })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const copyMessageText = useCallback((text: string, messageKey: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => {
        setCopiedMessageKey(messageKey)
        showToast('已复制到剪贴板')
        window.setTimeout(() => {
          setCopiedMessageKey(current => (current === messageKey ? null : current))
        }, 2000)
      })
      .catch(() => showToast('复制失败，请检查浏览器权限', 'error'))
  }, [showToast])

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

  /**
   * Ratings are stored on the message row, not in component state.
   *
   * This used to live in a `Record<arrayIndex, 'up' | 'down'>` that was never
   * sent anywhere and drifted onto unrelated messages as soon as the history
   * reloaded and the array re-ordered.
   */
  const handleFeedback = useCallback((messageId: number | undefined, type: 'up' | 'down') => {
    const conversationId = activeConvRef.current?.id
    if (!conversationId || messageId === undefined) {
      showToast('该消息尚未保存，稍后再试', 'warning')
      return
    }

    let previous: MessageFeedback = ''
    let next: MessageFeedback = type
    setMessages(current => current.map(message => {
      if (message.id !== messageId) return message
      previous = message.feedback ?? ''
      next = previous === type ? '' : type
      return { ...message, feedback: next }
    }))

    apiFetch<{ feedback: MessageFeedback }>(
      `/api/conversations/${conversationId}/messages/${messageId}/feedback`,
      { method: 'PATCH', body: JSON.stringify({ feedback: next }) },
    ).catch(error => {
      console.error(error)
      setMessages(current => current.map(message => (
        message.id === messageId ? { ...message, feedback: previous } : message
      )))
      showToast('反馈保存失败', 'error')
    })
  }, [activeConvRef, setMessages, showToast])

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
      showToast('无法重新生成，请检查连接状态', 'error')
    }
  }

  const handleLogin = () => {
    setIsLoggedIn(true)
  }

  /**
   * True when the create form holds anything the user typed or chose.
   *
   * The old check only looked at the name and the browsed path, so switching
   * the agent or the permission mode and then clicking the scrim discarded
   * those choices with no warning at all.
   */
  const hasUnsavedDraftProject = useMemo(() => (
    drawerMode === 'create' && (
      newConvName.trim() !== ''
      || (selectedDir !== '' && selectedDir !== defaultWorkspaceRoot)
      || (currentPath !== '' && currentPath !== defaultWorkspaceRoot)
      || (selectedProvider !== '' && selectedProvider !== defaultProvider)
      || selectedPermissionMode !== 'workspace'
    )
  ), [
    currentPath, defaultProvider, defaultWorkspaceRoot, drawerMode,
    newConvName, selectedDir, selectedPermissionMode, selectedProvider,
  ])

  const requestCloseDrawer = useCallback(() => {
    if (!hasUnsavedDraftProject) {
      setIsDrawerOpen(false)
      return
    }
    requestConfirm({
      id: 'discard-draft-project',
      title: '放弃新建项目',
      description: '名称、目录、Agent 与权限设置都会丢失，确定要关闭吗？',
      confirmText: '放弃',
      variant: 'destructive',
      onConfirm: () => setIsDrawerOpen(false),
    })
  }, [hasUnsavedDraftProject, requestConfirm])

  /** Drop a starter suggestion into the composer rather than sending blind. */
  const applyStarterPrompt = useCallback((prompt: string) => {
    setInput(current => (current.trim() ? `${current.trim()}\n${prompt}` : prompt))
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }, [])

  const showProjectHome = () => {
    const conversationId = activeConvRef.current?.id
    if (conversationId && messagesContainerRef.current) {
      conversationScrollPositionsRef.current.set(conversationId, messagesContainerRef.current.scrollTop)
    }
    activeConvRef.current = null
    setActiveConv(null)
    setMessages([])
    setCopiedMessageKey(null)
    historyRequestRef.current += 1
    disconnectCurrentSocket()
    window.dispatchEvent(new CustomEvent(CLOSE_INSPECTOR_EVENT))
    const url = new URL(window.location.href)
    url.searchParams.delete('id')
    url.searchParams.delete('panel')
    window.history.replaceState({}, '', url.toString())
  }

<<<<<<< Updated upstream
  /* A project awaiting its undo window still exists server-side, so hide it
     locally instead of letting the next list refresh bring it back. */
  const visibleConversations = pendingDeletionIds.length === 0
    ? conversations
    : conversations.filter(conversation => !pendingDeletionIds.includes(conversation.id))
=======
  const handleCloseDrawerWithConfirm = useCallback(() => {
    if (drawerMode === 'create' && (newConvName.trim() || currentPath !== defaultWorkspaceRoot)) {
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
  }, [drawerMode, newConvName, currentPath, defaultWorkspaceRoot])

  const scrimTouchRef = useRef<{ startX: number; startY: number; isDragging: boolean } | null>(null)

  const handleScrimPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    scrimTouchRef.current = { startX: e.clientX, startY: e.clientY, isDragging: false }
  }, [])

  const handleScrimPointerMove = useCallback((e: React.PointerEvent) => {
    const start = scrimTouchRef.current
    if (!start) return
    const deltaX = e.clientX - start.startX
    const deltaY = Math.abs(e.clientY - start.startY)

    if (deltaX < -25 && deltaY < Math.abs(deltaX)) {
      start.isDragging = true
    }
  }, [])

  const handleScrimPointerUp = useCallback((e: React.PointerEvent) => {
    const start = scrimTouchRef.current
    scrimTouchRef.current = null
    if (!start) return

    const deltaX = e.clientX - start.startX
    const deltaY = Math.abs(e.clientY - start.startY)

    if (start.isDragging || (deltaX < -35 && deltaY < Math.abs(deltaX))) {
      handleCloseDrawerWithConfirm()
    }
  }, [handleCloseDrawerWithConfirm])

  const handleScrimPointerCancel = useCallback(() => {
    scrimTouchRef.current = null
  }, [])
>>>>>>> Stashed changes

  if (isLoggedIn === null) {
    return <div className="app-container" aria-label="正在验证登录状态" />
  }

  if (!isLoggedIn) {
    return <Login onLogin={handleLogin} />
  }

  const contextValue: AppContextType = {
    theme, toggleTheme, showToast, requestConfirm, isDrawerOpen, setIsDrawerOpen,
    drawerMode, setDrawerMode, showProjectHome, requestCloseDrawer,
    activeTaskCount: mobileTaskCount,
    isCmdPaletteOpen, setIsCmdPaletteOpen,
    conversations: visibleConversations,
    isConversationsLoading, activeConv, setActiveConv,
    deleteConversation, createConversation, loadConversations, selectConversation,
    updateConversation,
    editingConvId, setEditingConvId, editingConvName, setEditingConvName,
    startEditingConv, saveConvName, providers, defaultProvider,
    selectedProvider, setSelectedProvider, models, selectedModel,
    selectedPermissionMode, setSelectedPermissionMode,
    setSelectedModel, loadModels, loadProviders, getProviderBadge,
    formatModelName, workspaceRoots, defaultWorkspaceRoot,
    currentPath, setCurrentPath, items, selectedDir,
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
<<<<<<< Updated upstream
            className="drawer-scrim"
            onClick={requestCloseDrawer}
=======
            className="drawer-scrim" 
            onClick={() => {
              if (scrimTouchRef.current?.isDragging) return
              handleCloseDrawerWithConfirm()
            }}
            onPointerDown={handleScrimPointerDown}
            onPointerMove={handleScrimPointerMove}
            onPointerUp={handleScrimPointerUp}
            onPointerCancel={handleScrimPointerCancel}
>>>>>>> Stashed changes
          />
        )}
      </AnimatePresence>

      {/* Sidebar Drawer */}
      <Sidebar />

      {/* Main Chat Area */}
      <div className="chat-main">
        {!isOnline && (
          <div className="offline-banner" role="status">
            <WifiOff size={13} />
            <span>当前离线：可查看缓存并继续编辑草稿，恢复网络后自动重连</span>
          </div>
        )}
        <ChatHeader />

        <div
          className="chat-messages"
          data-conversation-export
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={handleMessagesScrollIntent}
          onTouchStart={event => {
            handleMessagesScrollIntent()
            handlePullStart(event)
          }}
          onTouchMove={handlePullMove}
          onTouchEnd={handlePullEnd}
          onTouchCancel={handlePullEnd}
          onPointerDown={handleMessagesScrollIntent}
          onKeyDownCapture={handleMessagesScrollIntent}
        >
          <div
            className={`pull-refresh-indicator ${pullDistance >= 54 || isPullRefreshing ? 'ready' : ''}`}
            style={{ height: pullDistance }}
            aria-hidden="true"
          >
            <RefreshCw size={15} className={isPullRefreshing ? 'animate-spin' : ''} />
            <span>{isPullRefreshing ? '正在同步' : pullDistance >= 54 ? '松开刷新' : '下拉刷新'}</span>
          </div>
          <div className="chat-message-list" ref={messagesContentRef}>
            {(isHistoryLoading && (!activeConv || messages.filter(m => m.role !== 'system').length === 0)) ? (
              <div className="chat-history-loading" aria-label="正在加载对话">
                <div className="history-skeleton history-skeleton-agent skeleton-shimmer" />
                <div className="history-skeleton history-skeleton-user skeleton-shimmer" />
                <div className="history-skeleton history-skeleton-agent short skeleton-shimmer" />
              </div>
            ) : (!activeConv || messages.filter(m => m.role !== 'system').length === 0) ? (
              <WelcomeScreen
                activeConv={activeConv}
                messages={messages}
                setIsDrawerOpen={setIsDrawerOpen}
                setDrawerMode={setDrawerMode}
                conversations={visibleConversations}
                selectConversation={selectConversation}
                onUseStarter={applyStarterPrompt}
              />
            ) : (
              <MessageList
                key={activeConv.id}
                messages={messages}
                copiedMessageKey={copiedMessageKey}
                isAgentThinking={!!isAgentThinking}
                copyMessageText={copyMessageText}
                handleFeedback={handleFeedback}
                regenerateLastResponse={regenerateLastResponse}
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
            loadModels={loadModels}
            socketRef={socketRef}
            connectWebSocket={connectWebSocket}
            showToast={showToast}
            setIsDrawerOpen={setIsDrawerOpen}
          />
        </div>
      </div>

      <Suspense fallback={null}>
        <WorkspaceInspector
          onActiveTaskCountChange={setMobileTaskCount}
        />
      </Suspense>

      {/* Command Palette */}
      <Suspense fallback={null}>
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
          onSelectConv={(id, messageId) => {
            const found = visibleConversations.find(c => c.id === id)
            if (found) {
              selectConversation(found)
              if (messageId) {
                window.setTimeout(() => {
                  document.querySelector(`[data-message-id="${messageId}"]`)?.scrollIntoView({
                    block: 'center',
                    behavior: 'smooth',
                  })
                }, 350)
              }
            }
          }}
          conversations={visibleConversations}
          showToast={showToast}
          isAgentThinking={!!isAgentThinking}
        />
      </Suspense>

      {/* PWA Mobile Install Prompt */}
      <Suspense fallback={null}>
        <PwaInstallPrompt showToast={showToast} />
      </Suspense>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* One dialog at a time; further requests wait their turn in the queue. */}
      <ConfirmDialog
        isOpen={activeConfirm !== null}
        title={activeConfirm?.title ?? ''}
        description={activeConfirm?.description ?? ''}
        confirmText={activeConfirm?.confirmText ?? '确认'}
        cancelText={activeConfirm?.cancelText ?? '取消'}
        variant={activeConfirm?.variant ?? 'default'}
        onConfirm={() => {
          const request = activeConfirm
          if (!request) return
          // Handlers that need the dialog to stay open call closeActiveConfirm
          // themselves; the default is to dismiss.
          request.onConfirm()
          setConfirmQueue(queue => (queue[0] === request ? queue.slice(1) : queue))
        }}
        onCancel={() => {
          activeConfirm?.onCancel?.()
          closeActiveConfirm()
        }}
      />
    </div>
    </AppContext.Provider>
  )
}
