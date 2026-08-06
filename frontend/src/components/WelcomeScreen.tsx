import { motion } from 'framer-motion'
import { Plus, FolderGit2, Folder, ArrowRight, Code2, Sparkles, Terminal, ShieldCheck, Cpu } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation, Message } from '../lib/types'

interface WelcomeScreenProps {
  activeConv: Conversation | null
  messages: Message[]
  setIsDrawerOpen: (open: boolean) => void
  setDrawerMode?: (mode: 'sessions' | 'create') => void
  onQuickPrompt?: (promptText: string) => void
  conversations?: Conversation[]
  selectConversation?: (conv: Conversation) => void
}

const QUICK_SUGGESTIONS = [
  {
    icon: Code2,
    title: '项目架构概览',
    desc: '梳理核心技术栈与目录职责',
    prompt: '请分析当前项目结构，说明主要模块职责与代码组织规范。',
  },
  {
    icon: Terminal,
    title: '检查代码变更',
    desc: '查看分支改动与未提交工作',
    prompt: '请运行 git status 和 git diff 检查最近的修改状态。',
  },
  {
    icon: Sparkles,
    title: '重构优化建议',
    desc: '审查关键组件交互与 UI 样式',
    prompt: '请审查前端交互与视觉设计，提出具体的优化重构建议。',
  },
  {
    icon: ShieldCheck,
    title: '自动化测试',
    desc: '运行项目测试用例并排除故障',
    prompt: '请查看测试用例覆盖情况，并检查是否存在潜在运行错误。',
  },
]

export function WelcomeScreen({
  activeConv,
  messages,
  setIsDrawerOpen,
  setDrawerMode,
  onQuickPrompt,
  conversations = [],
  selectConversation,
}: WelcomeScreenProps) {
  return (
    <>
      {!activeConv && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="welcome-container"
        >
          <div className="welcome-hero-wrapper">
            <div className="welcome-hero-icon">
              <LogoIcon size={48} />
            </div>

            <h1 className="welcome-hero-title">
              ORBIT <span className="title-highlight">PANE</span>
            </h1>

            <p className="welcome-subtitle">
              自主 Agent 代码与工程协同工作区
            </p>

            <div className="welcome-hero-actions">
              <button
                className="cw-create-btn"
                onClick={() => {
                  setIsDrawerOpen(true)
                  if (setDrawerMode) setDrawerMode('create')
                  window.dispatchEvent(new CustomEvent('highlight-drawer'))
                }}
                aria-label="选择或新建工程工作区"
              >
                <Plus size={15} strokeWidth={2} className="btn-icon" />
                <span>新建工程工作区</span>
                <ArrowRight size={14} className="welcome-arrow-icon" />
              </button>
            </div>

            {/* Quick Recent Conversations Shortcuts */}
            {conversations.length > 0 && selectConversation && (
              <div className="recent-workspaces-section">
                <div className="recent-workspaces-title">近期工作区</div>
                <div className="recent-workspaces-grid">
                  {conversations.slice(0, 4).map(conv => (
                    <button
                      key={conv.id}
                      className="recent-workspace-card"
                      onClick={() => selectConversation(conv)}
                      aria-label={`打开工作区 ${conv.name}`}
                    >
                      <div className="recent-card-icon">
                        <Cpu size={16} />
                      </div>
                      <div className="recent-card-info">
                        <span className="recent-card-name">{conv.name}</span>
                        <span className="recent-card-path">{conv.path}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {activeConv && messages.filter(m => m.role !== 'system').length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="welcome-container session-empty-container"
        >
          <div className="session-hero-wrapper">
            <div className="session-hero-icon">
              <FolderGit2 size={32} />
            </div>
            <h2 className="session-hero-title">
              {activeConv.name}
            </h2>
            <div className="session-path-badge">
              <Folder size={13} />
              <span className="font-mono">{activeConv.path}</span>
            </div>
            <p className="session-empty-tip">
              工程工作区已就绪。快捷选择提示词或在下方输入框发送开发指令：
            </p>

            {/* Quick Suggestion Chips */}
            <div className="quick-suggestions-grid">
              {QUICK_SUGGESTIONS.map((item, idx) => {
                const IconComponent = item.icon
                return (
                  <motion.button
                    key={idx}
                    whileHover={{ scale: 1.02, translateY: -2 }}
                    whileTap={{ scale: 0.98 }}
                    className="suggestion-chip-card"
                    onClick={() => onQuickPrompt?.(item.prompt)}
                    aria-label={`快捷开发指令：${item.title}`}
                  >
                    <div className="suggestion-chip-header">
                      <div className="suggestion-icon-badge">
                        <IconComponent size={14} />
                      </div>
                      <span className="suggestion-chip-title">{item.title}</span>
                    </div>
                    <span className="suggestion-chip-desc">{item.desc}</span>
                  </motion.button>
                )
              })}
            </div>
          </div>
        </motion.div>
      )}
    </>
  )
}
