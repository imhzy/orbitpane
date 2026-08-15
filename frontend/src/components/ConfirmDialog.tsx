import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import './ConfirmDialog.css'

export interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  variant = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const isDestructive = variant === 'destructive'
  // Focus lands on the safe choice, and Tab cannot escape into the page behind.
  const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
    initialFocus: () => cancelRef.current,
  })

  // Topmost layer: Escape reaches this dialog and nothing behind it.
  useEscapeLayer(isOpen, onCancel)

  useEffect(() => {
    if (!isOpen || isDestructive) return

    // Enter confirms only when the outcome is reversible. Deleting a project or
    // clearing a conversation must be a deliberate click or a Tab away.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'BUTTON') return
      event.preventDefault()
      onConfirm()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, isDestructive, onConfirm])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="confirm-overlay"
          onClick={onCancel}
        >
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-sheet-handle" />

            {isDestructive && (
              <div className="confirm-danger-icon" aria-hidden="true">
                <AlertTriangle size={20} />
              </div>
            )}
            <h3 id="confirm-dialog-title">{title}</h3>
            <p id="confirm-dialog-description">{description}</p>
            <div className="confirm-actions">
              <button ref={cancelRef} className="confirm-cancel-btn" onClick={onCancel}>
                {cancelText}
              </button>
              <button
                className={isDestructive ? 'confirm-delete-btn' : 'confirm-primary-btn'}
                onClick={onConfirm}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
