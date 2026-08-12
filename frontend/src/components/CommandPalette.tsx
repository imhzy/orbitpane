import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Plus, Sun, Moon,
  Eraser, Download, HelpCircle, MessageSquare, Terminal, Keyboard, FileText, Loader2
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import type { SearchResult } from '../lib/types'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onNewWorkspace: () => void
  onToggleTheme: () => void
  theme: 'dark' | 'light'
  onClearMessages: () => void
  onExportImage: () => void
  onSelectConv: (id: number, messageId?: number | null) => void
  conversations: Array<{ id: number; name: string; path: string }>
}

export function CommandPalette({
  isOpen,
  onClose,
  onNewWorkspace,
  onToggleTheme,
  theme,
  onClearMessages,
  onExportImage,
  onSelectConv,
  conversations
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [showHelp, setShowHelp] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      const originalOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      setTimeout(() => inputRef.current?.focus(), 50)
      setSelectedIndex(0)
      return () => {
        document.body.style.overflow = originalOverflow
      }
    } else {
      setQuery('')
      setShowHelp(false)
      setSelectedIndex(0)
    }
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    setIsSearching(true)
    const timer = window.setTimeout(() => {
      apiFetch<{ items: SearchResult[] }>(`/api/search?q=${encodeURIComponent(trimmed)}&limit=30`)
        .then(data => setSearchResults(data.items))
        .catch(error => {
          console.error(error)
          setSearchResults([])
        })
        .finally(() => setIsSearching(false))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!listRef.current) return
    const activeEl = listRef.current.querySelector<HTMLElement>('.cmd-item.active')
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedIndex])

  if (!isOpen) return null

  const filteredConvs = conversations.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase()) ||
    c.path.toLowerCase().includes(query.toLowerCase())
  )

  const handleAction = (action: () => void) => {
    action()
    onClose()
  }

  // Combine items for keyboard navigation
  const staticActions = [
    { type: 'new', label: '新建项目', icon: Plus, action: onNewWorkspace, kbd: '⌘ N' },
    { type: 'theme', label: `切换至${theme === 'dark' ? '明亮' : '暗夜'}主题模式`, icon: theme === 'dark' ? Sun : Moon, action: onToggleTheme },
    { type: 'export', label: '导出当前对话为 PNG 图片', icon: Download, action: onExportImage },
    { type: 'clear', label: '清空当前会话记录', icon: Eraser, action: onClearMessages, isDanger: true },
    { type: 'help', label: '查看键盘快捷键说明', icon: HelpCircle, action: () => setShowHelp(true), kbd: '?' },
  ]

  const itemsCount = !query
    ? staticActions.length + filteredConvs.slice(0, 5).length
    : searchResults.slice(0, 20).length

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => (itemsCount > 0 ? (prev + 1) % itemsCount : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => (itemsCount > 0 ? (prev - 1 + itemsCount) % itemsCount : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (showHelp) {
        setShowHelp(false)
        return
      }
      if (!query) {
        if (selectedIndex < staticActions.length) {
          handleAction(staticActions[selectedIndex].action)
        } else {
          const conv = filteredConvs[selectedIndex - staticActions.length]
          if (conv) handleAction(() => onSelectConv(conv.id))
        }
      } else {
        const result = searchResults[selectedIndex]
        if (result) handleAction(() => onSelectConv(result.conversation_id, result.message_id))
      }
    }
  }

  return (
    <AnimatePresence>
      <div className="cmd-backdrop" onClick={onClose}>
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: -10 }}
          transition={{ duration: 0.15 }}
          className="cmd-dialog"
          onClick={e => e.stopPropagation()}
        >
          <div className="cmd-header">
            <Search size={16} className="cmd-search-icon" />
            <input
              ref={inputRef}
              type="text"
              className="cmd-input"
              placeholder="搜索项目、消息或常用指令…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <kbd className="cmd-kbd">ESC</kbd>
          </div>

          <div className="cmd-body" ref={listRef}>
            {showHelp ? (
              <div className="cmd-help-section">
                <div className="cmd-section-title">
                  <Keyboard size={14} style={{ marginRight: 6 }} />
                  快捷键指南 (Shortcuts Guide)
                </div>
                <div className="cmd-help-grid">
                  <div className="cmd-help-item">
                    <span>打开快捷指令</span>
                    <kbd>⌘ K</kbd>
                  </div>
                  <div className="cmd-help-item">
                    <span>发送消息</span>
                    <kbd>Enter</kbd>
                  </div>
                  <div className="cmd-help-item">
                    <span>消息换行</span>
                    <kbd>Shift + Enter</kbd>
                  </div>
                  <div className="cmd-help-item">
                    <span>新建工作区</span>
                    <kbd>⌘ N</kbd>
                  </div>
                  <div className="cmd-help-item">
                    <span>切换侧边栏</span>
                    <kbd>⌘ B</kbd>
                  </div>
                </div>
                <button
                  className="cmd-item active"
                  onClick={() => setShowHelp(false)}
                  style={{ marginTop: 12, justifyContent: 'center' }}
                >
                  返回指令列表
                </button>
              </div>
            ) : (
              <>
                {!query && (
                  <div className="cmd-section">
                    <div className="cmd-section-title">快捷操作</div>
                    {staticActions.map((act, idx) => {
                      const IconComp = act.icon
                      const isActive = selectedIndex === idx
                      return (
                        <button
                          key={act.type}
                          className={`cmd-item ${isActive ? 'active' : ''}`}
                          onClick={() => handleAction(act.action)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                        >
                          <IconComp size={15} className={`cmd-item-icon ${act.isDanger ? 'text-danger' : ''}`} />
                          <span className={act.isDanger ? 'text-danger' : ''}>{act.label}</span>
                          {act.kbd && <kbd>{act.kbd}</kbd>}
                        </button>
                      )
                    })}
                  </div>
                )}

                {!query && filteredConvs.length > 0 && (
                  <div className="cmd-section">
                    <div className="cmd-section-title">会话工作区 ({filteredConvs.length})</div>
                    {filteredConvs.slice(0, 5).map((c, idx) => {
                      const itemIdx = !query ? staticActions.length + idx : idx
                      const isActive = selectedIndex === itemIdx
                      return (
                        <button
                          key={c.id}
                          className={`cmd-item ${isActive ? 'active' : ''}`}
                          onClick={() => handleAction(() => onSelectConv(c.id))}
                          onMouseEnter={() => setSelectedIndex(itemIdx)}
                        >
                          <MessageSquare size={15} className="cmd-item-icon" />
                          <div className="cmd-conv-text">
                            <div className="cmd-conv-name">{c.name}</div>
                            <div className="cmd-conv-path">{c.path}</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}

                {query && (
                  <div className="cmd-section">
                    <div className="cmd-section-title">全文搜索 ({searchResults.length})</div>
                    {isSearching && (
                      <div className="cmd-searching"><Loader2 size={15} className="animate-spin" />搜索项目与消息…</div>
                    )}
                    {!isSearching && searchResults.slice(0, 20).map((result, idx) => (
                      <button
                        key={`${result.result_type}-${result.conversation_id}-${result.message_id || 0}`}
                        className={`cmd-item ${selectedIndex === idx ? 'active' : ''}`}
                        onClick={() => handleAction(() => onSelectConv(result.conversation_id, result.message_id))}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        {result.result_type === 'message'
                          ? <FileText size={15} className="cmd-item-icon" />
                          : <MessageSquare size={15} className="cmd-item-icon" />}
                        <div className="cmd-conv-text">
                          <div className="cmd-conv-name">{result.title}</div>
                          <div className="cmd-search-snippet">{result.snippet}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {query && !isSearching && searchResults.length === 0 && (
                  <div className="cmd-empty">
                    <Terminal size={24} style={{ opacity: 0.4, marginBottom: 8 }} />
                    <span>未找到匹配的会话或指令</span>
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
