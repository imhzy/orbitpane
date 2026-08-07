import { useState, useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import type { Conversation, DirItem, Provider, ModelsResponse, AgentsResponse } from '../lib/types'

export function useConversations(showToast: (msg: string) => void) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [isConversationsLoading, setIsConversationsLoading] = useState(true)
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const activeConvRef = useRef<Conversation | null>(activeConv)

  useEffect(() => {
    activeConvRef.current = activeConv
  }, [activeConv])

  // Provider & Model state
  const [providers, setProviders] = useState<Provider[]>([])
  const [defaultProvider, setDefaultProvider] = useState<string>('antigravity')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.1-pro-high')
  const modelsRequestRef = useRef(0)

  // Drawer / Workspace Creation state
  const [currentPath, setCurrentPath] = useState<string>('/root')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('/root')
  const [newConvName, setNewConvName] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('')

  // Workspace Name Editing state
  const [editingConvId, setEditingConvId] = useState<number | null>(null)
  const [editingConvName, setEditingConvName] = useState<string>('')

  const loadProviders = useCallback(() => {
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
  }, [])

  const loadModels = useCallback((providerId?: string) => {
    const p = typeof providerId === 'string'
      ? providerId
      : (activeConvRef.current?.provider || defaultProvider || 'antigravity')
    const requestId = ++modelsRequestRef.current
    apiFetch<ModelsResponse>(`/api/models?provider=${p}`)
      .then(data => {
        if (requestId !== modelsRequestRef.current) return
        if (data.models && data.models.length > 0) {
          setModels(data.models)
          setSelectedModel(prev => data.models.includes(prev) ? prev : data.models[0])
        } else {
          setModels([])
        }
      })
      .catch(error => {
        if (requestId === modelsRequestRef.current) console.error(error)
      })
  }, [defaultProvider])

  const loadConversations = useCallback((isInitial = false) => {
    if (isInitial) {
      setIsConversationsLoading(true)
    }
    return apiFetch<Conversation[]>('/api/conversations')
      .then((data: Conversation[]) => {
        setConversations(data)
        if (isInitial) {
          const params = new URLSearchParams(window.location.search)
          const convId = params.get('id')
          if (convId) {
            const found = data.find(c => c.id === Number(convId))
            if (found) {
              setActiveConv(found)
              activeConvRef.current = found
              loadModels(found.provider)
              return found
            }
          }
        } else if (activeConvRef.current) {
          const updated = data.find(c => c.id === activeConvRef.current?.id)
          if (updated) {
            setActiveConv(updated)
            activeConvRef.current = updated
          }
        }
        return null
      })
      .catch(err => {
        console.error(err)
        return null
      })
      .finally(() => {
        setIsConversationsLoading(false)
      })
  }, [loadModels])

  const loadDir = useCallback((path: string) => {
    apiFetch<{ items: DirItem[] }>(`/api/ls?path=${encodeURIComponent(path)}`)
      .then(data => {
        if (data && Array.isArray(data.items)) {
          setItems(data.items)
        } else {
          setItems([])
        }
      })
      .catch(err => console.error(err))
  }, [])

  const startEditingConv = useCallback((e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    setEditingConvId(conv.id)
    setEditingConvName(conv.name)
  }, [])

  const saveConvName = useCallback((convId: number) => {
    const trimmed = editingConvName.trim()
    const originalConv = conversations.find(c => c.id === convId)
    
    if (!trimmed || (originalConv && originalConv.name === trimmed)) {
      setEditingConvId(null)
      return
    }
    
    apiFetch<Conversation>(`/api/conversations/${convId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: trimmed })
    })
      .then(() => {
        setConversations(prev => prev.map(c => c.id === convId ? { ...c, name: trimmed } : c))
        if (activeConvRef.current?.id === convId) {
          const updated = { ...activeConvRef.current, name: trimmed }
          activeConvRef.current = updated
          setActiveConv(updated)
        }
        setEditingConvId(null)
        showToast('工作区名称已更新')
      })
      .catch(err => {
        console.error(err)
        showToast('更新失败')
        setEditingConvId(null)
      })
  }, [editingConvName, conversations, showToast])

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
  }
}
