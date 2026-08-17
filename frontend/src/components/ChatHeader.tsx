import { useState, useRef, useEffect } from 'react'
import { Menu, ChevronLeft, Pencil, Sun, Moon, Eraser, Download, Command, FileText, MoreVertical, WifiOff, Loader2, ListChecks, RefreshCw } from 'lucide-react'
import { LogoIcon } from '../LogoIcon'
import { ModelSelector } from './ModelSelector'
import { hasProviderChoice } from '../lib/providers'
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
    setIsDrawerOpen, selectedModel, setSelectedModel, models,
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

  const showProviderTags = hasProviderChoice(providers)

  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false)
  const { isChecking: isCheckingForUpdate, checkForUpdate } = useUpdateCheck(showToast)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  const isCancelingRef = useRef(false)

  /* The same menu is a bottom sheet you can drag on a phone and an anchored
     popover under the trigger on a pointer device. It used to exist only on
     the phone, which is why the desktop header carried three loose buttons for
     actions that are used once a session. */
  const [isCoarsePointer, setIsCoarsePointer] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(pointer: coarse)')
    const sync = () => setIsCoarsePointer(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const sheetMotion = isCoarsePointer
    ? {
        drag: 'y' as const,
        dragDirectionLock: true,
        dragConstraints: { top: 0, bottom: 800 },
        dragElastic: 0.08,
        dragMomentum: false,
        initial: { y: 800 },
        animate: { y: 0 },
        exit: { y: 800 },
        transition: { type: 'spring' as const, damping: 28, stiffness: 320 },
      }
    : {
        initial: { opacity: 0, y: -6, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -4, scale: 0.98 },
        transition: { duration: 0.14, ease: [0.22, 1, 0.36, 1] as const },
      }

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

        {/* App identity only when nothing else can carry it. The docked sidebar
            owns the wordmark at >=1024px, and once a project is open the header
            identifies the project — a second logo 500px from the first was the
            most visible thing wrong with this screen. */}
        {!activeConv && <LogoIcon size={22} className="header-app-mark" />}

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
                  {/* The agent is named once on this screen, by the run
                      control on the right. It used to also be a bordered
                      accent pill wedged between the project name and its
                      rename button, so the widest, loudest element in the
                      title row was the one word that never changes. */}
                  <button
                    className="icon-btn edit-title-btn"
                    title="重命名项目"
                    aria-label="重命名项目"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      startEditingConv(e, activeConv)
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                </>
              )
            ) : (
              <div className="brand-title-group header-app-mark">
                <span className="brand-wordmark">OrbitPane</span>
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

      {/* Three clusters, left to right: what this run is configured to use,
          app-level chrome, this project's panel. They used to be one
          undifferentiated run of six icons and two pills; the count is the
          same only because the run configuration absorbed the connection
          pill and three one-a-session actions moved into the overflow. */}
      <div className="header-actions">
        {activeConv && (
          <div className="desktop-only-action">
            {/* Model, agent and link state are one fact — "what is about to
                run, and can it" — so they are one control. The connection
                used to be a separate pill that said 已连接 in green at all
                times, which spent the most prominent colour on the screen on
                the least surprising thing on it. */}
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
              <ModelSelector
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                models={models}
                position="header"
                onOpen={loadModels}
              />
            </div>
          </div>
        )}

        <div className="header-tool-group desktop-only-action">
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
            aria-label={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>

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
            <ListChecks size={16} />
            {activeTaskCount > 0 && <span className="contextual-task-badge">{Math.min(activeTaskCount, 99)}</span>}
          </button>
        )}

        {/* Overflow: everything used once a session. On a phone it is the
            bottom sheet it always was; on a pointer device it is an anchored
            popover rather than three permanent buttons in the bar. */}
        <div className="actions-dropdown-wrapper" ref={actionsMenuRef}>
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
                  onDragEnd={(_event, info) => {
                    if (info.offset.y > 90 || info.velocity.y > 500) setIsActionsMenuOpen(false)
                  }}
                  {...sheetMotion}
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
