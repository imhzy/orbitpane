import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceDiff, pairDiffLines } from '../src/lib/workspaceDiff.ts'

test('numbers context and changes across multiple hunks without counting file headers', () => {
  const [file] = parseWorkspaceDiff('diff --git a/app.ts b/app.ts\nindex abc..def 100644\n--- a/app.ts\n+++ b/app.ts\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-last\n+next\n')
  assert.equal(file.path, 'app.ts')
  assert.equal(file.added, 3)
  assert.equal(file.removed, 2)
  assert.deepEqual(file.lines.filter(line => line.kind === 'added').map(line => line.newLine), [3, 4, 21])
  assert.deepEqual(file.lines.filter(line => line.kind === 'removed').map(line => line.oldLine), [3, 20])
  const pairs = pairDiffLines(file.lines).filter(row => !row.full)
  assert.equal(pairs[1].left.text, 'old')
  assert.equal(pairs[1].right.text, 'new')
  assert.equal(pairs[2].left, undefined)
  assert.equal(pairs[2].right.text, 'extra')
})

test('handles additions, deletions, binary and rename-only files', () => {
  const files = parseWorkspaceDiff('diff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+hello\ndiff --git a/old b/old\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\ndiff --git a/pic b/pic\nBinary files a/pic and b/pic differ\ndiff --git a/before b/after\nsimilarity index 100%\nrename from before\nrename to after\n')
  assert.deepEqual(files.map(file => [file.path, file.added, file.removed]), [['new', 1, 0], ['old', 0, 1], ['pic', 0, 0], ['after', 0, 0]])
  assert.match(files[2].lines[0].text, /Binary files/)
  assert.equal(pairDiffLines(files[0].lines).at(-1).left, undefined)
  assert.equal(pairDiffLines(files[1].lines).at(-1).right, undefined)
})

test('decodes Git quoted UTF-8 paths and preserves paths with spaces', () => {
  const [quoted] = parseWorkspaceDiff('diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"\n+++ "b/\\344\\270\\255.txt"\n')
  assert.equal(quoted.path, '中.txt')
  const [spaced] = parseWorkspaceDiff('diff --git a/my file.txt b/my file.txt\n+++ b/my file.txt\n')
  assert.equal(spaced.path, 'my file.txt')
})

test('retains no-newline markers and tolerates truncated hunks', () => {
  const [file] = parseWorkspaceDiff('diff --git a/a b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+partial')
  assert.equal(file.added, 1)
  assert.equal(file.removed, 1)
  assert.equal(file.lines[2].kind, 'meta')
  assert.equal(pairDiffLines(file.lines).at(-1).right.text, 'partial')
  assert.deepEqual(parseWorkspaceDiff(''), [])
})
