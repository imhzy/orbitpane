export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'meta'
  text: string
  oldLine?: number
  newLine?: number
}
export interface DiffFile {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
}

function decodePath(path: string) {
  if (!path.startsWith('"')) return path
  // Git quotes non-ASCII paths as octal UTF-8 bytes.
  const bytes: number[] = []
  const value = path.slice(1, -1)
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      const octal = value.slice(i + 1).match(/^[0-7]{3}/)
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
      const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' }
      bytes.push(...new TextEncoder().encode(escapes[value[++i]] ?? value[i]))
    } else {
      bytes.push(...new TextEncoder().encode(value[i]))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function parseWorkspaceDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const text of lines) {
    if (text.startsWith('diff --git ')) {
      const paths = text.slice(11).match(/^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/)
      file = { path: paths ? decodePath(paths[2]).replace(/^b\//, '') : text.slice(11), lines: [], added: 0, removed: 0 }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) {
      file = { path: '文件差异', lines: [], added: 0, removed: 0 }
      files.push(file)
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
      file.lines.push({ kind: 'hunk', text })
    } else if (inHunk && text.startsWith('+')) {
      file.lines.push({ kind: 'added', text: text.slice(1), newLine: newLine++ }); file.added++
    } else if (inHunk && text.startsWith('-')) {
      file.lines.push({ kind: 'removed', text: text.slice(1), oldLine: oldLine++ }); file.removed++
    } else if (inHunk && text.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (!inHunk && (text.startsWith('--- ') || text.startsWith('+++ '))) {
      const path = decodePath(text.slice(4))
      if (text.startsWith('+++ ') && path !== '/dev/null') file.path = path.replace(/^b\//, '')
    } else {
      file.lines.push({ kind: 'meta', text })
    }
  }
  return files
}

export function pairDiffLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine; full?: DiffLine }[] {
  const rows: { left?: DiffLine; right?: DiffLine; full?: DiffLine }[] = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.kind === 'removed' || line.kind === 'added') {
      const removed: DiffLine[] = []
      const added: DiffLine[] = []
      while (i < lines.length && lines[i].kind === 'removed') removed.push(lines[i++])
      while (i < lines.length && lines[i].kind === 'added') added.push(lines[i++])
      for (let j = 0; j < Math.max(removed.length, added.length); j++) rows.push({ left: removed[j], right: added[j] })
    } else {
      rows.push(line.kind === 'context' ? { left: line, right: line } : { full: line })
      i++
    }
  }
  return rows
}
