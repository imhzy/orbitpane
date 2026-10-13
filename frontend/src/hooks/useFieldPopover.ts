import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useEscapeLayer } from './useEscapeLayer'

/** Keep styled field menus in the top layer, above scrolling/clipped panels.
 * They remain DOM descendants so the enclosing dialog's focus trap still works.
 */
export function useFieldPopover(open: boolean, onClose: () => void) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })

  useEscapeLayer(open, () => closeRef.current())

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const popup = popupRef.current
    if (!anchor || !popup) return

    // Manual mode lets Escape use the app's existing overlay stack, closing
    // only this menu instead of also dismissing the panel behind it.
    popup.showPopover?.()
    const viewport = window.visualViewport
    const place = () => {
      const leftEdge = (viewport?.offsetLeft ?? 0) + 12
      const topEdge = (viewport?.offsetTop ?? 0) + 12
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 24
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 24
      const rect = anchor.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 200), rightEdge - leftEdge)
      const below = bottomEdge - rect.bottom - 6
      const above = rect.top - topEdge - 6
      const upward = below < Math.min(popup.scrollHeight, 240) && above > below
      const maxHeight = Math.max(0, Math.min(320, upward ? above : below))
      const height = Math.min(popup.scrollHeight, maxHeight)
      setStyle({
        width,
        maxHeight,
        left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
        top: upward ? rect.top - height - 6 : Math.max(topEdge, rect.bottom + 6),
        visibility: 'visible',
      })
    }
    place()
    const resizeObserver = new ResizeObserver(place)
    resizeObserver.observe(anchor)
    resizeObserver.observe(popup)
    const outside = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node)) closeRef.current()
    }
    const scroll = (event: Event) => {
      if (!popup.contains(event.target as Node)) closeRef.current()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    return () => {
      resizeObserver.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
      if (popup.hidePopover && popup.matches(':popover-open')) popup.hidePopover()
    }
  }, [open])

  return { anchorRef, popupRef, style }
}
