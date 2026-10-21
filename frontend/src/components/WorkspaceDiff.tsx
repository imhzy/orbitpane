import { useEffect, useState } from 'react'
import { apiFetch, describeApiError } from '../lib/api'
import { ReaderDialog } from './ReaderDialog'

export function WorkspaceDiff({ conversationId, onClose }: { conversationId: number; onClose: () => void }) {
  const [result, setResult] = useState<{ diff: string; truncated: boolean; scope: string } | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    setResult(null)
    apiFetch<{ diff: string; truncated: boolean; scope: string }>(`/api/conversations/${conversationId}/workspace-diff`, { signal: controller.signal })
      .then(setResult).catch(error => { if (!controller.signal.aborted) setError(describeApiError(error, '读取差异失败')) })
    return () => controller.abort()
  }, [conversationId, attempt])
  return <ReaderDialog title="项目文件差异" onClose={onClose}>
    {error ? <div role="alert"><p>{error}</p><button className="ui-btn secondary" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
      : !result ? <p role="status">正在读取差异…</p> : <>
        <p className="reader-note">{result.scope} 这是工作区的当前状态，不代表某一个任务独自造成的改动。</p>
        {result.truncated && <p role="status">差异超过 256 KB，仅显示前一部分。</p>}
        {result.diff ? <pre className="workspace-diff">{result.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : ''}>{line}{'\n'}</span>)}</pre>
          : <p>当前没有已跟踪文件相对 HEAD 的改动。</p>}
      </>}
  </ReaderDialog>
}
