import { describe, expect, it } from 'vitest'
import { bulkRetryTargets, canRetry, retryAllLabel } from '../identifyRetry'

// Retry after an outage. A row can be retried when there is something to retry FROM: the sale in memory (the
// clip is cut again from the buffer) or a clip kept on disk (core/identifyKept). The bulk action takes every
// FAILED row that can be retried -- not skipped (nothing identifiable in it), not abandoned (the show ended
// before it was reached), not one still being identified, and not one an operator corrected by hand.
type Row = { orderId?: string; status: 'transcribing' | 'done' | 'error' | 'skipped' | 'abandoned'; sale?: object; atEpochSec?: number; edited?: boolean }
const row = (o: Partial<Row> = {}): Row => ({ orderId: 'o1', status: 'error', sale: {}, atEpochSec: 100, ...o })
const none = new Set<string>()

describe('canRetry', () => {
  it('is true with the sale in memory', () => {
    expect(canRetry(row(), none)).toBe(true)
  })
  it('is true with a clip kept on disk, even for a row restored without its sale', () => {
    expect(canRetry(row({ sale: undefined }), new Set(['o1']))).toBe(true)
  })
  it('is false with neither: there is no audio to retry from', () => {
    expect(canRetry(row({ sale: undefined }), none)).toBe(false)
    expect(canRetry(row({ sale: undefined }), new Set(['other']))).toBe(false)
  })
  it('is false for a row with no order id (a demo row), whatever else it has', () => {
    expect(canRetry(row({ orderId: undefined }), new Set(['o1']))).toBe(false)
    expect(canRetry(row({ orderId: '' }), none)).toBe(false)
  })
  it('is false while the row is still being identified', () => {
    expect(canRetry(row({ status: 'transcribing' }), none)).toBe(false)
  })
})

describe('bulkRetryTargets', () => {
  it('takes every failed row that can be retried', () => {
    const rows = [row({ orderId: 'a' }), row({ orderId: 'b', sale: undefined }), row({ orderId: 'c', sale: undefined })]
    expect(bulkRetryTargets(rows, new Set(['b'])).map((r) => r.orderId)).toEqual(['a', 'b'])
  })
  it('leaves out everything that is not a failure', () => {
    const rows = [
      row({ orderId: 'done', status: 'done' }),
      row({ orderId: 'skip', status: 'skipped' }),
      row({ orderId: 'gone', status: 'abandoned' }),
      row({ orderId: 'busy', status: 'transcribing' }),
      row({ orderId: 'bad', status: 'error' }),
    ]
    expect(bulkRetryTargets(rows, none).map((r) => r.orderId)).toEqual(['bad'])
  })
  it('does not retry a row an operator corrected by hand', () => {
    expect(bulkRetryTargets([row({ edited: true })], none)).toEqual([])
  })
  it('goes oldest sale first, so the lots come back in the order they were sold', () => {
    const rows = [row({ orderId: 'new', atEpochSec: 300 }), row({ orderId: 'old', atEpochSec: 100 }), row({ orderId: 'mid', atEpochSec: 200 })]
    expect(bulkRetryTargets(rows, none).map((r) => r.orderId)).toEqual(['old', 'mid', 'new'])
  })
  it('does not reorder or modify the list it was given', () => {
    const rows = [row({ orderId: 'new', atEpochSec: 300 }), row({ orderId: 'old', atEpochSec: 100 })]
    bulkRetryTargets(rows, none)
    expect(rows.map((r) => r.orderId)).toEqual(['new', 'old'])
  })
  it('is empty for no rows', () => {
    expect(bulkRetryTargets([], none)).toEqual([])
  })
  it('a row with no sale time sorts last rather than breaking the order', () => {
    const rows = [row({ orderId: 'none', atEpochSec: undefined }), row({ orderId: 'a', atEpochSec: 5 })]
    expect(bulkRetryTargets(rows, none).map((r) => r.orderId)).toEqual(['a', 'none'])
  })
})

describe('retryAllLabel', () => {
  it('says how many, and asks again before it spends them (every retry can cost a model call)', () => {
    expect(retryAllLabel(1, false)).toBe('Retry 1 failed')
    expect(retryAllLabel(27, false)).toBe('Retry 27 failed')
    expect(retryAllLabel(27, true)).toBe('Confirm: retry 27')
  })
})
