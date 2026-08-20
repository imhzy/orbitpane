import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(element => {
    if (element === document.activeElement) return true
    if (element.offsetWidth === 0 && element.offsetHeight === 0) return false
    // A collapsed section still lays its contents out at full size, so the
    // box measurements alone would keep hidden controls in the Tab cycle
    // where the browser then silently refuses to focus them.
    return window.getComputedStyle(element).visibility !== 'hidden'
  })
}

interface FocusTrapOptions {
  /** Focused on open. Defaults to the first focusable element. */
  initialFocus?: () => HTMLElement | null
  /** Set false for panels that should keep Tab flowing to the page behind. */
  trapTab?: boolean
}

/**
 * Confine Tab to `active` overlays and hand focus back to whatever opened them.
 *
 * Without this, Tab walks straight out of a drawer or dialog into the content
 * it is covering, and closing an overlay drops focus to the document body so
 * keyboard users restart from the top of the page.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  options: FocusTrapOptions = {},
) {
  const containerRef = useRef<T | null>(null)
  const { initialFocus, trapTab = true } = options
  const initialFocusRef = useRef(initialFocus)
  initialFocusRef.current = initialFocus

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusInitialTarget = () => {
      const target = initialFocusRef.current?.() ?? focusableWithin(container)[0] ?? container
      if (target === container && !container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1')
      }
      target.focus({ preventScroll: true })
      return container.contains(document.activeElement)
    }

    // Focus immediately: the DOM is committed and laid out by the time effects
    // run. A deferred retry covers overlays whose content mounts a tick later
    // (lazy chunks, entry animations that start from display:none).
    //
    // Deliberately a timer, not requestAnimationFrame: rAF does not fire while
    // the tab is hidden or not compositing, which would leave focus outside a
    // dialog that is, as far as the app is concerned, open.
    const focused = focusInitialTarget()
    const retry = focused ? undefined : window.setTimeout(focusInitialTarget, 50)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !trapTab) return
      const focusable = focusableWithin(container)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement

      if (!container.contains(current)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      if (retry !== undefined) window.clearTimeout(retry)
      document.removeEventListener('keydown', handleKeyDown, true)
      // Only restore if focus is still inside (or was lost to the body); if the
      // user has already clicked elsewhere, leave their choice alone.
      const activeElement = document.activeElement
      const shouldRestore = !activeElement
        || activeElement === document.body
        || container.contains(activeElement)
      if (shouldRestore && previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [active, trapTab])

  return containerRef
}
