import { useState, useEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy, Check } from 'lucide-react'

function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') || 'dark')
  
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'data-theme') {
          setTheme(document.documentElement.getAttribute('data-theme') || 'dark')
        }
      })
    })
    observer.observe(document.documentElement, { attributes: true })
    return () => observer.disconnect()
  }, [])
  
  return theme
}

export function CodeBlock({ children, className, ...props }: any) {
  const [copied, setCopied] = useState(false)
  const theme = useTheme()
  const match = /language-(\w+)/.exec(className || '')
  const codeStr = String(children).replace(/\n$/, '')

  const handleCopy = () => {
    navigator.clipboard.writeText(codeStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const syntaxStyle = theme === 'light' ? oneLight : oneDark

  return match ? (
    <div className="my-4 rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-code)] shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--bg-code-header)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-tertiary)] font-mono">
        <div className="flex items-center gap-2">
          <span>{match[1]}</span>
        </div>
        <button 
          className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          onClick={handleCopy}
        >
          {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>
      <SyntaxHighlighter 
        style={syntaxStyle as any} 
        language={match[1]} 
        PreTag="div" 
        customStyle={{ margin: 0, padding: '1rem', background: 'transparent', fontSize: '13px' }}
        showLineNumbers={true}
        {...props}
      >
        {codeStr}
      </SyntaxHighlighter>
    </div>
  ) : (
    <code className="px-1.5 py-0.5 rounded bg-[var(--bg-input)] text-[var(--accent-color)] font-mono text-[0.9em]" {...props}>
      {children}
    </code>
  )
}
