import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import {
  X, MessageSquare, Plus, Trash2, Folder,
  ChevronRight, Compass, FolderPlus,
  Check, Pencil, Layers, HardDrive, RefreshCw, Cpu,
  Search, Star, LogOut, ChevronDown, Maximize2, Minimize2,
  Archive, ArchiveRestore, ShieldAlert, ShieldCheck
} from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation, Provider } from '../lib/types'
import { hasProviderChoice } from '../lib/providers'
import { apiFetch } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'
import { haptic } from '../lib/nativeFeedback'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeLayer } from '../hooks/useEscapeLayer'

import { useAppContext } from '../contexts/AppContext'

interface SidebarProps {
  // Props moved to context
}

const springConfig = { type: 'spring' as const, damping: 25, stiffness: 250, mass: 1 }
/* Damped hard enough not to overshoot: this slide carries a list the user is
   reading, and a bounce at the end reads as a glitch rather than as polish. */
const PANE_SLIDE = { type: 'spring' as const, stiffness: 380, damping: 40, mass: 0.9 }
const PANE_SLIDE_REDUCED = { duration: 0 }

function ProviderDropdown({ providers, selectedProvider, defaultProvider, setSelectedProvider }: {
  providers: Provider[],
  selectedProvider: string,
  defaultProvider: string,
  setSelectedProvider: (provider: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = React.useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const currentProvider = providers.find(p => p.id === (selectedProvider || defaultProvider))
  const displaySelectedProvider = selectedProvider || defaultProvider

  return (
    <div ref={dropdownRef} className="provider-selector-container">
      <button
        className="cw-input provider-selector-btn"
        onClick={(e) => { e.preventDefault(); setIsOpen(!isOpen) }}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="选择 Agent"
      >
        <span>{currentProvider ? currentProvider.name : '选择 Agent'}</span>
        <ChevronDown size={14} className={`provider-selector-chevron ${isOpen ? 'open' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -5, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -5, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="model-dropdown-menu provider-dropdown-menu"
            role="listbox"
            aria-label="Agent 列表"
          >
            {providers.map(p => (
              <button
                key={p.id}
                disabled={!p.available}
                className={`model-dropdown-item ${displaySelectedProvider === p.id ? 'selected' : ''}`}
                role="option"
                aria-selected={displaySelectedProvider === p.id}
                onClick={(e) => {
                  e.preventDefault()
                  if (p.available) {
                    setSelectedProvider(p.id)
                    setIsOpen(false)
                  }
                }}
                type="button"
                style={{ opacity: p.available ? 1 : 0.5, cursor: p.available ? 'pointer' : 'not-allowed' }}
              >
                <div className="model-item-icon">
                  {displaySelectedProvider === p.id ? <Check size={14} /> : <div style={{ width: 14 }} />}
                </div>
                <span className="model-item-name">{p.name} {!p.available && '(不可用)'}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Sidebar(_props: SidebarProps) {
  const {
    isDrawerOpen, setIsDrawerOpen, drawerMode, setDrawerMode,
    conversations, isConversationsLoading, activeConv, selectConversation,
    editingConvId, editingConvName, setEditingConvName, saveConvName,
    startEditingConv, setEditingConvId, deleteConversation, getProviderBadge,
    providers, newConvName, setNewConvName, selectedDir, setSelectedDir,
    currentPath, setCurrentPath, selectedProvider, setSelectedProvider,
    selectedPermissionMode, setSelectedPermissionMode,
    defaultProvider, items, loadDir, getBreadcrumbParts, createConversation,
    loadConversations, updateConversation, showToast, requestCloseDrawer
  } = useAppContext()

  const [searchTerm, setSearchTerm] = useState('')
  const [isDirectoryExpanded, setIsDirectoryExpanded] = useState(false)
  const isCancelingRef = React.useRef(false)
  const [showArchived, setShowArchived] = useState(false)
  const [createStep, setCreateStep] = useState<1 | 2>(1)
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
  const paneSlide = prefersReducedMotion ? PANE_SLIDE_REDUCED : PANE_SLIDE
  const [contextConv, setContextConv] = useState<Conversation | null>(null)
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
  const drawerRef = useFocusTrap<HTMLDivElement>(isDrawerOpen && isOverlayDrawer)
  useEscapeLayer(isDrawerOpen && isOverlayDrawer, requestCloseDrawer)
  // Registered after the drawer layer, so cancelling a rename wins over
  // closing the drawer for the same keypress.
  useEscapeLayer(editingConvId !== null, () => {
    isCancelingRef.current = true
    setEditingConvId(null)
  })
  useEscapeLayer(contextConv !== null, () => setContextConv(null))
  const longPressRef = React.useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClickRef = React.useRef(false)

  /* Swipe-to-close over form fields.
   *
   * Framer Motion's drag deliberately never engages when the gesture starts on
   * an input or textarea — it hands the pointer to the field so typing and
   * caret placement keep working. Traced on a phone viewport, a swipe starting
   * in the search box delivered every pointermove to the drawer and still left
   * its transform untouched, which is why that strip was a dead zone in 0 of 5
   * attempts while the rest of the drawer closed fine.
   *
   * These listeners sit on the drawer and only arm when the gesture began on a
   * field, so everywhere else the real drag still owns the interaction. The
   * thresholds mirror onDragEnd below so the two feel identical. */
  const fieldSwipeRef = React.useRef<{ x: number; y: number; t: number } | null>(null)
  const onFieldPointerDown = (event: React.PointerEvent) => {
    fieldSwipeRef.current = null
    if (event.pointerType !== 'touch') return
    const target = event.target as Element | null
    if (!target?.closest('input, textarea')) return
    fieldSwipeRef.current = { x: event.clientX, y: event.clientY, t: event.timeStamp }
  }
  const onFieldPointerUp = (event: React.PointerEvent) => {
    const start = fieldSwipeRef.current
    fieldSwipeRef.current = null
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dx) <= Math.abs(dy)) return          // a vertical scroll, not a dismiss
    const velocity = (dx / Math.max(event.timeStamp - start.t, 1)) * 1000
    if (dx < -60 || velocity < -200) setIsDrawerOpen(false)
  }

  const cancelLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }

  const beginLongPress = (event: React.PointerEvent, conversation: Conversation) => {
    if (event.pointerType !== 'touch') return
    cancelLongPress()
    longPressRef.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        suppressClickRef.current = true
        haptic('light')
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
      setCreateStep(1)
      setUnrestrictedAcknowledged(false)
    }
  }, [isDrawerOpen, drawerMode])

  const togglePin = (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    const conversation = conversations.find(item => item.id === id)
    if (!conversation) return
    void updateConversation(id, { is_pinned: !conversation.is_pinned })
      .then(updated => {
        if (updated) showToast(conversation.is_pinned ? '已取消星标' : '已添加星标')
      })
  }

  // Filter & sort conversations (pinned top)
  const filteredConvs = conversations.filter(c =>
    c.is_archived === showArchived && (
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.path.toLowerCase().includes(searchTerm.toLowerCase())
    )
  ).sort((a, b) => {
    const aPin = a.is_pinned ? 1 : 0
    const bPin = b.is_pinned ? 1 : 0
    return bPin - aPin
  })

  return (
    <AnimatePresence>
      {isDrawerOpen && (
        <motion.div
          ref={drawerRef}
          initial={{ x: -400 }} animate={{ x: 0 }} exit={{ x: -400 }}
          transition={springConfig}
          className={`drawer ${drawerMode === 'create' ? 'create-mode' : ''} ${drawerMode === 'create' && isDirectoryExpanded ? 'directory-focus-mode' : ''}`}
          role={isOverlayDrawer ? 'dialog' : undefined}
          aria-modal={isOverlayDrawer ? true : undefined}
          aria-label="项目菜单"
          onPointerDown={onFieldPointerDown}
          onPointerUp={onFieldPointerUp}
          onPointerCancel={() => { fieldSwipeRef.current = null }}
          drag="x"
          dragDirectionLock={true}
          dragConstraints={{ left: -Math.max(500, typeof window !== 'undefined' ? window.innerWidth : 500), right: 0 }}
          dragElastic={0.1}
          dragMomentum={false}
          onDragEnd={(_e, { offset, velocity }) => {
            if (offset.x < -60 || velocity.x < -200) {
              setIsDrawerOpen(false)
            }
          }}
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
                    transition={paneSlide}
                  />
                )}
                <Icon size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {/* The two modes ride on one track and slide, rather than swapping
              instantly. Both panes stay mounted so the browser keeps each one's
              scroll position — an unmount/remount resets it, which is what made
              the old switch feel like a page load. The inactive pane is `inert`
              so it takes no focus and is invisible to assistive tech. */}
          <div className="drawer-panes">
            <motion.div
              className="drawer-pane-track"
              animate={{ x: drawerMode === 'create' ? '-50%' : '0%' }}
              transition={paneSlide}
              initial={false}
            >
              <div className="drawer-pane" inert={drawerMode !== 'sessions'}>
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
              {(showArchived || conversations.some(conversation => conversation.is_archived)) && (
                <button
                  className={`archived-toggle-btn ${showArchived ? 'active' : ''}`}
                  onClick={() => setShowArchived(previous => !previous)}
                >
                  <ArchiveRestore size={13} />
                  {showArchived ? '返回活跃项目' : '查看已归档项目'}
                </button>
              )}

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

                  const renderConvItem = (conv: Conversation) => {
                    const isEditing = editingConvId === conv.id
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
                          setContextConv(conv)
                          haptic('light')
                        }}
                      >
                        {/* Tinting by agent is only a distinction when the rows
                            can differ. Otherwise the tile is neutral and the
                            accent is left to mean "selected", which is the one
                            thing the eye should find in this list. */}
                        <div className={`item-icon ${showProviderTags ? badge.type : ''}`}>
                          <ProviderIcon size={16} />
                        </div>
                        <div className="item-content">
                          {isEditing ? (
                            <input
                              type="text"
                              className="cw-input conv-title-input"
                              value={editingConvName}
                              autoFocus
                              onClick={e => e.stopPropagation()}
                              onChange={e => setEditingConvName(e.target.value)}
                              onKeyDown={e => {
                                // Escape is handled by the layer stack above.
                                if (e.key === 'Enter') saveConvName(conv.id)
                              }}
                              onBlur={() => {
                                if (isCancelingRef.current) {
                                  isCancelingRef.current = false
                                  return
                                }
                                saveConvName(conv.id)
                              }}
                            />
                          ) : (
                            <>
                              <div className="item-title-row">
                                <span className="item-title" title={conv.name}>{conv.name}</span>
                                {isPinned && <Star size={11} className="pin-star-icon" fill="currentColor" />}
                              </div>
                              {/* One metadata line, not three stacked blocks.
                                  The agent used to be a bordered accent pill on
                                  its own row — a label reading identically on
                                  every row, drawn as emphatically as the only
                                  thing on the row that differs. It is a colour
                                  dot now, and the path gets the width it needs
                                  to stay identifiable. */}
                              <span className="item-meta-row">
                                {showProviderTags && (
                                  <span
                                    className={`provider-orbit-mark ${badge.className}`}
                                    title={badge.text}
                                    aria-label={badge.text}
                                    role="img"
                                  />
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
                              onClick={() => saveConvName(conv.id)}
                            >
                              <Check size={14} />
                            </button>
                          ) : (
                            <>
                              {conv.is_archived && (
                                <button
                                  className="icon-btn"
                                  title="恢复项目"
                                  onClick={() => void updateConversation(conv.id, { is_archived: false }).then(() => {
                                    void loadConversations(false)
                                  })}
                                >
                                  <ArchiveRestore size={13} />
                                </button>
                              )}
                              <button
                                className={`icon-btn pin-btn ${isPinned ? 'pinned' : ''}`}
                                title={isPinned ? '取消星标' : '星标置顶'}
                                onClick={(e) => togglePin(e, conv.id)}
                              >
                                <Star size={13} fill={isPinned ? 'currentColor' : 'none'} />
                              </button>
                              <button 
                                className="icon-btn" 
                                title="重命名项目"
                                onClick={(e) => startEditingConv(e, conv)}
                              >
                                <Pencil size={13} />
                              </button>
                              <button 
                                className="icon-btn destructive" 
                                title="删除项目"
                                onClick={(e) => deleteConversation(e, conv.id)}
                              >
                                <Trash2 size={14} />
                              </button>
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
                          {pinnedConvs.map(renderConvItem)}
                        </div>
                      )}

                      {unpinnedConvs.length > 0 && (
                        <div className="sidebar-section-group">
                          {pinnedConvs.length > 0 && (
                            <div className="sidebar-section-title">
                              <span>所有项目 ({unpinnedConvs.length})</span>
                            </div>
                          )}
                          {unpinnedConvs.map(renderConvItem)}
                        </div>
                      )}
                    </div>
                  )
                })()
              )}
                </div>
              </div>

              {/* Create Project Mode */}
              <div className="drawer-pane" inert={drawerMode !== 'create'}>
                <div className="drawer-content cw-content">
              <div className="cw-header">
                <h3 className="cw-title">配置新项目</h3>
              </div>
              {/* Two steps, and the stepper is clickable: the old three-step
                  flow made you walk back through "返回" to fix a typo in the
                  name, and step 3 only restated what you had just entered. */}
              <div className="cw-stepper" aria-label={`新建项目第 ${createStep} 步，共 2 步`}>
                {([1, 2] as const).map(step => (
                  <button
                    key={step}
                    type="button"
                    className={createStep >= step ? 'active' : ''}
                    aria-current={createStep === step ? 'step' : undefined}
                    disabled={step > createStep && !canLeaveFirstStep}
                    onClick={() => setCreateStep(step)}
                  >
                    <b>{step}</b>{step === 1 ? '项目与目录' : '运行配置'}
                  </button>
                ))}
              </div>

              {createStep === 1 && (
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
              )}

              {createStep === 2 && (
                <div className="cw-provider-step">
                  <div className="cw-form">
                    <div className="cw-field-group">
                      <label className="cw-label">Agent 接入方式</label>
                      <div className="cw-input-wrapper">
                        <Cpu size={14} className="cw-icon" />
                        <ProviderDropdown
                          providers={providers}
                          selectedProvider={selectedProvider}
                          defaultProvider={defaultProvider}
                          setSelectedProvider={setSelectedProvider}
                        />
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
                  <div className="provider-capability-list">
                    <span><Check size={12} />读取项目上下文</span>
                    <span><Check size={12} />在授权范围内修改文件</span>
                    <span><Check size={12} />实时展示命令与工具调用</span>
                  </div>

                  <dl className="cw-summary">
                    <div><dt>名称</dt><dd>{newConvName || '—'}</dd></div>
                    <div><dt>目录</dt><dd>{selectedDir || '—'}</dd></div>
                    <div><dt>Agent</dt><dd>{providers.find(provider => provider.id === (selectedProvider || defaultProvider))?.name || selectedProvider || '—'}</dd></div>
                    <div className={selectedPermissionMode === 'unrestricted' ? 'danger' : undefined}>
                      <dt>权限</dt>
                      <dd>{selectedPermissionMode === 'workspace' ? '受限工作区' : '完全访问'}</dd>
                    </div>
                  </dl>
                </div>
              )}

              <div className="cw-action cw-wizard-actions">
                {createStep > 1 && (
                  <button className="cw-back-btn" onClick={() => setCreateStep(1)}>
                    返回
                  </button>
                )}
                {createStep === 1 ? (
                  <button
                    className="cw-create-btn"
                    disabled={!canLeaveFirstStep}
                    onClick={() => setCreateStep(2)}
                  >
                    <span>下一步</span><ChevronRight size={15} />
                  </button>
                ) : (
                  <button
                    className="cw-create-btn"
                    disabled={!canCreateProject}
                    title={
                      !isSelectedProviderAvailable
                        ? '所选 Agent 当前不可用'
                        : !canCreateProject
                          ? '请先确认完全访问模式的风险'
                          : undefined
                    }
                    onClick={() => {
                      createConversation()
                      setCreateStep(1)
                      setUnrestrictedAcknowledged(false)
                    }}
                  >
                    <Plus size={16} strokeWidth={2.5} />
                    <span>创建项目</span>
                  </button>
                )}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>

          {/* Sidebar Global Footer */}
          <div className="sidebar-footer">
            <button 
              className="sidebar-footer-btn destructive"
              onClick={() => {
                apiFetch('/api/logout', { method: 'POST' }).finally(() => {
                  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
                })
              }}
              title="退出登录"
            >
              <LogOut size={16} />
              <span>退出系统</span>
            </button>
          </div>
        </motion.div>
      )}
      {contextConv && (
        <>
          <motion.button
            type="button"
            className="mobile-sheet-backdrop project-actions-backdrop"
            aria-label="关闭项目操作"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setContextConv(null)}
          />
          <motion.div
            className="mobile-bottom-sheet project-actions-sheet"
            role="menu"
            drag="y"
            dragDirectionLock={true}
            dragConstraints={{ top: 0, bottom: 800 }}
            dragElastic={0.1}
            dragMomentum={false}
            onDragEnd={(_event, info) => {
              if (info.offset.y > 90 || info.velocity.y > 500) setContextConv(null)
            }}
            initial={{ y: 800 }}
            animate={{ y: 0 }}
            exit={{ y: 800 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          >
            <div className="mobile-sheet-grabber" aria-hidden="true" />
            <div className="mobile-sheet-title">{contextConv.name}</div>
            <button type="button" role="menuitem" onClick={() => {
              void updateConversation(contextConv.id, { is_pinned: !contextConv.is_pinned })
              haptic('selection')
              setContextConv(null)
            }}><Star size={17} fill={contextConv.is_pinned ? 'currentColor' : 'none'} />{contextConv.is_pinned ? '取消星标' : '星标置顶'}</button>
            <button type="button" role="menuitem" onClick={() => {
              setEditingConvId(contextConv.id)
              setEditingConvName(contextConv.name)
              setContextConv(null)
            }}><Pencil size={17} />重命名项目</button>
            <button type="button" role="menuitem" onClick={() => {
              void updateConversation(contextConv.id, { is_archived: !contextConv.is_archived }).then(() => {
                void loadConversations(false)
              })
              setContextConv(null)
            }}><Archive size={17} />{contextConv.is_archived ? '恢复项目' : '归档项目'}</button>
            <button type="button" role="menuitem" className="destructive" onClick={event => {
              deleteConversation(event, contextConv.id)
              haptic('warning')
              setContextConv(null)
            }}><Trash2 size={17} />删除项目</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
