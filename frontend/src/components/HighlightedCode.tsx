import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

for (const [name, language] of Object.entries({
  bash,
  css,
  diff,
  javascript,
  js: javascript,
  json,
  jsx,
  markdown,
  md: markdown,
  markup,
  html: markup,
  python,
  py: python,
  sql,
  tsx,
  typescript,
  ts: typescript,
  yaml,
  yml: yaml,
})) {
  SyntaxHighlighter.registerLanguage(name, language)
}

interface HighlightedCodeProps {
  code: string
  language: string
  theme: string
  showLineNumbers?: boolean
  wrapLongLines?: boolean
}

export default function HighlightedCode({
  code,
  language,
  theme,
  showLineNumbers = true,
  wrapLongLines = false,
}: HighlightedCodeProps) {
  return (
    <SyntaxHighlighter
      style={(theme === 'light' ? oneLight : oneDark) as never}
      language={language}
      PreTag="div"
      customStyle={{
        margin: 0,
        padding: '1.25rem',
        background: 'transparent',
        fontSize: '13px',
      }}
      showLineNumbers={showLineNumbers}
      wrapLongLines={wrapLongLines}
      lineProps={wrapLongLines ? { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } } : undefined}
    >
      {code}
    </SyntaxHighlighter>
  )
}
