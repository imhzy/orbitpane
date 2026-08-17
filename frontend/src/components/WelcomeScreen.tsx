import { Plus, FolderGit2, Folder, AtSign, GitBranch, ListChecks } from 'lucide-react'
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
  const openCreateDrawer = () => {
    setIsDrawerOpen(true)
    if (setDrawerMode) setDrawerMode('create')
  }

  return (
    <>
      {/* No project open. This is the app's landing view: it goes straight to
          the project list rather than to a title card, because a self-hosted
          tool never has to introduce itself to its only user. */}
      {!activeConv && (
        <div className="welcome-container">
          {conversations.length > 0 && selectConversation ? (
            <MissionControl
              conversations={conversations}
              onSelect={selectConversation}
              onCreate={openCreateDrawer}
            />
          ) : (
            <div className="welcome-empty">
              <p>还没有项目。选一个服务器上的目录，就能在里面运行 agent。</p>
              <button className="cw-create-btn" onClick={openCreateDrawer} aria-label="新建项目">
                <Plus size={15} strokeWidth={2} className="btn-icon" />
                <span>新建项目</span>
              </button>
            </div>
          )}
        </div>
      )}

      {activeConv && messages.filter(m => m.role !== 'system').length === 0 && (
        <div className="welcome-container session-empty-container">
          <div className="session-hero-wrapper">
            <h2 className="session-hero-title">{activeConv.name}</h2>
            <div className="session-path-badge">
              <Folder size={13} style={{ flexShrink: 0 }} />
              <span className="font-mono truncate" style={{ minWidth: 0 }}>{activeConv.path}</span>
            </div>

            {onUseStarter && (
              <div className="session-starter-block">
                {/* A label, not a sentence. "点击后填入输入框，可以先改再发"
                    described an interaction the first click teaches anyway,
                    and it was set at the same size as the prompts it labelled. */}
                <span className="session-starter-title">常用开场</span>
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
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
