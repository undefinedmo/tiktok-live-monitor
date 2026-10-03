// Batches journal lines per file and hands each batch to an append function. The disk call
// is injected so this stays portable and testable; in the app it runs inside the journal
// worker thread, never on the thread that dispatches print jobs.

export type AppendFn = (file: string, data: string) => void

export class JournalWriter {
  private pending = new Map<string, string[]>()
  private count = 0
  /** Lines discarded because the backlog hit its cap (a disk that stayed unwritable). */
  dropped = 0

  constructor(
    private readonly append: AppendFn,
    private readonly maxPending = 50_000,
  ) {}

  get size(): number {
    return this.count
  }

  add(file: string, line: string): void {
    let lines = this.pending.get(file)
    if (!lines) { lines = []; this.pending.set(file, lines) }
    lines.push(line)
    this.count++
    // A journal that cannot be written must not grow without bound and take the app down
    // with it. Shed the OLDEST line of this file: the newest state is the most useful.
    if (this.count > this.maxPending) {
      lines.shift()
      this.count--
      this.dropped++
    }
  }

  /** Write every pending batch. A file whose append throws keeps its lines for the next flush. */
  flush(): { written: number; failed: number } {
    let written = 0
    let failed = 0
    for (const [file, lines] of this.pending) {
      if (!lines.length) { this.pending.delete(file); continue }
      try {
        this.append(file, lines.join('\n') + '\n')
        written += lines.length
        this.count -= lines.length
        this.pending.delete(file)
      } catch {
        failed += lines.length
      }
    }
    return { written, failed }
  }
}
