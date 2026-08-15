import { useEffect, useRef } from 'react'

interface KeyboardShortcutHandlers {
  onFocusInput?: () => void
  onCmdPalette?: () => void
  onToggleSidebar?: () => void
  onNewWorkspace?: () => void
  onInterrupt?: () => void
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return (
    element.tagName === 'INPUT'
    || element.tagName === 'TEXTAREA'
    || element.isContentEditable
  )
}

/**
 * Global chords.
 *
 * Escape is deliberately *not* handled here: `useEscapeLayer` owns it so that
 * exactly one overlay — the topmost — reacts to a given keypress. Interrupting
 * a run lives on Cmd/Ctrl+. because it is destructive, and Escape is what
 * people press to close things.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const {
        onFocusInput,
        onCmdPalette,
        onToggleSidebar,
        onNewWorkspace,
        onInterrupt,
      } = handlersRef.current

      const withModifier = event.metaKey || event.ctrlKey
      if (!withModifier || event.altKey) return

      const key = event.key.toLowerCase()
      if (key === 'k') {
        event.preventDefault()
        onCmdPalette?.()
      } else if (key === 'b') {
        event.preventDefault()
        onToggleSidebar?.()
      } else if (key === '.') {
        event.preventDefault()
        onInterrupt?.()
      } else if (key === 'j' && event.shiftKey) {
        // Cmd/Ctrl+N is reserved by the browser for a new window and cannot be
        // reliably intercepted, so project creation uses a chord we own.
        event.preventDefault()
        onNewWorkspace?.()
      } else if (key === '/' && !isTextEntry(event.target)) {
        event.preventDefault()
        onFocusInput?.()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
