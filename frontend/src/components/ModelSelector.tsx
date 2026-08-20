import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, ChevronDown, Check } from 'lucide-react'
import { formatModelName } from '../lib/providers'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import type { ModelOption } from '../lib/types'
import { MobileBottomSheet } from './MobileBottomSheet'

export interface ModelSelectorProps {
  selectedModel: string
  setSelectedModel: (model: string) => void
  models: ModelOption[]
  position: 'header' | 'input'
  onOpen?: () => void
}

export function ModelSelector({ selectedModel, setSelectedModel, models, position, onOpen }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  useEscapeLayer(isOpen, () => setIsOpen(false))

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest('.model-bottom-sheet')) return
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
  const modelOptions = models.map(model => (
    <button
      key={model.id}
      role="option"
      aria-selected={selectedModel === model.id}
      className={`model-dropdown-item ${selectedModel === model.id ? 'selected' : ''}`}
      onClick={() => {
        setSelectedModel(model.id)
        setIsOpen(false)
      }}
    >
      <div className="model-item-icon">
        {selectedModel === model.id ? <Check size={14} /> : <div style={{ width: 14 }} />}
      </div>
      <span className="model-item-name">{model.display_name}</span>
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
        )}
      </AnimatePresence>
      <MobileBottomSheet
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title="选择运行模型"
        className="model-bottom-sheet"
        role="listbox"
        ariaLabel="模型列表"
      >
        <div className="mobile-sheet-options">{modelOptions}</div>
      </MobileBottomSheet>
    </div>
  )
}
