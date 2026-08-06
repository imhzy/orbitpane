import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import { CodeBlock } from './CodeBlock'

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

export default function MarkdownContent({
  content,
  enableCodeBlocks = false,
}: MarkdownContentProps) {
  const processedContent = React.useMemo(() => fixMarkdownTables(content), [content])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={enableCodeBlocks ? { code: CodeBlock } : undefined}
    >
      {processedContent}
    </ReactMarkdown>
  )
}

