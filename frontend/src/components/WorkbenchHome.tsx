import { FolderOpen } from 'lucide-react'
import { useAppContext } from '../contexts/AppContext'

export function WorkbenchHome() {
  const { conversations, setDrawerMode, openSettings } = useAppContext()
  const hasProjects = conversations.some(item => !item.is_archived)
  return <section className="workbench-home" aria-label="工作台">
    <div className="home-start">
      <FolderOpen size={32} strokeWidth={1.5} aria-hidden="true" />
      <h1>工作台</h1>
      <p>{hasProjects ? '从左侧选择会话，或打开一个项目。' : '打开一个项目，开始你的工作。'}</p>
      <button className="ui-btn primary" onClick={() => setDrawerMode('create')}><FolderOpen size={16} />打开项目</button>
      {!hasProjects && conversations.some(item => item.is_archived) && <button className="ui-btn ghost" onClick={() => openSettings('data')}>管理已归档会话</button>}
    </div>
  </section>
}
