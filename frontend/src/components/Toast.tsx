
import { motion, AnimatePresence } from 'framer-motion'
import { Check } from 'lucide-react'

interface ToastProps {
  toast: string | null;
}

export function Toast({ toast }: ToastProps) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.2 }}
          className="toast-container"
        >
          <div className="toast">
            <Check size={14} style={{ color: '#10B981' }} />
            {toast}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
