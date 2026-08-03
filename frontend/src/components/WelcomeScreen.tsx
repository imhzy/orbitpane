import { motion } from 'framer-motion'
import { Plus, FolderGit2, Folder, ArrowRight } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation, Message } from '../lib/types'

interface WelcomeScreenProps {
  activeConv: Conversation | null
  messages: Message[]
  setIsDrawerOpen: (open: boolean) => void
  onQuickPrompt?: (promptText: string) => void
}

export function WelcomeScreen({ activeConv, messages, setIsDrawerOpen }: WelcomeScreenProps) {
  return (
    <>
      {!activeConv && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="welcome-container"
        >
          <div className="welcome-hero-wrapper">
            <div className="welcome-hero-icon">
              <LogoIcon size={48} />
            </div>

            <h1 className="welcome-hero-title">
              ANTIGRAVITY <span className="title-highlight">STUDIO</span>
            </h1>

            <p className="welcome-subtitle">
              智能代码结对与工程协同工作区
            </p>

            <button
              className="cw-create-btn"
              onClick={() => setIsDrawerOpen(true)}
            >
              <Plus size={15} strokeWidth={2} />
              <span>选择或创建工程工作区</span>
              <ArrowRight size={14} style={{ marginLeft: 4, opacity: 0.6 }} />
            </button>
          </div>
        </motion.div>
      )}

      {activeConv && messages.filter(m => m.role !== 'system').length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
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
              已就绪。在下方输入框描述需求。
            </p>
          </div>
        </motion.div>
      )}
    </>
  )
}

