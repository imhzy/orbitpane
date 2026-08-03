import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Plus, Sun, Moon,
  Eraser, Download, HelpCircle, MessageSquare, Terminal, Keyboard
} from 'lucide-react'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onNewWorkspace: () => void
  onToggleTheme: () => void
  theme: 'dark' | 'light'
  onClearMessages: () => void
  onExportImage: () => void
  onSelectConv: (id: number) => void
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
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery('')
      setShowHelp(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const filteredConvs = conversations.filter(c =>
    c.name.toLowerCase().includes(query.toLowerCase()) ||
    c.path.toLowerCase().includes(query.toLowerCase())
  )

  const handleAction = (action: () => void) => {
    action()
    onClose()
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
              placeholder="搜索会话、常用指令或按 Esc 退出..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') onClose()
              }}
            />
            <kbd className="cmd-kbd">ESC</kbd>
          </div>

          <div className="cmd-body">
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
                  className="cmd-item"
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
                    <button className="cmd-item" onClick={() => handleAction(onNewWorkspace)}>
                      <Plus size={15} className="cmd-item-icon" />
                      <span>新建工程工作区</span>
                      <kbd>⌘ N</kbd>
                    </button>
                    <button className="cmd-item" onClick={() => handleAction(onToggleTheme)}>
                      {theme === 'dark' ? <Sun size={15} className="cmd-item-icon" /> : <Moon size={15} className="cmd-item-icon" />}
                      <span>切换至{theme === 'dark' ? '明亮' : '暗夜'}主题模式</span>
                    </button>
                    <button className="cmd-item" onClick={() => handleAction(onExportImage)}>
                      <Download size={15} className="cmd-item-icon" />
                      <span>导出当前对话为 PNG 图片</span>
                    </button>
                    <button className="cmd-item" onClick={() => handleAction(onClearMessages)}>
                      <Eraser size={15} className="cmd-item-icon text-danger" />
                      <span className="text-danger">清空当前会话记录</span>
                    </button>
                    <button className="cmd-item" onClick={() => setShowHelp(true)}>
                      <HelpCircle size={15} className="cmd-item-icon" />
                      <span>查看键盘快捷键说明</span>
                      <kbd>?</kbd>
                    </button>
                  </div>
                )}

                {filteredConvs.length > 0 && (
                  <div className="cmd-section">
                    <div className="cmd-section-title">会话工作区 ({filteredConvs.length})</div>
                    {filteredConvs.slice(0, 5).map(c => (
                      <button
                        key={c.id}
                        className="cmd-item"
                        onClick={() => handleAction(() => onSelectConv(c.id))}
                      >
                        <MessageSquare size={15} className="cmd-item-icon" />
                        <div className="cmd-conv-text">
                          <div className="cmd-conv-name">{c.name}</div>
                          <div className="cmd-conv-path">{c.path}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {query && filteredConvs.length === 0 && (
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
