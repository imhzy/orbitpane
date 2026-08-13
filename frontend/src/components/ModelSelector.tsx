import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, ChevronDown, Check } from 'lucide-react'

export interface ModelSelectorProps {
  selectedModel: string
  setSelectedModel: (model: string) => void
  models: string[]
  formatModelName: (modelId: string) => string
  position: 'header' | 'input'
  onOpen?: () => void
}

export function ModelSelector({ selectedModel, setSelectedModel, models, formatModelName, position, onOpen }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleToggle = () => {
    const nextState = !isOpen
    setIsOpen(nextState)
    if (nextState && onOpen) {
      onOpen()
    }
  }

  const isInput = position === 'input'
  const modelOptions = models.map(m => (
    <button
      key={m}
      role="option"
      aria-selected={selectedModel === m}
      className={`model-dropdown-item ${selectedModel === m ? 'selected' : ''}`}
      onClick={() => {
        setSelectedModel(m)
        setIsOpen(false)
      }}
    >
      <div className="model-item-icon">
        {selectedModel === m ? <Check size={14} /> : <div style={{ width: 14 }} />}
      </div>
      <span className="model-item-name">{formatModelName(m)}</span>
    </button>
  ))

  return (
    <div
      className={`model-selector-container ${isInput ? 'input-position mobile-only-model-selector' : 'header-position desktop-only-model-selector'}`}
      ref={dropdownRef}
    >
      <button
        className={`model-selector-btn ${isInput ? 'input-btn' : ''}`}
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="选择模型"
      >
        {isInput && <Cpu size={13} className="model-btn-icon" />}
        <span className="model-selector-text">{formatModelName(selectedModel)}</span>
        <ChevronDown size={14} className={`model-selector-chevron ${isOpen ? 'open' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0, y: isInput ? 6 : -5, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: isInput ? 6 : -5, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className={`model-dropdown-menu desktop-model-menu ${isInput ? 'input-menu' : ''}`}
              role="listbox"
              aria-label="模型列表"
            >
              {modelOptions}
            </motion.div>
            <motion.button
              type="button"
              className="mobile-sheet-backdrop"
              aria-label="关闭模型选择"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              className="mobile-bottom-sheet model-bottom-sheet"
              role="listbox"
              aria-label="模型列表"
              drag="y"
              dragConstraints={{ top: 0, bottom: 180 }}
              dragElastic={0.08}
              dragMomentum={false}
              onDragEnd={(_event, info) => {
                if (info.offset.y > 90 || info.velocity.y > 500) setIsOpen(false)
              }}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            >
              <div className="mobile-sheet-grabber" aria-hidden="true" />
              <div className="mobile-sheet-title">选择运行模型</div>
              <div className="mobile-sheet-options">{modelOptions}</div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
