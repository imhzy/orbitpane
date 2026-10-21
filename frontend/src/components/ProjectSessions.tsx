import { useState } from 'react'
import { Plus, Folder, Loader2 } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'
import { apiFetch, describeApiError } from '../lib/api'
import { emitConversationsChanged } from '../lib/appEvents'
import type { Conversation } from '../lib/types'

/** A canonical directory is a project; conversations retain independent histories. */
export function ProjectSessions() {
  const { activeConv, conversations, selectConversation, loadConversations, showToast } = useAppContext()
  const [creating, setCreating] = useState(false)
  if (!activeConv) return null
  const sessions = conversations.filter(item => item.path === activeConv.path && !item.is_archived)
  const createSession = async () => {
    if (creating) return
    setCreating(true)
    try {
      const created = await apiFetch<Conversation>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          name: `新会话 ${sessions.length + 1}`, path: activeConv.path,
          provider: activeConv.provider, preferred_model: activeConv.preferred_model,
          permission_mode: 'workspace',
        }),
      })
      await loadConversations()
      emitConversationsChanged()
      selectConversation(created)
    } catch (error) { showToast(describeApiError(error, '创建会话失败'), 'error') }
    finally { setCreating(false) }
  }
  return <div className="project-session-bar">
    <details className="project-location"><summary><Folder size={14} />项目详情</summary>
      <div><strong>{activeConv.path.split('/').filter(Boolean).at(-1) || '/'}</strong><code>{activeConv.path}</code>
        <p>同一目录下的会话共享项目文件，各自保留对话、模型配置和任务记录。</p></div>
    </details>
    <nav aria-label="项目内会话" className="session-navigation">
      {sessions.map(session => <button type="button" key={session.id} aria-current={session.id === activeConv.id ? 'page' : undefined}
        onClick={() => selectConversation(session)} title={session.name}>{session.name}</button>)}
    </nav>
    <button type="button" className="ui-btn ghost" disabled={creating} onClick={() => void createSession()}>
      {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}新会话
    </button>
  </div>
}
