import { useEffect, useMemo, useState } from 'react'
import { apiFetch, describeApiError } from '../lib/api'
import { pairDiffLines, parseWorkspaceDiff, type DiffLine } from '../lib/workspaceDiff'
import { ReaderDialog } from './ReaderDialog'
import './WorkspaceDiff.css'

function DiffCell({ line, side }: { line?: DiffLine; side: 'old' | 'new' }) {
  return <div className={`diff-cell ${line ? `diff-${line.kind}` : 'diff-empty'}`}>
    <span className="diff-line-number" aria-hidden="true">{side === 'old' ? line?.oldLine : line?.newLine}</span>
    <span className="diff-marker" aria-hidden="true">{line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ' '}</span>
    <code>{line?.text || ' '}</code>
  </div>
}

export function WorkspaceDiff({ conversationId, onClose }: { conversationId: number; onClose: () => void }) {
  const [result, setResult] = useState<{ diff: string; truncated: boolean; scope: string } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [layout, setLayout] = useState<'split' | 'unified'>('split')
  const [wrap, setWrap] = useState(true)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px)')
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    setResult(null)
    apiFetch<{ diff: string; truncated: boolean; scope: string }>(`/api/conversations/${conversationId}/workspace-diff`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult(data) })
      .catch(error => { if (!controller.signal.aborted) setError(describeApiError(error, '读取差异失败')) })
    return () => controller.abort()
  }, [conversationId, attempt])
  const files = useMemo(() => parseWorkspaceDiff(result?.diff || ''), [result?.diff])
  const split = !mobile && layout === 'split'
  return <ReaderDialog title="项目文件差异" onClose={onClose}>
    {error ? <div role="alert"><p>{error}</p><button className="ui-btn secondary" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : !result ? <p role="status">正在读取差异…</p> : <>
        <p className="reader-note">{result.scope} 这是工作区的当前状态，不代表某一个任务独自造成的改动。</p>
        {result.truncated && <p role="status">差异超过 256 KB，仅显示前一部分。</p>}
        {files.length ? <div className={`workspace-diff-view ${wrap ? 'diff-wrap' : ''}`}>
          <div className="diff-toolbar">
            <span>{files.length} 个文件 <span className="diff-stat-added">+{files.reduce((n, file) => n + file.added, 0)}</span> <span className="diff-stat-removed">−{files.reduce((n, file) => n + file.removed, 0)}</span></span>
            <div className="diff-controls">
              {!mobile && <><button type="button" aria-pressed={split} onClick={() => setLayout('split')}>左右对比</button><button type="button" aria-pressed={!split} onClick={() => setLayout('unified')}>单栏</button></>}
              <button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>自动折行</button>
            </div>
          </div>
          {files.map((file, index) => <details className="diff-file" key={`${index}-${file.path}`} open>
            <summary><span className="diff-file-path">{file.path}</span><span className="diff-file-stats"><span className="diff-stat-added">+{file.added}</span> <span className="diff-stat-removed">−{file.removed}</span></span></summary>
            <div className="diff-scroll" tabIndex={0} role="region" aria-label={`${file.path} 文件差异`} data-drawer-swipe-ignore="horizontal">
              <div className={`diff-lines ${split ? 'diff-split' : 'diff-unified'}`}>
                {split ? <>
                  <div className="diff-column-labels"><span>原始版本 · HEAD</span><span>当前工作区</span></div>
                  {pairDiffLines(file.lines).map((row, rowIndex) => row.full
                    ? <div key={rowIndex} className={`diff-info diff-${row.full.kind}`}>{row.full.text}</div>
                    : <div className="diff-pair" key={rowIndex}><DiffCell line={row.left} side="old" /><DiffCell line={row.right} side="new" /></div>)}
                </> : file.lines.map((line, lineIndex) => line.kind === 'hunk' || line.kind === 'meta'
                  ? <div key={lineIndex} className={`diff-info diff-${line.kind}`}>{line.text}</div>
                  : <div key={lineIndex} className={`diff-unified-line diff-${line.kind}`}>
                    <span className="diff-line-number" aria-hidden="true">{line.oldLine}</span><span className="diff-line-number" aria-hidden="true">{line.newLine}</span>
                    <span className="diff-marker" aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span><code>{line.text || ' '}</code>
                  </div>)}
              </div>
            </div>
          </details>)}
        </div> : <p>当前没有已跟踪文件相对 HEAD 的改动。</p>}
      </>}
  </ReaderDialog>
}
