import React, { useState, useEffect } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { MotionValue } from 'framer-motion'
import {
  X, MessageSquare, Plus, Trash2, Folder,
  ChevronRight, Compass, FolderPlus,
  Check, Pencil, Layers, HardDrive, RefreshCw, Cpu,
  Search, Star, Settings, Command, MoreHorizontal, ChevronDown, Maximize2, Minimize2,
  Archive, ShieldAlert, ShieldCheck, ArrowUp, ArrowDown, GripVertical
} from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation } from '../lib/types'
import { hasProviderChoice } from '../lib/providers'
import { sortConversations } from '../lib/conversationOrder'
import { haptic } from '../lib/nativeFeedback'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import { MobileBottomSheet } from './MobileBottomSheet'
import { ConversationNameInput } from './ConversationNameInput'
import { SortableConversationGroup } from './SortableConversationGroup'

import { useAppContext } from '../contexts/AppContext'

interface SidebarProps {
  /** On screen at all, including while it slides out. Owned by the gesture controller. */
  isVisible: boolean
  /** Horizontal offset in pixels, driven by gesture and spring alike. */
  drawerX?: MotionValue<number>
}

/* Damped hard enough not to overshoot: this carries a list the user is
   reading, and a bounce at the end reads as a glitch rather than as polish. */
const PANE_ZOOM = { type: 'spring' as const, stiffness: 380, damping: 40, mass: 0.9 }
const PANE_ZOOM_REDUCED = { duration: 0 }

/* Switching tabs moves through the panes rather than sideways past them: the
   outgoing pane grows and dissolves as the incoming one rises to meet it, so
   the whole drawer reads as one surface zooming instead of two panels being
   swapped. The sessions list sits nearest the viewer and the create flow one
   step behind it, which is what gives the transition its direction. */
const SESSIONS_PANE = {
  active: { opacity: 1, scale: 1 },
  hidden: { opacity: 0, scale: 1.06 },
}
const CREATE_PANE = {
  active: { opacity: 1, scale: 1 },
  hidden: { opacity: 0, scale: 0.94 },
}

function projectMenuPosition(element: Element) {
  const trigger = element.querySelector<HTMLElement>('.project-menu-trigger') ?? element
  const rect = trigger.getBoundingClientRect()
  return {
    top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 304)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 210)),
  }
}

export function Sidebar({ isVisible, drawerX }: SidebarProps) {
  const {
    isDrawerOpen, drawerMode, setDrawerMode,
    conversations, isConversationsLoading, activeConv, selectConversation,
    editingConvId, editingConvSurface, saveConvName, startEditingConv,
    deleteConversation, getProviderBadge, reorderConversations, isReorderingConversations,
    providers, newConvName, setNewConvName, selectedDir, setSelectedDir,
    currentPath, setCurrentPath, selectedProvider, setSelectedProvider,
    selectedPermissionMode, setSelectedPermissionMode,
    defaultProvider, items, loadDir, getBreadcrumbParts, createConversation,
    loadConversations, updateConversation, showToast, requestCloseDrawer,
    openSettings, settingsSection, setIsCmdPaletteOpen
  } = useAppContext()

  const [searchTerm, setSearchTerm] = useState('')
  const [isSorting, setIsSorting] = useState(false)
  const [isDirectoryExpanded, setIsDirectoryExpanded] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [unrestrictedAcknowledged, setUnrestrictedAcknowledged] = useState(false)
  const canLeaveFirstStep = Boolean(newConvName.trim() && selectedDir.trim())
  const isSelectedProviderAvailable = providers.length === 0 || Boolean(
    providers.find(provider => provider.id === (selectedProvider || defaultProvider))?.available
  )
  const canCreateProject = canLeaveFirstStep
    && isSelectedProviderAvailable
    && (selectedPermissionMode !== 'unrestricted' || unrestrictedAcknowledged)
  const showProviderTags = hasProviderChoice(providers)
  /* The global reduced-motion rule only reaches CSS transitions; a spring
     driven in JS keeps running unless it is asked not to. */
  const prefersReducedMotion = useReducedMotion()
  const paneZoom = prefersReducedMotion ? PANE_ZOOM_REDUCED : PANE_ZOOM
  const [contextConv, setContextConv] = useState<Conversation | null>(null)
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  const menuRef = useFocusTrap<HTMLDivElement>(contextConv !== null && !isPhone && !settingsSection)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)')
    const sync = () => setIsPhone(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  /* Only an overlay drawer is modal; the docked desktop column must keep Tab
     flowing into the conversation next to it. */
  const [isOverlayDrawer, setIsOverlayDrawer] = useState(() => window.innerWidth < 1024)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const sync = () => setIsOverlayDrawer(!query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  /* Focus the panel itself, not the first control in it. The default target is
     the refresh button, and a drawer pulled open by a swipe would arrive with
     a focus ring drawn around it as if the user had selected it. Tab still
     steps into the header from here. */
  const drawerRef = useFocusTrap<HTMLDivElement>(isDrawerOpen && isOverlayDrawer && !settingsSection, {
    initialFocus: (): HTMLElement | null => drawerRef.current,
  })
  // While sorting, dnd-kit's sensor owns Escape; cancelling must leave the
  // overlay drawer open, ready for the next keyboard operation.
  useEscapeLayer(isDrawerOpen && isOverlayDrawer && !settingsSection && !isSorting, requestCloseDrawer)
  useEscapeLayer(contextConv !== null, () => setContextConv(null))
  const longPressRef = React.useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClickRef = React.useRef(false)

  const cancelLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }

  const beginLongPress = (event: React.PointerEvent, conversation: Conversation) => {
    if (event.pointerType !== 'touch') return
    if ((event.target as Element).closest('button, input')) return
    cancelLongPress()
    const position = projectMenuPosition(event.currentTarget)
    longPressRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        suppressClickRef.current = true
        haptic('light')
        setMenuPosition(position)
        setContextConv(conversation)
        longPressRef.current = null
      }, 460),
    }
  }

  const moveLongPress = (event: React.PointerEvent) => {
    const pending = longPressRef.current
    if (!pending) return
    if (Math.abs(event.clientX - pending.x) > 10 || Math.abs(event.clientY - pending.y) > 10) cancelLongPress()
  }

  useEffect(() => {
    if (isDrawerOpen && window.innerWidth < 1024) {
      const originalOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = originalOverflow
      }
    }
  }, [isDrawerOpen])

  useEffect(() => {
    if (!isDrawerOpen || drawerMode !== 'create') {
      setIsDirectoryExpanded(false)
      setIsAdvancedOpen(false)
      setUnrestrictedAcknowledged(false)
    }
  }, [isDrawerOpen, drawerMode])

  useEffect(() => {
    if (!contextConv) return
    const close = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest('.project-actions-sheet, .project-menu-trigger')) return
      if (!menuRef.current?.contains(event.target as Node)) setContextConv(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextConv, menuRef])

  const filteredConvs = sortConversations(conversations.filter(c =>
    !c.is_archived && (
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.path.toLowerCase().includes(searchTerm.toLowerCase())
    )
  ))
  const sortingDisabled = isReorderingConversations || editingConvId !== null || Boolean(searchTerm.trim())
  const contextGroup = filteredConvs.filter(item => item.is_pinned === contextConv?.is_pinned)
  const contextIndex = contextGroup.findIndex(item => item.id === contextConv?.id)
  const moveContextConversation = (direction: -1 | 1) => {
    const target = contextIndex + direction
    if (sortingDisabled || contextIndex < 0 || target < 0 || target >= contextGroup.length) return
    const ids = contextGroup.map(item => item.id)
    ;[ids[contextIndex], ids[target]] = [ids[target], ids[contextIndex]]
    void reorderConversations(ids)
    haptic('selection')
    setContextConv(null)
  }

  const projectActions = contextConv && <>
    <button type="button" role="menuitem" onClick={() => {
      openSettings('project', contextConv.id)
      setContextConv(null)
    }}><Settings size={16} />项目设置</button>
    <button type="button" role="menuitem" onClick={() => {
      void updateConversation(contextConv.id, { is_pinned: !contextConv.is_pinned })
      haptic('selection')
      setContextConv(null)
    }}><Star size={16} fill={contextConv.is_pinned ? 'currentColor' : 'none'} />{contextConv.is_pinned ? '取消星标' : '星标置顶'}</button>
    <button type="button" role="menuitem" onClick={() => {
      startEditingConv(contextConv, 'sidebar')
      setContextConv(null)
    }}><Pencil size={16} />重命名项目</button>
    <button type="button" role="menuitem" disabled={sortingDisabled || contextIndex <= 0}
      onClick={() => moveContextConversation(-1)}><ArrowUp size={16} />上移</button>
    <button type="button" role="menuitem" disabled={sortingDisabled || contextIndex < 0 || contextIndex >= contextGroup.length - 1}
      onClick={() => moveContextConversation(1)}><ArrowDown size={16} />下移</button>
    <button type="button" role="menuitem" onClick={() => {
      void updateConversation(contextConv.id, { is_archived: !contextConv.is_archived })
      setContextConv(null)
    }}><Archive size={16} />{contextConv.is_archived ? '恢复项目' : '归档项目'}</button>
    <button type="button" role="menuitem" className="destructive" onClick={event => {
      deleteConversation(event, contextConv.id)
      haptic('warning')
      setContextConv(null)
    }}><Trash2 size={16} />删除项目</button>
  </>

  return (
    <>
      {isVisible && (
          <motion.div
            ref={drawerRef}
            style={drawerX ? { x: drawerX } : undefined}
            className={`drawer ${drawerMode === 'create' ? 'create-mode' : ''} ${drawerMode === 'create' && isDirectoryExpanded ? 'directory-focus-mode' : ''}`}
            role={isDrawerOpen && isOverlayDrawer ? 'dialog' : undefined}
            aria-modal={isDrawerOpen && isOverlayDrawer ? true : undefined}
            aria-hidden={!isDrawerOpen ? true : undefined}
            inert={!isDrawerOpen ? true : undefined}
            aria-label="项目菜单"
          >
          <div className="drawer-header">
            <div className="drawer-brand">
              <LogoIcon size={24} />
              <div className="brand-title-group">
                <span className="brand-wordmark">OrbitPane</span>
              </div>
            </div>
            <div className="header-actions">
              <button 
                className="icon-btn" 
                title="刷新数据" 
                onClick={() => {
                  loadConversations(false)
                  if (drawerMode === 'create') loadDir(currentPath)
                  showToast('最新数据已刷新')
                }}
              >
                <RefreshCw size={14} className={isConversationsLoading ? 'animate-spin' : ''} />
              </button>
              <button
                className="icon-btn"
                onClick={requestCloseDrawer}
                title="关闭菜单"
                aria-label="关闭菜单"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          {/* The selected pill is one element that travels between the tabs
              (shared layoutId) instead of one background switching off while
              another switches on — so the indicator and the panes below it
              move together. */}
          <div className="drawer-tabs" role="tablist">
            {([
              { mode: 'sessions' as const, Icon: MessageSquare, label: '项目列表' },
              { mode: 'create' as const, Icon: Plus, label: '新建项目' },
            ]).map(({ mode, Icon, label }) => (
              <button
                key={mode}
                role="tab"
                aria-selected={drawerMode === mode}
                className={`drawer-tab-btn ${drawerMode === mode ? 'active' : ''}`}
                onClick={() => setDrawerMode(mode)}
              >
                {drawerMode === mode && (
                  <motion.span
                    layoutId="drawer-tab-pill"
                    className="drawer-tab-pill"
                    transition={paneZoom}
                  />
                )}
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* The two modes are stacked in depth and cross-zoom, rather than
              swapping instantly. Both panes stay mounted so the browser keeps
              each one's scroll position — an unmount/remount resets it, which
              is what made the old switch feel like a page load. The inactive
              pane is `inert` so it takes no focus and is invisible to
              assistive tech. */}
          <div className="drawer-panes">
            <motion.div
              className="drawer-pane"
              inert={drawerMode !== 'sessions'}
              variants={SESSIONS_PANE}
              animate={drawerMode === 'sessions' ? 'active' : 'hidden'}
              transition={paneZoom}
              initial={false}
            >
                <div className="drawer-content">
              {/* Search input for conversations */}
              {conversations.length > 0 && (
                <div className="sidebar-search-box">
                  <Search size={14} className="search-icon" />
                  <input
                    type="text"
                    className="sidebar-search-input"
                    placeholder="搜索项目或路径…"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                  />
                  {searchTerm && (
                    <button className="search-clear-btn" onClick={() => setSearchTerm('')}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}
              {filteredConvs.length > 1 && <p className="sidebar-sort-hint">
                <GripVertical size={12} aria-hidden="true" />
                <span>{searchTerm.trim() ? '清空搜索后可调整顺序' : isReorderingConversations ? '正在保存顺序…' : '拖动手柄排序，也可在菜单中上移、下移'}</span>
              </p>}
              {isConversationsLoading ? (
                <div className="flex flex-col gap-2 p-2">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-14 rounded-xl skeleton-shimmer" />
                  ))}
                </div>
              ) : filteredConvs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 opacity-70">
                  <Compass size={44} className="text-[var(--accent-color)] mb-3 opacity-60" />
                  <div className="text-center text-[var(--text-secondary)] text-[14px] font-medium">
                    {searchTerm ? '未找到相关项目' : '暂无项目'}
                  </div>
                  <div className="text-center text-[var(--text-tertiary)] text-[12px] mt-1 mb-4">
                    {searchTerm ? '尝试更改搜索关键词' : '点击下方按钮创建第一个项目'}
                  </div>
                  {searchTerm ? (
                    <button 
                      className="secondary-text-btn" 
                      onClick={() => setSearchTerm('')}
                      style={{ marginTop: 8 }}
                    >
                      清空搜索词
                    </button>
                  ) : (
                    <button 
                      className="cw-create-btn" 
                      onClick={() => setDrawerMode('create')}
                    >
                      <Plus size={14} className="btn-icon" /> 立即创建
                    </button>
                  )}
                </div>
              ) : (
                (() => {
                  const pinnedConvs = filteredConvs.filter(c => c.is_pinned)
                  const unpinnedConvs = filteredConvs.filter(c => !c.is_pinned)

                  const renderConvItem = (conv: Conversation, dragHandle: React.ReactNode) => {
                    const isEditing = editingConvId === conv.id && editingConvSurface === 'sidebar'
                    const isPinned = conv.is_pinned
                    const badge = getProviderBadge(conv.provider, providers)
                    const ProviderIcon = badge.Icon
                    return (
                      <div 
                        key={conv.id} 
                        className={`list-item ${activeConv?.id === conv.id ? 'selected' : ''} ${isPinned ? 'pinned-item' : ''}`}
                        onClick={() => {
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false
                            return
                          }
                          if (!isEditing) {
                            selectConversation(conv)
                          }
                        }}
                        onPointerDown={event => beginLongPress(event, conv)}
                        onPointerMove={moveLongPress}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onContextMenu={event => {
                          if (!window.matchMedia('(pointer: coarse)').matches) return
                          event.preventDefault()
                          setMenuPosition(projectMenuPosition(event.currentTarget))
                          setContextConv(conv)
                          haptic('light')
                        }}
                      >
                        {dragHandle}
                        <div className={`item-icon ${badge.type}`} role="img" aria-label={badge.text} title={badge.text}>
                          <ProviderIcon size={22} />
                        </div>
                        <div className="item-content">
                          {isEditing ? (
                            <ConversationNameInput conversationId={conv.id} />
                          ) : (
                            <>
                              <div className="item-title-row">
                                <span className="item-title" title={conv.name}>{conv.name}</span>
                                {isPinned && <Star size={11} className="pin-star-icon" fill="currentColor" />}
                              </div>
                              <span className="item-meta-row">
                                {showProviderTags && (
                                  <span className="item-provider-name">{badge.text}</span>
                                )}
                                <span className="item-meta-path" title={conv.path}>{conv.path}</span>
                              </span>
                            </>
                          )}
                        </div>
                        <div className="item-actions header-actions" onClick={e => e.stopPropagation()}>
                          {isEditing ? (
                            <button
                              className="icon-btn"
                              title="保存名称"
                              aria-label="保存名称"
                              onMouseDown={event => event.preventDefault()}
                              onClick={() => saveConvName(conv.id)}
                            >
                              <Check size={14} />
                            </button>
                          ) : (
                            <>
                              <button type="button" className="icon-btn project-menu-trigger"
                                title="项目操作" aria-label={`项目操作 ${conv.name}`}
                                aria-haspopup="menu" aria-expanded={contextConv?.id === conv.id}
                                onClick={event => {
                                  event.stopPropagation()
                                  setMenuPosition(projectMenuPosition(event.currentTarget))
                                  setContextConv(previous => previous?.id === conv.id ? null : conv)
                                }}><MoreHorizontal size={16} /></button>
                            </>
                          )}
                        </div>
                      </div>
                    )
                  }

                  return (
                    <div className="flex flex-col gap-3">
                      {pinnedConvs.length > 0 && (
                        <div className="sidebar-section-group">
                          <div className="sidebar-section-title">
                            <Star size={12} className="icon-warning" />
                            <span>星标置顶 ({pinnedConvs.length})</span>
                          </div>
                          <SortableConversationGroup conversations={pinnedConvs} label="星标项目" disabled={sortingDisabled} renderItem={renderConvItem} onSortingChange={setIsSorting} />
                        </div>
                      )}

                      {unpinnedConvs.length > 0 && (
                        <div className="sidebar-section-group">
                          {pinnedConvs.length > 0 && (
                            <div className="sidebar-section-title">
                              <span>所有项目 ({unpinnedConvs.length})</span>
                            </div>
                          )}
                          <SortableConversationGroup conversations={unpinnedConvs} label="所有项目" disabled={sortingDisabled} renderItem={renderConvItem} onSortingChange={setIsSorting} />
                        </div>
                      )}
                    </div>
                  )
                })()
              )}
                </div>

            </motion.div>

            {/* Create Project Mode */}
            <motion.div
              className="drawer-pane"
              inert={drawerMode !== 'create'}
              variants={CREATE_PANE}
              animate={drawerMode === 'create' ? 'active' : 'hidden'}
              transition={paneZoom}
              initial={false}
            >
                <div className="drawer-content cw-content">
              <div className="cw-header">
                <h3 className="cw-title">新建项目</h3>
              </div>
              <>
                  <div className="cw-form">
                    <div className="cw-field-group">
                      <label className="cw-label">项目名称</label>
                      <div className="cw-input-wrapper">
                        <Layers size={14} className="cw-icon" />
                        <input
                          type="text"
                          value={newConvName}
                          onChange={event => setNewConvName(event.target.value)}
                          className="cw-input"
                          aria-label="项目名称"
                          placeholder="如：OrbitPane 前端"
                        />
                      </div>
                    </div>

                    <div className="cw-field-group">
                      <label className="cw-label">项目路径</label>
                      <div className="cw-input-wrapper">
                        <Folder size={14} className="cw-icon" />
                        <input
                          type="text"
                          placeholder="输入允许范围内的绝对路径"
                          value={selectedDir}
                          onChange={event => {
                            setSelectedDir(event.target.value)
                            if (event.target.value.startsWith('/')) setCurrentPath(event.target.value)
                          }}
                          className="cw-input font-mono"
                          aria-label="项目路径"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="cw-browser-section">
                <div className="cw-browser-header">
                  <span className="cw-browser-title">
                    {isDirectoryExpanded ? '选择项目目录' : '目录浏览'}
                  </span>
                  <div className="cw-browser-actions">
                    <button
                      className="icon-btn cw-browser-refresh-btn"
                      title="刷新目录"
                      aria-label="刷新目录"
                      onClick={() => {
                        loadDir(currentPath)
                        showToast('目录结构已刷新')
                      }}
                    >
                      <RefreshCw size={12} />
                    </button>
                    <button
                      type="button"
                      className="cw-browser-expand-btn"
                      onClick={() => setIsDirectoryExpanded(expanded => !expanded)}
                      aria-expanded={isDirectoryExpanded}
                      aria-label={isDirectoryExpanded ? '完成目录选择' : '展开目录浏览'}
                    >
                      {isDirectoryExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      <span>{isDirectoryExpanded ? '完成' : '展开'}</span>
                    </button>
                  </div>
                </div>
                <div className="cw-browser">
                  <div className="cw-crumbs">
                    {getBreadcrumbParts(currentPath).map((part, idx, arr) => (
                      <div key={part.fullPath} className="cw-crumb-item">
                        <button
                          className={`cw-crumb ${idx === arr.length - 1 ? 'active' : ''}`}
                          onClick={() => {
                            setCurrentPath(part.fullPath)
                            setSelectedDir(part.fullPath)
                          }}
                        >
                          {part.name === '/' ? <HardDrive size={12} /> : part.name}
                        </button>
                        {idx < arr.length - 1 && <ChevronRight size={10} className="cw-crumb-sep" />}
                      </div>
                    ))}
                  </div>

                  <div className="cw-list">
                    {(() => {
                      const filtered = items.filter(item => item.is_dir)

                      if (filtered.length === 0) {
                        return (
                          <div className="cw-empty">
                            <FolderPlus size={20} />
                            <span>该目录下无子文件夹</span>
                          </div>
                        )
                      }

                      return filtered.map(item => {
                        const isSelected = selectedDir === item.path
                        return (
                          <button 
                            key={item.path}
                            className={`cw-item ${isSelected ? 'selected' : ''}`}
                            onClick={() => {
                              setSelectedDir(item.path)
                              setCurrentPath(item.path)
                              if (!newConvName.trim()) {
                                setNewConvName(item.name)
                              }
                            }}
                            aria-label={`选择并进入目录 ${item.name}`}
                          >
                            <Folder size={14} className="cw-item-icon" />
                            <span className="cw-item-name">{item.name}</span>
                            {isSelected && (
                              <motion.span 
                                initial={{ scale: 0 }} 
                                animate={{ scale: 1 }} 
                                className="cw-check"
                              >
                                <Check size={10} strokeWidth={3} />
                              </motion.span>
                            )}
                            <span className="cw-enter" aria-hidden="true">
                              <ChevronRight size={14} />
                            </span>
                          </button>
                        )
                      })
                    })()}
                  </div>
                </div>
                  </div>
              </>

              <button type="button" className="cw-advanced-toggle" aria-expanded={isAdvancedOpen}
                onClick={() => setIsAdvancedOpen(open => !open)}>
                <Cpu size={14} /><span>运行配置<small>{providers.find(provider => provider.id === (selectedProvider || defaultProvider))?.name || selectedProvider} · {selectedPermissionMode === 'workspace' ? '受限工作区' : '完全访问'}</small></span>
                <ChevronDown size={15} className={isAdvancedOpen ? 'open' : ''} />
              </button>
              <p className="cw-default-note">默认配置可在<button type="button" onClick={() => openSettings('ai')}>设置 → AI 与工作区</button>中调整。</p>

              {isAdvancedOpen && (
                <div className="cw-provider-step">
                  <div className="cw-form">
                    <div className="cw-field-group">
                      <label className="cw-label">Agent 接入方式</label>
                      <div className="cw-input-wrapper">
                        <Cpu size={14} className="cw-icon" />
                        <select className="cw-input cw-agent-select" aria-label="选择 Agent"
                          value={selectedProvider || defaultProvider} onChange={event => setSelectedProvider(event.target.value)}>
                          {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.available}>
                            {provider.name}{!provider.available ? '（不可用）' : ''}
                          </option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                  {/* A missing agent CLI is the most common first-run failure.
                      Say so here rather than letting "创建项目" fail with a
                      backend error the user cannot interpret. */}
                  {!isSelectedProviderAvailable && (
                    <div className="cw-provider-warning" role="alert">
                      <ShieldAlert size={15} />
                      <span>
                        <strong>该 Agent 当前不可用</strong>
                        <small>
                          未在服务器上检测到对应的命令行工具。请先安装并确保它在 PATH 中，
                          或在上方切换到其他可用 Agent。
                        </small>
                      </span>
                    </div>
                  )}
                  <div className="permission-mode-section">
                    <span className="cw-label">文件系统权限</span>
                    <div className="permission-mode-options" role="radiogroup" aria-label="文件系统权限">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedPermissionMode === 'workspace'}
                        className={selectedPermissionMode === 'workspace' ? 'selected' : ''}
                        onClick={() => {
                          setSelectedPermissionMode('workspace')
                          setUnrestrictedAcknowledged(false)
                        }}
                      >
                        <ShieldCheck size={20} />
                        <span><strong>受限工作区</strong><small>默认；Agent 只能在所选目录内读写</small></span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedPermissionMode === 'unrestricted'}
                        className={`danger ${selectedPermissionMode === 'unrestricted' ? 'selected' : ''}`}
                        onClick={() => setSelectedPermissionMode('unrestricted')}
                      >
                        <ShieldAlert size={20} />
                        <span><strong>完全访问</strong><small>跳过审批与沙箱，可访问运行账户允许的所有路径</small></span>
                      </button>
                    </div>
                    {/* Full access is a real risk, so it cannot be reached by
                        clicking through the wizard without reading anything. */}
                    {selectedPermissionMode === 'unrestricted' && (
                      <label className="permission-ack">
                        <input
                          type="checkbox"
                          checked={unrestrictedAcknowledged}
                          onChange={event => setUnrestrictedAcknowledged(event.target.checked)}
                        />
                        <span>我了解该模式下 Agent 可以修改这台机器上运行账户能访问的任何文件。</span>
                      </label>
                    )}
                  </div>
                </div>
              )}

              <div className="cw-action cw-wizard-actions">
                <button className="cw-create-btn" disabled={!canCreateProject}
                  title={!canLeaveFirstStep ? '请填写项目名称与目录' : !isSelectedProviderAvailable ? '所选 Agent 当前不可用' : !canCreateProject ? '请先确认完全访问模式的风险' : undefined}
                  onClick={() => { createConversation(); setIsAdvancedOpen(false); setUnrestrictedAcknowledged(false) }}>
                  <Plus size={16} strokeWidth={2.5} /><span>创建项目</span>
                </button>
              </div>
                </div>
            </motion.div>
          </div>

          <div className="sidebar-footer">
            <button type="button" className="sidebar-footer-btn sidebar-command-btn" onClick={() => setIsCmdPaletteOpen(true)}>
              <Command size={16} /><span>搜索与快捷指令</span><kbd>⌘K</kbd>
            </button>
            <button type="button" className="sidebar-footer-btn sidebar-settings-btn" onClick={() => openSettings()}>
              <Settings size={16} /><span>设置</span><ChevronRight size={14} />
            </button>
          </div>
          </motion.div>
      )}
      {contextConv && !isPhone && <div ref={menuRef} className="project-actions-popover" role="menu" aria-label="项目操作"
        style={{ top: menuPosition.top, left: menuPosition.left }} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}>{projectActions}</div>}
      <MobileBottomSheet open={contextConv !== null && isPhone} onClose={() => setContextConv(null)}
        title={contextConv?.name ?? '项目操作'} className="project-actions-sheet" backdropClassName="project-actions-backdrop" role="menu">
        {projectActions}
      </MobileBottomSheet>
    </>
  )
}
