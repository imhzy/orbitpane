/**
 * localStorage access that cannot break the app.
 *
 * Two failure modes are handled here rather than at every call site:
 *   - Writes throw once the origin hits its quota (~5MB). Cached conversation
 *     history is the main consumer, so a long-lived install would otherwise
 *     start failing every write silently.
 *   - Per-conversation keys used to outlive the conversation itself, so deleted
 *     projects left their history, draft and recent-file lists behind forever.
 */

const CONVERSATION_KEY_PREFIXES = [
  'orbitpane_history_',
  'orbitpane_draft_',
  'orbitpane_recent_files_',
] as const

/** Newest-first cap on cached histories; older entries are evicted on write. */
const MAX_CACHED_HISTORIES = 12
const HISTORY_INDEX_KEY = 'orbitpane_history_index'

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T | null
    return parsed === null ? fallback : parsed
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    // Quota exceeded or storage disabled (private mode, blocked cookies).
    // Drop the least recently used histories and try exactly once more.
    if (evictOldestHistories(Math.ceil(MAX_CACHED_HISTORIES / 2))) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

export function readText(key: string, fallback: string | null = null): string | null {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    // Storage can be entirely unavailable (private mode, blocked cookies).
    return fallback
  }
}

export function writeText(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to do: the key is unreachable either way.
  }
}

function readHistoryIndex(): number[] {
  const value = readJson<unknown>(HISTORY_INDEX_KEY, [])
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : []
}

function evictOldestHistories(count: number): boolean {
  const index = readHistoryIndex()
  if (index.length === 0) return false
  const evicted = index.slice(-count)
  for (const conversationId of evicted) {
    remove(`orbitpane_history_${conversationId}`)
  }
  writeText(HISTORY_INDEX_KEY, JSON.stringify(index.slice(0, index.length - evicted.length)))
  return evicted.length > 0
}

/** Cache one conversation's history, keeping the cache bounded (LRU by touch). */
export function cacheHistory(conversationId: number, history: unknown): void {
  const index = [conversationId, ...readHistoryIndex().filter(id => id !== conversationId)]
  for (const staleId of index.slice(MAX_CACHED_HISTORIES)) {
    remove(`orbitpane_history_${staleId}`)
  }
  const trimmed = index.slice(0, MAX_CACHED_HISTORIES)
  writeJson(`orbitpane_history_${conversationId}`, history)
  writeJson(HISTORY_INDEX_KEY, trimmed)
}

export function readCachedHistory<T>(conversationId: number, fallback: T): T {
  return readJson<T>(`orbitpane_history_${conversationId}`, fallback)
}

/** Drop every key owned by a conversation. Call this when one is deleted. */
export function forgetConversation(conversationId: number): void {
  for (const prefix of CONVERSATION_KEY_PREFIXES) {
    remove(`${prefix}${conversationId}`)
  }
  writeJson(HISTORY_INDEX_KEY, readHistoryIndex().filter(id => id !== conversationId))
}

/**
 * Drop keys belonging to conversations the server no longer knows about.
 * Runs after each conversation list load so deletions made on another device,
 * or while this tab was closed, do not leak storage here either.
 */
export function pruneConversationKeys(liveConversationIds: Iterable<number>): void {
  const live = new Set(liveConversationIds)
  let keys: string[]
  try {
    keys = Object.keys(localStorage)
  } catch {
    return
  }
  for (const key of keys) {
    const prefix = CONVERSATION_KEY_PREFIXES.find(candidate => key.startsWith(candidate))
    if (!prefix) continue
    const conversationId = Number(key.slice(prefix.length))
    if (Number.isFinite(conversationId) && !live.has(conversationId)) {
      remove(key)
    }
  }
  writeJson(HISTORY_INDEX_KEY, readHistoryIndex().filter(id => live.has(id)))
}
