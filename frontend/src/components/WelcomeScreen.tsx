import { motion } from 'framer-motion'
import { Plus, FolderGit2, Folder, ArrowRight } from 'lucide-react'
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
}


export function WelcomeScreen({
  activeConv,
  messages,
  setIsDrawerOpen,
  setDrawerMode,
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
            <div className="welcome-hero-icon compact"><LogoIcon size={34} /></div>

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
            <p className="session-empty-tip">
              工程工作区已就绪。
            </p>
          </div>
        </motion.div>
      )}
    </>
  )
}
