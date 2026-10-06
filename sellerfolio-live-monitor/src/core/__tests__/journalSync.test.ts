import { describe, it, expect } from 'vitest'
import { backoffMs, batchBody, takeLines, verdictFor } from '../journalSync'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('takeLines', () => {
  it('returns complete lines and the bytes they occupy', () => {
    const src = '{"id":"a-1"}\n{"id":"a-2"}\n'
    const b = takeLines(bytes(src), 500)
    expect(b.lines).toEqual(['{"id":"a-1"}', '{"id":"a-2"}'])
    expect(b.consumed).toBe(bytes(src).length)
    expect(b.skipped).toBe(0)
  })

  it('leaves a trailing partial line for the next read', () => {
    const b = takeLines(bytes('{"id":"a-1"}\n{"id":"a-2","buy'), 500)
    expect(b.lines).toEqual(['{"id":"a-1"}'])
    expect(b.consumed).toBe(13)
  })

  it('returns nothing, consuming nothing, when no line is complete', () => {
    expect(takeLines(bytes('{"id":"a-1"'), 500)).toEqual({ lines: [], consumed: 0, skipped: 0 })
    expect(takeLines(bytes(''), 500)).toEqual({ lines: [], consumed: 0, skipped: 0 })
  })

  it('stops at the batch limit and consumes only what it took', () => {
    const b = takeLines(bytes('{"n":1}\n{"n":2}\n{"n":3}\n'), 2)
    expect(b.lines).toEqual(['{"n":1}', '{"n":2}'])
    expect(b.consumed).toBe(16)
    const rest = takeLines(bytes('{"n":1}\n{"n":2}\n{"n":3}\n').subarray(b.consumed), 2)
    expect(rest.lines).toEqual(['{"n":3}'])
  })

  it('skips a torn or non-object line instead of blocking the file forever', () => {
    const b = takeLines(bytes('{"n":1}\n{"n":2,"x\n[1,2]\n\n{"n":3}\r\n'), 500)
    expect(b.lines).toEqual(['{"n":1}', '{"n":3}'])
    expect(b.skipped).toBe(2)
    expect(b.consumed).toBe(bytes('{"n":1}\n{"n":2,"x\n[1,2]\n\n{"n":3}\r\n').length)
  })

  it('keeps multi-byte text intact', () => {
    const line = '{"buyer":"Dennis2cool 👩🏽‍🎤","name":"Saldaña"}'
    const b = takeLines(bytes(line + '\n'), 500)
    expect(b.lines).toEqual([line])
    expect(b.consumed).toBe(bytes(line).length + 1)
  })
})

describe('batchBody', () => {
  it('joins lines into one JSON document without re-serializing them', () => {
    const body = batchBody('dev-1', ['{"id":"a-1","t":1}', '{"id":"a-2","t":2}'])
    expect(JSON.parse(body)).toEqual({ device: 'dev-1', events: [{ id: 'a-1', t: 1 }, { id: 'a-2', t: 2 }] })
  })
})

describe('backoffMs', () => {
  it('doubles from 5s and caps at 5 minutes', () => {
    expect(backoffMs(0)).toBe(0)
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10000, 20000, 40000])
    expect(backoffMs(7)).toBe(300000)
    expect(backoffMs(500)).toBe(300000)
  })
})

describe('verdictFor', () => {
  it('classifies statuses', () => {
    expect(verdictFor(200)).toBe('ok')
    expect(verdictFor(204)).toBe('ok')
    expect(verdictFor(401)).toBe('auth')
    expect(verdictFor(403)).toBe('auth')
    expect(verdictFor(429)).toBe('retry')
    expect(verdictFor(502)).toBe('retry')
    expect(verdictFor(400)).toBe('rejected')
    expect(verdictFor(413)).toBe('rejected')
  })
})
