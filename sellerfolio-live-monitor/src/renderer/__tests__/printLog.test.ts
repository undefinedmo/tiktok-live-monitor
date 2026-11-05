import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { _resetPrintLogForTests, onPrintLastChange, onPrintResult, printLastLabel } from '../printLog'
import { isSampleLabel } from '../../core/printLogFormat'
import type { LabelData } from '../../electron/label'

// designer.ts reads localStorage at module load; the app's tests run in node.
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

let sampleLabelData: () => LabelData
beforeAll(async () => { ({ sampleLabelData } = await import('../designer')) })

const result = (data: LabelData, ok: boolean) => ({ data, ok, at: Date.now(), ...(ok ? { spoolMs: 40 } : { error: 'Printer offline' }) })

describe('printLog → Print last [F14]', () => {
  beforeEach(() => _resetPrintLogForTests())

  it('holds nothing before the first print', () => {
    expect(printLastLabel()).toBeUndefined()
  })

  it('#80 prints, #81 FAILS → F14 reprints #81, not a second #80', () => {
    onPrintResult(result({ itemNumber: '80', buyer: 'Jo' }, true))
    onPrintResult(result({ itemNumber: '81', buyer: 'Ann' }, false))
    expect(printLastLabel()).toMatchObject({ itemNumber: '81', buyer: 'Ann' })
  })

  it('the designer / Settings test tag (sampleLabelData) is ignored mid-show', () => {
    onPrintResult(result({ itemNumber: '81', buyer: 'Ann' }, false))
    onPrintResult(result(sampleLabelData(), true))
    expect(printLastLabel()).toMatchObject({ itemNumber: '81', buyer: 'Ann' })
  })

  it('designer.ts sampleLabelData() carries SAMPLE_LABEL_CODE (drift guard)', () => {
    expect(isSampleLabel(sampleLabelData())).toBe(true)
  })

  it('tells the button when the label changes, and not for a test tag', () => {
    const seen: (string | undefined)[] = []
    onPrintLastChange((d) => seen.push(d?.itemNumber))
    onPrintResult(result({ itemNumber: '80' }, true))
    onPrintResult(result(sampleLabelData(), true))
    onPrintResult(result({ itemNumber: '81' }, false))
    expect(seen).toEqual(['80', '81'])
  })

  it('hands out copies', () => {
    onPrintResult(result({ itemNumber: '80' }, true))
    const a = printLastLabel()!
    a.itemNumber = '999'
    expect(printLastLabel()?.itemNumber).toBe('80')
  })
})
