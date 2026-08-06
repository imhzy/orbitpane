import { lazy, Suspense, useState, useEffect } from 'react'
import { Copy, Check, Code } from 'lucide-react'

const HighlightedCode = lazy(() => import('./HighlightedCode'))

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

interface CodeBlockProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode
  className?: string
}

export function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const theme = useTheme()
  const match = /language-(\w+)/.exec(className || '')
  const codeStr = String(children).replace(/\n$/, '')
  const lineCount = codeStr.split('\n').length

  const handleCopy = () => {
    navigator.clipboard.writeText(codeStr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return match ? (
    <div className="my-4 rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--bg-code)] shadow-sm group">
      <div className="flex items-center justify-between px-3.5 py-2 bg-[var(--bg-code-header)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] font-mono">
        <div className="flex items-center gap-2">
          <Code size={13} className="text-[var(--accent-color)]" />
          <span className="font-medium capitalize">{match[1]}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface-hover)] text-[var(--text-tertiary)]">
            {lineCount} 行
          </span>
        </div>
        <button 
          className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-[12px]"
          onClick={handleCopy}
          title="复制代码内容"
        >
          {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <Suspense
        fallback={
          <pre className="m-0 overflow-auto p-4 text-[13px] font-mono">
            <code>{codeStr}</code>
          </pre>
        }
      >
        <HighlightedCode code={codeStr} language={match[1]} theme={theme} />
      </Suspense>
    </div>
  ) : (
    <code className="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface-hover)] text-[var(--accent-color)] font-mono text-[0.88em] border border-[var(--border-subtle)]" {...props}>
      {children}
    </code>
  )
}
