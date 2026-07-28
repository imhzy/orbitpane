export interface DirItem {
  name: string
  path: string
  is_dir: boolean
  size?: number
  mtime?: number
}

export interface Message {
  role: 'user' | 'agent' | 'system'
  content: string
  thought?: string
  isThinking?: boolean
  thinkingDuration?: number
  elapsedSoFar?: number
  isError?: boolean
  timestamp?: string
  model?: string
  provider?: string
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
