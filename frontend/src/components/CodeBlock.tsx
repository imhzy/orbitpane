import { REFERENCE_FILE_EVENT } from '../lib/appEvents'
import { lazy, Suspense, useState, useEffect } from 'react'
import { Copy, Check, Code, Download, ListOrdered, MapPin, WrapText } from 'lucide-react'

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
  const [wrapLongLines, setWrapLongLines] = useState(false)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const theme = useTheme()
  const match = /language-(\w+)/.exec(className || '')
  const rawCode = String(children).replace(/\n$/, '')
  const fileMatch = rawCode.match(/^(?:\/\/|#|<!--)\s*(?:file|filename):\s*([^\n>]+)(?:-->)?\s*\n/i)
  const fileName = fileMatch?.[1]?.trim() || ''
  const codeStr = fileMatch ? rawCode.slice(fileMatch[0].length) : rawCode
  const lineCount = codeStr.split('\n').length

  const handleCopy = () => {
    void navigator.clipboard.writeText(codeStr).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleDownload = () => {
    const blob = new Blob([codeStr], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName.split('/').pop() || `snippet.${match?.[1] || 'txt'}`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return match ? (
    <div className="my-4 rounded-md overflow-hidden border border-[var(--border-color)] bg-[var(--bg-code)] shadow-sm group">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--bg-code-header)] border-b border-[var(--border-subtle)] text-[13px] text-[var(--text-secondary)] font-mono">
        <div className="flex items-center gap-2.5">
          <Code size={13} className="text-[var(--accent-color)]" />
          <span className="font-medium code-file-label" title={fileName || match[1]}>{fileName || match[1]}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface-hover)] text-[var(--text-tertiary)]">
            {lineCount} 行
          </span>
        </div>
        <div className="code-block-actions">
          {fileName && (
            <button onClick={() => window.dispatchEvent(new CustomEvent(REFERENCE_FILE_EVENT, { detail: fileName }))} title="在输入框引用此文件"><MapPin size={13} /></button>
          )}
          <button className={wrapLongLines ? 'active' : ''} onClick={() => setWrapLongLines(value => !value)} title="切换代码折行"><WrapText size={13} /></button>
          <button className={showLineNumbers ? 'active' : ''} onClick={() => setShowLineNumbers(value => !value)} title="切换行号"><ListOrdered size={13} /></button>
          <button onClick={handleDownload} title="下载代码片段"><Download size={13} /></button>
          <button onClick={handleCopy} title="复制代码内容">
            {copied ? <Check size={13} className="icon-success" /> : <Copy size={13} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <Suspense
        fallback={
          <pre className="m-0 overflow-auto p-4 text-[13px] font-mono">
            <code>{codeStr}</code>
          </pre>
        }
      >
        <HighlightedCode
          code={codeStr}
          language={match[1]}
          theme={theme}
          showLineNumbers={showLineNumbers}
          wrapLongLines={wrapLongLines}
        />
      </Suspense>
    </div>
  ) : (
    /* Inline code marks a token as literal; it is not a chip. Padded, filled
       and bordered, a paragraph with six file names in it renders as a row of
       grey blocks with prose in the gaps — the emphasis lands on the
       punctuation between words rather than on the words. The tint carries it
       on its own, with just enough side padding to keep the glyphs off the
       surrounding text and no vertical padding to disturb the line rhythm. */
    <code className="orbit-inline-code" {...props}>
      {children}
    </code>
  )
}
