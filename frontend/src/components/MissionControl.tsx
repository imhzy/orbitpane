import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Clock3, Radio, XCircle } from 'lucide-react'
import { apiFetch } from '../lib/api'
import type { Conversation, TaskRecord } from '../lib/types'
import { LogoIcon } from '../LogoIcon'

interface MissionControlProps {
  conversations: Conversation[]
  onSelect: (conversation: Conversation) => void
}

export function MissionControl({ conversations, onSelect }: MissionControlProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([])

  useEffect(() => {
    const load = () => {
      void apiFetch<{ items: TaskRecord[] }>('/api/tasks?limit=80')
        .then(data => setTasks(data.items))
        .catch(console.error)
    }
    load()
    const timer = window.setInterval(load, 5000)
    window.addEventListener('orbitpane-task-change', load)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('orbitpane-task-change', load)
    }
  }, [])

  const recentStatus = useMemo(() => {
    const status = new Map<number, TaskRecord['status']>()
    tasks.forEach(task => {
      if (!status.has(task.conversation_id)) status.set(task.conversation_id, task.status)
    })
    return status
  }, [tasks])

  const projects = conversations.filter(conversation => !conversation.is_archived)
  if (projects.length === 0) return null

  const runningCount = projects.filter(conversation => {
    const status = recentStatus.get(conversation.id)
    return status === 'running' || status === 'starting'
  }).length
  const queuedCount = projects.filter(conversation => recentStatus.get(conversation.id) === 'queued').length
  const attentionCount = projects.filter(conversation => recentStatus.get(conversation.id) === 'failed').length

  const statusIcon = (status?: TaskRecord['status']) => {
    if (status === 'running' || status === 'starting') return <Activity size={12} />
    if (status === 'queued') return <Clock3 size={12} />
    if (status === 'failed') return <XCircle size={12} />
    return <CheckCircle2 size={12} />
  }

  const statusLabel = (status?: TaskRecord['status']) => {
    if (status === 'running' || status === 'starting') return '执行中'
    if (status === 'queued') return '等待中'
    if (status === 'failed') return '需处理'
    if (status === 'completed') return '已完成'
    if (status === 'interrupted' || status === 'canceled') return '已停止'
    return '就绪'
  }

  return (
    <section className="mission-control" aria-label="项目任务总览">
      <div className="mission-control-heading">
        <div><Radio size={13} /><span>MISSION CONTROL</span></div>
        <small>{projects.length} 个活跃项目</small>
      </div>
      <div className="mission-control-body">
        <div className="mission-overview" aria-label="项目运行概况">
          <div className="orbit-map" aria-hidden="true">
            <div className="orbit-ring orbit-ring-one" />
            <div className="orbit-ring orbit-ring-two" />
            <div className="orbit-core"><LogoIcon size={24} /><span>OrbitPane</span></div>
          </div>
          <div className="mission-metrics">
            <span><b>{runningCount}</b> 执行</span>
            <span><b>{queuedCount}</b> 排队</span>
            <span className={attentionCount > 0 ? 'attention' : ''}><b>{attentionCount}</b> 异常</span>
          </div>
        </div>

        <div className="mission-project-grid">
          {projects.map(conversation => {
            const status = recentStatus.get(conversation.id)
            return (
              <button
                key={conversation.id}
                className={`orbit-project-node ${status || 'idle'}`}
                onClick={() => onSelect(conversation)}
                aria-label={`打开项目 ${conversation.name}`}
                title={conversation.name}
              >
                <span className="orbit-node-status">{statusIcon(status)}</span>
                <strong>{conversation.name}</strong>
                <small><span>{statusLabel(status)}</span><span>{conversation.provider}</span></small>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
