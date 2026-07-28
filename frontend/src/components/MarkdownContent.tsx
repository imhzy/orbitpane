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

export default function MarkdownContent({
  content,
  enableCodeBlocks = false,
}: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={enableCodeBlocks ? { code: CodeBlock } : undefined}
    >
      {content}
    </ReactMarkdown>
  )
}

