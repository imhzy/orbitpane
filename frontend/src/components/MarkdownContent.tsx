import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import { CodeBlock } from './CodeBlock'
import { Maximize2, X } from 'lucide-react'

interface MarkdownContentProps {
  content: string
  enableCodeBlocks?: boolean
}

function fixMarkdownTables(text: string): string {
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const current = lines[i].trim()
    if (/^[- ]+$/.test(current) && current.includes('-')) {
      const prev = lines[i - 1]
      if (prev.includes('|') && !/^[- |]+$/.test(prev)) {
        const cols = prev.split('|').length
        lines[i] = Array(cols).fill('---').join('|')
      }
    }
  }
  return lines.join('\n')
}

function ResponsiveTable({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  const [expanded, setExpanded] = React.useState(false)
  React.useEffect(() => {
    if (!expanded) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [expanded])
  return (
    <div className={`markdown-table-shell ${expanded ? 'expanded' : ''}`}>
      <div className="markdown-table-toolbar">
        <span>数据表格</span>
        <button onClick={() => setExpanded(value => !value)} aria-label={expanded ? '退出全屏表格' : '全屏查看表格'}>
          {expanded ? <X size={13} /> : <Maximize2 size={13} />}
          {expanded ? '退出' : '全屏'}
        </button>
      </div>
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    </div>
  )
}

export default function MarkdownContent({
  content,
  enableCodeBlocks = false,
}: MarkdownContentProps) {
  const processedContent = React.useMemo(() => fixMarkdownTables(content), [content])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        table: ResponsiveTable,
        ...(enableCodeBlocks ? { code: CodeBlock } : {}),
      }}
    >
      {processedContent}
    </ReactMarkdown>
  )
}
