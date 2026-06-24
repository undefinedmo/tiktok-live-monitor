import { describe, it, expect } from 'vitest'
import { parseGenerateCapture } from '../capture'

const REQ = JSON.stringify({
  op_scene: 2,
  fulfill_unit_id_list: ['1156730386024534712', '1156716186041946310', '1156716231897944200'],
  content_type_list: [1],
})
const RESP = JSON.stringify({
  code: 0,
  data: {
    doc_url: 'https://seller-us.tiktok.com/wsos_v2/oec_fulfillment_doc_tts/object/wsosABC?expire=1&skipCookie=true&sign=x',
    stats: [
      { order_id: '1156730386024534712' },
      { order_id: '1156716186041946310' },
      { order_id: '1156716231897944200' },
    ],
  },
})

describe('parseGenerateCapture', () => {
  it('extracts the ordered unit list, doc_url, and stats unit ids', () => {
    const c = parseGenerateCapture(REQ, RESP)
    expect(c.fulfillUnitIds).toEqual(['1156730386024534712', '1156716186041946310', '1156716231897944200'])
    expect(c.docUrl).toContain('/wsos_v2/')
    expect(c.statsUnitIds).toEqual(c.fulfillUnitIds) // stats order_id === fulfill_unit_id
  })

  it('degrades safely on malformed input', () => {
    const c = parseGenerateCapture('not json', '{}')
    expect(c.fulfillUnitIds).toEqual([])
    expect(c.docUrl).toBeNull()
    expect(c.statsUnitIds).toEqual([])
  })
})
