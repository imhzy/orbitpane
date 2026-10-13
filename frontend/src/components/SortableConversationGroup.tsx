import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from 'framer-motion'
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  closestCenter, useSensor, useSensors,
} from '@dnd-kit/core'
import type { Modifier, UniqueIdentifier } from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy,
  sortableKeyboardCoordinates, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { Conversation } from '../lib/types'
import { useAppContext } from '../contexts/AppContext'
import { haptic } from '../lib/nativeFeedback'

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })
const modifiers = [verticalOnly]
type RenderItem = (conversation: Conversation, handle: ReactNode) => ReactNode

function SortableConversation({ conversation, disabled, renderItem }: {
  conversation: Conversation
  disabled: boolean
  renderItem: RenderItem
}) {
  const reducedMotion = useReducedMotion()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id, disabled,
    transition: reducedMotion ? null : { duration: 160, easing: 'ease' },
  })
  const handle = <button
    type="button"
    ref={setActivatorNodeRef}
    {...attributes}
    {...listeners}
    aria-disabled={disabled}
    tabIndex={disabled ? -1 : attributes.tabIndex}
    className="conversation-drag-handle"
    data-drawer-swipe-ignore
    aria-label={`调整项目顺序 ${conversation.name}`}
    aria-roledescription="排序手柄"
    title="按住拖动排序，或按空格后用上下方向键移动"
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
  ><GripVertical size={16} aria-hidden="true" /></button>
  return <div ref={setNodeRef} className={`sortable-conversation ${isDragging ? 'is-dragging' : ''}`}
    data-conversation-id={conversation.id} role="listitem"
    style={{ transform: CSS.Translate.toString(transform), transition }}>
    {renderItem(conversation, handle)}
  </div>
}

/** Separate contexts keep starred and unstarred rows in their own groups. */
export function SortableConversationGroup({ conversations, label, disabled, renderItem, onSortingChange }: {
  conversations: Conversation[]
  label: string
  disabled: boolean
  renderItem: RenderItem
  onSortingChange: (active: boolean) => void
}) {
  const { reorderConversations, getProviderBadge, providers } = useAppContext()
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)
  const [overlayWidth, setOverlayWidth] = useState(0)
  useEffect(() => () => onSortingChange(false), [onSortingChange])
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = conversations.map(item => item.id)
  const activeConversation = conversations.find(item => item.id === activeId)
  const badge = getProviderBadge(activeConversation?.provider, providers)
  const ProviderIcon = badge.Icon
  const name = (id: UniqueIdentifier) => conversations.find(item => item.id === id)?.name ?? '项目'
  const position = (id: UniqueIdentifier) => ids.indexOf(Number(id)) + 1
  return <DndContext
    sensors={sensors}
    collisionDetection={closestCenter}
    modifiers={modifiers}
    accessibility={{
      screenReaderInstructions: { draggable: '按空格或回车开始排序，用上下方向键调整位置，再按空格或回车保存，按 Escape 取消。星标项目单独排序。' },
      announcements: {
        onDragStart: ({ active }) => `已拿起${name(active.id)}，第 ${position(active.id)} 项，共 ${ids.length} 项。`,
        onDragOver: ({ active, over }) => over ? `${name(active.id)}移动到第 ${position(over.id)} 项。` : '已移出列表。',
        onDragEnd: ({ active, over }) => over ? `${name(active.id)}放到第 ${position(over.id)} 项。` : '已取消排序。',
        onDragCancel: () => '已取消排序，顺序未更改。',
      },
    }}
    onDragStart={({ active }) => {
      setActiveId(active.id)
      onSortingChange(true)
      setOverlayWidth(active.rect.current.initial?.width ?? 0)
      haptic('light')
    }}
    onDragCancel={() => {
      setActiveId(null)
      onSortingChange(false)
    }}
    onDragEnd={({ active, over }) => {
      setActiveId(null)
      onSortingChange(false)
      if (disabled || !over || active.id === over.id) return
      const from = ids.indexOf(Number(active.id))
      const to = ids.indexOf(Number(over.id))
      if (from < 0 || to < 0) return
      void reorderConversations(arrayMove(ids, from, to))
      haptic('selection')
    }}
  >
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <div className="conversation-sort-group" role="list" aria-label={label}>
        {conversations.map(conversation => <SortableConversation key={conversation.id}
          conversation={conversation} disabled={disabled || ids.length < 2} renderItem={renderItem} />)}
      </div>
    </SortableContext>
    {createPortal(<DragOverlay dropAnimation={null}>
      {activeConversation && <div className="list-item conversation-drag-overlay" style={{ width: overlayWidth }} aria-hidden="true">
        <GripVertical size={16} />
        <span className={`item-icon ${badge.type}`}><ProviderIcon size={22} /></span>
        <span className="item-content">
          <span className="item-title">{activeConversation.name}</span>
          <span className="item-meta-path">{activeConversation.path}</span>
        </span>
      </div>}
    </DragOverlay>, document.body)}
  </DndContext>
}
