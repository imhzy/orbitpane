import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamCursor } from '../src/lib/streamProtocol.ts'

const frame = (type, sequence, run_id = 'run') => ({ type, sequence, run_id, protocol: 2 })

test('duplicate deltas are ignored; missing deltas require one snapshot', () => {
  const cursor = new StreamCursor()
  assert.equal(cursor.accept(frame('start', 0)), 'apply')
  assert.equal(cursor.accept(frame('token', 1)), 'apply')
  assert.equal(cursor.accept(frame('token', 1)), 'ignore')
  assert.equal(cursor.accept(frame('step', 3)), 'sync')
  assert.equal(cursor.accept(frame('token', 4)), 'ignore')
  assert.equal(cursor.accept(frame('sync_state', 4)), 'apply')
  assert.equal(cursor.accept(frame('status', 5)), 'apply')
  assert.equal(cursor.accept(frame('token', 6)), 'apply')
})

test('heartbeats detect a lost last delta; final snapshots repair gaps', () => {
  const cursor = new StreamCursor()
  assert.equal(cursor.accept(frame('sync_state', 8)), 'apply')
  assert.equal(cursor.accept(frame('elapsed', 8)), 'apply')
  assert.equal(cursor.accept(frame('elapsed', 9)), 'sync')
  assert.equal(cursor.accept(frame('done', 10)), 'apply')
  assert.equal(cursor.accept(frame('token', 9)), 'ignore')
})

test('late snapshots cannot roll back the cursor; runs are independent', () => {
  const cursor = new StreamCursor()
  cursor.accept(frame('sync_state', 8))
  assert.equal(cursor.accept(frame('sync_state', 7)), 'ignore')
  assert.equal(cursor.accept(frame('token', 1, 'new-run')), 'sync')
  assert.equal(cursor.accept(frame('token', 9)), 'apply')
  assert.equal(cursor.accept({ type: 'token', sequence: 99 }), 'apply')
})
