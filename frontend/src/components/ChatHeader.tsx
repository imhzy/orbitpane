import { useState, useRef, useEffect } from 'react'
import { Menu, Pencil, Sun, Moon, Eraser, Plus, Download, Command, FileText, MoreVertical } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { ModelSelector } from './ModelSelector'

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
    formatModelName, loadModels, theme, toggleTheme, setIsCmdPaletteOpen,
    isConnected, isReconnecting, connectWebSocket, activeConvRef, isExporting,
    exportConversationAsImage, messages, clearMessages, summarizeMessages
  } = useAppContext()
  
  const onOpenCmdPalette = () => setIsCmdPaletteOpen(true)

  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  const isCancelingRef = useRef(false)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setIsActionsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="chat-header">
      <div className="header-brand">
        <button 
          className="icon-btn" 
          style={{ visibility: isDrawerOpen ? 'hidden' : 'visible' }}
          onClick={() => setIsDrawerOpen(true)}
          title="展开工作区菜单 (⌘B)"
          aria-label="展开工作区菜单"
        >
          <Menu size={18} />
        </button>

        <LogoIcon size={24} />

        <ModelSelector
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          models={models}
          formatModelName={formatModelName}
          position="header"
          onOpen={loadModels}
        />

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
                    if (e.key === 'Enter') saveConvName(activeConv.id)
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
                    saveConvName(activeConv.id)
                  }}
                />
              ) : (
                <>
                  <span className="active-conv-title-text">{activeConv.name}</span>
                  <span className={`conv-provider-tag ${getProviderBadge(activeConv.provider, providers).className}`}>
                    {getProviderBadge(activeConv.provider, providers).text}
                  </span>
                  <button
                    className="icon-btn edit-title-btn"
                    title="修改工作区名称"
                    aria-label="修改工作区名称"
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
                title="清空会话"
                onClick={clearMessages}
              >
                <Eraser size={14} />
                <span className="action-btn-text">清空</span>
              </button>
            </div>
            
            <div 
              className={`status-indicator ${!isConnected ? 'clickable' : ''}`}
              onClick={() => {
                if (!isConnected && activeConvRef.current) {
                  connectWebSocket(activeConvRef.current, true)
                }
              }}
              title={isConnected ? 'Agent 在线' : isReconnecting ? '正在重连...' : '未连接，点击重连'}
            >
              <div className={`status-dot ${isConnected ? 'online' : isReconnecting ? 'connecting' : 'offline'}`} />
              <span className="status-text">{isConnected ? '在线' : isReconnecting ? '重连中...' : '重连'}</span>
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
            <span className="hide-on-mobile new-ws-text">新建工作区</span>
          </button>
        )}

        {/* Mobile Actions Dropdown (Global + Conversation) */}
        <div className="mobile-only-action actions-dropdown-wrapper" ref={actionsMenuRef}>
          <button 
            className="icon-btn"
            title="更多选项"
            onClick={() => setIsActionsMenuOpen(!isActionsMenuOpen)}
          >
            <MoreVertical size={16} />
          </button>
          
          <AnimatePresence>
            {isActionsMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: -5, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -5, scale: 0.98 }}
                transition={{ duration: 0.15 }}
                className="actions-dropdown-menu"
              >
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
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
