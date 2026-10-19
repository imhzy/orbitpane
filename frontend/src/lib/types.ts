export interface DirItem {
  name: string
  path: string
  is_dir: boolean
  size?: number
  mtime?: number
}

export interface FileSearchItem {
  name: string
  path: string
  relative_path: string
}

export interface FileSearchResponse {
  items: FileSearchItem[]
  truncated: boolean
}

export type MessageFeedback = 'up' | 'down' | ''

export type HealthStatus = 'active' | 'compacting' | 'retrying' | 'slow' | 'stalled'

export interface Message {
  schedule_id?: number | null
  schedule_name?: string
  scheduled_for?: string
  request_id?: string
  deliveryFailed?: boolean
  id?: number
  /**
   * Stable client-side identity, assigned when a message first appears.
   *
   * React keys must not change while a message streams: the server ids arrive
   * in stages (none -> run_id -> row id), and keying off those remounted the
   * whole subtree mid-answer, replaying entry animations and discarding the
   * execution timeline's expanded state.
   */
  localId?: string
  role: 'user' | 'agent' | 'system' | 'summary'
  content: string
  thought?: string
  isThinking?: boolean
  isQueued?: boolean
  queuePosition?: number
  thinkingDuration?: number
  duration?: number
  elapsedSoFar?: number
  inactiveSeconds?: number
  healthStatus?: HealthStatus
  statusMessage?: string
  isError?: boolean
  /**
   * Server-assigned class of failure, e.g. `permission_required`.
   *
   * Keyed on rather than the provider id so the client can offer the right
   * remedy without learning which agent produced the error.
   */
  errorCode?: string
  /** Verbatim agent output behind the failure, folded away until asked for. */
  errorDetail?: string
  timestamp?: string
  model?: string
  provider?: string
  run_id?: string
  streamSequence?: number
  streamFinished?: boolean
  isOptimistic?: boolean
  input_chars?: number
  output_chars?: number
  context_chars?: number
  feedback?: MessageFeedback
}

export interface Conversation {
  id: number
  name: string
  path: string
  created_at: string
  provider: string
  is_pinned: boolean
  is_archived: boolean
  preferred_model: string
  permission_mode: PermissionMode
  draft: string
  active_summary_id?: number | null
  sort_order: number
}

export type PermissionMode = 'workspace' | 'unrestricted'

/** A model id paired with the label its provider publishes for it. */
export interface ModelOption {
  id: string
  display_name: string
}

export interface ModelsResponse {
  provider: string
  models: ModelOption[]
}

export interface Provider {
  id: string
  name: string
  /** Badge colour family chosen by the backend, not guessed from the id. */
  tone: string
  available: boolean
  models: ModelOption[]
}

export interface AgentsResponse {
  default_provider: string
  providers: Provider[]
}

export interface ProviderBadge {
  text: string
  type: string
  className: string
  Icon: React.ComponentType<{ size?: number; className?: string }>
}

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastMessage {
  id: number
  message: string
  kind: ToastKind
  actionLabel?: string
  onAction?: () => void
}

export interface TaskRecord {
  schedule_id?: number | null
  schedule_name?: string
  scheduled_for?: string
  compact_before?: boolean
  run_id: string
  conversation_id: number
  conversation_name: string
  status: 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'canceled'
  prompt: string
  model: string
  provider: string
  is_summary: boolean
  queued_at: string
  started_at?: string | null
  completed_at?: string | null
  duration: number
  input_chars: number
  output_chars: number
  context_chars: number
  error: string
  position?: number
}

export interface ScheduleSpec {
  kind: 'interval' | 'daily' | 'weekly'
  timezone: string
  interval?: number | null
  unit?: 'minutes' | 'hours' | null
  times: string[]
  weekdays: number[]
}

export interface ScheduleRecord {
  id: number
  conversation_id: number
  conversation_name: string
  name: string
  prompt: string
  spec: ScheduleSpec
  enabled: boolean
  compact_before: boolean
  next_run_at: string | null
  version: number
  created_at: string
  updated_at: string
  last_run_id: string | null
  last_status: TaskRecord['status'] | null
  last_error: string | null
  last_run_at: string | null
  last_completed_at: string | null
  pending_count: number
}

export interface ConversationStats {
  message_count: number
  duration: number
  input_chars: number
  output_chars: number
  context_chars: number
  summary_count: number
  context_limit?: number
}

export interface WorkspaceChange {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  code: string
}

export interface WorkspaceStatus {
  is_git: boolean
  root?: string
  branch: string
  files: WorkspaceChange[]
  counts: Record<string, number>
  truncated?: boolean
}

export interface SearchResult {
  result_type: 'conversation' | 'message'
  conversation_id: number
  message_id?: number | null
  title: string
  snippet: string
  created_at: string
}

/** One turn inside a published snapshot. Narrower than {@link Message}: a
 *  public copy carries no run ids, character accounting or feedback. */
export interface SharedMessage {
  id?: number
  role: 'user' | 'agent' | 'summary'
  content: string
  timestamp?: string
  model?: string
  duration?: number
  thought?: string
}

export interface SharedSnapshot {
  version: number
  title: string
  include_thoughts: boolean
  messages: SharedMessage[]
  shared_at: string
  expires_at: string | null
}

/**
 * A live link as its owner sees it.
 *
 * `url_path` is rebuilt server-side from the sealed token, so the owner can
 * copy a link they created earlier. It is null when the token can no longer be
 * unsealed — a link from before tokens were kept, or one sealed with a signing
 * secret that has since been rotated. Such a link still works for whoever
 * holds it; it just cannot be shown again, only revoked.
 */
export interface ShareLink {
  id: number
  conversation_id: number
  title: string
  message_count: number
  include_thoughts: boolean
  created_at: string
  expires_at: string | null
  view_count: number
  last_viewed_at: string | null
  url_path: string | null
}

/** Creation response — the one and only time the raw token is returned. */
export interface ShareLinkCreated extends ShareLink {
  token: string
  url_path: string
}

export interface UsageWindow {
  id: string
  group?: string
  label: string
  used_percent: number
  remaining_percent: number
  window_minutes: number | null
  resets_at: number | null
}

export interface ProviderUsage {
  provider: string
  provider_name: string
  available: boolean
  plan: string | null
  windows: UsageWindow[]
  credits_balance: string | number | null
  limit_reached: string | null
  fetched_at: string | null
  stale: boolean
  error: string | null
}
