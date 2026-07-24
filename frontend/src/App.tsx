import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { 
  Menu, X, MessageSquare, Plus, Trash2, Folder, 
  FileText, ChevronLeft, ArrowUp, Brain, Sparkles,
  ChevronDown, ChevronUp, Copy, Check, Lock
} from 'lucide-react'
import './App.css'

interface DirItem { name: string; path: string; is_dir: boolean; }
interface Message { 
  role: 'user' | 'agent' | 'system'; 
  content: string; 
  thought?: string;
  isThinking?: boolean;
  thinkingDuration?: number;
  isError?: boolean; 
}
interface Conversation { id: number; name: string; path: string; created_at: string; }

function ThinkingBlock({ 
  thought, 
  isThinking, 
  duration 
}: { 
  thought: string; 
  isThinking: boolean; 
  duration?: number;
}) {
  const [isOpen, setIsOpen] = useState<boolean>(true)
  const [elapsed, setElapsed] = useState<number>(0)

  useEffect(() => {
    let timer: any
    if (isThinking) {
      const startTime = Date.now()
      setElapsed(0)
      timer = setInterval(() => {
        setElapsed(Number(((Date.now() - startTime) / 1000).toFixed(1)))
      }, 100)
    } else if (duration !== undefined) {
      setElapsed(duration)
    }
    return () => clearInterval(timer)
  }, [isThinking, duration])

  // Auto collapse when done if thought is empty or after short delay
  useEffect(() => {
    if (!isThinking && !thought) {
      setIsOpen(false)
    }
  }, [isThinking, thought])

  if (!isThinking && !thought && (duration === undefined || duration === 0)) return null

  return (
    <div className={`thinking-card ${isThinking ? 'active' : 'completed'}`}>
      <button 
        className="thinking-header" 
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="thinking-title">
          {isThinking ? (
            <span className="sparkle-icon pulsing">
              <Sparkles size={16} />
            </span>
          ) : (
            <span className="sparkle-icon done">
              <Brain size={16} />
            </span>
          )}
          <span className="thinking-text">
            {isThinking ? 'Thinking...' : `Thought for ${elapsed}s`}
          </span>
          {isThinking && <span className="thinking-timer">{elapsed}s</span>}
        </div>
        <div className="thinking-chevron">
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="thinking-body-wrapper"
          >
            <div className="thinking-body">
              {thought ? (
                <div className="thought-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {thought}
                  </ReactMarkdown>
                </div>
              ) : isThinking ? (
                <div className="thinking-shimmer">
                  <div className="shimmer-bar" />
                  <span className="status-tip">Analyzing request, inspecting context & formulating steps...</span>
                </div>
              ) : (
                <div className="thinking-empty">Thought process finalized.</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function CodeBlock({ children, className, ...props }: any) {
  const [copied, setCopied] = useState(false)
  const match = /language-(\w+)/.exec(className || '')
  const codeStr = String(children).replace(/\n$/, '')

  const handleCopy = () => {
    navigator.clipboard.writeText(codeStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return match ? (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="code-lang">{match[1]}</span>
        <button className="copy-code-btn" onClick={handleCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <SyntaxHighlighter style={oneLight as any} language={match[1]} PreTag="div" {...props}>
        {codeStr}
      </SyntaxHighlighter>
    </div>
  ) : (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (pin === '0524') {
      onLogin()
    } else {
      setError(true)
      setPin('')
    }
  }

  return (
    <div className="login-container">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="login-card"
      >
        <div className="login-icon">
          <Lock size={40} />
        </div>
        <h2>Welcome Back</h2>
        <p>Please enter your PIN to continue</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input 
            type="password"
            value={pin}
            onChange={e => { setPin(e.target.value); setError(false); }}
            placeholder="Enter PIN"
            className={`textfield login-input ${error ? 'error' : ''}`}
            autoFocus
          />
          {error && <div className="login-error">Incorrect PIN</div>}
          <button type="submit" className="action-btn login-btn">
            Login
          </button>
        </form>
      </motion.div>
    </div>
  )
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [drawerMode, setDrawerMode] = useState<'sessions' | 'create'>('sessions')
  
  // Create Session State
  const [currentPath, setCurrentPath] = useState<string>('/root')
  const [items, setItems] = useState<DirItem[]>([])
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [newConvName, setNewConvName] = useState('')
  
  // Chat State
  const [input, setInput] = useState('')
  const [socket, setSocket] = useState<WebSocket | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem('isLoggedIn') === 'true'
  })

  // Fluid Spring Configuration
  const springConfig = { type: "spring" as const, damping: 25, stiffness: 250, mass: 1 }

  useEffect(() => {
    const init = async () => {
      const data = await loadConversations()
      const params = new URLSearchParams(window.location.search)
      const idStr = params.get('id')
      if (idStr && data) {
        const conv = data.find(c => c.id === Number(idStr))
        if (conv) {
          setActiveConv(conv)
          connectWebSocket(conv.id)
        }
      }
    }
    init()
    loadDir('/root')

    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search)
      const idStr = params.get('id')
      if (idStr) {
        setConversations(prev => {
          const conv = prev.find(c => c.id === Number(idStr))
          if (conv) {
            setActiveConv(conv)
            connectWebSocket(conv.id)
          }
          return prev
        })
      } else {
        setActiveConv(null)
        setMessages([])
        if (socketRef.current) socketRef.current.close()
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }

  const loadConversations = async () => {
    try {
      const r = await fetch('/agy/api/conversations')
      const data = await r.json()
      if (Array.isArray(data)) {
        setConversations(data)
        return data
      }
    } catch (e) {
      console.error(e)
    }
    return []
  }

  const loadDir = (path: string) => {
    fetch(`/agy/api/ls?path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then(data => {
        if (data.items) {
          setItems(data.items)
          setCurrentPath(path)
        }
      })
      .catch(console.error)
  }

  const selectConversation = (conv: Conversation) => {
    setActiveConv(conv)
    setIsDrawerOpen(false)
    connectWebSocket(conv.id)

    const url = new URL(window.location.href)
    url.searchParams.set('id', String(conv.id))
    window.history.pushState({}, '', url.toString())
  }

  const connectWebSocket = (convId: number) => {
    if (socketRef.current) {
      socketRef.current.close()
    }
    
    // Load history first
    fetch(`/agy/api/history/${convId}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMessages(data.map((m: any) => ({
            role: m.role,
            content: m.content || '',
            thought: m.thought || '',
            isThinking: false
          })))
        }
      })

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${wsProto}//${window.location.host}/agy/api/chat`)
    
    ws.onopen = () => {
      setIsConnected(true)
      ws.send(JSON.stringify({ conversation_id: convId }))
    }
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'start') {
        setMessages(prev => [
          ...prev, 
          { role: 'agent', content: '', thought: '', isThinking: true }
        ])
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
      } else if (data.type === 'token') {
        setMessages(prev => {
          const newMsgs = [...prev]
          let lastMsg = newMsgs[newMsgs.length - 1]
          if (lastMsg && lastMsg.role === 'agent') {
            lastMsg.content += data.content
          } else {
            newMsgs.push({ role: 'agent', content: data.content, thought: '', isThinking: false })
          }
          return newMsgs
        })
      } else if (data.type === 'done') {
        setMessages(prev => {
          const newMsgs = [...prev]
          let lastMsg = newMsgs[newMsgs.length - 1]
          if (lastMsg && lastMsg.role === 'agent') {
            lastMsg.isThinking = false
            lastMsg.thinkingDuration = data.duration
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
          newMsgs.push({ role: 'system', content: `Error: ${data.content}`, isError: true })
          return newMsgs
        })
      }
    }
    
    ws.onclose = () => {
      setIsConnected(false)
      setSocket(null)
      socketRef.current = null
    }
    setSocket(ws)
    socketRef.current = ws
  }

  const createConversation = () => {
    if (!selectedDir || !newConvName.trim()) return
    fetch('/agy/api/conversations', {
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
    if (window.confirm('Delete this conversation entirely?')) {
      fetch(`/agy/api/conversations/${convId}`, { method: 'DELETE' })
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
  }

  const sendMessage = () => {
    if (!input.trim() || !socket || socket.readyState !== WebSocket.OPEN) return
    const msg = input.trim()
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setMessages(prev => [...prev, { role: 'user', content: msg }])
    socket.send(msg)
  }

  const copyMessageText = (text: string) => {
    navigator.clipboard.writeText(text)
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
      {/* Main Chat Area */}
      <div className="chat-main">
        <div className="chat-header">
          <motion.button 
            whileTap={{ scale: 0.95 }}
            className="icon-btn" 
            onClick={() => setIsDrawerOpen(true)}
          >
            <Menu size={20} />
          </motion.button>
          
          <div className="header-title">
            {activeConv ? activeConv.name : "Antigravity"}
          </div>
          
          {activeConv && (
            <div className="status-indicator">
              <div className={`status-dot ${isConnected ? 'online' : 'offline'}`} />
              {isConnected ? 'Connected' : 'Offline'}
            </div>
          )}
        </div>

        <div className="chat-messages">
          {!activeConv && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              className="system-msg welcome-card"
            >
              <div className="welcome-icon">
                <Sparkles size={28} />
              </div>
              <h3>Welcome to Antigravity Chat</h3>
              <p>Open the left menu to select an existing session or start a new workspace chat.</p>
            </motion.div>
          )}

          {messages.map((m, i) => (
            m.role === 'system' ? (
              <div key={i} className={`system-msg ${m.isError ? 'error' : ''}`}>{m.content}</div>
            ) : (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={springConfig}
                className={`message-row ${m.role}`}
              >
                <div className="message-bubble">
                  {m.role === 'agent' ? (
                    <div className="agent-container">
                      <ThinkingBlock 
                        thought={m.thought || ''} 
                        isThinking={!!m.isThinking} 
                        duration={m.thinkingDuration} 
                      />

                      {m.content ? (
                        <div className="markdown-body">
                          <ReactMarkdown 
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeRaw]}
                            components={{
                              code: CodeBlock
                            }}
                          >
                            {m.content}
                          </ReactMarkdown>
                          
                          {!m.isThinking && (
                            <div className="message-toolbar">
                              <button 
                                className="toolbar-btn" 
                                title="Copy Response"
                                onClick={() => copyMessageText(m.content)}
                              >
                                <Copy size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      ) : null}

                      {m.isThinking && m.content && (
                        <span className="streaming-cursor" />
                      )}
                    </div>
                  ) : (
                    m.content
                  )}
                </div>
              </motion.div>
            )
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          <div className="input-box">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              }}
              placeholder={activeConv ? "Ask anything..." : "Select a session to start talking..."}
              disabled={!activeConv || !isConnected}
              rows={1}
            />
            <motion.button 
              whileTap={{ scale: 0.95 }}
              className="send-btn" 
              onClick={sendMessage} 
              disabled={!activeConv || !isConnected || !input.trim()}
            >
              <ArrowUp size={18} />
            </motion.button>
          </div>
        </div>
      </div>

      {/* Drawer */}
      <AnimatePresence>
        {isDrawerOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="drawer-scrim" 
              onClick={() => setIsDrawerOpen(false)} 
            />
            <motion.div 
              initial={{ x: '-100%', opacity: 0.5 }} 
              animate={{ x: 0, opacity: 1 }} 
              exit={{ x: '-100%', opacity: 0.5 }}
              transition={springConfig}
              className="drawer"
            >
              {drawerMode === 'sessions' ? (
                <>
                  <div className="drawer-header">
                    <span className="drawer-title">Sessions</span>
                    <motion.button whileTap={{ scale: 0.9 }} className="icon-btn" onClick={() => setIsDrawerOpen(false)}>
                      <X size={20} />
                    </motion.button>
                  </div>
                  <div className="drawer-content">
                    {conversations.map(conv => (
                      <motion.div 
                        whileTap={{ scale: 0.98 }}
                        key={conv.id} 
                        className={`list-item ${activeConv?.id === conv.id ? 'selected' : ''}`}
                        onClick={() => selectConversation(conv)}
                      >
                        <div className="item-icon"><MessageSquare size={18} /></div>
                        <div className="item-content">
                          <div className="item-title">{conv.name}</div>
                          <div className="item-subtitle">{conv.path}</div>
                        </div>
                        <motion.button 
                          whileTap={{scale: 0.9}} 
                          className="icon-btn destructive" 
                          onClick={(e) => deleteConversation(e, conv.id)}
                        >
                          <Trash2 size={16} />
                        </motion.button>
                      </motion.div>
                    ))}
                  </div>
                  <div className="drawer-form">
                    <motion.button 
                      whileTap={{ scale: 0.98 }}
                      className="action-btn" 
                      onClick={() => setDrawerMode('create')}
                    >
                      <Plus size={18} /> New Session
                    </motion.button>
                  </div>
                </>
              ) : (
                <>
                  <div className="drawer-header">
                    <motion.button whileTap={{ scale: 0.9 }} className="icon-btn" onClick={() => setDrawerMode('sessions')}>
                      <ChevronLeft size={20} />
                    </motion.button>
                    <span className="drawer-title">Select Path</span>
                    <div style={{width: 32}} />
                  </div>
                  <div className="drawer-content">
                    <div className="list-item" onClick={() => {
                        if (currentPath === '/') return;
                        const parts = currentPath.split('/');
                        parts.pop();
                        loadDir(parts.join('/') || '/');
                    }}>
                      <div className="item-icon"><ChevronLeft size={16} /></div>
                      <div className="item-content"><div className="item-title">Go Up ({currentPath})</div></div>
                    </div>
                    {items.map((item, idx) => (
                      <div 
                        key={idx} 
                        className={`list-item ${selectedDir === item.path ? 'selected' : ''}`}
                        onClick={() => item.is_dir && setSelectedDir(item.path)}
                        onDoubleClick={() => item.is_dir && loadDir(item.path)}
                      >
                        <div className="item-icon">
                          {item.is_dir ? <Folder size={18} fill={selectedDir === item.path ? "currentColor" : "none"} /> : <FileText size={18} />}
                        </div>
                        <div className="item-content"><div className="item-title">{item.name}</div></div>
                      </div>
                    ))}
                  </div>
                  <div className="drawer-form">
                    <input 
                      className="textfield"
                      placeholder="Session Name" 
                      value={newConvName}
                      onChange={e => setNewConvName(e.target.value)}
                    />
                    <motion.button 
                      whileTap={{ scale: 0.98 }}
                      className="action-btn" 
                      onClick={createConversation} 
                      disabled={!selectedDir || !newConvName.trim()}
                    >
                      Create
                    </motion.button>
                  </div>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
