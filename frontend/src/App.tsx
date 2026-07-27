import { useState, useEffect, useRef } from 'react'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { 
  Menu, X, MessageSquare, Plus, Trash2, Folder,
  ChevronRight, Send, Compass, FolderPlus, Sun, Moon,
  Check, ChevronDown, Sparkles, Copy, Layers, HardDrive, Eraser,
  User, RotateCcw, ThumbsUp, ThumbsDown, AlertCircle
} from 'lucide-react'
import { LogoIcon } from './LogoIcon'
import './App.css'

interface DirItem { name: string; path: string; is_dir: boolean; }
interface Message { 
  role: 'user' | 'agent' | 'system'; 
  content: string; 
  thought?: string;
  isThinking?: boolean;
  thinkingDuration?: number;
  elapsedSoFar?: number;
  isError?: boolean; 
  timestamp?: string;
}
interface Conversation { id: number; name: string; path: string; created_at: string; }

function formatTimestamp(ts?: string | number) {
  if (!ts) return ''
  const d = new Date(ts.toString().includes(' ') ? ts + ' UTC' : ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

import { ThinkingBlock } from './components/ThinkingBlock'

import { CodeBlock } from './components/CodeBlock'

import { Login } from './components/Login'
import { ConfirmDialog } from './components/ConfirmDialog'

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark')
  }

  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.6-flash-medium')
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (data.models && data.models.length > 0) {
          setModels(data.models)
        }
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsModelDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const formatModelName = (id: string) => {
    if (id === 'gemini-3.6-flash-high') return 'Gemini 3.6 Flash (High)'
    if (id === 'gemini-3.6-flash-medium') return 'Gemini 3.6 Flash (Medium)'
    if (id === 'gemini-3.6-flash-low') return 'Gemini 3.6 Flash (Low)'
    if (id === 'gemini-3.5-flash-high') return 'Gemini 3.5 Flash (High)'
    if (id === 'gemini-3.5-flash-medium') return 'Gemini 3.5 Flash (Medium)'
    if (id === 'gemini-3.5-flash-low') return 'Gemini 3.5 Flash (Low)'
    if (id === 'gemini-3.1-pro-high') return 'Gemini 3.1 Pro (High)'
    if (id === 'gemini-3.1-pro-low') return 'Gemini 3.1 Pro (Low)'
    if (id === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6'
    if (id === 'claude-opus-4-6-thinking') return 'Claude Opus 4.6 (Thinking)'
    if (id === 'gpt-oss-120b-medium') return 'GPT-OSS 120B (Medium)'
    return id.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  }

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [isConversationsLoading, setIsConversationsLoading] = useState(true)
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [drawerMode, setDrawerMode] = useState<'sessions' | 'create'>('sessions')
  
  // Create Session State
  const [currentPath, setCurrentPath] = useState<string>('/root/agy_web_bridge')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('/root/agy_web_bridge')
  const [newConvName, setNewConvName] = useState('')

  // Toast notification
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }

  // Confirm dialog state
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean
    title: string
    description: string
    onConfirm: () => void
  }>({ isOpen: false, title: '', description: '', onConfirm: () => {} })

  const getBreadcrumbParts = (pathStr: string) => {
    const segments = pathStr.split('/').filter(Boolean)
    let result: { name: string; fullPath: string }[] = [{ name: '/', fullPath: '/' }]
    let acc = ''
    segments.forEach(seg => {
      acc += '/' + seg
      result.push({ name: seg, fullPath: acc })
    })
    if (result.length > 5) {
      const first = result[0]
      const second = result[1]
      const ellipsis = { name: '...', fullPath: result[result.length - 3].fullPath }
      const secondLast = result[result.length - 2]
      const last = result[result.length - 1]
      result = [first, second, ellipsis, secondLast, last]
    }
    return result
  }
  
  // Chat State
  const [input, setInput] = useState('')
  const [copiedMsgIdx, setCopiedMsgIdx] = useState<number | null>(null)
  const [feedbackState, setFeedbackState] = useState<Record<number, 'up' | 'down'>>({})
  const [, setSocket] = useState<WebSocket | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)

  const isNearBottom = () => {
    const container = messagesContainerRef.current
    if (!container) return true
    return container.scrollHeight - container.scrollTop - container.clientHeight < 150
  }

  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem('isLoggedIn') === 'true'
  })

  useKeyboardShortcuts({
    onEscape: () => {
      setIsDrawerOpen(false)
      setIsModelDropdownOpen(false)
    },
    onFocusInput: () => {
      textareaRef.current?.focus()
    }
  })

  const triggerVibration = () => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(50)
    }
  }

  // Fluid Spring Configuration
  const springConfig = { type: "spring" as const, damping: 25, stiffness: 250, mass: 1 }

  useEffect(() => {
    const updateAppHeight = () => {
      const vv = window.visualViewport
      const h = vv ? vv.height : window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${h}px`)
    }
    updateAppHeight()

    const handleResize = () => {
      updateAppHeight()
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }, 100)
    }

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize)
      window.visualViewport.addEventListener('scroll', handleResize)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize)
        window.visualViewport.removeEventListener('scroll', handleResize)
      }
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    if (isLoggedIn) {
      loadConversations()
    }
  }, [isLoggedIn])

  useEffect(() => {
    if (drawerMode === 'create' && isLoggedIn) {
      loadDir(currentPath)
    }
  }, [drawerMode, currentPath, isLoggedIn])

  useEffect(() => {
    if (isNearBottom()) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const loadConversations = () => {
    setIsConversationsLoading(true)
    fetch('/api/conversations', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: Conversation[]) => {
        setConversations(data)
        const params = new URLSearchParams(window.location.search)
        const convId = params.get('id')
        if (convId) {
          const found = data.find(c => c.id === Number(convId))
          if (found) {
            selectConversation(found)
          }
        }
      })
      .catch(err => console.error(err))
      .finally(() => setIsConversationsLoading(false))
  }

  const loadDir = (path: string) => {
    fetch(`/api/ls?path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then(data => {
        if (data && Array.isArray(data.items)) {
          setItems(data.items)
        } else {
          setItems([])
        }
      })
      .catch(err => console.error(err))
  }

  const selectConversation = (conv: Conversation) => {
    setActiveConv(conv)
    setIsDrawerOpen(false)
    
    const url = new URL(window.location.href)
    url.searchParams.set('id', conv.id.toString())
    window.history.pushState({}, '', url.toString())

    if (socketRef.current) {
      socketRef.current.close()
    }

    fetch(`/api/history/${conv.id}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(data)
        } else {
          setMessages([])
        }
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
      })
      .catch(err => {
        console.error(err)
        setMessages([])
      })

    const loc = window.location
    const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${loc.host}/api/chat`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      if (socketRef.current !== ws) return
      setIsConnected(true)
      // Handshake with conversation_id required by backend
      ws.send(JSON.stringify({ conversation_id: conv.id }))
    }

    ws.onmessage = (e) => {
      if (socketRef.current !== ws) return
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'start') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (!lastMsg || lastMsg.role !== 'agent') {
              newMsgs.push({ role: 'agent', content: '', thought: '', isThinking: true, elapsedSoFar: data.elapsed || 0 })
            } else {
              lastMsg.isThinking = true
              lastMsg.elapsedSoFar = data.elapsed || 0
            }
            return newMsgs
          })
        } else if (data.type === 'sync_state') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (!lastMsg || lastMsg.role !== 'agent') {
              newMsgs.push({ role: 'agent', content: data.content || '', thought: data.thought || '', isThinking: data.in_thought || true, elapsedSoFar: data.elapsed || 0 })
            } else {
              lastMsg.content = data.content || ''
              lastMsg.thought = data.thought || ''
              lastMsg.isThinking = data.in_thought || true
              lastMsg.elapsedSoFar = data.elapsed || 0
            }
            return newMsgs
          })
        } else if (data.type === 'thought') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              lastMsg.thought = (lastMsg.thought || '') + data.content
              lastMsg.isThinking = true
            } else {
              newMsgs.push({ role: 'agent', content: '', thought: data.content, isThinking: true })
            }
            return newMsgs
          })
        } else if (data.type === 'token' || data.type === 'answer') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              lastMsg.content += data.content
            } else {
              newMsgs.push({ role: 'agent', content: data.content })
            }
            return newMsgs
          })
        } else if (data.type === 'done' || data.type === 'thought_done') {
          setMessages(prev => {
            const newMsgs = [...prev]
            let lastMsg = newMsgs[newMsgs.length - 1]
            if (lastMsg && lastMsg.role === 'agent') {
              lastMsg.isThinking = false
              if (data.type === 'done') {
                lastMsg.timestamp = new Date().toISOString()
              }
              if (data.duration) {
                lastMsg.thinkingDuration = data.duration
              }
            }
            return newMsgs
          })
        } else if (data.type === 'error') {
          setMessages(prev => {
            const newMsgs = [...prev]
            const lastIdx = newMsgs.length - 1
            if (lastIdx >= 0 && newMsgs[lastIdx].role === 'agent') {
              if (!newMsgs[lastIdx].content && !newMsgs[lastIdx].thought) {
                newMsgs.pop()
              } else {
                newMsgs[lastIdx].isThinking = false
              }
            }
            newMsgs.push({ role: 'system', content: `处理异常: ${data.content}`, isError: true })
            return newMsgs
          })
        }
      } catch (err) {
        console.error("WS message parse error:", err)
      }
    }
    
    ws.onclose = () => {
      if (socketRef.current === ws) {
        setIsConnected(false)
        setSocket(null)
        socketRef.current = null
        // Auto-reconnect with exponential backoff
        const attempt = (ws as any).__reconnectAttempt || 0
        if (attempt < 5) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 15000)
          setTimeout(() => {
            if (!socketRef.current && activeConv?.id === conv.id) {
              const newWs = new WebSocket(wsUrl) as any
              newWs.__reconnectAttempt = attempt + 1
              // Reuse the same handlers
              newWs.onopen = ws.onopen
              newWs.onmessage = ws.onmessage
              newWs.onclose = ws.onclose
              setSocket(newWs)
              socketRef.current = newWs
            }
          }, delay)
        }
      }
    }
    setSocket(ws)
    socketRef.current = ws
  }

  const createConversation = () => {
    triggerVibration()
    if (!selectedDir || !newConvName.trim()) return
    fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newConvName, path: selectedDir })
    })
    .then(r => r.json())
    .then(data => {
      loadConversations()
      setDrawerMode('sessions')
      setNewConvName('')
      selectConversation(data)
    })
  }

  const deleteConversation = (e: React.MouseEvent, convId: number) => {
    e.stopPropagation()
    setConfirmState({
      isOpen: true,
      title: '删除会话',
      description: '此操作不可撤销，确定要删除该会话记录吗？',
      onConfirm: () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        fetch(`/api/conversations/${convId}`, { method: 'DELETE' })
          .then(() => {
            loadConversations()
            if (activeConv?.id === convId) {
              setActiveConv(null)
              setMessages([])
              if (socketRef.current) socketRef.current.close()
              const url = new URL(window.location.href)
              url.searchParams.delete('id')
              window.history.pushState({}, '', url.toString())
            }
          })
      }
    })
  }

  const sendMessage = (customText?: string) => {
    triggerVibration()
    const textToSend = typeof customText === 'string' ? customText : input
    const currentSocket = socketRef.current
    if (!textToSend.trim() || !currentSocket || currentSocket.readyState !== WebSocket.OPEN) return
    
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setMessages(prev => [...prev, { role: 'user', content: textToSend.trim(), timestamp: new Date().toISOString() }])
    currentSocket.send(JSON.stringify({ content: textToSend.trim(), model: selectedModel }))
  }



  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }

  const clearMessages = () => {
    if (!activeConv) return
    setConfirmState({
      isOpen: true,
      title: '清空会话消息',
      description: '确定要清空当前会话的所有消息吗？此操作不可逆。',
      onConfirm: () => {
        setConfirmState(prev => ({ ...prev, isOpen: false }))
        fetch(`/api/history/${activeConv.id}`, { method: 'DELETE' })
          .then(() => {
            setMessages([])
          })
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const copyMessageText = (text: string, msgIndex: number) => {
    navigator.clipboard.writeText(text)
    setCopiedMsgIdx(msgIndex)
    showToast('已复制到剪贴板')
    setTimeout(() => setCopiedMsgIdx(null), 2000)
  }

  const handleFeedback = (idx: number, type: 'up' | 'down') => {
    setFeedbackState(prev => ({
      ...prev,
      [idx]: prev[idx] === type ? (undefined as any) : type
    }))
    showToast(type === 'up' ? '感谢你的好评反馈！' : '已收到反馈，我们将持续优化')
  }

  const regenerateLastResponse = () => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg && isConnected) {
      sendMessage(lastUserMsg.content)
      showToast('正在重新生成回复...')
    } else {
      showToast('无法重新生成，请检查连接状态')
    }
  }

  const handleLogin = () => {
    setIsLoggedIn(true)
    localStorage.setItem('isLoggedIn', 'true')
  }

  if (!isLoggedIn) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="app-container">
      {/* Sidebar Drawer Scrim */}
      <AnimatePresence>
        {isDrawerOpen && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="drawer-scrim" 
            onClick={() => {
              if (drawerMode === 'create' && (newConvName.trim() || currentPath !== '/root/agy_web_bridge')) {
                setConfirmState({
                  isOpen: true,
                  title: '放弃修改',
                  description: '有未保存的信息，确定要关闭吗？',
                  onConfirm: () => {
                    setConfirmState(prev => ({ ...prev, isOpen: false }))
                    setIsDrawerOpen(false)
                  }
                })
              } else {
                setIsDrawerOpen(false)
              }
            }} 
          />
        )}
      </AnimatePresence>

      {/* Sidebar Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <motion.div 
            initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
            transition={springConfig}
            className="drawer"
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
                  <span className="brand-main-name">ANTIGRAVITY</span>
                  <span className="brand-badge-sm">STUDIO</span>
                </div>
              </div>
              <button className="icon-btn" onClick={() => setIsDrawerOpen(false)}>
                <X size={18} />
              </button>
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
                {isConversationsLoading ? (
                  <div className="flex flex-col gap-2 p-2">
                    {[1, 2, 3].map(i => (
                      <div key={i} className="h-14 bg-[var(--bg-surface-hover)] rounded-xl animate-pulse" />
                    ))}
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 opacity-70">
                    <Compass size={48} className="text-[var(--accent-color)] mb-4 opacity-50" />
                    <div className="text-center text-[var(--text-secondary)] text-[14px] font-medium">
                      暂无工作区
                    </div>
                    <div className="text-center text-[var(--text-tertiary)] text-[12px] mt-1 mb-4">
                      点击下方按钮创建您的第一个智能工作区
                    </div>
                    <button 
                      className="icon-btn" 
                      onClick={() => setDrawerMode('create')}
                      style={{ background: 'var(--accent-subtle-bg)', color: 'var(--accent-text)', border: '1px solid var(--accent-border)' }}
                    >
                      <Plus size={14} style={{ marginRight: 4 }} /> 立即创建
                    </button>
                  </div>
                ) : (
                  conversations.map(conv => (
                    <div 
                      key={conv.id} 
                      className={`list-item ${activeConv?.id === conv.id ? 'selected' : ''}`}
                      onClick={() => selectConversation(conv)}
                    >
                      <div className="item-icon">
                        <MessageSquare size={16} />
                      </div>
                      <div className="item-content">
                        <span className="item-title">{conv.name}</span>
                        <span className="item-subtitle">{conv.path}</span>
                      </div>
                      <button 
                        className="icon-btn destructive" 
                        title="删除会话"
                        onClick={(e) => deleteConversation(e, conv.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Create Workspace Mode */}
            {drawerMode === 'create' && (
              <div className="drawer-content cw-content">
                <div className="cw-header">
                  <h3 className="cw-title">配置新工作区</h3>
                  <p className="cw-subtitle">设定工作区名称并选择项目所在的本地目录</p>
                </div>

                <div className="cw-form">
                  <div className="cw-field-group">
                    <label className="cw-label">工作区名称</label>
                    <div className="cw-input-wrapper">
                      <Layers size={14} className="cw-icon" />
                      <input 
                        type="text" 
                        placeholder="例如：Frontend Project" 
                        value={newConvName}
                        onChange={e => setNewConvName(e.target.value)}
                        className="cw-input"
                        aria-label="工作区名称"
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
                </div>

                <div className="cw-browser-section">
                  <div className="cw-browser-header">
                    <span className="cw-browser-title">目录浏览</span>
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
                              onClick={() => setSelectedDir(item.path)}
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
                    onClick={createConversation}
                  >
                    <Plus size={16} strokeWidth={2.5} />
                    <span>创建工作区</span>
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <div className="chat-main">
        <div className="chat-header">
          <div className="header-brand">
            <motion.button 
              whileTap={{ scale: 0.95 }}
              className="icon-btn" 
              onClick={() => setIsDrawerOpen(true)}
              title="展开工作区菜单"
            >
              <Menu size={18} />
            </motion.button>

            <LogoIcon size={26} />

            <div className="model-selector-container" ref={dropdownRef}>
              <button 
                className="model-selector-btn"
                onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                aria-haspopup="listbox"
                aria-expanded={isModelDropdownOpen}
                aria-label="选择 AI 模型"
              >
                <span className="model-selector-text">{formatModelName(selectedModel)}</span>
                <ChevronDown size={14} className={`model-selector-chevron ${isModelDropdownOpen ? 'open' : ''}`} />
              </button>
              
              <AnimatePresence>
                {isModelDropdownOpen && (
                  <motion.div 
                    initial={{ opacity: 0, y: -5, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -5, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    className="model-dropdown-menu"
                    role="listbox"
                    aria-label="AI 模型列表"
                  >
                    {models.map(m => (
                      <button
                        key={m}
                        role="option"
                        aria-selected={selectedModel === m}
                        className={`model-dropdown-item ${selectedModel === m ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedModel(m)
                          setIsModelDropdownOpen(false)
                        }}
                      >
                        <div className="model-item-icon">
                          {selectedModel === m ? <Check size={14} /> : <div style={{ width: 14 }} />}
                        </div>
                        <span className="model-item-name">{formatModelName(m)}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="header-title-wrapper">
              <div className="header-title">
                {activeConv ? (
                  activeConv.name
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

          <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              className="icon-btn theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换至明亮模式' : '切换至暗夜模式'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {activeConv ? (
              <div className="header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <motion.button 
                  whileTap={{ scale: 0.95 }}
                  className="icon-btn"
                  title="清空会话"
                  onClick={clearMessages}
                >
                  <Eraser size={16} />
                </motion.button>
                <div className="status-indicator">
                  <div className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
                  <span>{isConnected ? '在线已连接' : '未连接'}</span>
                </div>
              </div>
            ) : (
              <button className="icon-btn" onClick={() => setIsDrawerOpen(true)}>
                <Plus size={16} style={{ marginRight: 4 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>新建工作区</span>
              </button>
            )}
          </div>
        </div>

        <div className="chat-messages" ref={messagesContainerRef}>
          {!activeConv && (
            <motion.div 
              initial={{ opacity: 0, y: 15 }} 
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="welcome-container"
            >
              <div className="welcome-hero-wrapper">
                <div className="welcome-hero-icon">
                  <LogoIcon size={52} />
                </div>
                <h1 className="welcome-hero-title">
                  ANTIGRAVITY <span className="title-highlight">STUDIO</span>
                </h1>
                <div className="welcome-hero-badge">
                  <Sparkles size={13} className="badge-sparkle" />
                  <span>NEXT-GEN AI PAIR PROGRAMMER</span>
                </div>
              </div>
              <p className="welcome-subtitle">
                下一代 AI 结对编程与智能工作区
              </p>
            </motion.div>
          )}

          {messages.map((m, i) => {
            if (m.role === 'system') {
              return (
                <div key={i} className={`system-msg ${m.isError ? 'error' : ''}`}>
                  {m.isError ? <AlertCircle size={14} /> : <Sparkles size={14} />}
                  <span>{m.content}</span>
                </div>
              )
            }

            const isLastAgentMessage = m.role === 'agent' && i === messages.length - 1;

            return (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 14, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={springConfig}
                className={`message-row ${m.role}`}
              >
                <div className="message-header">
                  <div className="message-author">
                    {m.role === 'agent' ? (
                      <div className="avatar agent-avatar">
                        <LogoIcon size={16} />
                        <span className="avatar-pulse-ring" />
                      </div>
                    ) : (
                      <div className="avatar user-avatar">
                        <User size={14} />
                      </div>
                    )}
                    <span className="author-name">
                      {m.role === 'agent' ? 'Antigravity AI' : '你'}
                    </span>
                    {m.role === 'agent' && selectedModel && (
                      <span className="model-pill">{formatModelName(selectedModel)}</span>
                    )}
                  </div>
                  {m.timestamp && (
                    <span className="message-time">{formatTimestamp(m.timestamp)}</span>
                  )}
                </div>

                <div className="message-bubble">
                  {m.role === 'agent' ? (
                    <div className="agent-container">
                      <ThinkingBlock 
                        thought={m.thought || ''} 
                        isThinking={!!m.isThinking} 
                        duration={m.thinkingDuration} 
                        elapsedSoFar={m.elapsedSoFar}
                      />

                      {m.content ? (
                        <div className="markdown-body">
                          <ReactMarkdown 
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeRaw, rehypeKatex]}
                            components={{
                              code: CodeBlock
                            }}
                          >
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      ) : null}

                      {m.isThinking && m.content && (
                        <span className="streaming-cursor" />
                      )}

                      {!m.isThinking && m.content && (
                        <div className="message-toolbar">
                          <button 
                            className={`toolbar-btn ${copiedMsgIdx === i ? 'copied' : ''}`}
                            title={copiedMsgIdx === i ? '已复制' : '复制全文'}
                            onClick={() => copyMessageText(m.content, i)}
                          >
                            {copiedMsgIdx === i ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                            <span className="toolbar-btn-text">{copiedMsgIdx === i ? '已复制' : '复制'}</span>
                          </button>

                          <button 
                            className={`toolbar-btn ${feedbackState[i] === 'up' ? 'active-up' : ''}`}
                            title="好评"
                            onClick={() => handleFeedback(i, 'up')}
                          >
                            <ThumbsUp size={14} />
                          </button>

                          <button 
                            className={`toolbar-btn ${feedbackState[i] === 'down' ? 'active-down' : ''}`}
                            title="差评"
                            onClick={() => handleFeedback(i, 'down')}
                          >
                            <ThumbsDown size={14} />
                          </button>

                          {isLastAgentMessage && (
                            <button 
                              className="toolbar-btn regenerate-btn"
                              title="重新生成"
                              onClick={regenerateLastResponse}
                            >
                              <RotateCcw size={14} />
                              <span className="toolbar-btn-text">重新生成</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="user-content-wrapper">
                      <div className="user-text-content">{m.content}</div>
                      <button 
                        className="user-copy-btn"
                        title="复制发送内容"
                        onClick={() => copyMessageText(m.content, i)}
                      >
                        {copiedMsgIdx === i ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          <div className="input-box">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setTimeout(() => {
                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                }, 300)
              }}
              placeholder={activeConv ? "发送消息给 Antigravity AI (Shift + Enter 换行)..." : "请先选择或新建一个工作区会话以发起提问..."}
              disabled={!activeConv}
              aria-label="消息输入框"
              rows={1}
              className="input-textarea"
            />
            
            <div className="input-bottom-bar">
              <div className="input-hint">
                <span>按 Enter 发送 / Shift + Enter 换行</span>
              </div>
              <button 
                className="send-btn" 
                onClick={() => {
                  if (!activeConv) { showToast('请先选择一个工作区会话'); return }
                  if (!isConnected) { showToast('AI 服务未连接，正在重连...'); return }
                  sendMessage()
                }}
                disabled={!input.trim()}
                title={!activeConv ? '请先选择工作区' : !isConnected ? '未连接' : '发送消息'}
                aria-label="发送消息"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className="toast-container"
          >
            <div className="toast">
              <Check size={14} style={{ color: '#10B981' }} />
              {toast}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        description={confirmState.description}
        confirmText="确认"
        cancelText="取消"
        variant="destructive"
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  )
}
