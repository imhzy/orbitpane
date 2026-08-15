import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { rememberModelLabels } from '../lib/providers'
import { pruneConversationKeys, readJson, writeJson } from '../lib/storage'
import type { Conversation, DirItem, Provider, ModelOption, ModelsResponse, AgentsResponse, PermissionMode, ToastKind } from '../lib/types'

const CONVERSATION_CACHE_KEY = 'orbitpane_conversations_cache_v2'
const PROVIDER_CACHE_KEY = 'orbitpane_provider_cache_v2'

const readCache = readJson

/** Older caches stored plain id strings; upgrade them in place. */
function normalizeModelOptions(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (typeof entry === 'string') return [{ id: entry, display_name: entry }]
    if (
      entry && typeof entry === 'object'
      && typeof (entry as ModelOption).id === 'string'
    ) {
      const option = entry as ModelOption
      return [{ id: option.id, display_name: option.display_name || option.id }]
    }
    return []
  })
}

function normalizeConversation(value: unknown): Conversation | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Conversation>
  if (typeof raw.id !== 'number' || typeof raw.name !== 'string' || typeof raw.path !== 'string') {
    return null
  }
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    provider: typeof raw.provider === 'string' ? raw.provider : 'antigravity',
    is_pinned: Boolean(raw.is_pinned),
    is_archived: Boolean(raw.is_archived),
    preferred_model: typeof raw.preferred_model === 'string' ? raw.preferred_model : '',
    // Fail closed: only an explicit 'unrestricted' unlocks the sandbox, so a
    // malformed or truncated payload cannot silently widen permissions.
    permission_mode: raw.permission_mode === 'unrestricted' ? 'unrestricted' : 'workspace',
    draft: typeof raw.draft === 'string' ? raw.draft : '',
    active_summary_id: typeof raw.active_summary_id === 'number' ? raw.active_summary_id : null,
  }
}

function normalizeConversations(value: unknown): Conversation[] {
  return Array.isArray(value)
    ? value.map(normalizeConversation).filter((item): item is Conversation => item !== null)
    : []
}

export function useConversations(showToast: (msg: string, kind?: ToastKind) => void) {
  const [conversations, setConversations] = useState<Conversation[]>(() => (
    normalizeConversations(readCache<unknown>(CONVERSATION_CACHE_KEY, []))
  ))
  const conversationsRef = useRef(conversations)
  const [isConversationsLoading, setIsConversationsLoading] = useState(true)
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const activeConvRef = useRef<Conversation | null>(activeConv)

  useEffect(() => {
    activeConvRef.current = activeConv
  }, [activeConv])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  const [providers, setProviders] = useState<Provider[]>(() => (
    (() => {
      const cached = readCache<unknown>(PROVIDER_CACHE_KEY, [])
      return Array.isArray(cached) ? cached as Provider[] : []
    })()
  ))
  const [defaultProvider, setDefaultProvider] = useState<string>('antigravity')
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModelState] = useState<string>('')
  const modelsRequestRef = useRef(0)

  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([])
  const [defaultWorkspaceRoot, setDefaultWorkspaceRoot] = useState<string>('')
  const [currentPath, setCurrentPath] = useState<string>('')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('')
  const [newConvName, setNewConvName] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionMode>('workspace')

  const [editingConvId, setEditingConvId] = useState<number | null>(null)
  const [editingConvName, setEditingConvName] = useState<string>('')

  const loadWorkspaceRoots = useCallback(() => {
    return apiFetch<{ roots: string[]; default_root: string }>('/api/workspace-roots')
      .then(data => {
        setWorkspaceRoots(data.roots)
        setDefaultWorkspaceRoot(data.default_root)
        setCurrentPath(previous => previous || data.default_root)
        setSelectedDir(previous => previous || data.default_root)
        writeJson('orbitpane_workspace_roots', data)
        return data
      })
      .catch(error => {
        console.error(error)
        const cached = readCache<{ roots: string[]; default_root: string }>(
          'orbitpane_workspace_roots',
          { roots: [], default_root: '' },
        )
        setWorkspaceRoots(cached.roots)
        setDefaultWorkspaceRoot(cached.default_root)
        setCurrentPath(previous => previous || cached.default_root)
        setSelectedDir(previous => previous || cached.default_root)
        return cached
      })
  }, [])

  const loadProviders = useCallback(() => {
    return apiFetch<AgentsResponse>('/api/agents')
      .then(data => {
        if (data.providers) {
          setProviders(data.providers)
          writeJson(PROVIDER_CACHE_KEY, data.providers)
        }
        if (data.default_provider) {
          setDefaultProvider(data.default_provider)
          setSelectedProvider(previous => previous || data.default_provider)
        }
      })
      .catch(console.error)
  }, [])

  const loadModels = useCallback((providerId?: string) => {
    const provider = typeof providerId === 'string'
      ? providerId
      : (activeConvRef.current?.provider || defaultProvider || 'antigravity')
    const requestId = ++modelsRequestRef.current
    const cacheKey = `orbitpane_models_${provider}`
    const applyModels = (nextModels: ModelOption[]) => {
      setModels(nextModels)
      rememberModelLabels(nextModels)
      if (nextModels.length === 0) return
      setSelectedModelState(previous => {
        const preferred = activeConvRef.current?.preferred_model
        const has = (id: string) => nextModels.some(model => model.id === id)
        if (preferred && has(preferred)) return preferred
        return has(previous) ? previous : nextModels[0].id
      })
    }

    return apiFetch<ModelsResponse>(`/api/models?provider=${encodeURIComponent(provider)}`)
      .then(data => {
        if (requestId !== modelsRequestRef.current) return
        const nextModels = normalizeModelOptions(data.models)
        applyModels(nextModels)
        writeJson(cacheKey, nextModels)
      })
      .catch(error => {
        if (requestId !== modelsRequestRef.current) return
        console.error(error)
        applyModels(normalizeModelOptions(readCache<unknown>(cacheKey, [])))
      })
  }, [defaultProvider])

  const loadConversations = useCallback((isInitial = false) => {
    if (isInitial) setIsConversationsLoading(true)
    return apiFetch<Conversation[]>('/api/conversations?include_archived=true')
      .then(data => {
        const normalized = normalizeConversations(data)
        conversationsRef.current = normalized
        setConversations(normalized)
        writeJson(CONVERSATION_CACHE_KEY, normalized)
        // Deletions made elsewhere (another tab, another device) also free the
        // per-conversation keys they left behind here.
        pruneConversationKeys(normalized.map(conversation => conversation.id))
        if (isInitial) {
          const conversationId = new URLSearchParams(window.location.search).get('id')
          if (conversationId) {
            const found = normalized.find(conversation => conversation.id === Number(conversationId))
            if (found) {
              setActiveConv(found)
              activeConvRef.current = found
              setSelectedModelState(found.preferred_model || '')
              loadModels(found.provider)
              return found
            }
          }
        } else if (activeConvRef.current) {
          const updated = normalized.find(conversation => conversation.id === activeConvRef.current?.id)
          if (updated) {
            setActiveConv(updated)
            activeConvRef.current = updated
          }
        }
        return null
      })
      .catch(error => {
        console.error(error)
        const cached = normalizeConversations(readCache<unknown>(CONVERSATION_CACHE_KEY, []))
        if (cached.length > 0) setConversations(cached)
        if (isInitial) {
          const conversationId = new URLSearchParams(window.location.search).get('id')
          const found = cached.find(conversation => conversation.id === Number(conversationId)) || null
          if (found) {
            setActiveConv(found)
            activeConvRef.current = found
          }
          return found
        }
        return null
      })
      .finally(() => setIsConversationsLoading(false))
  }, [loadModels])

  const updateConversation = useCallback((
    conversationId: number,
    values: Partial<Pick<Conversation,
      'name' | 'path' | 'provider' | 'is_pinned' | 'is_archived' | 'preferred_model' | 'permission_mode' | 'draft'
    >>,
    options: { silent?: boolean } = {},
  ) => {
    const original = conversationsRef.current.find(conversation => conversation.id === conversationId)
    const optimistic = conversationsRef.current.map(conversation => (
      conversation.id === conversationId ? { ...conversation, ...values } : conversation
    ))
    conversationsRef.current = optimistic
    setConversations(optimistic)
    if (activeConvRef.current?.id === conversationId) {
      const updated = { ...activeConvRef.current, ...values }
      activeConvRef.current = updated
      setActiveConv(updated)
    }
    return apiFetch<Conversation>(`/api/conversations/${conversationId}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    }).then(updated => {
      const committed = conversationsRef.current.map(conversation => (
        conversation.id === conversationId ? updated : conversation
      ))
      conversationsRef.current = committed
      setConversations(committed)
      if (activeConvRef.current?.id === conversationId) {
        activeConvRef.current = updated
        setActiveConv(updated)
      }
      return updated
    }).catch(error => {
      console.error(error)
      if (original) {
        const rolledBack = conversationsRef.current.map(conversation => (
          conversation.id === conversationId ? original : conversation
        ))
        conversationsRef.current = rolledBack
        setConversations(rolledBack)
        if (activeConvRef.current?.id === conversationId) {
          activeConvRef.current = original
          setActiveConv(original)
        }
      }
      if (!options.silent) showToast('项目设置保存失败', 'error')
      return null
    })
  }, [showToast])

  const setSelectedModel = useCallback((model: string) => {
    setSelectedModelState(model)
    const conversation = activeConvRef.current
    if (conversation && conversation.preferred_model !== model) {
      void updateConversation(
        conversation.id,
        { preferred_model: model },
        { silent: true },
      )
    }
  }, [updateConversation])

  const loadDir = useCallback((path: string) => {
    const suffix = path ? `?path=${encodeURIComponent(path)}` : ''
    return apiFetch<{ items: DirItem[]; current_path: string }>(`/api/ls${suffix}`)
      .then(data => {
        setItems(Array.isArray(data.items) ? data.items : [])
        if (!path && data.current_path) {
          setCurrentPath(data.current_path)
          setSelectedDir(data.current_path)
        }
      })
      .catch(error => {
        console.error(error)
        setItems([])
      })
  }, [])

  const startEditingConv = useCallback((event: React.MouseEvent, conversation: Conversation) => {
    event.stopPropagation()
    setEditingConvId(conversation.id)
    setEditingConvName(conversation.name)
  }, [])

  const saveConvName = useCallback((conversationId: number) => {
    const trimmed = editingConvName.trim()
    const original = conversations.find(conversation => conversation.id === conversationId)
    if (!trimmed || original?.name === trimmed) {
      setEditingConvId(null)
      return
    }
    void updateConversation(conversationId, { name: trimmed })
      .then(updated => {
        if (updated) showToast('项目名称已更新')
      })
      .finally(() => setEditingConvId(null))
  }, [conversations, editingConvName, showToast, updateConversation])

  return {
    conversations,
    setConversations,
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
  }
}
