import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { apiFetch } from '../lib/api'
import type { ProviderUsage } from '../lib/types'

type State = { usage?: ProviderUsage; loading: boolean }
type Entry = {
  state: State
  fetchedAt: number
  pending?: Promise<void>
  listeners: Set<() => void>
}
const entries = new Map<string, Entry>()

function entryFor(key: string): Entry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { state: { loading: true }, fetchedAt: 0, listeners: new Set() }
    entries.set(key, entry)
  }
  return entry
}
function publish(entry: Entry, state: State) {
  entry.state = state
  entry.listeners.forEach(listener => listener())
}

async function load(key: string, allowCache = true): Promise<void> {
  const entry = entryFor(key)
  if (entry.pending) return entry.pending
  if (allowCache && Date.now() - entry.fetchedAt < 10_000) return
  publish(entry, { ...entry.state, loading: true })
  entry.pending = (async () => {
    try {
      const usage = await apiFetch<ProviderUsage>(`/api/usage${key ? `?provider=${encodeURIComponent(key)}` : ''}`)
      entry.fetchedAt = Date.now()
      publish(entry, { usage, loading: false })
    } catch (error) {
      console.error('Unable to read account usage', error)
      publish(entry, { ...entry.state, loading: false })
    } finally {
      entry.pending = undefined
    }
  })()
  return entry.pending
}

export function useProviderUsage(provider?: string) {
  const key = provider ?? ''
  const entry = entryFor(key)
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }, [entry])
  const getSnapshot = useCallback(() => entry.state, [entry])
  const state = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    void load(key)
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(key)
    }
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [key])
  const refresh = useCallback(() => load(key, false), [key])
  return { ...state, refresh }
}
