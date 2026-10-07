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

  // The chat journal can out-write every other record many times over. When the disk is failing and
  // the backlog hits its cap, the shedding must fall on the flood, never on a sale.
  it('sheds from the file holding the most, so a chat flood cannot push a sale out of the backlog', () => {
    const calls: Record<string, string> = {}
    let broken = true
    const w = new JournalWriter((f, d) => { if (broken) throw new Error('ENOSPC'); calls[f] = d }, 5)
    for (const l of ['c1', 'c2', 'c3', 'c4', 'c5']) w.add('chat', l)
    w.add('sales', 's1')
    expect(w.size).toBe(5)
    expect(w.dropped).toBe(1)
    broken = false
    w.flush()
    expect(calls).toEqual({ chat: 'c2\nc3\nc4\nc5\n', sales: 's1\n' })
  })

  it('sheds the largest backlog, and from the file being added to when the backlogs are level', () => {
    const calls: Record<string, string> = {}
    let broken = true
    const w = new JournalWriter((f, d) => { if (broken) throw new Error('x'); calls[f] = d }, 4)
    w.add('a', 'a1'); w.add('a', 'a2'); w.add('b', 'b1'); w.add('b', 'b2')
    w.add('b', 'b3') // 5 > 4: a has 2, b has 3 -> b is the largest
    broken = false
    w.flush()
    expect(calls).toEqual({ a: 'a1\na2\n', b: 'b2\nb3\n' })

    const calls2: Record<string, string> = {}
    let broken2 = true
    const w2 = new JournalWriter((f, d) => { if (broken2) throw new Error('x'); calls2[f] = d }, 4)
    w2.add('a', 'a1'); w2.add('b', 'b1'); w2.add('a', 'a2'); w2.add('b', 'b2')
    w2.add('a', 'a3') // a=3 is the largest, so a sheds its oldest
    broken2 = false
    w2.flush()
    expect(calls2).toEqual({ a: 'a2\na3\n', b: 'b1\nb2\n' })
  })

  it('keeps the count honest across a shed in another file', () => {
    const w = new JournalWriter(() => { throw new Error('x') }, 3)
    w.add('chat', '1'); w.add('chat', '2'); w.add('chat', '3'); w.add('sales', 's')
    expect(w.size).toBe(3)
    expect(w.dropped).toBe(1)
  })

  it('on a tie for the largest backlog, sheds the file just added to; among OTHER ties, the earliest', () => {
    const calls: Record<string, string> = {}
    let broken = true
    const w = new JournalWriter((f, d) => { if (broken) throw new Error('x'); calls[f] = d }, 3)
    w.add('a', 'a1'); w.add('a', 'a2'); w.add('b', 'b1')
    w.add('b', 'b2') // 4 > 3, a=2 and b=2 are level: the file added to (b) sheds
    broken = false
    w.flush()
    expect(calls).toEqual({ a: 'a1\na2\n', b: 'b2\n' })

    const calls2: Record<string, string> = {}
    let broken2 = true
    const w2 = new JournalWriter((f, d) => { if (broken2) throw new Error('x'); calls2[f] = d }, 4)
    w2.add('a', 'a1'); w2.add('a', 'a2'); w2.add('c', 'c1'); w2.add('c', 'c2')
    w2.add('b', 'b1') // 5 > 4: a=2 and c=2 are level and both larger than b; the earlier file (a) sheds
    broken2 = false
    w2.flush()
    expect(calls2).toEqual({ a: 'a2\n', c: 'c1\nc2\n', b: 'b1\n' })
  })
})
