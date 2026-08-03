import { lazy, Suspense, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Brain, ChevronRight } from 'lucide-react'
import './ThinkingBlock.css'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

export function ThinkingBlock({ 
  thought, 
  isThinking, 
  duration,
  elapsedSoFar = 0
}: { 
  thought: string; 
  isThinking: boolean; 
  duration?: number;
  elapsedSoFar?: number;
}) {
  const [isOpen, setIsOpen] = useState<boolean>(true)
  const elapsed = isThinking ? elapsedSoFar : (duration ?? elapsedSoFar)

  useEffect(() => {
    if (!isThinking && !thought) {
      setIsOpen(false)
    }
  }, [isThinking, thought])

  useEffect(() => {
    if (!isThinking && thought) {
      const timer = setTimeout(() => setIsOpen(false), 1500)
      return () => clearTimeout(timer)
    }
  }, [isThinking, thought])

  if (!isThinking && !thought && (duration === undefined || duration === 0)) return null

  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const mins = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(0)
    return `${mins}m ${secs}s`
  }

  return (
    <div className="thinking-block-container" data-active={isThinking}>
      <button 
        className="thinking-block-header"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="thinking-block-left">
          {isThinking ? (
            <span className="thinking-icon active">
              <Sparkles size={14} />
            </span>
          ) : (
            <span className="thinking-icon done">
              <Brain size={14} />
            </span>
          )}
          <span className="thinking-label">
            {isThinking ? '思考中...' : '思考过程'}
          </span>
          <span className="thinking-duration">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <ChevronRight 
          size={14} 
          className={`thinking-chevron ${isOpen ? 'open' : ''}`} 
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="thinking-block-body-wrapper"
          >
            <div className="thinking-block-body">
              {thought ? (
                <div className="thinking-content">
                  <Suspense fallback={<div>{thought}</div>}>
                    <MarkdownContent content={thought} />
                  </Suspense>
                </div>
              ) : isThinking ? (
                <div className="thinking-placeholder">
                  正在分析上下文与制定策略...
                </div>
              ) : (
                <div className="thinking-placeholder">思考过程已完成。</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
