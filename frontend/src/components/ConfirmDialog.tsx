import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle } from 'lucide-react'
import './ConfirmDialog.css'

interface ConfirmDialogProps {
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

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel, onConfirm])

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
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="confirm-card"
            onClick={e => e.stopPropagation()}
          >
            <div className="confirm-sheet-handle" />

            {variant === 'destructive' && (
              <div style={{ 
                width: 40, height: 40, borderRadius: 12, 
                background: 'var(--danger-bg)', 
                border: '1px solid var(--danger-color)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 16, color: 'var(--danger-color)'
              }}>
                <AlertTriangle size={20} />
              </div>
            )}
            <h3>{title}</h3>
            <p>{description}</p>
            <div className="confirm-actions">
              <button className="confirm-cancel-btn" onClick={onCancel}>
                {cancelText}
              </button>
              <button 
                className={variant === 'destructive' ? 'confirm-delete-btn' : 'confirm-cancel-btn'}
                onClick={onConfirm}
                style={variant === 'default' ? { background: 'var(--accent-subtle-bg)', color: 'var(--accent-text)', borderColor: 'var(--accent-border)' } : undefined}
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
