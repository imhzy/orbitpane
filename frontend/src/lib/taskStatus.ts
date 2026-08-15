import {
  Activity,
  CheckCircle2,
  CircleDot,
  Clock3,
  Loader2,
  XCircle,
} from 'lucide-react'
import type { TaskRecord } from './types'

export type TaskStatus = TaskRecord['status']

/** Status buckets the UI actually filters on, independent of the raw status. */
export type TaskTone = 'idle' | 'queued' | 'running' | 'done' | 'attention' | 'stopped'

export interface TaskStatusDescriptor {
  /** The single label used everywhere this status is shown. */
  label: string
  tone: TaskTone
  Icon: typeof Activity
  /** Whether the icon should spin while this status is displayed. */
  animated: boolean
}

/**
 * One vocabulary for task status across the whole product.
 *
 * The mission board and the inspector queue used to carry their own maps, so
 * the same run could read "需处理" in one place and "失败" in the other. Every
 * surface now renders from here.
 */
const DESCRIPTORS: Record<TaskStatus, TaskStatusDescriptor> = {
  queued: { label: '排队中', tone: 'queued', Icon: Clock3, animated: false },
  starting: { label: '启动中', tone: 'running', Icon: Loader2, animated: true },
  running: { label: '执行中', tone: 'running', Icon: Loader2, animated: true },
  completed: { label: '已完成', tone: 'done', Icon: CheckCircle2, animated: false },
  failed: { label: '已失败', tone: 'attention', Icon: XCircle, animated: false },
  interrupted: { label: '已中断', tone: 'stopped', Icon: XCircle, animated: false },
  canceled: { label: '已取消', tone: 'stopped', Icon: XCircle, animated: false },
}

const IDLE: TaskStatusDescriptor = {
  label: '未运行',
  tone: 'idle',
  Icon: CircleDot,
  animated: false,
}

export function describeTaskStatus(status?: TaskStatus): TaskStatusDescriptor {
  return status ? DESCRIPTORS[status] ?? IDLE : IDLE
}

export function taskStatusLabel(status?: TaskStatus): string {
  return describeTaskStatus(status).label
}

export function taskStatusTone(status?: TaskStatus): TaskTone {
  return describeTaskStatus(status).tone
}

/** Queued, starting or running — i.e. the task still owns the project. */
export function isTaskActive(status?: TaskStatus): boolean {
  const tone = taskStatusTone(status)
  return tone === 'queued' || tone === 'running'
}

export function isTaskRunning(status?: TaskStatus): boolean {
  return taskStatusTone(status) === 'running'
}
