/** Per-connection cursors. A missing delta requires a snapshot before applying more. */
export class StreamCursor {
  private sequences = new Map<string, number>()
  private pending = new Set<string>()

  accept(event: { protocol?: number; type: string; run_id?: string; sequence?: number }): 'apply' | 'ignore' | 'sync' {
    const { protocol, type, run_id: run, sequence } = event
    if (protocol !== 2 || !run || !Number.isInteger(sequence)) return 'apply'
    const seq = sequence!
    const previous = this.sequences.get(run)
    if (type === 'start' || type === 'sync_state' || type === 'done') {
      if (previous !== undefined && seq < previous) return 'ignore'
      this.sequences.set(run, seq)
      this.pending.delete(run)
      return 'apply'
    }
    if (!['token', 'thought', 'answer', 'step', 'status', 'elapsed'].includes(type)) return 'apply'
    if (this.pending.has(run)) return 'ignore'
    if (previous === undefined || seq > previous + (type === 'elapsed' ? 0 : 1)) {
      this.pending.add(run)
      return 'sync'
    }
    if (type === 'elapsed') return 'apply'
    if (seq <= previous) return 'ignore'
    this.sequences.set(run, seq)
    return 'apply'
  }
}
