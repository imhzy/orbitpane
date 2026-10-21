import { useRef } from 'react'
import type { usePanelWidth } from '../hooks/usePanelWidth'

export function PanelResizeHandle({ panel, label, controls, reverse = false, onCollapse }: {
  panel: ReturnType<typeof usePanelWidth>; label: string; controls: string; reverse?: boolean; onCollapse: () => void
}) {
  const start = useRef<{ x: number; width: number } | null>(null)
  return <div className={`panel-resize-handle ${reverse ? 'resize-left' : ''}`} role="separator" tabIndex={0}
    aria-label={label} aria-controls={controls} aria-orientation="vertical"
    aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width} aria-valuetext={`${panel.width} 像素`}
    onPointerDown={event => {
      if (event.button !== 0) return
      event.stopPropagation()
      start.current = { x: event.clientX, width: panel.width }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={event => {
      if (start.current) panel.update(start.current.width + (event.clientX - start.current.x) * (reverse ? -1 : 1))
    }}
    onPointerUp={() => { start.current = null }}
    onPointerCancel={() => { start.current = null }}
    onLostPointerCapture={() => { start.current = null }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Enter') onCollapse()
      else panel.update(event.key === 'Home' ? panel.min : event.key === 'End' ? panel.max
        : panel.width + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1))
    }}
  />
}
