import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown,
  ChevronRight,
  Play,
  Terminal,
  FileEdit,
  Search,
  ListTodo,
  Brain,
  Check,
  Activity,
  AlertTriangle,
  AlertCircle,
  Clock,
  Square,
} from 'lucide-react'
import MarkdownContent from './MarkdownContent'
import { asText } from '../lib/normalize'
import { REQUEST_INTERRUPT_EVENT } from '../lib/appEvents'
import type { HealthStatus } from '../lib/types'
import './AgentExecutionTimeline.css'

interface AgentExecutionTimelineProps {
  thought: string
  isThinking: boolean
  duration?: number
  elapsedSoFar?: number
  inactiveSeconds?: number
  healthStatus?: HealthStatus
  statusMessage?: string
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
  elapsedSoFar = 0,
  inactiveSeconds,
  healthStatus,
  statusMessage,
}: AgentExecutionTimelineProps) {
  const [isOpen, setIsOpen] = useState<boolean>(isThinking)
  const [filter, setFilter] = useState<'all' | 'actions' | 'thoughts'>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const prevThinkingRef = useRef<boolean>(isThinking)
  const elapsed = isThinking ? elapsedSoFar : (duration ?? elapsedSoFar)

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
    // Streamed straight off the socket, so it is only a string by convention.
    const transcript = asText(thought)
    if (!transcript) return []
    const parsedSteps: ParsedStep[] = []

    const blocks = transcript.split(/(?=\n\n● \*\*|\n● \*\*|\n▸ \*Thought\*)/).filter(Boolean)
    
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
         title = title.substring(0, 50) + '…'
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

  if (!isThinking && !thought && duration === undefined) return null

  const formatDuration = (sec: number): string => {
    if (!sec || sec <= 0) return '0 秒'
    if (sec < 60) return `${sec.toFixed(1)} 秒`
    const mins = Math.floor(sec / 60)
    const secs = (sec % 60).toFixed(0)
    return `${mins} 分 ${secs} 秒`
  }

  const finalDurationSec = duration ?? elapsed
  const visibleSteps = steps.filter(step => {
    if (filter === 'actions') return ['exec', 'tool', 'search', 'file'].includes(step.type)
    if (filter === 'thoughts') return ['thought', 'plan'].includes(step.type)
    return true
  })

  return (
    <div className="agent-execution-block" data-active={isThinking}>
      <button 
        className={`agent-execution-header ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
        aria-label={isThinking ? '思考与工具调用进行中' : `思考与工具调用已完成，用时 ${formatDuration(finalDurationSec)}`}
      >
        <div className="header-left">
          {isThinking ? (
            healthStatus === 'retrying' ? (
              <span className="execution-icon retrying" title="模型接口繁忙重试中">
                <AlertTriangle size={14} className="icon-pulse" />
              </span>
            ) : healthStatus === 'stalled' ? (
              <span className="execution-icon stalled" title="任务长时间无响应">
                <AlertCircle size={14} className="icon-pulse" />
              </span>
            ) : (
              <span className="execution-icon active">
                <Activity size={14} className="icon-pulse" />
              </span>
            )
          ) : (
            <span className="execution-icon done">
              <Brain size={14} />
            </span>
          )}
          
          <span className={`execution-title ${isThinking && healthStatus ? healthStatus : ''}`}>
            {isThinking 
              ? (healthStatus === 'compacting'
                  ? (statusMessage || '正在压缩上下文…')
                  : healthStatus === 'retrying'
                  ? (statusMessage || '模型服务繁忙，重试中…')
                  : healthStatus === 'stalled'
                    ? '长时间无输出（疑似卡住）'
                    : '思考与工具调用中…')
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
          {isThinking && healthStatus === 'retrying' && (
            <span className="step-status-badge retrying">重试中</span>
          )}
          {isThinking && healthStatus === 'stalled' && (
            <span className="step-status-badge stalled">疑似卡住</span>
          )}
          {isThinking && healthStatus === 'slow' && (
            <span className="step-status-badge slow">耗时较长</span>
          )}
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
              {steps.length > 1 && (
                <div className="timeline-filters" role="group" aria-label="执行步骤筛选">
                  <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部</button>
                  <button className={filter === 'actions' ? 'active' : ''} onClick={() => setFilter('actions')}>命令与文件</button>
                  <button className={filter === 'thoughts' ? 'active' : ''} onClick={() => setFilter('thoughts')}>分析与计划</button>
                </div>
              )}
              {steps.length > 0 ? (
                <div className="agent-timeline">
                  {visibleSteps.map((step, idx) => {
                    const isExpanded = expandedIds.has(step.id)
                    
                    let Icon = Play
                    if (step.type === 'exec') Icon = Terminal
                    else if (step.type === 'file') Icon = FileEdit
                    else if (step.type === 'search') Icon = Search
                    else if (step.type === 'plan') Icon = ListTodo
                    else if (step.type === 'thought') Icon = Brain
                    else if (step.type === 'tool') Icon = Terminal
                    
                    return (
                      <div key={step.id} className="timeline-step" data-type={step.type}>
                        <div className="step-indicator">
                          <div className={`step-dot ${step.isComplete ? 'complete' : 'active'}`}>
                            {step.isComplete ? <Check size={8} /> : <div className="dot-pulse" />}
                          </div>
                          {idx < visibleSteps.length - 1 && <div className="step-line" />}
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
                            {(isExpanded || !step.isComplete) && (
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
                <div className="thinking-placeholder" role="status" aria-live="polite">
                  正在分析上下文与制定策略...
                </div>
              ) : (
                <div className="thinking-placeholder">
                  思考过程已完成。
                </div>
              )}

              {isThinking && (
                <>
                  {healthStatus === 'retrying' && (
                    <div className="timeline-health-banner retrying" role="status">
                      <AlertTriangle size={15} className="health-banner-icon" />
                      <div className="health-banner-content">
                        <div className="health-banner-title">模型接口繁忙，正在自动重试</div>
                        <div className="health-banner-desc">
                          {statusMessage || '后台检测到模型服务暂时限流或繁忙（503），系统正在自动退避重试，无需刷新页面。'}
                        </div>
                      </div>
                    </div>
                  )}

                  {healthStatus === 'stalled' && (
                    <div className="timeline-health-banner stalled" role="alert">
                      <AlertCircle size={16} className="health-banner-icon" />
                      <div className="health-banner-content">
                        <div className="health-banner-title">
                          已超过 {formatDuration(inactiveSeconds ?? 120)} 无新输出，任务疑似卡住
                        </div>
                        <div className="health-banner-desc">
                          后台进程较长时间未产生新步骤或日志。可能是命令正处于无输出的长时间运行、交互阻塞或网络等待；若您确信任务仍在正常计算可继续等待，或者可直接中断。
                        </div>
                        <div className="health-banner-actions">
                          <button
                            type="button"
                            className="health-interrupt-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              window.dispatchEvent(new CustomEvent(REQUEST_INTERRUPT_EVENT))
                            }}
                          >
                            <Square size={12} fill="currentColor" />
                            <span>中断当前任务</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {healthStatus === 'slow' && (
                    <div className="timeline-health-banner slow" role="status">
                      <Clock size={14} className="health-banner-icon" />
                      <div className="health-banner-content">
                        <div className="health-banner-desc">
                          当前步骤已持续 {formatDuration(inactiveSeconds ?? 45)} 无新输出，后台正在处理耗时较长的操作...
                        </div>
                      </div>
                    </div>
                  )}

                  {steps.length > 0 && (
                    <div className="timeline-activity-footer">
                      <span>已执行 {steps.length} 个步骤</span>
                      <span className="activity-dot">·</span>
                      <span>
                        最近活动：{inactiveSeconds && inactiveSeconds >= 1 ? `${Math.round(inactiveSeconds)} 秒前` : '刚刚'}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
