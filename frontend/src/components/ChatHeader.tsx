import React from 'react'
import { Menu, Pencil, Sun, Moon, Eraser, Plus, Download, Command } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { ModelSelector } from './ModelSelector'
import type { Conversation, Provider, Message } from '../lib/types'

interface ChatHeaderProps {
  activeConv: Conversation | null
  editingConvId: number | null
  setEditingConvId: (id: number | null) => void
  editingConvName: string
  setEditingConvName: (name: string) => void
  saveConvName: (id: number) => void
  startEditingConv: (e: React.MouseEvent, conv: Conversation) => void
  getProviderBadge: (providerId?: string, providersCatalog?: Provider[]) => any
  providers: Provider[]
  isDrawerOpen: boolean
  setIsDrawerOpen: (open: boolean) => void
  selectedModel: string
  setSelectedModel: (model: string) => void
  models: string[]
  formatModelName: (modelId: string) => string
  loadModels: () => void
  theme: 'dark' | 'light'
  toggleTheme: () => void
  onOpenCmdPalette: () => void
  isConnected: boolean
  isReconnecting: boolean
  connectWebSocket: (conv: Conversation, isManual?: boolean) => void
  activeConvRef: React.MutableRefObject<Conversation | null>
  isExporting: boolean
  exportConversationAsImage: () => void
  messages: Message[]
  clearMessages: () => void
}

export function ChatHeader({
  activeConv,
  editingConvId,
  editingConvName,
  setEditingConvName,
  saveConvName,
  startEditingConv,
  setEditingConvId,
  getProviderBadge,
  providers,
  setIsDrawerOpen,
  selectedModel,
  setSelectedModel,
  models,
  formatModelName,
  loadModels,
  theme,
  toggleTheme,
  onOpenCmdPalette,
  isConnected,
  isReconnecting,
  connectWebSocket,
  activeConvRef,
  isExporting,
  exportConversationAsImage,
  messages,
  clearMessages
}: ChatHeaderProps) {
  return (
    <div className="chat-header">
      <div className="header-brand">
        <button 
          className="icon-btn" 
          onClick={() => setIsDrawerOpen(true)}
          title="展开工作区菜单 (⌘B)"
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
          <div className="header-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {activeConv ? (
              editingConvId === activeConv.id ? (
                <input
                  type="text"
                  className="cw-input"
                  style={{ padding: '2px 8px', fontSize: '14px', fontWeight: 600, height: '28px', maxWidth: '240px' }}
                  value={editingConvName}
                  autoFocus
                  onChange={e => setEditingConvName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveConvName(activeConv.id)
                    if (e.key === 'Escape') setEditingConvId(null)
                  }}
                  onBlur={() => saveConvName(activeConv.id)}
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
                    onClick={(e) => startEditingConv(e, activeConv)}
                    style={{ padding: 2, width: 22, height: 22, opacity: 0.6 }}
                  >
                    <Pencil size={12} />
                  </button>
                </>
              )
            ) : (
              <div className="brand-title-group compact">
                <span className="brand-main-name">ANTIGRAVITY</span>
                <span className="brand-badge-sm">STUDIO</span>
              </div>
            )}
          </div>
          {activeConv && (
            <div className="header-path">{activeConv.path}</div>
          )}
        </div>
      </div>

      <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {/* Command Palette trigger */}
        <button
          className="icon-btn cmd-trigger-btn"
          onClick={onOpenCmdPalette}
          title="快捷指令 (⌘K)"
        >
          <Command size={14} />
          <span className="cmd-btn-label">⌘K</span>
        </button>

        {/* Theme toggle button */}
        <button 
          className="icon-btn theme-toggle-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {activeConv ? (
          <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              className="icon-btn"
              disabled={isExporting || !messages.some(message => message.role !== 'system')}
              title={isExporting ? '正在导出对话图片' : '导出当前对话为 PNG 图片'}
              aria-label={isExporting ? '正在导出对话图片' : '导出当前对话为 PNG 图片'}
              onClick={exportConversationAsImage}
            >
              <Download size={16} className={isExporting ? 'animate-pulse' : ''} />
            </button>
            <button 
              className="icon-btn"
              title="清空会话"
              onClick={clearMessages}
            >
              <Eraser size={16} />
            </button>

            <div 
              className={`status-indicator ${!isConnected ? 'clickable' : ''}`}
              onClick={() => {
                if (!isConnected && activeConvRef.current) {
                  connectWebSocket(activeConvRef.current, true)
                }
              }}
              title={isConnected ? 'AI agent 已在线' : isReconnecting ? '正在重连...' : '未连接，点击重连'}
              style={{ cursor: isConnected ? 'default' : 'pointer' }}
            >
              <div className={`status-dot ${isConnected ? 'online' : isReconnecting ? 'connecting' : 'offline'}`} />
              <span className="status-text">{isConnected ? '在线' : isReconnecting ? '重连中...' : '重连'}</span>
            </div>
          </div>
        ) : (
          <button 
            className="icon-btn new-ws-header-btn" 
            onClick={() => setIsDrawerOpen(true)}
          >
            <Plus size={14} style={{ marginRight: 4 }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>新建工作区</span>
          </button>
        )}
      </div>
    </div>
  )
}
