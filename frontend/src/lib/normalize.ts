import type { Message, MessageFeedback } from './types'

/**
 * Runtime shape guards for data that enters the app untyped.
 *
 * `apiFetch<T>`, `readJson<T>` and `readCachedHistory<T>` are casts, not
 * validators: whatever the network or localStorage holds is handed to the
 * renderer with the declared type stapled on. Conversations and model options
 * are already normalized on the way in; messages were not, and they are the one
 * payload the UI parses as text — `MarkdownContent` and
 * `AgentExecutionTimeline` both call `String.prototype.split` on it, so a
 * single non-string `content` or `thought` took the whole conversation down
 * with `e.split is not a function` rather than degrading to an empty block.
 */

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['user', 'agent', 'system', 'summary'])

/** Text as the renderer needs it: always a string, never `undefined`. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value
  // Numbers and booleans still carry meaning, so show them rather than blank
  // the message out. Objects and arrays have no sensible textual form here.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

/** Server text when the payload carried any, else `undefined` so callers can fall back. */
export function asOptionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : asText(value)
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * One stored message, coerced to the shape the components are typed against.
 *
 * Rows with an unknown role are dropped: the list has no way to render one, and
 * guessing a role would attribute somebody else's text to the user.
 */
export function normalizeMessage(value: unknown): Message | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.role !== 'string' || !MESSAGE_ROLES.has(raw.role)) return null

  const feedback: MessageFeedback =
    raw.feedback === 'up' || raw.feedback === 'down' ? raw.feedback : ''

  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    role: raw.role as Message['role'],
    content: asText(raw.content),
    thought: asText(raw.thought),
    timestamp: asText(raw.timestamp),
    model: asText(raw.model),
    provider: asText(raw.provider),
    run_id: asText(raw.run_id),
    duration: asFiniteNumber(raw.duration),
    input_chars: asFiniteNumber(raw.input_chars),
    output_chars: asFiniteNumber(raw.output_chars),
    context_chars: asFiniteNumber(raw.context_chars),
    feedback,
  }
}

export function normalizeMessages(value: unknown): Message[] {
  return Array.isArray(value)
    ? value.map(normalizeMessage).filter((message): message is Message => message !== null)
    : []
}
