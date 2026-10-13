// Bundle the marks into the precached JavaScript for offline PWA sessions.
import geminiMark from '../assets/providers/gemini.svg?inline'
import codexMark from '../assets/providers/codex.svg?inline'

interface ProviderIconProps { size?: number; className?: string }

export function GeminiIcon({ size = 20, className = '' }: ProviderIconProps) {
  return <img src={geminiMark} width={size} height={size} alt="" aria-hidden="true"
    draggable={false} className={`provider-logo provider-logo-gemini ${className}`.trim()} />
}

export function CodexIcon({ size = 20, className = '' }: ProviderIconProps) {
  return <img src={codexMark} width={size} height={size} alt="" aria-hidden="true"
    draggable={false} className={`provider-logo provider-logo-codex ${className}`.trim()} />
}
