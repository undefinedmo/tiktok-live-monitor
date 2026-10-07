import { describe, it, expect } from 'vitest'
import { buildJournalLine, journalFileName } from '../journalLine'

const base = { runId: 'abc123abc123.k1', seq: 7, nowMs: 1781991026000, room: '7692', session: '3411' }

describe('buildJournalLine', () => {
  it('builds the envelope then the data, with a run-and-sequence id by default', () => {
    const line = buildJournalLine({ ...base, type: 'sale', data: { lot: '#41', buyer: 'Ann' } })
    expect(line).toBe('{"v":1,"id":"abc123abc123.k1-7","t":1781991026000,"room":"7692","session":"3411","type":"sale","lot":"#41","buyer":"Ann"}')
  })

  it('uses an explicit id instead of the sequence one, so a re-journaled message keeps its identity', () => {
    const line = JSON.parse(buildJournalLine({ ...base, type: 'chat', data: { text: 'hi' }, id: 'chat.123' }))
    expect(line.id).toBe('chat.123')
    expect(line.type).toBe('chat')
    expect(line.text).toBe('hi')
  })

  it('stamps t from the machine clock it is given, and nothing in the data can overwrite the envelope', () => {
    const line = JSON.parse(buildJournalLine({ ...base, type: 'chat', data: { id: 'evil', t: 1, v: 9, room: 'x', session: 'y', type: 'z', text: 'hi' }, id: 'chat.1' }))
    expect(line).toMatchObject({ v: 1, id: 'chat.1', t: 1781991026000, room: '7692', session: '3411', type: 'chat', text: 'hi' })
  })

  it('leaves out room and session when they are not known yet', () => {
    const line = JSON.parse(buildJournalLine({ runId: 'r', seq: 1, nowMs: 5, type: 'session', data: {} }))
    expect('room' in line).toBe(false)
    expect('session' in line).toBe(false)
  })

  it('emits exactly one line: a newline in the text is escaped, never a second journal line', () => {
    const line = buildJournalLine({ ...base, type: 'chat', data: { text: 'a\nb\r\nc d' }, id: 'chat.1' })
    expect(line).not.toMatch(/[\r\n]/)
    expect(JSON.parse(line).text).toBe('a\nb\r\nc d')
  })
})

describe('journalFileName', () => {
  it('puts a show\'s records in one file per room', () => {
    expect(journalFileName('7692', 'sale', '2026-10-07')).toBe('show-7692.jsonl')
    expect(journalFileName('7692', 'auction_end', '2026-10-07')).toBe('show-7692.jsonl')
  })

  it('puts the chat in its own file, so it can never queue ahead of, or crowd out, the sales', () => {
    expect(journalFileName('7692', 'chat', '2026-10-07')).toBe('show-7692.chat.jsonl')
  })

  it('keeps pre-room records in a dated catch-all, chat in its own', () => {
    expect(journalFileName(undefined, 'session', '2026-10-07')).toBe('unassigned-2026-10-07.jsonl')
    expect(journalFileName(undefined, 'chat', '2026-10-07')).toBe('unassigned-2026-10-07.chat.jsonl')
    expect(journalFileName('', 'chat', '2026-10-07')).toBe('unassigned-2026-10-07.chat.jsonl')
  })

  it('only the exact type "chat" is routed away', () => {
    expect(journalFileName('1', 'chatter', 'd')).toBe('show-1.jsonl')
    expect(journalFileName('1', 'print', 'd')).toBe('show-1.jsonl')
  })
})
