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

export interface Message {
  id?: number
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
}

export interface Conversation {
  id: number
  name: string
  path: string
  created_at: string
  provider: string
  is_pinned: boolean
  is_archived: boolean
  tags: string[]
  preferred_model: string
  draft: string
  active_summary_id?: number | null
}

export interface ModelsResponse {
  provider: string
  models: string[]
}

export interface Provider {
  id: string
  name: string
  available: boolean
  models: string[]
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

export interface SummaryCheckpoint {
  id: number
  conversation_id: number
  message_id: number
  covered_through_id: number
  title: string
  content: string
  created_at: string
  active: boolean
}

export interface SearchResult {
  result_type: 'conversation' | 'message'
  conversation_id: number
  message_id?: number | null
  title: string
  snippet: string
  created_at: string
}
