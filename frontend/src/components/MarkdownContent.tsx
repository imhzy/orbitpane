import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import { CodeBlock } from './CodeBlock'
import { asText } from '../lib/normalize'
import { Maximize2, X } from 'lucide-react'
import { Checkbox } from './FormControls'

interface MarkdownContentProps {
  content: string
  enableCodeBlocks?: boolean
  isStreaming?: boolean
}

/**
 * Callers are typed `string`, but the text they pass originates on the wire.
 * A non-string reaching `.split` here crashed the entire message list, so this
 * degrades to an empty block instead of taking the conversation down.
 */
function fixMarkdownTables(value: unknown): string {
  const text = asText(value)
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
    <div
      className={`markdown-table-shell ${expanded ? 'expanded' : ''}`}
      data-drawer-swipe-ignore="horizontal"
    >
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

/* Hoisted: a fresh plugin array or components map on every render makes
   react-markdown re-parse and rebuild the tree even when the text is
   unchanged. */
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]
function MarkdownCheckbox({ checked, disabled }: { checked?: boolean; disabled?: boolean }) {
  return <Checkbox checked={checked} disabled={disabled} readOnly />
}
const PROSE_COMPONENTS = { table: ResponsiveTable, input: MarkdownCheckbox }
const CODE_COMPONENTS = { table: ResponsiveTable, code: CodeBlock, input: MarkdownCheckbox }

/**
 * Memoised on the text alone.
 *
 * Parsing markdown, laying out KaTeX and highlighting code is the expensive
 * half of rendering a transcript, and in a long conversation the great
 * majority of messages are finished and will never change again. Anything that
 * re-renders a row for another reason — a copy tick, a feedback vote, a
 * streamed token in the turn below — must not pay to rebuild them.
 */
function MarkdownContent({
  content,
  enableCodeBlocks = false,
  isStreaming = false,
}: MarkdownContentProps) {
  const latestContent = React.useRef(content)
  const [streamContent, setStreamContent] = React.useState(content)
  React.useEffect(() => { latestContent.current = content }, [content])
  React.useEffect(() => {
    if (!isStreaming) return
    const timer = window.setInterval(() => setStreamContent(latestContent.current), 150)
    return () => window.clearInterval(timer)
  }, [isStreaming])
  // Preserve one Markdown document (references, fences, tables and maths can
  // cross paragraph boundaries). Limit parsing during streaming, then display
  // the complete final document immediately and enable syntax highlighting.
  const displayedContent = isStreaming ? streamContent : content
  const processedContent = React.useMemo(() => fixMarkdownTables(displayedContent), [displayedContent])

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={enableCodeBlocks && !isStreaming ? CODE_COMPONENTS : PROSE_COMPONENTS}
    >
      {processedContent}
    </ReactMarkdown>
  )
}

export default React.memo(MarkdownContent)
