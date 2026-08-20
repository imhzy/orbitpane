import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useDragControls } from 'framer-motion'

interface MobileBottomSheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
  backdropClassName?: string
  role?: 'dialog' | 'listbox' | 'menu'
  ariaLabel?: string
}

/**
 * Shared phone bottom sheet.
 *
 * Rendering at document.body keeps WebKit from resolving `position: fixed`
 * against a transformed, scrolling, or backdrop-filtered component ancestor.
 * Dragging is owned by Framer Motion and starts only from the header, leaving
 * long option lists with native vertical scrolling.
 */
export function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
  className = '',
  backdropClassName = '',
  role = 'dialog',
  ariaLabel,
}: MobileBottomSheetProps) {
  const dragControls = useDragControls()

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && [
        <motion.button
          key="backdrop"
          type="button"
          className={`mobile-sheet-backdrop ${backdropClassName}`.trim()}
          aria-label={`关闭${title}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />,
        <motion.div
          key="sheet"
          className={`mobile-bottom-sheet ${className}`.trim()}
          role={role}
          aria-label={ariaLabel ?? title}
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragDirectionLock
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 1 }}
          dragMomentum={false}
          dragSnapToOrigin
          onDragEnd={(_event, info) => {
            if (info.offset.y > 72 || info.velocity.y > 500) onClose()
          }}
          initial={{ y: '110%' }}
          animate={{ y: '0%' }}
          exit={{ y: '110%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 340 }}
        >
          <div
            className="mobile-sheet-drag-region"
            onPointerDown={event => dragControls.start(event)}
          >
            <div className="mobile-sheet-grabber" aria-hidden="true" />
            <div className="mobile-sheet-title">{title}</div>
          </div>
          {children}
        </motion.div>,
      ]}
    </AnimatePresence>,
    document.body,
  )
}
