import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastKind, ToastMessage } from '../lib/types'

const MAX_VISIBLE = 3
const DEFAULT_DURATION = 2600
/** Long enough to read the sentence and reach for the button. */
const ACTION_DURATION = 6000

export interface ShowToastOptions {
  actionLabel?: string
  onAction?: () => void
  durationMs?: number
}

export interface UndoableRequest {
  /** Shown while the undo window is open, e.g. "项目已删除". */
  message: string
  /** Runs once the window closes without an undo. */
  perform: () => void
  /** Runs if the user takes it back. */
  onUndo?: () => void
  durationMs?: number
}

let nextToastId = 0

/**
 * Stacked toasts with optional actions.
 *
 * The previous single-slot implementation replaced whatever was on screen, so
 * a burst of events silently swallowed all but the last message — and there was
 * nowhere to put an "undo" affordance.
 */
interface PendingAction {
  perform: () => void
  timer: number
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const pendingActionsRef = useRef(new Set<PendingAction>())

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts(current => current.filter(toast => toast.id !== id))
  }, [])

  const showToast = useCallback((
    message: string,
    kind: ToastKind = 'success',
    options: ShowToastOptions = {},
  ) => {
    const id = ++nextToastId
    const duration = options.durationMs
      ?? (options.actionLabel ? ACTION_DURATION : DEFAULT_DURATION)

    setToasts(current => {
      const next = [...current, {
        id,
        message,
        kind,
        actionLabel: options.actionLabel,
        onAction: options.onAction,
      }]
      // Oldest first out, so the newest message is always readable.
      const overflow = next.slice(0, Math.max(0, next.length - MAX_VISIBLE))
      for (const toast of overflow) {
        const timer = timersRef.current.get(toast.id)
        if (timer) {
          clearTimeout(timer)
          timersRef.current.delete(toast.id)
        }
      }
      return next.slice(-MAX_VISIBLE)
    })

    timersRef.current.set(id, setTimeout(() => {
      timersRef.current.delete(id)
      setToasts(current => current.filter(toast => toast.id !== id))
    }, duration))

    return id
  }, [])

  /**
   * Defer a destructive action behind an undo window instead of asking for
   * confirmation and then doing it irreversibly. The work only leaves the
   * client once the toast expires.
   */
  const runWithUndo = useCallback((request: UndoableRequest) => {
    const duration = request.durationMs ?? ACTION_DURATION
    const pending = { perform: request.perform, timer: 0 }

    const id = showToast(request.message, 'info', {
      actionLabel: '撤销',
      durationMs: duration,
      onAction: () => {
        window.clearTimeout(pending.timer)
        pendingActionsRef.current.delete(pending)
        request.onUndo?.()
      },
    })

    pending.timer = window.setTimeout(() => {
      pendingActionsRef.current.delete(pending)
      pending.perform()
    }, duration)
    pendingActionsRef.current.add(pending)

    return id
  }, [showToast])

  /**
   * Commit anything still inside its undo window before the page goes away.
   *
   * Otherwise closing the tab five seconds after a delete silently cancels it,
   * and the project the user believes is gone reappears on the next visit.
   */
  useEffect(() => {
    const flush = () => {
      for (const pending of pendingActionsRef.current) {
        window.clearTimeout(pending.timer)
        try {
          pending.perform()
        } catch {
          // A failed flush must not block the remaining actions or the unload.
        }
      }
      pendingActionsRef.current.clear()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  return { toasts, showToast, dismissToast, runWithUndo }
}
