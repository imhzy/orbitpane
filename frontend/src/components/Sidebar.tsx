import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, MessageSquare, Plus, Trash2, Folder,
  ChevronRight, Compass, FolderPlus,
  Check, Pencil, Layers, HardDrive, RefreshCw, Cpu,
  Search, Star, LogOut, ChevronDown
} from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import type { Conversation, DirItem, Provider, ProviderBadge } from '../lib/types'
import { apiFetch } from '../lib/api'
import { AUTH_EXPIRED_EVENT } from '../lib/auth'

interface SidebarProps {
  isDrawerOpen: boolean
  setIsDrawerOpen: (open: boolean) => void
  drawerMode: 'sessions' | 'create'
  setDrawerMode: (mode: 'sessions' | 'create') => void
  conversations: Conversation[]
  isConversationsLoading: boolean
  activeConv: Conversation | null
  selectConversation: (conv: Conversation) => void
  editingConvId: number | null
  editingConvName: string
  setEditingConvName: (name: string) => void
  saveConvName: (id: number) => void
  startEditingConv: (e: React.MouseEvent, conv: Conversation) => void
  setEditingConvId: (id: number | null) => void
  deleteConversation: (e: React.MouseEvent, id: number) => void
  getProviderBadge: (providerId?: string, providersCatalog?: Provider[]) => ProviderBadge
  providers: Provider[]
  newConvName: string
  setNewConvName: (name: string) => void
  selectedDir: string
  setSelectedDir: (dir: string) => void
  currentPath: string
  setCurrentPath: (path: string) => void
  selectedProvider: string
  setSelectedProvider: (provider: string) => void
  defaultProvider: string
  items: DirItem[]
  loadDir: (path: string) => void
  getBreadcrumbParts: (pathStr: string) => { name: string; fullPath: string }[]
  createConversation: () => void
  loadConversations: (isInitial: boolean) => void
  showToast: (msg: string) => void
}

const springConfig = { type: 'spring' as const, damping: 25, stiffness: 250, mass: 1 }

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
      >
        <span>{currentProvider ? currentProvider.name : 'Select Provider'}</span>
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
          >
            {providers.map(p => (
              <button
                key={p.id}
                disabled={!p.available}
                className={`model-dropdown-item ${displaySelectedProvider === p.id ? 'selected' : ''}`}
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

export function Sidebar({
  isDrawerOpen,
  setIsDrawerOpen,
  drawerMode,
  setDrawerMode,
  conversations,
  isConversationsLoading,
  activeConv,
  selectConversation,
  editingConvId,
  editingConvName,
  setEditingConvName,
  saveConvName,
  startEditingConv,
  setEditingConvId,
  deleteConversation,
  getProviderBadge,
  providers,
  newConvName,
  setNewConvName,
  selectedDir,
  setSelectedDir,
  currentPath,
  setCurrentPath,
  selectedProvider,
  setSelectedProvider,
  defaultProvider,
  items,
  loadDir,
  getBreadcrumbParts,
  createConversation,
  loadConversations,
  showToast,
}: SidebarProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const isCancelingRef = React.useRef(false)
  const [pinnedIds, setPinnedIds] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('orbitpane_pinned_convs') || '[]')
    } catch {
      return []
    }
  })

  const [isHighlighting, setIsHighlighting] = useState(false)

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
    const handleHighlight = () => {
      setIsHighlighting(true)
      setTimeout(() => setIsHighlighting(false), 800) // Remove class after animation
    }
    window.addEventListener('highlight-drawer', handleHighlight)
    return () => window.removeEventListener('highlight-drawer', handleHighlight)
  }, [])

  const togglePin = (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    setPinnedIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      localStorage.setItem('orbitpane_pinned_convs', JSON.stringify(next))
      showToast(prev.includes(id) ? '已取消星标置顶' : '已添加星标置顶')
      return next
    })
  }

  // Filter & sort conversations (pinned top)
  const filteredConvs = conversations.filter(c =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.path.toLowerCase().includes(searchTerm.toLowerCase())
  ).sort((a, b) => {
    const aPin = pinnedIds.includes(a.id) ? 1 : 0
    const bPin = pinnedIds.includes(b.id) ? 1 : 0
    return bPin - aPin
  })

  return (
    <AnimatePresence>
      {isDrawerOpen && (
        <motion.div 
          initial={{ x: '-100%', marginLeft: -320 }} animate={{ x: 0, marginLeft: 0 }} exit={{ x: '-100%', marginLeft: -320 }}
          transition={springConfig}
          className={`drawer ${isHighlighting ? 'drawer-highlight' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="工作区菜单"
          drag="x"
          dragConstraints={{ left: -340, right: 0 }}
          dragElastic={0.1}
          onDragEnd={(_e, { offset, velocity }) => {
            if (offset.x < -100 || velocity.x < -300) {
              setIsDrawerOpen(false)
            }
          }}
        >
          <div className="drawer-header">
            <div className="drawer-brand">
              <LogoIcon size={24} />
              <div className="brand-title-group">
                <span className="brand-main-name">ORBIT</span>
                <span className="brand-badge-sm">PANE</span>
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
              <button className="icon-btn" onClick={() => setIsDrawerOpen(false)}>
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="drawer-tabs">
            <button 
              className={`drawer-tab-btn ${drawerMode === 'sessions' ? 'active' : ''}`}
              onClick={() => setDrawerMode('sessions')}
            >
              <MessageSquare size={14} />
              <span>会话列表</span>
            </button>
            <button 
              className={`drawer-tab-btn ${drawerMode === 'create' ? 'active' : ''}`}
              onClick={() => setDrawerMode('create')}
            >
              <Plus size={14} />
              <span>新建工作区</span>
            </button>
          </div>

          {/* Sessions Mode */}
          {drawerMode === 'sessions' && (
            <div className="drawer-content">
              {/* Search input for conversations */}
              {conversations.length > 0 && (
                <div className="sidebar-search-box">
                  <Search size={14} className="search-icon" />
                  <input
                    type="text"
                    className="sidebar-search-input"
                    placeholder="搜索工作区名称或路径..."
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
                    {searchTerm ? '未找到相关工作区' : '暂无工作区'}
                  </div>
                  <div className="text-center text-[var(--text-tertiary)] text-[12px] mt-1 mb-4">
                    {searchTerm ? '尝试更改搜索关键词' : '点击下方按钮创建您的第一个工程工作区'}
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
                  const pinnedConvs = filteredConvs.filter(c => pinnedIds.includes(c.id))
                  const unpinnedConvs = filteredConvs.filter(c => !pinnedIds.includes(c.id))

                  const renderConvItem = (conv: Conversation) => {
                    const isEditing = editingConvId === conv.id
                    const isPinned = pinnedIds.includes(conv.id)
                    const badge = getProviderBadge(conv.provider, providers)
                    const ProviderIcon = badge.Icon
                    return (
                      <div 
                        key={conv.id} 
                        className={`list-item ${activeConv?.id === conv.id ? 'selected' : ''} ${isPinned ? 'pinned-item' : ''}`}
                        onClick={() => {
                          if (!isEditing) {
                            selectConversation(conv)
                          }
                        }}
                      >
                        <div className={`item-icon ${badge.type}`}>
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
                                if (e.key === 'Enter') saveConvName(conv.id)
                                if (e.key === 'Escape') {
                                  isCancelingRef.current = true
                                  setEditingConvId(null)
                                }
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
                              <div className="item-badge-row">
                                <span className={`conv-provider-tag ${badge.className}`}>
                                  {badge.text}
                                </span>
                              </div>
                              <span className="item-subtitle" title={conv.path}>{conv.path}</span>
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
                              <button
                                className={`icon-btn pin-btn ${isPinned ? 'pinned' : ''}`}
                                title={isPinned ? '取消星标' : '星标置顶'}
                                onClick={(e) => togglePin(e, conv.id)}
                              >
                                <Star size={13} fill={isPinned ? 'currentColor' : 'none'} />
                              </button>
                              <button 
                                className="icon-btn" 
                                title="重命名工作区"
                                onClick={(e) => startEditingConv(e, conv)}
                              >
                                <Pencil size={13} />
                              </button>
                              <button 
                                className="icon-btn destructive" 
                                title="删除会话"
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
                            <Star size={12} className="text-warning fill-warning" />
                            <span>星标置顶 ({pinnedConvs.length})</span>
                          </div>
                          {pinnedConvs.map(renderConvItem)}
                        </div>
                      )}

                      {unpinnedConvs.length > 0 && (
                        <div className="sidebar-section-group">
                          {pinnedConvs.length > 0 && (
                            <div className="sidebar-section-title">
                              <span>所有工作区 ({unpinnedConvs.length})</span>
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
          )}

          {/* Create Workspace Mode */}
          {drawerMode === 'create' && (
            <div className="drawer-content cw-content">
              <div className="cw-header">
                <h3 className="cw-title">配置新工作区</h3>
              </div>

              <div className="cw-form">
                <div className="cw-field-group">
                  <label className="cw-label">工作区名称</label>
                  <div className="cw-input-wrapper">
                    <Layers size={14} className="cw-icon" />
                    <input 
                      type="text" 
                      value={newConvName}
                      onChange={e => setNewConvName(e.target.value)}
                      className="cw-input"
                      aria-label="工作区名称"
                      placeholder="如: my-cool-project"
                    />
                  </div>
                </div>

                <div className="cw-field-group">
                  <label className="cw-label">项目路径</label>
                  <div className="cw-input-wrapper">
                    <Folder size={14} className="cw-icon" />
                    <input
                      type="text"
                      placeholder="输入绝对路径或从下方选择"
                      value={selectedDir}
                      onChange={e => {
                        setSelectedDir(e.target.value)
                        if (e.target.value.startsWith('/')) {
                          setCurrentPath(e.target.value)
                        }
                      }}
                      className="cw-input font-mono"
                      aria-label="项目路径"
                    />
                  </div>
                </div>

                <div className="cw-field-group">
                  <label className="cw-label">Agent 接入方式 (Provider)</label>
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

              <div className="cw-browser-section">
                <div className="cw-browser-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="cw-browser-title">目录浏览</span>
                  <button 
                    className="icon-btn" 
                    title="刷新目录"
                    onClick={() => {
                      loadDir(currentPath)
                      showToast('目录结构已刷新')
                    }}
                    style={{ padding: 3, width: 24, height: 24 }}
                  >
                    <RefreshCw size={12} />
                  </button>
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
                            <span
                              className="cw-enter"
                              onClick={(e) => {
                                e.stopPropagation()
                                setCurrentPath(item.path)
                                setSelectedDir(item.path)
                              }}
                              role="button"
                              tabIndex={0}
                              title="进入该目录"
                              aria-label={`进入目录 ${item.name}`}
                            >
                              <ChevronRight size={14} />
                            </span>
                          </button>
                        )
                      })
                    })()}
                  </div>
                </div>
              </div>

              <div className="cw-action">
                <button 
                  className="cw-create-btn"
                  disabled={!selectedDir.trim() || !newConvName.trim()}
                  onClick={() => createConversation()}
                >
                  <Plus size={16} strokeWidth={2.5} />
                  <span>创建工程工作区</span>
                </button>
              </div>
            </div>
          )}

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
    </AnimatePresence>
  )
}
