import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import type { Conversation, Message } from '../lib/types'

export interface RealtimeEvent {
  type: string
  conversation_id?: number
  run_id?: string
  sequence?: number
  user_content?: string
  content?: string
  thought?: string
  full_content?: string
  full_thought?: string
  elapsed?: number
  duration?: number
  model?: string
  provider?: string
  code?: string
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function ensureRunAgent(
  messages: Message[],
  event: RealtimeEvent,
): { messages: Message[]; agentIndex: number } {
  const next = [...messages]
  const runId = event.run_id
  const existingAgentIndex = runId
    ? next.findIndex(message => message.role === 'agent' && message.run_id === runId)
    : -1
  let userIndex = runId
    ? next.findIndex(message => message.role === 'user' && message.run_id === runId)
    : -1

  if (runId && userIndex < 0 && typeof event.user_content === 'string') {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index]
      if (
        message.role === 'user'
        && !message.run_id
        && message.content === event.user_content
      ) {
        userIndex = index
        next[index] = { ...message, run_id: runId, isOptimistic: false }
        break
      }
    }
    if (userIndex < 0) {
      const userMessage: Message = {
        role: 'user',
        content: event.user_content,
        timestamp: new Date().toISOString(),
        provider: event.provider,
        run_id: runId,
      }
      if (existingAgentIndex >= 0) {
        userIndex = existingAgentIndex
        next.splice(existingAgentIndex, 0, userMessage)
      } else {
        userIndex = next.length
        next.push(userMessage)
      }
    }
  }

  let agentIndex = runId
    ? next.findIndex(message => message.role === 'agent' && message.run_id === runId)
    : -1

  if (agentIndex < 0 && runId && userIndex >= 0) {
    const candidateIndex = userIndex + 1
    const candidate = next[candidateIndex]
    if (
      candidate
      && candidate.role === 'agent'
      && !candidate.run_id
      && candidate.isThinking
    ) {
      agentIndex = candidateIndex
      next[agentIndex] = {
        ...candidate,
        run_id: runId,
        isOptimistic: false,
      }
    }
  }

  if (agentIndex < 0 && !runId) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (next[index].role === 'agent' && next[index].isThinking) {
        agentIndex = index
        break
      }
    }
  }

  if (agentIndex < 0) {
    agentIndex = next.length
    next.push({
      role: 'agent',
      content: '',
      thought: '',
      isThinking: true,
      elapsedSoFar: isFiniteNumber(event.elapsed) ? event.elapsed : 0,
      model: event.model,
      provider: event.provider,
      run_id: runId,
      streamSequence: -1,
    })
  }

  return { messages: next, agentIndex }
}

export function applyRealtimeEvent(messages: Message[], event: RealtimeEvent): Message[] {
  const ensured = ensureRunAgent(messages, event)
  const next = ensured.messages
  const current = next[ensured.agentIndex]
  const currentSequence = current.streamSequence ?? -1
  const incomingSequence = isFiniteNumber(event.sequence)
    ? event.sequence
    : currentSequence + 1
  const elapsed = isFiniteNumber(event.elapsed)
    ? Math.max(current.elapsedSoFar ?? 0, event.elapsed)
    : current.elapsedSoFar
  const common = {
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(elapsed !== undefined ? { elapsedSoFar: elapsed } : {}),
    isOptimistic: false,
  }

  if (event.type !== 'done' && current.streamFinished) {
    return next
  }

  if (event.type === 'start') {
    if (incomingSequence < currentSequence) return next
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'sync_state') {
    if (incomingSequence < currentSequence) return next
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: event.content ?? '',
      thought: event.thought ?? '',
      isThinking: true,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'elapsed') {
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
    }
  } else if (event.type === 'thought' || event.type === 'token' || event.type === 'answer') {
    if (incomingSequence <= currentSequence) {
      next[ensured.agentIndex] = { ...current, ...common }
      return next
    }
    const content = event.content ?? ''
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: event.full_content ?? (
        event.type === 'thought' ? current.content : current.content + content
      ),
      thought: event.full_thought ?? (
        event.type === 'thought' ? (current.thought ?? '') + content : current.thought
      ),
      isThinking: true,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'done') {
    const duration = isFiniteNumber(event.duration)
      ? event.duration
      : (isFiniteNumber(event.elapsed) ? event.elapsed : current.elapsedSoFar)
    const hasCurrentNewerContent = incomingSequence < currentSequence
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: hasCurrentNewerContent ? current.content : (event.content ?? current.content),
      thought: hasCurrentNewerContent ? current.thought : (event.thought ?? current.thought),
      isThinking: false,
      streamFinished: true,
      streamSequence: Math.max(currentSequence, incomingSequence),
      ...(duration !== undefined
        ? { thinkingDuration: duration, elapsedSoFar: duration }
        : {}),
    }
  }

  return next
}

export function mergeHistoryWithTransientMessages(
  history: Message[],
  current: Message[],
): Message[] {
  const merged = history.map(message => ({ ...message }))
  const trackedRunIds = new Set(current.flatMap(message => (
    message.run_id
    && (
      message.isThinking
      || message.streamSequence !== undefined
    )
      ? [message.run_id]
      : []
  )))
  const transient = current.filter(message => (
    message.isOptimistic
    || (message.run_id !== undefined && trackedRunIds.has(message.run_id))
    || (message.isThinking && !message.run_id)
    || message.role === 'system'
  ))

  for (const message of transient) {
    let matchingIndex = -1
    if (message.run_id) {
      matchingIndex = merged.findIndex(candidate => (
        candidate.role === message.role && candidate.run_id === message.run_id
      ))
    } else if (message.role === 'user' && message.isOptimistic) {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index].role === 'user' && merged[index].content === message.content) {
          matchingIndex = index
          break
        }
      }
    }

    if (matchingIndex < 0) {
      merged.push(message)
      continue
    }

    if (message.role === 'agent') {
      merged[matchingIndex] = {
        ...merged[matchingIndex],
        isThinking: false,
        streamFinished: true,
      }
    }
  }

  return merged
}

export function useWebSocket(
  activeConv: Conversation | null,
  showToast: (msg: string) => void,
  loadConversations: (isInitial?: boolean) => void,
  scrollToBottom: (smooth?: boolean) => void
) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const socketConversationIdRef = useRef<number | null>(null)
  const activeConvRef = useRef<Conversation | null>(activeConv)
  const isAgentThinkingRef = useRef<boolean>(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef<number>(0)
  const historyRequestRef = useRef(0)
  const pendingSendMessagesRef = useRef(new Map<
    number,
    { content: string; model: string; provider: string }
  >())

  useEffect(() => {
    activeConvRef.current = activeConv
  }, [activeConv])

  const isAgentThinking = [...messages].reverse().find(m => m.role === 'agent')?.isThinking ?? false
  useEffect(() => {
    isAgentThinkingRef.current = isAgentThinking
  }, [isAgentThinking])

  const disconnectCurrentSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const currentSocket = socketRef.current
    socketRef.current = null
    socketConversationIdRef.current = null
    if (currentSocket) {
      currentSocket.onopen = null
      currentSocket.onmessage = null
      currentSocket.onerror = null
      currentSocket.onclose = null
      try { currentSocket.close() } catch {}
    }
    setIsConnected(false)
    setIsReconnecting(false)
  }, [])

  const loadHistory = useCallback((convId: number, silent = false) => {
    if (!silent) setIsHistoryLoading(true)
    const requestId = ++historyRequestRef.current
    apiFetch<Message[]>(`/api/history/${convId}`)
      .then(data => {
        if (
          requestId !== historyRequestRef.current
          || activeConvRef.current?.id !== convId
        ) return
        if (!silent) setIsHistoryLoading(false)
        const history = Array.isArray(data) ? data : []
        setMessages(current => {
          const merged = mergeHistoryWithTransientMessages(history, current)
          isAgentThinkingRef.current = merged.some(message => (
            message.role === 'agent' && message.isThinking
          ))
          return merged
        })
        setTimeout(() => scrollToBottom(false), 100)
      })
      .catch(err => {
        console.error(err)
        if (
          requestId === historyRequestRef.current
          && activeConvRef.current?.id === convId
        ) {
          if (!silent) setIsHistoryLoading(false)
          setMessages(current => {
            const merged = mergeHistoryWithTransientMessages([], current)
            isAgentThinkingRef.current = merged.some(message => (
              message.role === 'agent' && message.isThinking
            ))
            return merged
          })
        }
      })
  }, [scrollToBottom])

  const connectWebSocket = useCallback((conv: Conversation, isManual = false) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const currentSocket = socketRef.current
    const isCurrentConversation = socketConversationIdRef.current === conv.id
    if (
      currentSocket
      && isCurrentConversation
      && !isManual
      && (
        currentSocket.readyState === WebSocket.OPEN
        || currentSocket.readyState === WebSocket.CONNECTING
      )
    ) {
      if (currentSocket.readyState === WebSocket.OPEN) {
        setIsConnected(true)
        setIsReconnecting(false)
      }
      return
    }

    disconnectCurrentSocket()
    setIsReconnecting(true)
    if (isManual) showToast('正在尝试连接 AI 后台 agent...')

    const loc = window.location
    const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws: WebSocket
    try {
      ws = new WebSocket(`${wsProtocol}//${loc.host}/api/chat`)
    } catch (err) {
      console.error('WS construction error:', err)
      setIsReconnecting(false)
      return
    }

    socketRef.current = ws
    socketConversationIdRef.current = conv.id
    let awaitingPendingStart = false

    const belongsToActiveConversation = () => (
      socketRef.current === ws
      && socketConversationIdRef.current === conv.id
      && activeConvRef.current?.id === conv.id
    )

    ws.onopen = () => {
      if (!belongsToActiveConversation()) return
      setIsConnected(true)
      setIsReconnecting(false)
      reconnectAttemptRef.current = 0
      if (isManual) showToast('已成功连接后台 AI agent')
      ws.send(JSON.stringify({ conversation_id: conv.id }))

      const pending = pendingSendMessagesRef.current.get(conv.id)
      if (pending) {
        awaitingPendingStart = true
        pendingSendMessagesRef.current.delete(conv.id)
        ws.send(JSON.stringify(pending))
      }
    }

    ws.onmessage = event => {
      if (!belongsToActiveConversation()) return
      try {
        const data = JSON.parse(event.data) as RealtimeEvent
        if (
          isFiniteNumber(data.conversation_id)
          && data.conversation_id !== conv.id
        ) return

        if (data.type === 'ready') {
          if (!awaitingPendingStart) {
            isAgentThinkingRef.current = false
            setMessages(previous => previous.map(message => (
              message.isThinking
                ? { ...message, isThinking: false, streamFinished: true }
                : message
            )))
          }
          loadHistory(conv.id, true)
          return
        }

        if (
          data.type === 'start'
          || data.type === 'sync_state'
          || data.type === 'elapsed'
          || data.type === 'thought'
          || data.type === 'token'
          || data.type === 'answer'
          || data.type === 'done'
        ) {
          if (data.type === 'start') awaitingPendingStart = false
          setMessages(previous => {
            if (activeConvRef.current?.id !== conv.id) return previous
            const updated = applyRealtimeEvent(previous, data)
            isAgentThinkingRef.current = updated.some(message => (
              message.role === 'agent' && message.isThinking
            ))
            return updated
          })
          if (data.type === 'done') {
            loadConversations(false)
            loadHistory(conv.id, true)
          }
          return
        }

        if (data.type === 'error') {
          if (data.code === 'unauthorized') {
            window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
            return
          }
          const requestRejected = (
            data.code === 'busy'
            || data.code === 'invalid_request'
            || data.code === 'not_found'
          )
          if (requestRejected) awaitingPendingStart = false
          setMessages(previous => {
            if (activeConvRef.current?.id !== conv.id) return previous
            const next = requestRejected
              ? previous.filter(message => !message.isOptimistic)
              : [...previous]
            next.push({
              role: 'system',
              content: `处理异常: ${data.content ?? '未知错误'}`,
              isError: true,
            })
            if (requestRejected) {
              isAgentThinkingRef.current = next.some(message => (
                message.role === 'agent' && message.isThinking
              ))
            }
            return next
          })
        }
      } catch (err) {
        console.error('WS message parse error:', err)
      }
    }

    ws.onerror = err => {
      if (socketRef.current === ws) console.error('WS error:', err)
    }

    ws.onclose = event => {
      if (
        socketRef.current !== ws
        || socketConversationIdRef.current !== conv.id
      ) return
      socketRef.current = null
      socketConversationIdRef.current = null
      setIsConnected(false)
      setIsReconnecting(false)

      if (activeConvRef.current?.id !== conv.id) return
      const attempt = reconnectAttemptRef.current
      reconnectAttemptRef.current = attempt + 1
      const delay = Math.min(1000 * Math.pow(1.5, Math.min(attempt, 6)), 10000)
      console.log(`[WS] Disconnected (code ${event.code}). Auto-reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`)
      reconnectTimerRef.current = setTimeout(() => {
        if (!socketRef.current && activeConvRef.current?.id === conv.id) {
          connectWebSocket(activeConvRef.current, false)
        }
      }, delay)
    }
  }, [disconnectCurrentSocket, loadConversations, loadHistory, showToast])

  return {
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
  }
}
