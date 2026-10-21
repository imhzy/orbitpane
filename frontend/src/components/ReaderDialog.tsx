import './ReaderDialog.css'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'

export function ReaderDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLDivElement>(true)
  useEscapeLayer(true, onClose)
  return createPortal(<div className="reader-overlay" onClick={onClose}>
    <div className="reader-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <header><h2>{title}</h2><button className="icon-btn" aria-label="关闭阅读面板" onClick={onClose}><X size={19} /></button></header>
      <div className="reader-body">{children}</div>
    </div>
  </div>, document.body)
}
