import { describe, it, expect } from 'vitest'
import { JournalWriter } from '../journalWriter'

describe('JournalWriter', () => {
  it('writes each file as one newline-terminated batch, in order', () => {
    const calls: [string, string][] = []
    const w = new JournalWriter((f, d) => calls.push([f, d]))
    w.add('a.jsonl', '1'); w.add('b.jsonl', 'x'); w.add('a.jsonl', '2')
    expect(w.size).toBe(3)
    expect(w.flush()).toEqual({ written: 3, failed: 0 })
    expect(calls).toEqual([['a.jsonl', '1\n2\n'], ['b.jsonl', 'x\n']])
    expect(w.size).toBe(0)
    expect(w.flush()).toEqual({ written: 0, failed: 0 })
  })

  it('keeps a failed batch and writes it, with later lines, on the next flush', () => {
    let broken = true
    const calls: string[] = []
    const w = new JournalWriter((_f, d) => { if (broken) throw new Error('EBUSY'); calls.push(d) })
    w.add('a.jsonl', '1')
    expect(w.flush()).toEqual({ written: 0, failed: 1 })
    expect(w.size).toBe(1)
    w.add('a.jsonl', '2')
    broken = false
    expect(w.flush()).toEqual({ written: 2, failed: 0 })
    expect(calls).toEqual(['1\n2\n'])
  })

  it('one unwritable file does not hold back another', () => {
    const calls: string[] = []
    const w = new JournalWriter((f, d) => { if (f === 'bad') throw new Error('EACCES'); calls.push(d) })
    w.add('bad', '1'); w.add('good', '2')
    expect(w.flush()).toEqual({ written: 1, failed: 1 })
    expect(calls).toEqual(['2\n'])
  })

  it('sheds the oldest lines once the backlog reaches its cap', () => {
    const calls: string[] = []
    let broken = true
    const w = new JournalWriter((_f, d) => { if (broken) throw new Error('ENOSPC'); calls.push(d) }, 3)
    for (const l of ['1', '2', '3', '4', '5']) w.add('a', l)
    expect(w.size).toBe(3)
    expect(w.dropped).toBe(2)
    broken = false
    w.flush()
    expect(calls).toEqual(['3\n4\n5\n'])
  })
})
