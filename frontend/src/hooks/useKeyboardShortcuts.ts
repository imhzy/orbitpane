import { useEffect } from 'react'

export function useKeyboardShortcuts({
  onEscape,
  onFocusInput,
  onCmdPalette,
  onToggleSidebar,
  onNewWorkspace
}: {
  onEscape?: () => void
  onFocusInput?: () => void
  onCmdPalette?: () => void
  onToggleSidebar?: () => void
  onNewWorkspace?: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isInputElem = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (e.key === 'Escape') {
        onEscape?.()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onCmdPalette?.()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        onToggleSidebar?.()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        onNewWorkspace?.()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        if (!isInputElem) {
          e.preventDefault()
          onFocusInput?.()
        }
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onEscape, onFocusInput, onCmdPalette, onToggleSidebar, onNewWorkspace])
}
