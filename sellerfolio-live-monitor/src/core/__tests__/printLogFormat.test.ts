import { describe, expect, it } from 'vitest'
import {
  PRINT_LOG_CAP,
  SAMPLE_LABEL_CODE,
  clockTime,
  errorText,
  failedChipText,
  failedCount,
  isSampleLabel,
  labelName,
  nextPrintLast,
  printLastText,
  printLogText,
  pushEntry,
  spoolText,
  toEntry,
  type PrintLogEntry,
} from '../printLogFormat'
import { labelCode } from '../labelCode'

// Built from local components, so the assertion holds in any time zone.
const local = (h: number, m: number, s: number) => new Date(2026, 10, 5, h, m, s).getTime()

describe('clockTime', () => {
  it('formats the local clock as zero-padded 24 h HH:MM:SS', () => {
    expect(clockTime(local(9, 3, 7))).toBe('09:03:07')
    expect(clockTime(local(23, 59, 59))).toBe('23:59:59')
    expect(clockTime(local(0, 0, 0))).toBe('00:00:00')
  })
  it('never throws on a bad timestamp', () => {
    expect(clockTime(NaN)).toBe('--:--:--')
  })
})

describe('labelName', () => {
  it('joins the lot number and buyer', () => {
    expect(labelName({ itemNumber: '78', buyer: 'Jo' })).toBe('#78 Jo')
  })
  it('does not double the # and trims', () => {
    expect(labelName({ itemNumber: ' #78 ', buyer: '  ' })).toBe('#78')
  })
  it('falls back to the buyer, then "Tag"', () => {
    expect(labelName({ itemNumber: '', buyer: 'Jo' })).toBe('Jo')
    expect(labelName({})).toBe('Tag')
  })
})

describe('spoolText', () => {
  it('rounds milliseconds', () => {
    expect(spoolText(50.6)).toBe('51 ms')
    expect(spoolText(0)).toBe('0 ms')
  })
  it('switches to seconds for a slow spooler', () => {
    expect(spoolText(12_345)).toBe('12.3 s')
  })
  it('is undefined for missing or nonsense values', () => {
    expect(spoolText(undefined)).toBeUndefined()
    expect(spoolText(NaN)).toBeUndefined()
    expect(spoolText(-1)).toBeUndefined()
  })
})

describe('printLogText', () => {
  it('OK with a spool time', () => {
    expect(printLogText({ data: { itemNumber: '78' }, ok: true, spoolMs: 51, at: 0 })).toBe('#78 tag sent in 51 ms')
  })
  it('OK without a spool time says printed', () => {
    expect(printLogText({ data: { itemNumber: '81', buyer: 'Jo' }, ok: true, at: 0 })).toBe('#81 Jo printed')
  })
  it('a failure says so, even when main reported a spool time', () => {
    expect(printLogText({ data: { itemNumber: '82' }, ok: false, spoolMs: 40, error: 'x', at: 0 })).toBe('#82 failed to print')
  })
})

describe('toEntry', () => {
  it('carries the error (single line) on failures only', () => {
    const bad = toEntry({ data: { itemNumber: '1' }, ok: false, error: 'Printer\n offline ', at: local(10, 0, 0) }, 1)
    expect(bad).toMatchObject({ seq: 1, ok: false, time: '10:00:00', text: '#1 failed to print', error: 'Printer offline' })
    const good = toEntry({ data: { itemNumber: '1' }, ok: true, error: 'ignored', spoolMs: 5, at: 0 }, 2)
    expect(good.error).toBeUndefined()
  })
  it('gives a failure without an error a readable reason', () => {
    expect(errorText(undefined)).toBe('The printer did not say why.')
    expect(errorText('   ')).toBe('The printer did not say why.')
  })
})

describe('pushEntry', () => {
  const e = (seq: number, ok: boolean): PrintLogEntry => ({ seq, at: seq, ok, time: '', text: String(seq) })

  it('puts the newest first and does not mutate the input', () => {
    const a = [e(1, true)]
    const b = pushEntry(a, e(2, true))
    expect(b.map((x) => x.seq)).toEqual([2, 1])
    expect(a).toHaveLength(1)
  })

  it('caps at PRINT_LOG_CAP by default', () => {
    let list: PrintLogEntry[] = []
    for (let i = 1; i <= PRINT_LOG_CAP + 25; i++) list = pushEntry(list, e(i, true))
    expect(list).toHaveLength(PRINT_LOG_CAP)
    expect(list[0]?.seq).toBe(PRINT_LOG_CAP + 25)
    expect(list[list.length - 1]?.seq).toBe(26)
  })

  it('keeps old failures when good prints overflow the cap', () => {
    let list: PrintLogEntry[] = [e(1, false)]
    for (let i = 2; i <= 20; i++) list = pushEntry(list, e(i, true), 5, 3)
    expect(list).toHaveLength(5)
    expect(list.some((x) => x.seq === 1 && !x.ok)).toBe(true)
    expect(list[0]?.seq).toBe(20)
  })

  it('drops the oldest failures beyond the failure cap', () => {
    let list: PrintLogEntry[] = []
    for (let i = 1; i <= 6; i++) list = pushEntry(list, e(i, false), 10, 3)
    expect(list.map((x) => x.seq)).toEqual([6, 5, 4])
  })

  it('never exceeds the cap even when it is all failures', () => {
    let list: PrintLogEntry[] = []
    for (let i = 1; i <= 8; i++) list = pushEntry(list, e(i, false), 4, 10)
    expect(list.map((x) => x.seq)).toEqual([8, 7, 6, 5])
  })
})

describe('failed count', () => {
  it('counts failures and labels the chip', () => {
    expect(failedCount([{ seq: 1, at: 0, ok: false, time: '', text: '' }, { seq: 2, at: 0, ok: true, time: '', text: '' }])).toBe(1)
    expect(failedChipText(3)).toBe('3 failed')
  })
})

describe('Print last [F14] — the last ATTEMPTED sale label', () => {
  const sample = { itemNumber: '141', buyer: 'Sarah D.', code: SAMPLE_LABEL_CODE }

  it('the sample code is the labelCode of the designer sample sku', () => {
    expect(SAMPLE_LABEL_CODE).toBe(labelCode('1732451642461557731'))
  })

  it('ok #80 then FAILED #81 → Print last is #81 (the one with no label), not #80', () => {
    let last = nextPrintLast(undefined, { data: { itemNumber: '80', buyer: 'Jo' }, ok: true })
    last = nextPrintLast(last, { data: { itemNumber: '81', buyer: 'Ann' }, ok: false })
    expect(last).toEqual({ itemNumber: '81', buyer: 'Ann' })
    expect(printLastText(last)).toBe('Print last #81')
  })

  it('a failed first print is still held', () => {
    expect(nextPrintLast(undefined, { data: { itemNumber: '5' }, ok: false })).toEqual({ itemNumber: '5' })
  })

  it('a test/sample print never replaces it, ok or failed', () => {
    const real = { itemNumber: '81', buyer: 'Ann', code: 'SF1:T:999' }
    expect(nextPrintLast(real, { data: sample, ok: true })).toBe(real)
    expect(nextPrintLast(real, { data: sample, ok: false })).toBe(real)
    expect(nextPrintLast(undefined, { data: sample, ok: true })).toBeUndefined()
  })

  it('a sample with an edited title/buyer is still recognised by its code', () => {
    expect(isSampleLabel({ itemNumber: '81', buyer: 'Ann', code: SAMPLE_LABEL_CODE })).toBe(true)
    expect(isSampleLabel({ itemNumber: '141', buyer: 'Sarah D.' })).toBe(false)
    expect(isSampleLabel(undefined)).toBe(false)
  })

  it('holds a copy, not the caller\'s object', () => {
    const d = { itemNumber: '7' }
    const last = nextPrintLast(undefined, { data: d, ok: true })
    d.itemNumber = '8'
    expect(last?.itemNumber).toBe('7')
  })

  it('button text', () => {
    expect(printLastText(undefined)).toBe('Print last')
    expect(printLastText({ itemNumber: '' })).toBe('Print last')
    expect(printLastText({ itemNumber: '#81' })).toBe('Print last #81')
    expect(printLastText({ itemNumber: '1234567890' })).toBe('Print last #1234567…')
  })
})
