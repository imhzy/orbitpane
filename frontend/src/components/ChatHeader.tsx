import { useState, useRef, useEffect } from 'react'
import { Menu, ChevronLeft, Pencil, Sun, Moon, Eraser, Plus, Download, Command, FileText, MoreVertical, Wifi, WifiOff, Loader2, ListChecks, RefreshCw } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { ModelSelector } from './ModelSelector'
import { haptic } from '../lib/nativeFeedback'
import { OPEN_INSPECTOR_EVENT } from '../lib/appEvents'
import { useUpdateCheck } from '../hooks/useUpdateCheck'
import { useEscapeLayer } from '../hooks/useEscapeLayer'

import { motion, AnimatePresence } from 'framer-motion'

import { useAppContext } from '../contexts/AppContext'

interface ChatHeaderProps {
  // Props moved to context
}

export function ChatHeader(_props: ChatHeaderProps) {
  const {
    activeConv, editingConvId, editingConvName, setEditingConvName, saveConvName,
    startEditingConv, setEditingConvId, getProviderBadge, providers, isDrawerOpen,
    setIsDrawerOpen, setDrawerMode, selectedModel, setSelectedModel, models,
    loadModels, theme, toggleTheme, setIsCmdPaletteOpen,
    isExporting, exportConversationAsImage, messages, clearMessages, summarizeMessages,
    isConnected, isReconnecting, connectWebSocket, showToast, showProjectHome, activeTaskCount
  } = useAppContext()

  const connectionState = !activeConv
    ? 'idle'
    : isConnected
      ? 'online'
      : isReconnecting
        ? 'connecting'
        : 'offline'
  
  const onOpenCmdPalette = () => setIsCmdPaletteOpen(true)

  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false)
  const { isChecking: isCheckingForUpdate, checkForUpdate } = useUpdateCheck(showToast)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  const isCancelingRef = useRef(false)

  useEscapeLayer(isActionsMenuOpen, () => setIsActionsMenuOpen(false))
  useEscapeLayer(editingConvId !== null, () => {
    isCancelingRef.current = true
    setEditingConvId(null)
  })

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setIsActionsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [])

  return (
    <div className="chat-header">
      <div className="header-brand">
        <button 
          className="icon-btn" 
          style={{ visibility: isDrawerOpen ? 'hidden' : 'visible' }}
          onClick={() => activeConv ? showProjectHome() : setIsDrawerOpen(true)}
          title={activeConv ? '返回项目列表' : '展开项目菜单 (⌘B)'}
          aria-label={activeConv ? '返回项目列表' : '展开项目菜单'}
        >
          {activeConv ? <ChevronLeft size={20} /> : <Menu size={18} />}
        </button>

        <LogoIcon size={24} />

        <div className="header-title-wrapper">
          <div className="header-title">
            {activeConv ? (
              editingConvId === activeConv.id ? (
                <input
                  type="text"
                  className="cw-input conv-title-input"
                  value={editingConvName}
                  autoFocus
                  onChange={e => setEditingConvName(e.target.value)}
                  onKeyDown={e => {
                    // Escape is handled by the layer stack.
                    if (e.key === 'Enter') saveConvName(activeConv.id)
                  }}
                  onBlur={() => {
                    if (isCancelingRef.current) {
                      isCancelingRef.current = false
                      return
                    }
                    saveConvName(activeConv.id)
                  }}
                />
              ) : (
                <>
                  <span className="active-conv-title-text">{activeConv.name}</span>
                  <span className={`conv-provider-tag ${getProviderBadge(activeConv.provider, providers).className}`}>
                    {getProviderBadge(activeConv.provider, providers).text}
                  </span>
                  {/* Mobile hides the label above; the dot preserves which
                      agent this project runs on without eating title width. */}
                  <span
                    className={`provider-orbit-mark header-provider-dot ${getProviderBadge(activeConv.provider, providers).className}`}
                    title={getProviderBadge(activeConv.provider, providers).text}
                    aria-label={getProviderBadge(activeConv.provider, providers).text}
                    role="img"
                  />
                  <button
                    className="icon-btn edit-title-btn"
                    title="重命名项目"
                    aria-label="重命名项目"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      startEditingConv(e, activeConv)
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                </>
              )
            ) : (
              <div className="brand-title-group compact">
                <span className="brand-main-name">ORBIT</span>
                <span className="brand-badge-sm">PANE</span>
              </div>
            )}
          </div>
          {activeConv && (
            <div className="header-path" title={activeConv.path}>
              {activeConv.path}
            </div>
          )}
        </div>
      </div>

      <div className="header-actions">
        {/* Global Desktop Actions */}
        <div className="desktop-only-action" style={{ display: 'flex', gap: '8px' }}>
          {activeConv && (
            <div className="run-config-control">
              <span className={`provider-orbit-mark ${getProviderBadge(activeConv.provider, providers).className}`} />
              <ModelSelector
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                models={models}
                position="header"
                onOpen={loadModels}
              />
            </div>
          )}

          <button
            className={`connection-status-btn ${connectionState}`}
            onClick={() => {
              if (!isConnected && activeConv) connectWebSocket(activeConv, true)
            }}
            disabled={isConnected || !activeConv}
            title={!activeConv ? '选择项目后自动连接 Agent' : isConnected ? 'Agent 实时连接正常' : isReconnecting ? '正在连接 Agent' : '点击重新连接'}
          >
            {connectionState === 'online' ? <Wifi size={13} /> : connectionState === 'connecting' ? <Loader2 size={13} className="animate-spin" /> : connectionState === 'offline' ? <WifiOff size={13} /> : <Wifi size={13} />}
            <span>{connectionState === 'online' ? '已连接' : connectionState === 'connecting' ? '连接中' : connectionState === 'offline' ? '连接断开' : '待连接'}</span>
          </button>

          <button
            className="icon-btn cmd-trigger-btn"
            onClick={onOpenCmdPalette}
            title="快捷指令 (⌘K)"
          >
            <Command size={14} />
            <span className="cmd-btn-label hide-on-mobile">⌘K</span>
          </button>

          <button 
            className="icon-btn theme-toggle-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>

        {activeConv ? (
          <div className="header-actions-group">
            {/* Desktop Actions for Conversation */}
            <div className="desktop-only-action">
              <button
                className="icon-btn"
                disabled={isExporting || !messages.some(message => message.role !== 'system')}
                title={isExporting ? '正在导出对话图片' : '导出当前对话为 PNG 图片'}
                aria-label={isExporting ? '正在导出对话图片' : '导出当前对话为 PNG 图片'}
                onClick={exportConversationAsImage}
              >
                <Download size={14} className={isExporting ? 'animate-pulse' : ''} />
                <span className="action-btn-text">导出</span>
              </button>
              <button 
                className="icon-btn"
                title="生成对话总结"
                onClick={summarizeMessages}
                disabled={!messages.some(message => message.role !== 'system')}
              >
                <FileText size={14} />
                <span className="action-btn-text">总结</span>
              </button>
              <button 
                className="icon-btn"
                title="清空对话记录"
                onClick={clearMessages}
              >
                <Eraser size={14} />
                <span className="action-btn-text">清空</span>
              </button>
            </div>
            

          </div>
        ) : (
          <button 
            className="icon-btn new-ws-header-btn" 
            onClick={() => {
              setIsDrawerOpen(true);
              setDrawerMode('create');
            }}
          >
            <Plus size={14} className="btn-icon" />
            <span className="hide-on-mobile new-ws-text">新建项目</span>
          </button>
        )}

        {activeConv && (
          <button
            type="button"
            className="icon-btn inspector-trigger"
            aria-label={`打开任务与上下文面板${activeTaskCount > 0 ? `，${activeTaskCount} 个进行中` : ''}`}
            title="任务与上下文"
            onClick={() => {
              haptic('selection')
              const url = new URL(window.location.href)
              url.searchParams.set('panel', 'tasks')
              window.history.pushState({ ...window.history.state, orbitpanePanel: 'tasks' }, '', url.toString())
              window.dispatchEvent(new CustomEvent(OPEN_INSPECTOR_EVENT, { detail: 'tasks' }))
            }}
          >
            <ListChecks size={17} />
            {activeTaskCount > 0 && <span className="contextual-task-badge">{Math.min(activeTaskCount, 99)}</span>}
          </button>
        )}

        {/* Mobile Actions Dropdown (Global + Conversation) */}
        <div className="mobile-only-action actions-dropdown-wrapper" ref={actionsMenuRef}>
          <button 
            className="icon-btn"
            title="更多选项"
            aria-expanded={isActionsMenuOpen}
            aria-haspopup="menu"
            onClick={() => {
              haptic('selection')
              setIsActionsMenuOpen(!isActionsMenuOpen)
            }}
          >
            <MoreVertical size={16} />
          </button>
          
          <AnimatePresence>
            {isActionsMenuOpen && (
              <>
                <motion.button
                  type="button"
                  className="mobile-sheet-backdrop actions-sheet-backdrop"
                  aria-label="关闭更多操作"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setIsActionsMenuOpen(false)}
                />
                <motion.div
                  className="actions-dropdown-menu mobile-actions-sheet"
                  role="menu"
                  drag="y"
                  dragDirectionLock={true}
                  dragConstraints={{ top: 0, bottom: 800 }}
                  dragElastic={0.08}
                  dragMomentum={false}
                  onDragEnd={(_event, info) => {
                    if (info.offset.y > 90 || info.velocity.y > 500) setIsActionsMenuOpen(false)
                  }}
                  initial={{ y: 800 }}
                  animate={{ y: 0 }}
                  exit={{ y: 800 }}
                  transition={{ type: 'spring', damping: 28, stiffness: 320 }}
                >
                <div className="mobile-sheet-grabber" aria-hidden="true" />
                <div className="mobile-sheet-title">更多操作</div>
                <button
                  className="actions-dropdown-item"
                  onClick={() => {
                    onOpenCmdPalette();
                    setIsActionsMenuOpen(false);
                  }}
                >
                  <Command size={14} />
                  <span>快捷指令</span>
                </button>
                <button
                  className="actions-dropdown-item"
                  onClick={() => {
                    toggleTheme();
                    setIsActionsMenuOpen(false);
                  }}
                >
                  {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                  <span>切换主题</span>
                </button>
                <button
                  className="actions-dropdown-item"
                  disabled={isCheckingForUpdate}
                  onClick={() => {
                    setIsActionsMenuOpen(false)
                    void checkForUpdate()
                  }}
                >
                  <RefreshCw size={14} className={isCheckingForUpdate ? 'animate-spin' : ''} />
                  <span>{isCheckingForUpdate ? '正在更新…' : '检查更新'}</span>
                </button>

                {activeConv && (
                  <>
                    <button
                      className="actions-dropdown-item"
                      disabled={isExporting || !messages.some(message => message.role !== 'system')}
                      onClick={() => {
                        exportConversationAsImage();
                        setIsActionsMenuOpen(false);
                      }}
                    >
                      <Download size={14} className={isExporting ? 'animate-pulse' : ''} />
                      <span>导出</span>
                    </button>
                    <button 
                      className="actions-dropdown-item"
                      disabled={!messages.some(message => message.role !== 'system')}
                      onClick={() => {
                        summarizeMessages();
                        setIsActionsMenuOpen(false);
                      }}
                    >
                      <FileText size={14} />
                      <span>总结</span>
                    </button>
                    <button 
                      className="actions-dropdown-item"
                      onClick={() => {
                        clearMessages();
                        setIsActionsMenuOpen(false);
                      }}
                    >
                      <Eraser size={14} />
                      <span>清空</span>
                    </button>
                  </>
                )}

                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
