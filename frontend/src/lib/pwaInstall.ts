export interface PwaInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
}

type PromptListener = (event: PwaInstallPromptEvent | null) => void

let installPrompt: PwaInstallPromptEvent | null = null
const promptListeners = new Set<PromptListener>()

function publishPrompt(event: PwaInstallPromptEvent | null) {
  installPrompt = event
  promptListeners.forEach(listener => listener(event))
}

if (typeof window !== 'undefined') {
  // This module is evaluated when the application bundle starts, before the
  // authenticated app tree mounts, so Chrome's one-shot event cannot be lost.
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    publishPrompt(event as PwaInstallPromptEvent)
  })

  window.addEventListener('appinstalled', () => publishPrompt(null))
}

export function getPwaInstallPrompt() {
  return installPrompt
}

export function clearPwaInstallPrompt() {
  publishPrompt(null)
}

export function subscribeToPwaInstallPrompt(listener: PromptListener) {
  promptListeners.add(listener)
  listener(installPrompt)
  return () => promptListeners.delete(listener)
}
