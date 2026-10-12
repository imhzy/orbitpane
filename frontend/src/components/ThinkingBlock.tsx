import { lazy, Suspense, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Activity, Brain, ChevronRight, AlertTriangle, AlertCircle, Square } from 'lucide-react'
import { REQUEST_INTERRUPT_EVENT } from '../lib/appEvents'
import type { HealthStatus } from '../lib/types'
import './ThinkingBlock.css'

const MarkdownContent = lazy(() => import('./MarkdownContent'))

export function ThinkingBlock({ 
  thought, 
  isThinking, 
  duration,
  elapsedSoFar = 0,
  inactiveSeconds,
  healthStatus,
  statusMessage,
}: { 
  thought: string; 
  isThinking: boolean; 
  duration?: number;
  elapsedSoFar?: number;
  inactiveSeconds?: number;
  healthStatus?: HealthStatus;
  statusMessage?: string;
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
            healthStatus === 'retrying' ? (
              <span className="thinking-icon retrying" title="模型接口繁忙重试中">
                <AlertTriangle size={14} className="icon-pulse" />
              </span>
            ) : healthStatus === 'stalled' ? (
              <span className="thinking-icon stalled" title="任务长时间无响应">
                <AlertCircle size={14} className="icon-pulse" />
              </span>
            ) : (
              <span className="thinking-icon active">
                <Activity size={14} className="icon-pulse" />
              </span>
            )
          ) : (
            <span className="thinking-icon done">
              <Brain size={14} />
            </span>
          )}
          <span className="thinking-label">
            {isThinking 
              ? (healthStatus === 'compacting'
                  ? (statusMessage || '正在压缩上下文…')
                  : healthStatus === 'retrying'
                  ? (statusMessage || '模型重试中…')
                  : healthStatus === 'stalled'
                    ? '疑似卡住'
                    : '思考中…')
              : '思考过程'}
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

              {isThinking && healthStatus === 'stalled' && (
                <div className="timeline-health-banner stalled" style={{ marginTop: '8px' }}>
                  <AlertCircle size={15} className="health-banner-icon" />
                  <div className="health-banner-content">
                    <div className="health-banner-title">
                      已超过 {formatElapsed(inactiveSeconds ?? 120)} 无新输出，疑似卡住
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

              {isThinking && healthStatus === 'retrying' && (
                <div className="timeline-health-banner retrying" style={{ marginTop: '8px' }}>
                  <AlertTriangle size={15} className="health-banner-icon" />
                  <div className="health-banner-content">
                    <div className="health-banner-title">模型服务繁忙重试中</div>
                    <div className="health-banner-desc">{statusMessage || '系统正在自动退避重试，无需刷新页面。'}</div>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
