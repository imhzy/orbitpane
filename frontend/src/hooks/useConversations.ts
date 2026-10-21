import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { formatModelName, rememberModelLabels } from '../lib/providers'
import { pruneConversationKeys, readJson, writeJson } from '../lib/storage'
import { reorderConversationSubset, sortConversations } from '../lib/conversationOrder'
import type { Conversation, DirItem, Provider, ModelOption, ModelsResponse, AgentsResponse, PermissionMode, ToastKind } from '../lib/types'
import type { AppPreferences } from '../lib/preferences'

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
    sort_order: typeof raw.sort_order === 'number' ? raw.sort_order : -raw.id,
  }
}

function normalizeConversations(value: unknown): Conversation[] {
  return Array.isArray(value)
    ? sortConversations(value.map(normalizeConversation).filter((item): item is Conversation => item !== null))
    : []
}

export function useConversations(showToast: (msg: string, kind?: ToastKind) => void, preferences: AppPreferences) {
  const [conversations, setConversations] = useState<Conversation[]>(() => (
    normalizeConversations(readCache<unknown>(CONVERSATION_CACHE_KEY, []))
  ))
  const conversationsRef = useRef(conversations)
  const [isReorderingConversations, setIsReorderingConversations] = useState(false)
  const reorderingRef = useRef(false)
  const orderRevisionRef = useRef(0)
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
  const [serverDefaultProvider, setServerDefaultProvider] = useState<string>('antigravity')
  const defaultProvider = providers.some(provider => provider.id === preferences.defaultProvider && provider.available)
    ? preferences.defaultProvider : serverDefaultProvider
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModelState] = useState<string>('')
  /**
   * Mirrors `selectedModel` for readers that run outside React's update cycle.
   *
   * Deciding whether a model list replaces the current selection has to happen
   * before the state is set, because the swap is worth telling the user about
   * and a toast cannot be raised from inside a state updater.
   */
  const selectedModelRef = useRef(selectedModel)
  const applySelectedModel = useCallback((model: string) => {
    selectedModelRef.current = model
    setSelectedModelState(model)
  }, [])
  const modelsRequestRef = useRef(0)

  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([])
  const [serverWorkspaceRoot, setServerWorkspaceRoot] = useState<string>('')
  const defaultWorkspaceRoot = workspaceRoots.includes(preferences.workspaceRoot)
    ? preferences.workspaceRoot : serverWorkspaceRoot
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
  const [currentPath, setCurrentPath] = useState<string>('')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('')
  const [newConvName, setNewConvName] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionMode>('workspace')

  const [editingConvId, setEditingConvIdState] = useState<number | null>(null)
  const editingConvIdRef = useRef<number | null>(null)
  const setEditingConvId = useCallback((id: number | null) => {
    editingConvIdRef.current = id
    setEditingConvIdState(id)
  }, [])
  const [editingConvSurface, setEditingConvSurface] = useState<'header' | 'sidebar'>('header')
  const [editingConvName, setEditingConvName] = useState<string>('')
  const previousDefaultsRef = useRef({ provider: defaultProvider, root: defaultWorkspaceRoot })

  useEffect(() => {
    const previous = previousDefaultsRef.current
    // Adopt changed defaults only while the create form is still untouched.
    if (!newConvName.trim()) {
      setSelectedProvider(value => !value || value === previous.provider ? defaultProvider : value)
      setSelectedDir(value => !value || value === previous.root ? defaultWorkspaceRoot : value)
      setCurrentPath(value => !value || value === previous.root ? defaultWorkspaceRoot : value)
    }
    previousDefaultsRef.current = { provider: defaultProvider, root: defaultWorkspaceRoot }
  }, [defaultProvider, defaultWorkspaceRoot, newConvName])

  const loadWorkspaceRoots = useCallback(() => {
    return apiFetch<{ roots: string[]; default_root: string }>('/api/workspace-roots')
      .then(data => {
        setWorkspaceRoots(data.roots)
        setServerWorkspaceRoot(data.default_root)
        const root = data.roots.includes(preferencesRef.current.workspaceRoot)
          ? preferencesRef.current.workspaceRoot : data.default_root
        setCurrentPath(previous => previous || root)
        setSelectedDir(previous => previous || root)
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
        setServerWorkspaceRoot(cached.default_root)
        const root = cached.roots.includes(preferencesRef.current.workspaceRoot)
          ? preferencesRef.current.workspaceRoot : cached.default_root
        setCurrentPath(previous => previous || root)
        setSelectedDir(previous => previous || root)
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
          setServerDefaultProvider(data.default_provider)
          const preferred = preferencesRef.current.defaultProvider
          const provider = data.providers?.some(item => item.id === preferred && item.available)
            ? preferred : data.default_provider
          setSelectedProvider(previous => previous || provider)
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
      const previous = selectedModelRef.current
      const preferred = activeConvRef.current?.preferred_model
      const has = (id: string) => nextModels.some(model => model.id === id)
      if (preferred && has(preferred)) {
        applySelectedModel(preferred)
        return
      }
      if (has(previous)) return
      const fallback = nextModels[0].id
      // Opening a project served by another agent replaces the selection with
      // that agent's first model. Silently, this reads as the project having
      // switched agents on its own, so name the swap rather than let the chip
      // change under the user.
      if (previous && previous !== fallback) {
        showToast(
          `本项目不支持「${formatModelName(previous)}」，已切换为「${formatModelName(fallback)}」`,
          'info',
        )
      }
      applySelectedModel(fallback)
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
  }, [applySelectedModel, defaultProvider, showToast])

  const loadConversations = useCallback((isInitial = false) => {
    if (isInitial) setIsConversationsLoading(true)
    const orderRevision = orderRevisionRef.current
    return apiFetch<Conversation[]>('/api/conversations?include_archived=true')
      .then(data => {
        let normalized = normalizeConversations(data)
        if (reorderingRef.current || orderRevision !== orderRevisionRef.current) {
          const ranks = new Map(conversationsRef.current.map(item => [item.id, item.sort_order]))
          normalized = sortConversations(normalized.map(item => ({
            ...item, sort_order: ranks.get(item.id) ?? item.sort_order,
          })))
        }
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
              applySelectedModel(found.preferred_model || '')
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
  }, [applySelectedModel, loadModels])

  const reorderConversations = useCallback(async (conversationIds: number[]) => {
    if (reorderingRef.current || conversationIds.length < 2) return false
    const before = conversationsRef.current
    const selected = before.filter(item => conversationIds.includes(item.id))
    if (selected.length !== conversationIds.length || selected.some(item => item.is_archived)
      || selected.some(item => item.is_pinned !== selected[0].is_pinned)) return false
    if (selected.every((item, index) => item.id === conversationIds[index])) return true
    const previousRanks = new Map(before.map(item => [item.id, item.sort_order]))
    const applyRanks = (ranks: Map<number, number>) => {
      const next = sortConversations(conversationsRef.current.map(item => ({
        ...item, sort_order: ranks.get(item.id) ?? item.sort_order,
      })))
      conversationsRef.current = next
      setConversations(next)
      writeJson(CONVERSATION_CACHE_KEY, next)
    }
    reorderingRef.current = true
    orderRevisionRef.current += 1
    setIsReorderingConversations(true)
    const optimistic = reorderConversationSubset(before, conversationIds)
    conversationsRef.current = optimistic
    setConversations(optimistic)
    writeJson(CONVERSATION_CACHE_KEY, optimistic)
    try {
      const saved = await apiFetch<Conversation[]>('/api/conversations/reorder', {
        method: 'POST', body: JSON.stringify({ conversation_ids: conversationIds }),
      })
      applyRanks(new Map(saved.map(item => [item.id, item.sort_order])))
      return true
    } catch (error) {
      console.error(error)
      applyRanks(previousRanks)
      showToast('排序保存失败，已恢复原顺序', 'error')
      return false
    } finally {
      orderRevisionRef.current += 1
      reorderingRef.current = false
      setIsReorderingConversations(false)
    }
  }, [showToast])

  const updateConversation = useCallback((
    conversationId: number,
    values: Partial<Pick<Conversation,
      'name' | 'path' | 'provider' | 'is_pinned' | 'is_archived' | 'preferred_model' | 'permission_mode' | 'draft'
    >>,
    options: { silent?: boolean } = {},
  ) => {
    const original = conversationsRef.current.find(conversation => conversation.id === conversationId)
    const orderRevision = orderRevisionRef.current
    const optimistic = sortConversations(conversationsRef.current.map(conversation => (
      conversation.id === conversationId ? { ...conversation, ...values } : conversation
    )))
    conversationsRef.current = optimistic
    setConversations(optimistic)
    writeJson(CONVERSATION_CACHE_KEY, optimistic)
    if (activeConvRef.current?.id === conversationId) {
      const updated = { ...activeConvRef.current, ...values }
      activeConvRef.current = updated
      setActiveConv(updated)
    }
    return apiFetch<Conversation>(`/api/conversations/${conversationId}`, {
      method: 'PUT',
      body: JSON.stringify(values),
    }).then(updated => {
      updated = normalizeConversation(updated) ?? updated
      if (reorderingRef.current || orderRevision !== orderRevisionRef.current) {
        updated = { ...updated, sort_order: conversationsRef.current.find(item => item.id === conversationId)?.sort_order ?? updated.sort_order }
      }
      const committed = sortConversations(conversationsRef.current.map(conversation => (
        conversation.id === conversationId ? updated : conversation
      )))
      conversationsRef.current = committed
      setConversations(committed)
      writeJson(CONVERSATION_CACHE_KEY, committed)
      if (activeConvRef.current?.id === conversationId) {
        activeConvRef.current = updated
        setActiveConv(updated)
      }
      return updated
    }).catch(error => {
      console.error(error)
      if (original) {
        const rolledBack = sortConversations(conversationsRef.current.map(conversation => (
          conversation.id === conversationId ? { ...original, sort_order: conversation.sort_order } : conversation
        )))
        conversationsRef.current = rolledBack
        setConversations(rolledBack)
        writeJson(CONVERSATION_CACHE_KEY, rolledBack)
        if (activeConvRef.current?.id === conversationId) {
          activeConvRef.current = original
          setActiveConv(original)
        }
      }
      if (!options.silent) showToast('会话设置保存失败', 'error')
      return null
    })
  }, [showToast])

  const setSelectedModel = useCallback((model: string) => {
    applySelectedModel(model)
    const conversation = activeConvRef.current
    if (conversation && conversation.preferred_model !== model) {
      void updateConversation(
        conversation.id,
        { preferred_model: model },
        { silent: true },
      )
    }
  }, [applySelectedModel, updateConversation])

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

  const startEditingConv = useCallback((conversation: Conversation, surface: 'header' | 'sidebar') => {
    setEditingConvSurface(surface)
    setEditingConvId(conversation.id)
    setEditingConvName(conversation.name)
  }, [setEditingConvId])

  const saveConvName = useCallback((conversationId: number, name = editingConvName) => {
    // Enter can also cause blur. Retire the editor synchronously so only the
    // first event commits, and a cancelled or replaced editor cannot save.
    if (editingConvIdRef.current !== conversationId) return
    const trimmed = name.trim()
    const original = conversationsRef.current.find(conversation => conversation.id === conversationId)
    setEditingConvId(null)
    if (!trimmed || original?.name === trimmed) {
      return
    }
    void updateConversation(conversationId, { name: trimmed })
      .then(updated => {
        if (updated) showToast('会话名称已更新')
      })
  }, [editingConvName, setEditingConvId, showToast, updateConversation])

  return {
    conversations,
    setConversations,
    isConversationsLoading,
    isReorderingConversations,
    reorderConversations,
    activeConv,
    setActiveConv,
    activeConvRef,
    providers,
    defaultProvider,
    serverDefaultProvider,
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
    editingConvSurface,
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
