import { motion } from 'framer-motion'
import { Plus, FolderGit2, Folder, ArrowRight, AtSign, GitBranch, ListChecks, Sparkles } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation, Message } from '../lib/types'
import { MissionControl } from './MissionControl'

interface WelcomeScreenProps {
  activeConv: Conversation | null
  messages: Message[]
  setIsDrawerOpen: (open: boolean) => void
  setDrawerMode?: (mode: 'sessions' | 'create') => void
  conversations?: Conversation[]
  selectConversation?: (conv: Conversation) => void
  /** Puts a suggestion in the composer so the user can edit before sending. */
  onUseStarter?: (prompt: string) => void
}

/**
 * First-run prompts for a brand new project.
 *
 * An empty project used to show a single line of text with nothing to act on,
 * while the no-project screen was rich — the guidance was strongest exactly
 * where it was least needed.
 */
const STARTER_PROMPTS = [
  {
    Icon: FolderGit2,
    label: '梳理项目结构',
    prompt: '请先浏览这个仓库，说明它的整体结构、技术栈和主要模块之间的关系。',
  },
  {
    Icon: ListChecks,
    label: '运行测试',
    prompt: '找到这个项目的测试命令并运行，然后汇报结果；如果有失败的用例，分析原因。',
  },
  {
    Icon: GitBranch,
    label: '解释当前改动',
    prompt: '查看当前尚未提交的改动，逐个说明它们做了什么、有没有风险。',
  },
  {
    Icon: AtSign,
    label: '定位一个文件',
    prompt: '用 @ 引用具体文件后，我会针对它提问。先告诉我这个项目里最值得先读的三个文件。',
  },
] as const

export function WelcomeScreen({
  activeConv,
  messages,
  setIsDrawerOpen,
  setDrawerMode,
  conversations = [],
  selectConversation,
  onUseStarter,
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
            <div className="welcome-hero-icon compact"><LogoIcon size={34} /></div>

            <h1 className="welcome-hero-title">
              ORBIT <span className="title-highlight">PANE</span>
            </h1>

            <p className="welcome-subtitle">
              自主 Agent 代码与工程协同工作台
            </p>

            <div className="welcome-hero-actions">
              <button
                className="cw-create-btn"
                onClick={() => {
                  setIsDrawerOpen(true)
                  if (setDrawerMode) setDrawerMode('create')
                }}
                aria-label="新建项目"
              >
                <Plus size={15} strokeWidth={2} className="btn-icon" />
                <span>新建项目</span>
                <ArrowRight size={14} className="welcome-arrow-icon" />
              </button>
            </div>

            {conversations.length > 0 && selectConversation && (
              <MissionControl conversations={conversations} onSelect={selectConversation} />
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
              <Folder size={13} style={{ flexShrink: 0 }} />
              <span className="font-mono truncate" style={{ minWidth: 0 }}>{activeConv.path}</span>
            </div>

            {onUseStarter && (
              <div className="session-starter-block">
                <span className="session-starter-title">
                  <Sparkles size={13} />
                  从这些开始
                </span>
                <div className="session-starter-grid">
                  {STARTER_PROMPTS.map(({ Icon, label, prompt }) => (
                    <button
                      key={label}
                      type="button"
                      className="session-starter-card"
                      onClick={() => onUseStarter(prompt)}
                    >
                      <Icon size={15} />
                      <span>
                        <strong>{label}</strong>
                        <small>{prompt}</small>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="session-starter-hint">点击后会填入输入框，可以先修改再发送。</p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </>
  )
}
