import type { Message } from './types'

/**
 * Stable React keys for messages.
 *
 * A single streamed answer used to change key three times — `agent-<index>`
 * while optimistic, `agent-<run_id>` once the server acknowledged it, then
 * `message-<id>` after the history reload. Every change unmounted and rebuilt
 * the row: the entry animation replayed, the markdown re-parsed, and the
 * execution timeline lost which steps the user had expanded.
 *
 * A message therefore gets a client-side id the moment it appears, and the
 * run id acts as the bridge so the server's version of that same turn inherits
 * the id it already had.
 */

/** `${role}:${run_id}` -> localId, so a server row rejoins its optimistic row. */
const runLocalIds = new Map<string, string>()
const MAX_TRACKED_RUNS = 500

let counter = 0

export function nextLocalId(): string {
  counter += 1
  return `m${counter}`
}

function runKey(role: string, runId: string): string {
  return `${role}:${runId}`
}

export function bindRunLocalId(role: string, runId: string, localId: string): void {
  if (!runId || !localId) return
  if (runLocalIds.size >= MAX_TRACKED_RUNS) {
    // Run ids are unique, so evicting the oldest entries can only cost a single
    // remount for a turn that scrolled out of the session long ago.
    const oldest = runLocalIds.keys().next()
    if (!oldest.done) runLocalIds.delete(oldest.value)
  }
  runLocalIds.set(runKey(role, runId), localId)
}

function localIdForRun(role: string, runId: string): string {
  const key = runKey(role, runId)
  const existing = runLocalIds.get(key)
  if (existing) return existing
  const created = nextLocalId()
  runLocalIds.set(key, created)
  return created
}

/** Give a message an identity if it does not already carry one. */
export function ensureLocalId(message: Message): Message {
  if (message.localId) return message
  if (message.run_id) {
    return { ...message, localId: localIdForRun(message.role, message.run_id) }
  }
  if (message.id !== undefined) {
    return { ...message, localId: `s${message.id}` }
  }
  return { ...message, localId: nextLocalId() }
}

export function ensureLocalIds(messages: Message[]): Message[] {
  return messages.map(ensureLocalId)
}

/** Key used by the message list. Falls back for defensive safety only. */
export function messageKey(message: Message, index: number): string {
  return message.localId
    ?? (message.id !== undefined ? `s${message.id}` : `i${index}`)
}
