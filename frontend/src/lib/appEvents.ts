/**
 * Cross-component notifications for state the WebSocket already knows about.
 *
 * Three panels used to poll `/api/tasks` (and friends) on their own 5-second
 * timers while a live socket sat right next to them, so an idle desktop made
 * five HTTP requests every five seconds — one of which shells out to git. These
 * events let the socket push instead, leaving polling as a slow safety net.
 */

export const TASK_CHANGE_EVENT = 'orbitpane-task-change'
export const CONVERSATIONS_CHANGED_EVENT = 'orbitpane-conversations-changed'
export const OPEN_INSPECTOR_EVENT = 'orbitpane-open-inspector'
export const CLOSE_INSPECTOR_EVENT = 'orbitpane-close-inspector'
export const REFERENCE_FILE_EVENT = 'orbitpane-reference-file'
export const OPEN_SHARE_EVENT = 'orbitpane-open-share'
export const REQUEST_INTERRUPT_EVENT = 'orbitpane-request-interrupt'
export const UPDATE_READY_EVENT = 'orbitpane-update-ready'
export const OFFLINE_READY_EVENT = 'orbitpane-offline-ready'

/** Fallback poll interval for surfaces that also listen for events. */
export const BACKGROUND_REFRESH_MS = 30_000

const SYNC_CHANNEL = 'orbitpane-sync'

export function emitTaskChange(): void {
  window.dispatchEvent(new CustomEvent(TASK_CHANGE_EVENT))
}

export function emitConversationsChanged(): void {
  window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT))
}

/** Notify other tabs of the same install. Optional: older WebViews lack it. */
export function broadcast(message: { type: string; conversationId?: number }): void {
  try {
    const channel = new BroadcastChannel(SYNC_CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch {
    // BroadcastChannel is unavailable; same-tab listeners still fire.
  }
}

export function subscribeToOtherTabs(
  handler: (message: { type: string; conversationId?: number }) => void,
): () => void {
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(SYNC_CHANNEL)
  } catch {
    return () => {}
  }
  channel.onmessage = event => handler(event.data ?? {})
  return () => channel?.close()
}
