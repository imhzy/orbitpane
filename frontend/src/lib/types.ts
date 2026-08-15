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

export interface Message {
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
  isError?: boolean
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
