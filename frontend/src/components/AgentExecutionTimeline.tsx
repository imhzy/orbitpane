import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronRight, Play, Terminal, FileEdit, Search, ListTodo, Brain, Check, Sparkles } from 'lucide-react'
import MarkdownContent from './MarkdownContent'
import './AgentExecutionTimeline.css'

interface AgentExecutionTimelineProps {
  thought: string
  isThinking: boolean
  duration?: number
  elapsedSoFar?: number
}

type StepType = 'exec' | 'tool' | 'search' | 'file' | 'plan' | 'thought' | 'other'

interface ParsedStep {
  id: string
  type: StepType
  title: string
  content: string
  isComplete: boolean
}

export function AgentExecutionTimeline({ 
  thought, 
  isThinking, 
  duration, 
  elapsedSoFar = 0 
}: AgentExecutionTimelineProps) {
  const [isOpen, setIsOpen] = useState<boolean>(isThinking)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [elapsed, setElapsed] = useState<number>(duration || elapsedSoFar || 0)
  
  const timerRef = useRef<number | null>(null)
  const prevThinkingRef = useRef<boolean>(isThinking)
  const startTimeRef = useRef<number>(Date.now() - (elapsedSoFar * 1000))

  useEffect(() => {
    if (isThinking) {
      startTimeRef.current = Date.now() - (elapsedSoFar * 1000)
      const updateTimer = () => {
        const sec = (Date.now() - startTimeRef.current) / 1000
        setElapsed(sec)
        timerRef.current = requestAnimationFrame(updateTimer)
      }
      timerRef.current = requestAnimationFrame(updateTimer)
    } else {
      if (timerRef.current) {
        cancelAnimationFrame(timerRef.current)
        timerRef.current = null
      }
      if (duration !== undefined && duration > 0) {
        setElapsed(duration)
      }
    }
    return () => {
      if (timerRef.current) {
        cancelAnimationFrame(timerRef.current)
      }
    }
  }, [isThinking, duration, elapsedSoFar])

  useEffect(() => {
    if (prevThinkingRef.current && !isThinking) {
      setIsOpen(false)
    } else if (!prevThinkingRef.current && isThinking) {
      setIsOpen(true)
    }
    prevThinkingRef.current = isThinking
  }, [isThinking])

  const toggleStepExpand = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const steps = useMemo(() => {
    if (!thought) return []
    const parsedSteps: ParsedStep[] = []
    
    const blocks = thought.split(/(?=\n\n● \*\*|\n● \*\*|\n▸ \*Thought\*)/).filter(Boolean)
    
    blocks.forEach((block, idx) => {
      const b = block.trim()
      if (!b) return
      
      let type: StepType = 'other'
      let title = 'Step'
      let content = b
      
      if (b.startsWith('● **Exec**:')) {
        type = 'exec'
        title = '执行命令'
        content = b.replace(/● \*\*Exec\*\*:\s*/, '').trim()
      } else if (b.startsWith('● **Search**:')) {
        type = 'search'
        title = '搜索'
        content = b.replace(/● \*\*Search\*\*:\s*/, '').trim()
      } else if (b.startsWith('● **File (')) {
        type = 'file'
        const match = b.match(/● \*\*File \((.*?)\)\*\*:\s*(.*)/)
        if (match) {
          title = `文件变更 (${match[1]})`
          content = match[2]
        } else {
          title = '文件操作'
        }
      } else if (b.startsWith('● **Plan**:')) {
        type = 'plan'
        title = '更新计划'
        content = b.replace(/● \*\*Plan\*\*:\s*/, '').trim()
      } else if (b.startsWith('▸ *Thought*:')) {
        type = 'thought'
        title = '思考分析'
        content = b.replace(/▸ \*Thought\*:\s*/, '').trim()
      } else if (b.startsWith('● **')) {
        type = 'tool'
        const match = b.match(/● \*\*(.*?)\*\*(.*)/s)
        if (match) {
          title = `调用工具: ${match[1]}`
          content = match[2].trim()
        }
      }

      if (title.length > 50) {
         title = title.substring(0, 50) + '...'
      }

      parsedSteps.push({
        id: `step-${idx}`,
        type,
        title,
        content,
        isComplete: !(isThinking && idx === blocks.length - 1)
      })
    })

    return parsedSteps
  }, [thought, isThinking])

  if (!isThinking && !thought) return null

  const formatDuration = (sec: number): string => {
    if (!sec || sec <= 0) return '0 秒'
    if (sec < 60) return `${sec.toFixed(1)} 秒`
    const mins = Math.floor(sec / 60)
    const secs = (sec % 60).toFixed(0)
    return `${mins} 分 ${secs} 秒`
  }

  const finalDurationSec = duration && duration > 0 ? duration : elapsed

  return (
    <div className="agent-execution-block" data-active={isThinking}>
      <button 
        className={`agent-execution-header ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
      >
        <div className="header-left">
          {isThinking ? (
            <span className="execution-icon active">
              <Sparkles size={14} className="sparkle-pulse" />
            </span>
          ) : (
            <span className="execution-icon done">
              <Brain size={14} />
            </span>
          )}
          
          <span className="execution-title">
            {isThinking 
              ? '思考与工具调用中...' 
              : steps.length > 0 
                ? `已完成思考与工具调用` 
                : '思考过程'
            }
          </span>

          <span className={`execution-duration ${isThinking ? 'active' : 'done'}`}>
            {isThinking 
              ? formatDuration(elapsed) 
              : `用时 ${formatDuration(finalDurationSec)}`
            }
          </span>
        </div>

        <div className="header-right">
          {steps.length > 0 && !isThinking && (
            <span className="step-count-badge">
              {steps.length} 个步骤
            </span>
          )}
          <ChevronRight 
            size={14} 
            className={`chevron-icon ${isOpen ? 'open' : ''}`} 
          />
        </div>
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="agent-execution-body-wrapper"
          >
            <div className="agent-execution-body">
              {steps.length > 0 ? (
                <div className="agent-timeline">
                  {steps.map((step, idx) => {
                    const isExpanded = expandedIds.has(step.id)
                    
                    let Icon = Play
                    if (step.type === 'exec') Icon = Terminal
                    else if (step.type === 'file') Icon = FileEdit
                    else if (step.type === 'search') Icon = Search
                    else if (step.type === 'plan') Icon = ListTodo
                    else if (step.type === 'thought') Icon = Brain
                    else if (step.type === 'tool') Icon = Terminal
                    
                    return (
                      <div key={step.id} className="timeline-step">
                        <div className="step-indicator">
                          <div className={`step-dot ${step.isComplete ? 'complete' : 'active'}`}>
                            {step.isComplete ? <Check size={8} /> : <div className="dot-pulse" />}
                          </div>
                          {idx < steps.length - 1 && <div className="step-line" />}
                        </div>
                        
                        <div className="step-content">
                          <div 
                            className={`step-header ${isExpanded ? 'expanded' : ''}`}
                            onClick={(e) => toggleStepExpand(step.id, e)}
                          >
                            <div className="step-title-row">
                              <Icon size={13} className="step-icon" />
                              <span className="step-title">{step.title}</span>
                            </div>
                            {isExpanded ? (
                              <ChevronDown size={14} className="step-chevron" />
                            ) : (
                              <ChevronRight size={14} className="step-chevron" />
                            )}
                          </div>
                          
                          <AnimatePresence>
                            {(isExpanded || (!step.isComplete && step.type !== 'thought')) && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="step-body-wrapper"
                              >
                                <div className="step-body">
                                  {step.type === 'thought' || step.type === 'plan' ? (
                                    <div className="markdown-body text-xs text-[var(--text-secondary)]">
                                      <MarkdownContent content={step.content} enableCodeBlocks />
                                    </div>
                                  ) : (
                                    <div className="step-code">
                                      {step.content}
                                    </div>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : isThinking ? (
                <div className="thinking-placeholder">
                  正在分析上下文与制定策略...
                </div>
              ) : (
                <div className="thinking-placeholder">
                  思考过程已完成。
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

