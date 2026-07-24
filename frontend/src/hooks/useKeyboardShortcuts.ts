import { useEffect } from 'react'

export function useKeyboardShortcuts({
  onEscape,
  onFocusInput
}: {
  onEscape?: () => void;
  onFocusInput?: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onEscape?.()
      } else if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onFocusInput?.()
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onEscape, onFocusInput])
}
