import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch, describeApiError } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import { bindRunLocalId, ensureLocalId, ensureLocalIds } from '../lib/messageIdentity'
import { asOptionalText, asText, normalizeMessages } from '../lib/normalize'
import { cacheHistory, readCachedHistory, remove } from '../lib/storage'
import { broadcast, emitTaskChange } from '../lib/appEvents'
import type { Conversation, HealthStatus, Message, TaskRecord } from '../lib/types'

export interface RealtimeEvent {
  schedule_id?: number | null
  schedule_name?: string
  scheduled_for?: string
  type: string
  request_id?: string
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
  inactive_seconds?: number
  health_status?: HealthStatus
  status_message?: string
  model?: string
  provider?: string
  code?: string
  /** Verbatim agent output accompanying an `error` event, when there is any. */
  detail?: string
  status?: string
  input_chars?: number
  output_chars?: number
  context_chars?: number
  task?: TaskRecord
  queue?: TaskRecord[]
}

function scheduleMetadata(value: RealtimeEvent | TaskRecord): Partial<Message> {
  return value.schedule_name ? {
    schedule_id: value.schedule_id,
    schedule_name: value.schedule_name,
    scheduled_for: value.scheduled_for,
  } : {}
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function moveResponseAfterPrompt(
  messages: Message[],
  responseIndex: number,
  promptIndex: number,
): number {
  if (responseIndex === promptIndex + 1) return responseIndex
  const [response] = messages.splice(responseIndex, 1)
  if (responseIndex < promptIndex) promptIndex -= 1
  const targetIndex = promptIndex + 1
  messages.splice(targetIndex, 0, response)
  return targetIndex
}

/**
 * Attach the server acknowledgement to the optimistic turn that produced it.
 *
 * A socket can acknowledge several sends after React has already rendered all
 * of them. Picking the last unbound user row swaps run ids in that case, so the
 * eventual replies appear beside the wrong prompts. Acknowledgements arrive in
 * send order; bind the oldest matching optimistic turn instead.
 */
export function applySubmittedTask(messages: Message[], task: TaskRecord, requestId?: string): Message[] {
  const next = [...messages]
  let userIndex = requestId ? next.findIndex(message => (
    message.role === 'user' && message.request_id === requestId
  )) : -1
  if (userIndex < 0) userIndex = next.findIndex(message => (
    message.role === 'user' && message.run_id === task.run_id
  ))

  if (userIndex < 0 && !requestId && !task.schedule_name) {
    const optimisticUserIndexes = next.flatMap((message, index) => (
      message.role === 'user' && message.isOptimistic && !message.run_id
        ? [index]
        : []
    ))
    userIndex = optimisticUserIndexes.find(index => next[index].content === task.prompt)
      ?? optimisticUserIndexes[0]
      ?? -1
    if (userIndex >= 0) {
      const userMessage = next[userIndex]
      next[userIndex] = {
        ...userMessage,
        run_id: task.run_id,
        isOptimistic: false,
      }
      if (userMessage.localId) {
        bindRunLocalId('user', task.run_id, userMessage.localId)
      }
    }
  }

  if (userIndex < 0 && (requestId || task.schedule_name)) {
    userIndex = next.length
    next.push(ensureLocalId({ role: 'user', content: task.prompt, request_id: requestId, run_id: task.run_id, ...scheduleMetadata(task) }))
    next.push(ensureLocalId({ role: 'agent', content: '', request_id: requestId, run_id: task.run_id, isOptimistic: true, ...scheduleMetadata(task) }))
  }
  if (userIndex >= 0 && requestId) {
    const user = next[userIndex]
    next[userIndex] = { ...user, run_id: task.run_id, isOptimistic: false }
    if (user.localId) bindRunLocalId('user', task.run_id, user.localId)
  }
  let agentIndex = next.findIndex(message => (
    message.role === 'agent' && message.run_id === task.run_id
  ))
  if (agentIndex < 0 && userIndex >= 0) {
    const candidateIndex = userIndex + 1
    const candidate = next[candidateIndex]
    if (
      candidate
      && candidate.role === 'agent'
      && !candidate.run_id
      && candidate.isOptimistic
    ) {
      agentIndex = candidateIndex
      next[agentIndex] = {
        ...candidate,
        run_id: task.run_id,
        isOptimistic: false,
      }
      if (candidate.localId) {
        bindRunLocalId('agent', task.run_id, candidate.localId)
      }
    }
  }

  if (agentIndex >= 0) {
    const isQueued = task.status === 'queued'
    const isTerminal = !['queued', 'starting', 'running'].includes(task.status)
    const currentAgent = next[agentIndex]
    const hasAlreadyStarted = (
      currentAgent.streamSequence !== undefined && !currentAgent.isQueued
    )
    const keepCurrentState = currentAgent.streamFinished || hasAlreadyStarted
    next[agentIndex] = {
      ...currentAgent,
      isThinking: isTerminal ? false : (keepCurrentState ? currentAgent.isThinking : !isQueued),
      ...(isTerminal ? { streamFinished: true } : {}),
      isQueued: keepCurrentState ? currentAgent.isQueued : isQueued,
      queuePosition: keepCurrentState
        ? currentAgent.queuePosition
        : (isQueued ? task.position : undefined),
      isOptimistic: false,
    }
  }

  return next
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
    for (let index = 0; index < next.length; index += 1) {
      const message = next[index]
      if (
        message.role === 'user'
        && !message.run_id
        && !event.schedule_name
        && (event.request_id ? message.request_id === event.request_id : message.content === event.user_content)
      ) {
        userIndex = index
        next[index] = { ...message, run_id: runId, isOptimistic: false }
        // The server's copy of this turn must reuse the key it already has.
        if (message.localId) bindRunLocalId('user', runId, message.localId)
        break
      }
    }
    if (userIndex < 0) {
      const userMessage: Message = ensureLocalId({
        role: 'user',
        content: event.user_content,
        timestamp: new Date().toISOString(),
        provider: event.provider,
        run_id: runId,
        ...scheduleMetadata(event),
      })
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
      && (candidate.isThinking || candidate.isQueued)
    ) {
      agentIndex = candidateIndex
      next[agentIndex] = {
        ...candidate,
        run_id: runId,
        isOptimistic: false,
      }
      if (candidate.localId) bindRunLocalId('agent', runId, candidate.localId)
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
    const agentMessage = ensureLocalId({
      role: 'agent',
      content: '',
      thought: '',
      isThinking: true,
      isQueued: false,
      elapsedSoFar: isFiniteNumber(event.elapsed) ? event.elapsed : 0,
      model: event.model,
      provider: event.provider,
      run_id: runId,
      streamSequence: -1,
      ...scheduleMetadata(event),
    })
    // A response belongs immediately after its user prompt. Appending it to
    // the whole list puts reconnect/sync replies below turns that were queued
    // later, making those queued prompts look as if they preceded the reply
    // currently being generated.
    agentIndex = userIndex >= 0 ? userIndex + 1 : next.length
    next.splice(agentIndex, 0, agentMessage)
  } else if (userIndex >= 0 && agentIndex !== userIndex + 1) {
    // Repair an already-misordered transient row as soon as another event for
    // that run arrives. This also covers state restored by an older cache.
    agentIndex = moveResponseAfterPrompt(next, agentIndex, userIndex)
  }

  return { messages: next, agentIndex }
}

export function applyRealtimeEvent(
  messages: Message[], event: RealtimeEvent,
  prepared?: { messages: Message[]; agentIndex: number },
): Message[] {
  const ensured = prepared ?? ensureRunAgent(messages, event)
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
    ...scheduleMetadata(event),
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(elapsed !== undefined ? { elapsedSoFar: elapsed } : {}),
    ...(isFiniteNumber(event.inactive_seconds) ? { inactiveSeconds: event.inactive_seconds } : {}),
    ...(event.health_status ? { healthStatus: event.health_status } : {}),
    ...(event.status_message !== undefined ? { statusMessage: event.status_message } : {}),
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
      isQueued: false,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'sync_state') {
    if (incomingSequence < currentSequence) return next
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: asText(event.content),
      thought: asText(event.thought),
      isThinking: true,
      isQueued: false,
      streamSequence: incomingSequence,
    }
  } else if (event.type === 'elapsed') {
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
      isQueued: false,
    }
  } else if (event.type === 'status') {
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      isThinking: true,
      isQueued: false,
    }
  } else if (event.type === 'thought' || event.type === 'token' || event.type === 'answer') {
    if (incomingSequence <= currentSequence) {
      next[ensured.agentIndex] = { ...current, ...common }
      return next
    }
    const content = asText(event.content)
    next[ensured.agentIndex] = {
      ...current,
      ...common,
      content: asOptionalText(event.full_content) ?? (
        event.type === 'thought' ? current.content : current.content + content
      ),
      thought: asOptionalText(event.full_thought) ?? (
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
      content: hasCurrentNewerContent
        ? current.content
        : (asOptionalText(event.content) ?? current.content),
      thought: hasCurrentNewerContent
        ? current.thought
        : (asOptionalText(event.thought) ?? current.thought),
      isThinking: false,
      isQueued: false,
      streamFinished: true,
      healthStatus: undefined,
      statusMessage: undefined,
      inactiveSeconds: undefined,
      streamSequence: Math.max(currentSequence, incomingSequence),
      ...(duration !== undefined
        ? { thinkingDuration: duration, elapsedSoFar: duration }
        : {}),
      input_chars: event.input_chars ?? current.input_chars,
      output_chars: event.output_chars ?? current.output_chars,
      context_chars: event.context_chars ?? current.context_chars,
    }
  }

  return next
}

/** One array copy and one run index per frame, independent of token count. */
export function applyRealtimeEvents(messages: Message[], events: RealtimeEvent[]): Message[] {
  let next = [...messages]
  const agents = new Map<string, number>()
  const users = new Map<string, number>()
  const indexRuns = () => {
    agents.clear()
    users.clear()
    next.forEach((message, index) => {
      if (!message.run_id) return
      if (message.role === 'agent') agents.set(message.run_id, index)
      if (message.role === 'user') users.set(message.run_id, index)
    })
  }
  indexRuns()
  for (const event of events) {
    const index = event.run_id ? agents.get(event.run_id) : undefined
    const userIndex = event.run_id ? users.get(event.run_id) : undefined
    if (index !== undefined && (userIndex !== undefined ? index === userIndex + 1 : !event.user_content)) {
      applyRealtimeEvent(next, event, { messages: next, agentIndex: index })
    } else {
      next = applyRealtimeEvent(next, event)
      indexRuns()
    }
  }
  return next
}

export function mergeHistoryWithTransientMessages(
  history: Message[],
  current: Message[],
): Message[] {
  // `ensureLocalId` resolves each server row through the run-id bridge, so a
  // turn that streamed in this session keeps the key it streamed under.
  const merged = ensureLocalIds(history).map(message => ({ ...message }))
  const trackedRunIds = new Set(current.flatMap(message => (
    message.run_id
    && (
      message.isThinking
      || message.isQueued
      || message.streamSequence !== undefined
    )
      ? [message.run_id]
      : []
  )))
  const transient = current.filter(message => (
    message.isOptimistic
    || (message.run_id !== undefined && trackedRunIds.has(message.run_id))
    || (message.isThinking && !message.run_id)
    || message.deliveryFailed
    || message.role === 'system'
  ))
  const failedScheduledRuns = new Set(history.filter(message => (
    message.role === 'system' && message.isError && message.schedule_name && message.run_id
  )).map(message => message.run_id))

  for (const message of transient) {
    if (message.role === 'agent' && failedScheduledRuns.has(message.run_id)
      && !message.content && !message.isThinking && !message.isQueued) continue
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

  // A silent history refresh can race the first realtime event and otherwise
  // replay a temporarily misordered array. Keep the turn invariant even when
  // no further token happens to arrive immediately afterward.
  for (const runId of trackedRunIds) {
    const userIndex = merged.findIndex(message => (
      message.role === 'user' && message.run_id === runId
    ))
    const agentIndex = merged.findIndex(message => (
      message.role === 'agent' && message.run_id === runId
    ))
    if (userIndex >= 0 && agentIndex >= 0 && agentIndex !== userIndex + 1) {
      moveResponseAfterPrompt(merged, agentIndex, userIndex)
    }
  }

  return merged
}

export function useWebSocket(
  /**
   * The live conversation, shared with `useConversations` rather than mirrored.
   *
   * A private copy synced from a `useEffect` lagged the state it tracked by a
   * commit, and every guard in here reads it to decide whether a reply still
   * belongs to the open project. Selecting a project assigns the ref and calls
   * `loadHistory` in the same tick, so a mirror could still be pointing at the
   * previous project when the response arrived, and drop a transcript the user
   * was looking at.
   */
  activeConvRef: React.MutableRefObject<Conversation | null>,
  showToast: (msg: string) => void,
  loadConversations: (isInitial?: boolean) => void,
  desktopNotifications = true,
) {
  const desktopNotificationsRef = useRef(desktopNotifications)
  desktopNotificationsRef.current = desktopNotifications
  const [messages, setMessages] = useState<Message[]>([])
  const [isHistoryLoading, setIsHistoryLoading] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)
  const socketConversationIdRef = useRef<number | null>(null)
  const isAgentThinkingRef = useRef<boolean>(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastPongRef = useRef(Date.now())
  const reconnectAttemptRef = useRef<number>(0)
  const historyRequestRef = useRef(0)
  const [historyError, setHistoryError] = useState('')
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [isOlderHistoryLoading, setIsOlderHistoryLoading] = useState(false)
  const historyStateRef = useRef<{ id: number; items: Message[]; firstId: number } | null>(null)
  const historyFlightRef = useRef<{ id: number; promise: Promise<Message[] | null>; controller: AbortController } | null>(null)
  const olderFlightRef = useRef<Promise<Message[] | null> | null>(null)
  const refreshAgainRef = useRef(false)
  /**
   * Stream events waiting to be folded into `messages`, with the conversation
   * each one belongs to.
   *
   * An agent emits tokens far faster than a screen refreshes, and every one of
   * them used to commit its own render of the whole transcript. On a long
   * conversation that is where the stutter came from: the work is proportional
   * to the messages already on screen, not to the token that arrived. Folding a
   * frame's worth of events into a single update makes the cost of streaming
   * independent of how fast the agent is talking, and no update is ever skipped
   * — they are applied in order, just together.
   */
  const streamBufferRef = useRef<Array<{ conversationId: number; event: RealtimeEvent }>>([])
  const streamFrameRef = useRef<number | null>(null)
  const pendingSendMessagesRef = useRef(new Map<
    number,
    Array<{ request_id: string; content: string; model: string; provider: string }>
  >())

  const isAgentThinking = messages.some(message => (
    message.role === 'agent' && message.isThinking
  ))
  useEffect(() => {
    isAgentThinkingRef.current = isAgentThinking
  }, [isAgentThinking])

  const clearStreamBuffer = useCallback(() => {
    streamBufferRef.current = []
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
  }, [])

  const flushStreamBuffer = useCallback(() => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current)
      streamFrameRef.current = null
    }
    const queued = streamBufferRef.current
    if (queued.length === 0) return
    streamBufferRef.current = []
    setMessages(previous => {
      const conversationId = activeConvRef.current?.id
      const events = queued.filter(entry => entry.conversationId === conversationId).map(entry => entry.event)
      if (events.length === 0) return previous
      const next = applyRealtimeEvents(previous, events)
      if (next === previous) return previous
      isAgentThinkingRef.current = next.some(message => (
        message.role === 'agent' && message.isThinking
      ))
      return next
    })
  }, [activeConvRef])

  const queueStreamEvent = useCallback((conversationId: number, event: RealtimeEvent) => {
    streamBufferRef.current.push({ conversationId, event })
    if (streamFrameRef.current === null) {
      streamFrameRef.current = requestAnimationFrame(() => {
        streamFrameRef.current = null
        flushStreamBuffer()
      })
    }
  }, [flushStreamBuffer])

  useEffect(() => clearStreamBuffer, [clearStreamBuffer])

  const disconnectCurrentSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    clearStreamBuffer()
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
  }, [clearStreamBuffer])

  const publishHistory = useCallback((items: Message[]) => {
    const firstId = historyStateRef.current?.firstId ?? 0
    setMessages(current => mergeHistoryWithTransientMessages(items, current.filter(message => (
      message.id !== undefined
        ? firstId > 0 && message.id >= firstId
        : !message.streamFinished || firstId > 0
    ))))
  }, [])

  const loadHistory = useCallback((convId: number, silent = false, refreshAgain = false): Promise<Message[] | null> => {
    const flight = historyFlightRef.current
    if (flight?.id === convId && !flight.controller.signal.aborted) {
      if (refreshAgain) refreshAgainRef.current = true
      return flight.promise
    }
    flight?.controller.abort()
    const controller = new AbortController()
    const requestId = ++historyRequestRef.current
    const isCurrent = () => activeConvRef.current?.id === convId && historyRequestRef.current === requestId
    if (historyStateRef.current?.id !== convId) {
      const cached = ensureLocalIds(normalizeMessages(readCachedHistory<unknown>(convId, [])))
      historyStateRef.current = { id: convId, items: cached, firstId: 0 }
      publishHistory(cached)
      setHasOlderHistory(cached.length > 0)
      setIsOlderHistoryLoading(false)
      olderFlightRef.current = null
    }
    if (!silent) setIsHistoryLoading(true)
    setHistoryError('')
    const promise = (async () => {
      try {
        do {
          refreshAgainRef.current = false
          let more = true
          while (more) {
            const snapshot = historyStateRef.current!
            const lastId = snapshot.items.at(-1)?.id
            const page = await apiFetch<{ items: Message[]; has_more: boolean; first_id: number }>(
              `/api/history/${convId}?limit=60${lastId ? `&after_id=${lastId}` : ''}`,
              { signal: controller.signal },
            )
            if (!isCurrent()) return null
            const incoming = ensureLocalIds(normalizeMessages(page.items))
            const current = historyStateRef.current!
            const rows = new Map(current.items.filter(item => page.first_id > 0 && item.id! >= page.first_id).map(item => [item.id!, item]))
            incoming.forEach(item => rows.set(item.id!, item))
            const items = [...rows.values()].sort((a, b) => a.id! - b.id!)
            historyStateRef.current = { id: convId, items, firstId: page.first_id }
            setHasOlderHistory(!!items.length && items[0].id! > page.first_id)
            publishHistory(items)
            cacheHistory(convId, items.slice(-60))
            more = !!lastId && page.has_more
          }
        } while (refreshAgainRef.current)
        return historyStateRef.current!.items
      } catch (error) {
        if (isCurrent() && !controller.signal.aborted) {
          setHistoryError(describeApiError(error, '历史同步失败，当前内容可能不完整'))
        }
        return null
      } finally {
        if (historyFlightRef.current?.controller === controller) {
          historyFlightRef.current = null
          setIsHistoryLoading(false)
        }
      }
    })()
    historyFlightRef.current = { id: convId, promise, controller }
    return promise
  }, [activeConvRef, publishHistory])

  const loadOlderHistory = useCallback((): Promise<Message[] | null> => {
    if (olderFlightRef.current) return olderFlightRef.current
    const snapshot = historyStateRef.current
    if (!snapshot || activeConvRef.current?.id !== snapshot.id || !snapshot.items[0]?.id) return Promise.resolve(null)
    const convId = snapshot.id
    const requestId = historyRequestRef.current
    setIsOlderHistoryLoading(true)
    const promise = apiFetch<{ items: Message[]; has_more: boolean; first_id: number }>(
      `/api/history/${convId}?limit=60&before_id=${snapshot.items[0].id}`,
    ).then(page => {
      if (activeConvRef.current?.id !== convId || historyStateRef.current?.id !== convId
        || historyRequestRef.current !== requestId) return null
      const current = historyStateRef.current
      const rows = new Map([...ensureLocalIds(normalizeMessages(page.items)), ...current.items].map(item => [item.id!, item]))
      const items = [...rows.values()].filter(item => item.id! >= page.first_id).sort((a, b) => a.id! - b.id!)
      historyStateRef.current = { id: convId, items, firstId: page.first_id }
      setHasOlderHistory(page.has_more)
      setHistoryError('')
      publishHistory(items)
      return items
    }).catch(error => {
      if (activeConvRef.current?.id === convId) setHistoryError(describeApiError(error, '较早消息加载失败，请重试'))
      return null
    }).finally(() => {
      if (olderFlightRef.current === promise) {
        olderFlightRef.current = null
        setIsOlderHistoryLoading(false)
      }
    })
    olderFlightRef.current = promise
    return promise
  }, [activeConvRef, publishHistory])

  const loadAllHistory = useCallback(async () => {
    const convId = activeConvRef.current?.id
    if (!convId) return null
    await historyFlightRef.current?.promise
    if (activeConvRef.current?.id !== convId) return null
    const requestId = historyRequestRef.current
    const rows = await apiFetch<Message[]>(`/api/history/${convId}`)
    if (activeConvRef.current?.id !== convId || historyRequestRef.current !== requestId) return null
    const items = ensureLocalIds(normalizeMessages(rows))
    historyStateRef.current = { id: convId, items, firstId: items[0]?.id ?? 0 }
    setHasOlderHistory(false)
    publishHistory(items)
    return items
  }, [activeConvRef, publishHistory])

  useEffect(() => () => { historyFlightRef.current?.controller.abort() }, [])

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
      lastPongRef.current = Date.now()
      if (isManual) showToast('已成功连接后台 AI agent')
      ws.send(JSON.stringify({ conversation_id: conv.id }))

      const pending = pendingSendMessagesRef.current.get(conv.id) || []
      if (pending.length > 0) {
        awaitingPendingStart = true
        pending.forEach(message => ws.send(JSON.stringify(message)))
      }

      heartbeatTimerRef.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastPongRef.current > 45_000) {
          ws.close(4000, 'heartbeat timeout')
          return
        }
        ws.send(JSON.stringify({ action: 'ping' }))
      }, 20_000)
    }

    ws.onmessage = event => {
      if (!belongsToActiveConversation()) return
      try {
        const data = JSON.parse(event.data) as RealtimeEvent
        if (
          isFiniteNumber(data.conversation_id)
          && data.conversation_id !== conv.id
        ) return

        if (data.type === 'pong') {
          lastPongRef.current = Date.now()
          return
        }

        if (data.type === 'submitted' && data.task) {
          const task = data.task
          if (data.request_id) {
            const pending = pendingSendMessagesRef.current.get(conv.id) || []
            pendingSendMessagesRef.current.set(conv.id, pending.filter(message => message.request_id !== data.request_id))
          }
          setMessages(previous => applySubmittedTask(previous, task, data.request_id))
          if (!['queued', 'starting', 'running'].includes(task.status)) loadHistory(conv.id, true, true)
          emitTaskChange()
          return
        }

        if (data.type === 'queue_changed') {
          const positions = new Map((data.queue || []).map(task => [task.run_id, task.position]))
          setMessages(previous => {
            let next = previous
            for (const task of data.queue || []) {
              if (task.schedule_name) next = applySubmittedTask(next, task)
            }
            const removedScheduled = new Set(next.filter(message => (
              message.schedule_name && message.isQueued && message.run_id && !positions.has(message.run_id)
            )).map(message => message.run_id))
            return next.filter(message => !removedScheduled.has(message.run_id)).map(message => {
            if (!message.run_id || !message.isQueued) return message
            const position = positions.get(message.run_id)
            return position
              ? { ...message, queuePosition: position }
              : {
                  ...message,
                  isQueued: false,
                  queuePosition: undefined,
                  // Leaving the queue normally means this run is starting.
                  // Marking it finished here made the following `start` and
                  // token events get discarded as stale.
                  streamFinished: false,
                }
            })
          })
          emitTaskChange()
          return
        }

        if (data.type === 'schedules_changed' || data.type === 'checkpoint_created') {
          emitTaskChange()
          loadHistory(conv.id, true, true)
          return
        }

        if (data.type === 'sync_state' && data.queue) {
          setMessages(previous => data.queue!.reduce((current, task) => (
            task.schedule_name ? applySubmittedTask(current, task) : current
          ), previous))
        }

        if (data.type === 'history_cleared') {
          // The server dropped messages, summaries and the whole queue, so no
          // transient turn may survive here either — including tokens still
          // sitting in the frame buffer.
          clearStreamBuffer()
          historyRequestRef.current += 1
          isAgentThinkingRef.current = false
          awaitingPendingStart = false
          pendingSendMessagesRef.current.delete(conv.id)
          historyFlightRef.current?.controller.abort()
          historyFlightRef.current = null
          historyStateRef.current = { id: conv.id, items: [], firstId: 0 }
          setHasOlderHistory(false)
          setIsHistoryLoading(false)
          setHistoryError('')
          remove(`orbitpane_history_${conv.id}`)
          setMessages([])
          emitTaskChange()
          return
        }

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
          || data.type === 'status'
          || data.type === 'thought'
          || data.type === 'token'
          || data.type === 'answer'
          || data.type === 'done'
        ) {
          if (data.type === 'start') awaitingPendingStart = false
          queueStreamEvent(conv.id, data)
          // A turn beginning or ending changes what the whole screen shows —
          // the thinking indicator, the toolbar, the composer — so it lands
          // now rather than on the next frame. Draining the buffer through the
          // same path keeps every event in the order it arrived.
          if (
            data.type === 'start'
            || data.type === 'sync_state'
            || data.type === 'status'
            || data.type === 'done'
          ) {
            flushStreamBuffer()
          }
          if (data.type === 'done') {
            loadConversations(false)
            loadHistory(conv.id, true, true)
            emitTaskChange()
            if (
              desktopNotificationsRef.current
              && document.visibilityState !== 'visible'
              && typeof Notification !== 'undefined'
              && Notification.permission === 'granted'
            ) {
              const notification = new Notification(`${conv.name} · ${data.status === 'failed' ? '任务失败' : '任务完成'}`, {
                body: data.status === 'failed'
                  ? 'Agent 执行失败，点击查看详情'
                  : `已生成 ${data.output_chars ?? 0} 个字符的结果`,
                icon: '/pwa-192x192.png',
                tag: `orbitpane-${data.run_id || conv.id}`,
              })
              notification.onclick = () => {
                window.focus()
                const url = new URL(window.location.href)
                url.searchParams.set('id', String(conv.id))
                window.location.href = url.toString()
              }
            }
            broadcast({ type: 'task-done', conversationId: conv.id })
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
          if (requestRejected && data.request_id) {
            const pending = pendingSendMessagesRef.current.get(conv.id) || []
            pendingSendMessagesRef.current.set(conv.id, pending.filter(message => message.request_id !== data.request_id))
          }
          setMessages(previous => {
            if (activeConvRef.current?.id !== conv.id) return previous
            const next = requestRejected
              ? previous.flatMap(message => {
                  if (!data.request_id || message.request_id !== data.request_id) return [message]
                  return message.role === 'user'
                    ? [{ ...message, isOptimistic: false, deliveryFailed: true }]
                    : []
                })
              : [...previous]
            next.push({
              role: 'system',
              content: asText(data.content) || '未知错误',
              errorCode: asText(data.code) || 'provider_error',
              errorDetail: asText(data.detail),
              isError: true,
              ...(data.schedule_name ? { run_id: data.run_id, ...scheduleMetadata(data) } : {}),
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
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }

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
  }, [
    activeConvRef,
    clearStreamBuffer,
    disconnectCurrentSocket,
    flushStreamBuffer,
    loadConversations,
    loadHistory,
    queueStreamEvent,
    showToast,
  ])

  return {
    messages,
    setMessages,
    isHistoryLoading,
    historyError,
    hasOlderHistory,
    isOlderHistoryLoading,
    loadOlderHistory,
    loadAllHistory,
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
