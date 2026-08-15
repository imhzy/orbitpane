import { useEffect, useRef } from 'react'

/**
 * Escape handling as a layer stack: only the topmost open overlay reacts.
 *
 * `stopPropagation` is not enough here. Several overlays listen on `window`,
 * and listeners registered on the *same* target all run regardless of
 * propagation — so a single Escape with a dialog open above a panel would close
 * both. A stack makes "innermost first" explicit instead of depending on
 * mount order and phase tricks.
 */

type Handler = () => void

const stack: Array<{ handler: Handler }> = []
let listening = false

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  const top = stack[stack.length - 1]
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top.handler()
}

function ensureListener() {
  if (listening) return
  // Capture phase so the layer stack wins before any element-level handler.
  document.addEventListener('keydown', onKeyDown, true)
  listening = true
}

export function useEscapeLayer(active: boolean, handler: Handler) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!active) return
    ensureListener()
    const entry = { handler: () => handlerRef.current() }
    stack.push(entry)
    return () => {
      const index = stack.indexOf(entry)
      if (index >= 0) stack.splice(index, 1)
    }
  }, [active])
}
