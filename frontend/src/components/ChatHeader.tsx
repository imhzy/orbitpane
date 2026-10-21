import { useState, useRef, useEffect } from 'react'
import { Menu, Pencil, Eraser, Download, FileText, MoreVertical, WifiOff, Loader2, ListChecks, Share2, Settings, Clock } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { ShareDialog } from './ShareDialog'
import { hasProviderChoice } from '../lib/providers'
import { haptic } from '../lib/nativeFeedback'
import { openInspectorPanel, OPEN_SHARE_EVENT } from '../lib/appEvents'
import { useEscapeLayer } from '../hooks/useEscapeLayer'
import { MobileBottomSheet } from './MobileBottomSheet'
import { ConversationNameInput } from './ConversationNameInput'

import { motion, AnimatePresence } from 'framer-motion'

import { useAppContext } from '../contexts/AppContext'

interface ChatHeaderProps {
  // Props moved to context
}

export function ChatHeader(_props: ChatHeaderProps) {
  const {
    activeConv, editingConvId, editingConvSurface,
    startEditingConv, getProviderBadge, providers, isDrawerOpen,
    setIsDrawerOpen, openSettings,
    isExporting, exportConversationAsImage, messages, clearMessages, summarizeMessages,
    isAgentThinking, isConnected, isReconnecting, connectWebSocket, showProjectHome, activeTaskCount
  } = useAppContext()

  const connectionState = !activeConv
    ? 'idle'
    : isConnected
      ? 'online'
      : isReconnecting
        ? 'connecting'
        : 'offline'
  const showProviderTags = hasProviderChoice(providers)
  const providerBadge = getProviderBadge(activeConv?.provider, providers)
  const ProviderIcon = providerBadge.Icon

  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false)
  const [isShareOpen, setIsShareOpen] = useState(false)
  const actionsMenuRef = useRef<HTMLDivElement>(null)

  /* The same menu is a bottom sheet you can drag on a phone and an anchored
     popover under the trigger on a pointer device. It used to exist only on
     the phone, which is why the desktop header carried three loose buttons for
     actions that are used once a session. */
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)')
    const sync = () => setIsMobileViewport(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  useEscapeLayer(isActionsMenuOpen, () => setIsActionsMenuOpen(false))

  /* The overflow menu owns the dialog, so the command palette asks for it the
     same way the inspector is asked for rather than threading a callback
     through App. */
  useEffect(() => {
    const openShare = () => setIsShareOpen(true)
    window.addEventListener(OPEN_SHARE_EVENT, openShare)
    return () => window.removeEventListener(OPEN_SHARE_EVENT, openShare)
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if ((e.target as Element | null)?.closest('.actions-sheet-surface')) return
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

  const actionMenuItems = (
    <>
      <button type="button" role="menuitem" className="actions-dropdown-item" onClick={() => {
        openSettings('project', activeConv?.id)
        setIsActionsMenuOpen(false)
      }}><Settings size={14} /><span>会话设置</span></button>
      <div className="actions-dropdown-divider" />
      {activeConv && (
        <>
          <button type="button" role="menuitem" className="actions-dropdown-item" onClick={() => {
            startEditingConv(activeConv, 'header')
            setIsActionsMenuOpen(false)
          }}><Pencil size={14} /><span>重命名会话</span></button>
          <button type="button" role="menuitem" className="actions-dropdown-item" onClick={() => {
            openInspectorPanel('schedules')
            setIsActionsMenuOpen(false)
          }}><Clock size={14} /><span>定时任务</span></button>
          <button
            role="menuitem" className="actions-dropdown-item"
            disabled={!messages.some(message => message.role !== 'system')}
            onClick={() => {
              setIsShareOpen(true)
              setIsActionsMenuOpen(false)
            }}
          >
            <Share2 size={14} />
            <span>分享</span>
          </button>
          <button
            role="menuitem" className="actions-dropdown-item"
            disabled={isExporting || !messages.some(message => message.role !== 'system')}
            onClick={() => {
              exportConversationAsImage()
              setIsActionsMenuOpen(false)
            }}
          >
            <Download size={14} className={isExporting ? 'animate-pulse' : ''} />
            <span>导出图片</span>
          </button>
          <button
            role="menuitem" className="actions-dropdown-item"
            disabled={!messages.some(message => message.role !== 'system')}
            onClick={() => {
              summarizeMessages()
              setIsActionsMenuOpen(false)
            }}
          >
            <FileText size={14} />
            <span>总结对话</span>
          </button>
          <button
            role="menuitem" className="actions-dropdown-item"
            onClick={() => {
              clearMessages()
              setIsActionsMenuOpen(false)
            }}
          >
            <Eraser size={14} />
            <span>清空对话</span>
          </button>
        </>
      )}
    </>
  )

  return (
    <div className="chat-header">
      <div className="header-brand">
        <button 
          className="icon-btn" 
          aria-expanded={isDrawerOpen}
          onClick={() => setIsDrawerOpen(!isDrawerOpen)}
          title="展开 / 收起导航"
          aria-label="展开 / 收起导航"
        >
          <Menu size={18} />
        </button>

        {/* App identity only when nothing else can carry it. The docked sidebar
            owns the wordmark at >=1024px, and once a project is open the header
            identifies the project — a second logo 500px from the first was the
            most visible thing wrong with this screen. */}
        {!activeConv && <LogoIcon size={22} className="header-app-mark" />}
        {activeConv && <span className={`header-provider-icon ${providerBadge.type}`} role="img" aria-label={providerBadge.text} title={providerBadge.text}>
          <ProviderIcon size={22} />
        </span>}

        <div className="header-title-wrapper">
          <div className="header-title">
            {activeConv ? (
              editingConvId === activeConv.id && editingConvSurface === 'header' ? (
                <ConversationNameInput conversationId={activeConv.id} />
              ) : (
                <span className="conv-title-trigger">
                  <span className="active-conv-title-text" title={activeConv.name}>{activeConv.name}</span>
                  <button type="button" className="icon-btn" aria-label="重命名会话" onClick={() => startEditingConv(activeConv, 'header')}><Pencil size={13} /></button>
                </span>
              )
            ) : (
              <div className="brand-title-group header-app-mark">
                <span className="brand-wordmark">OrbitPane</span>
              </div>
            )}
          </div>
          {activeConv && (
            <div className="header-path"><button className="breadcrumb-home" onClick={showProjectHome}>工作台</button><span> / {activeConv.path.split('/').filter(Boolean).at(-1) || '/'} / 会话</span><span className="header-task-state"> · {isAgentThinking ? '执行中' : activeTaskCount > 0 ? `${activeTaskCount} 个活动任务` : '就绪'}</span></div>
          )}
        </div>
      </div>

      {/* The header contains connection state and conversation actions. */}
      <div className="header-actions">

        {activeConv && (
          <div className="header-connection">
            <div className="run-config-control">
              <button
                type="button"
                className={`run-config-link ${connectionState}`}
                onClick={() => {
                  if (!isConnected && activeConv) connectWebSocket(activeConv, true)
                }}
                disabled={isConnected}
                aria-label={isConnected ? 'Agent 实时连接正常' : isReconnecting ? '正在连接 Agent' : '连接已断开，点击重新连接'}
                title={isConnected ? 'Agent 实时连接正常' : isReconnecting ? '正在连接 Agent' : '点击重新连接'}
              >
                {connectionState === 'connecting'
                  ? <Loader2 size={12} className="animate-spin" />
                  : connectionState === 'offline'
                    ? <WifiOff size={12} />
                    : <span className={`provider-orbit-mark ${showProviderTags ? getProviderBadge(activeConv.provider, providers).className : 'badge-default'}`} />}
              </button>
            </div>
          </div>
        )}

        {activeConv && (
          <button
            type="button"
            className="icon-btn inspector-trigger"
            aria-label={`打开任务与上下文面板${activeTaskCount > 0 ? `，${activeTaskCount} 个进行中` : ''}`}
            title="任务与上下文"
            onClick={() => {
              haptic('selection')
              openInspectorPanel('tasks')
            }}
          >
            <ListChecks size={16} />
            {activeTaskCount > 0 && <span className="contextual-task-badge">{Math.min(activeTaskCount, 99)}</span>}
          </button>
        )}

        {/* Overflow: everything used once a session. On a phone it is the
            bottom sheet it always was; on a pointer device it is an anchored
            popover rather than three permanent buttons in the bar. */}
        {activeConv ? <div className="actions-dropdown-wrapper" ref={actionsMenuRef}>
          <button 
            className="icon-btn"
            title="会话操作"
            aria-label="会话操作"
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
            {isActionsMenuOpen && !isMobileViewport && (
              <motion.div
                className="actions-dropdown-menu"
                role="menu"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              >
                {actionMenuItems}
              </motion.div>
            )}
          </AnimatePresence>
        </div> : <button type="button" className="icon-btn" aria-label="打开设置" title="设置" onClick={() => openSettings()}><Settings size={17} /></button>}
        <MobileBottomSheet
          open={isActionsMenuOpen && isMobileViewport}
          onClose={() => setIsActionsMenuOpen(false)}
          title="会话操作"
          className="actions-sheet-surface mobile-actions-sheet"
          backdropClassName="actions-sheet-backdrop"
          role="menu"
        >
          {actionMenuItems}
        </MobileBottomSheet>
      </div>

      <ShareDialog isOpen={isShareOpen} onClose={() => setIsShareOpen(false)} />
    </div>
  )
}
