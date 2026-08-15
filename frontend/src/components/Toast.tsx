import { motion, AnimatePresence } from 'framer-motion'
import { AlertCircle, Check, Info, TriangleAlert, X } from 'lucide-react'
import type { ToastKind, ToastMessage } from '../lib/types'

const ICONS = {
  success: Check,
  error: AlertCircle,
  warning: TriangleAlert,
  info: Info,
} as const satisfies Record<ToastKind, unknown>

interface ToastStackProps {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="toast-container">
      <AnimatePresence initial={false}>
        {toasts.map(toast => {
          const Icon = ICONS[toast.kind]
          const isError = toast.kind === 'error'
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.18 }}
              className={`toast ${toast.kind}`}
              /* Errors interrupt; everything else waits for a pause. */
              role={isError ? 'alert' : 'status'}
              aria-live={isError ? 'assertive' : 'polite'}
            >
              <Icon size={14} />
              <span className="toast-message">{toast.message}</span>
              {toast.actionLabel && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    toast.onAction?.()
                    onDismiss(toast.id)
                  }}
                >
                  {toast.actionLabel}
                </button>
              )}
              <button
                type="button"
                className="toast-dismiss"
                aria-label="关闭提示"
                onClick={() => onDismiss(toast.id)}
              >
                <X size={12} />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
