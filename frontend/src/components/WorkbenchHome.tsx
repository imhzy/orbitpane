import { ArrowUpRight, FolderOpen, Layers3, Plus } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'
import { sortConversations } from '../lib/conversationOrder'
import type { Conversation } from '../lib/types'
import './WorkbenchHome.css'

export function WorkbenchHome() {
  const { conversations, isConversationsLoading, setDrawerMode, openSettings, selectConversation } = useAppContext()
  const active = sortConversations(conversations.filter(item => !item.is_archived))
  const projects = new Map<string, Conversation[]>()
  active.forEach(item => projects.set(item.path, [...(projects.get(item.path) || []), item]))
  const visibleProjects = [...projects.entries()].slice(0, 6)

  return <section className="workbench-home home-dashboard" aria-label="工作台">
    <div className="home-hero">
      <div className="home-start">
        <span className="home-eyebrow">ORBITPANE <span /> YOUR WORKSPACE</span>
        <h1>工作台</h1>
        <p>让想法落地，<br />从这里开始。</p>
        <button type="button" className="ui-btn primary" onClick={() => setDrawerMode('create')}>
          <Plus size={17} />打开项目<ArrowUpRight size={15} />
        </button>
      </div>
      <div className="home-orbit" aria-hidden="true">
        <div className="home-orbit-halo" />
        <div className="home-orbit-ring home-orbit-ring-outer" />
        <div className="home-orbit-ring home-orbit-ring-middle" />
        <div className="home-orbit-core"><span /></div>
        <div className="home-orbit-ring home-orbit-ring-front" />
        <span className="home-orbit-satellite" />
        <span className="home-orbit-caption">A SPACE FOR YOUR NEXT IDEA</span>
      </div>
      <div className="home-hero-footer">
        <span><span className="home-quiet-dot" />专注当下，自在探索</span>
        <span>{isConversationsLoading ? '正在载入工作空间' : `${projects.size} 个项目 · ${active.length} 个会话`}</span>
      </div>
    </div>

    <section className="home-projects" aria-labelledby="home-projects-title">
      <div className="home-section-heading">
        <div><span className="home-eyebrow">YOUR PROJECTS</span><h2 id="home-projects-title">继续你的工作</h2></div>
        <span className="home-section-note">{projects.size > 6 ? '更多项目可在侧栏查看' : '每一个想法，都有自己的空间'}</span>
      </div>
      {isConversationsLoading ? <p className="home-loading" role="status">正在载入项目…</p> : visibleProjects.length > 0 ? (
        <div className="home-project-grid">
          {visibleProjects.map(([path, sessions]) => {
            const conversation = sessions[0]
            const name = path.split('/').filter(Boolean).at(-1) || path
            return <button type="button" className="home-project-card" key={path}
              onClick={() => selectConversation(conversation)} aria-label={`打开项目 ${name}，继续会话 ${conversation.name}`}>
              <span className="home-card-top"><span className="home-folder-mark"><FolderOpen size={21} strokeWidth={1.5} /></span><ArrowUpRight size={17} /></span>
              <strong>{name}</strong>
              <span className="home-card-path" title={path}>{path}</span>
              <span className="home-card-footer"><span>{conversation.name}</span><small><Layers3 size={12} />{sessions.length} 个会话</small></span>
            </button>
          })}
        </div>
      ) : <div className="home-empty-projects">
        <span className="home-folder-mark"><FolderOpen size={24} strokeWidth={1.5} /></span>
        <div><h3>留一个空间，给下一个想法</h3><p>打开本地项目，与 Agent 一起探索、构建和完善。</p></div>
        <button type="button" className="ui-btn ghost" onClick={() => setDrawerMode('create')}>打开第一个项目<ArrowUpRight size={16} /></button>
      </div>}
      {!active.length && conversations.some(item => item.is_archived) && <button type="button" className="ui-btn ghost home-archive" onClick={() => openSettings('data')}>管理已归档会话</button>}
    </section>
  </section>
}
