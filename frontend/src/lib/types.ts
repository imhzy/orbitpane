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
  role: 'user' | 'agent' | 'system' | 'summary'
  content: string
  thought?: string
  isThinking?: boolean
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
}

export interface Conversation {
  id: number
  name: string
  path: string
  created_at: string
  provider: string
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

