import { useEffect, useRef } from 'react'
import { File, FileCode2, FileText, Loader2, Search } from 'lucide-react'
import type { FileSearchItem } from '../lib/types'

interface FileMentionPickerProps {
  items: FileSearchItem[]
  loading: boolean
  query: string
  activeIndex: number
  workspacePath: string
  showingRecent: boolean
  onSelect: (item: FileSearchItem) => void
}

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx',
  'kt', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue',
])
const TEXT_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'toml', 'yaml', 'yml'])

function FileTypeIcon({ name }: { name: string }) {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  if (CODE_EXTENSIONS.has(extension)) {
    return <FileCode2 size={17} className="file-mention-icon code" aria-hidden="true" />
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return <FileText size={17} className="file-mention-icon text" aria-hidden="true" />
  }
  return <File size={17} className="file-mention-icon" aria-hidden="true" />
}

export function FileMentionPicker({
  items,
  loading,
  query,
  activeIndex,
  workspacePath,
  showingRecent,
  onSelect,
}: FileMentionPickerProps) {
  const activeOptionRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      className="file-mention-picker"
      role="listbox"
      id="file-mention-results"
      aria-label="项目文件"
      onMouseDown={event => event.preventDefault()}
    >
      <div className="file-mention-header">
        <div className="file-mention-query">
          <Search size={14} aria-hidden="true" />
          <span className="file-mention-at">@</span>
          <span className={query ? '' : 'file-mention-placeholder'}>
            {query || (showingRecent ? '最近文件' : '搜索项目文件')}
          </span>
        </div>
        {loading && <Loader2 size={14} className="animate-spin" aria-label="搜索中" />}
      </div>

      <div className="file-mention-list">
        {items.map((item, index) => (
          <button
            ref={index === activeIndex ? activeOptionRef : undefined}
            type="button"
            role="option"
            id={`file-mention-option-${index}`}
            aria-selected={index === activeIndex}
            className={`file-mention-item ${index === activeIndex ? 'active' : ''}`}
            key={item.path}
            onClick={() => onSelect(item)}
          >
            <FileTypeIcon name={item.name} />
            <span className="file-mention-copy">
              <span className="file-mention-name">{item.name}</span>
              <span className="file-mention-path">{item.relative_path}</span>
            </span>
          </button>
        ))}

        {!loading && items.length === 0 && (
          <div className="file-mention-empty">
            {query ? `没有找到“${query}”` : '当前项目内没有可引用的文件'}
          </div>
        )}
      </div>

      <div className="file-mention-footer">
        <span className="file-mention-workspace" title={workspacePath}>{workspacePath}</span>
        <span className="file-mention-shortcuts">↑↓ 选择 · Enter 插入 · Esc 关闭</span>
      </div>
    </div>
  )
}
