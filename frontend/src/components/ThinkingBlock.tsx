import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, Brain, ChevronUp, ChevronDown } from 'lucide-react'

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
  const [elapsed, setElapsed] = useState<number>(0)
  const reqRef = useRef<number | null>(null)

  useEffect(() => {
    if (isThinking) {
      const startTime = Date.now() - (elapsedSoFar * 1000)
      
      const update = () => {
        setElapsed(Number(((Date.now() - startTime) / 1000).toFixed(1)))
        reqRef.current = requestAnimationFrame(update)
      }
      reqRef.current = requestAnimationFrame(update)
    } else if (duration !== undefined) {
      setElapsed(duration)
      if (reqRef.current) cancelAnimationFrame(reqRef.current)
    }
    return () => {
      if (reqRef.current) cancelAnimationFrame(reqRef.current)
    }
  }, [isThinking, duration, elapsedSoFar])

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

  return (
    <div className={`mb-4 p-2 overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] transition-colors duration-300 ${isThinking ? 'border-[var(--border-focus)] shadow-[0_0_12px_rgba(99,102,241,0.15)]' : 'opacity-85'}`}>
      <button 
        className="w-full flex items-center justify-between p-3 rounded-lg bg-[var(--bg-thinking)] cursor-pointer select-none text-[13px] hover:bg-[var(--bg-surface-hover)] transition-colors" 
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="flex items-center gap-2 font-medium text-[var(--text-secondary)]">
          {isThinking ? (
            <span className="text-[var(--accent-color)] animate-pulse">
              <Sparkles size={16} />
            </span>
          ) : (
            <span className="text-[var(--text-tertiary)]">
              <Brain size={16} />
            </span>
          )}
          <span>
            {isThinking ? '思考中 / Thinking Process...' : `已思考 ${elapsed} 秒 (Thought process)`}
          </span>
          {isThinking && <span className="font-mono text-[var(--accent-color)] text-[11px] ml-1 px-1.5 py-0.5 rounded bg-[var(--accent-subtle-bg)]">{elapsed.toFixed(1)}s</span>}
        </div>
        <div className="text-[var(--text-tertiary)] opacity-60">
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-6 py-5 text-[13px] leading-relaxed text-[var(--text-secondary)] border-t border-[var(--border-subtle)] bg-[var(--bg-card)]">
              {thought ? (
                <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-2 prose-pre:bg-[var(--bg-code)] text-[var(--text-secondary)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {thought}
                  </ReactMarkdown>
                </div>
              ) : isThinking ? (
                <div className="flex flex-col gap-3">
                  <div className="h-2 w-1/3 bg-[var(--bg-surface-hover)] rounded relative overflow-hidden" />
                  <span className="text-sm italic opacity-80 text-[var(--text-secondary)]">正在分析上下文、思考解题步骤与编写回复...</span>
                </div>
              ) : (
                <div className="text-sm italic opacity-80 text-[var(--text-secondary)]">思考过程已完成。</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
