import { describe, it, expect } from 'vitest'
import { decodeAuctionIm } from '../auctionIm'
import { tag, vField, sField, mField, bytes } from './pbEncode'

// Builders mirror the live-HAR layout documented in auctionIm.ts.

// pbEncode.varint is 32-bit (n >>> 0); ms epochs need 41 bits, so encode those here.
function varint64(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80) }
  out.push(v)
  return out
}
const vField64 = (field: number, value: number): number[] => [...tag(field, 0), ...varint64(value)]

/** WebcastOecLiveCreatorMessage with tracking event `event` and an auction record. */
function creatorMsg(event: string, rec: { id: string; status: number; winner: string; priceNum: string; priceFmt: string; endMs: string } | null): number[] {
  const record = rec
    ? mField(3, mField(2, mField(1, [
        ...sField(1, rec.id),
        ...vField(2, rec.status),
        ...vField(3, 1784664042),
        ...sField(5, rec.winner),
        ...sField(6, rec.priceNum),
        ...sField(7, rec.priceFmt),
        ...sField(8, 'https://avatar.example/x.jpeg'),
        ...sField(9, rec.endMs),
      ])))
    : mField(3, [])
  const tracking = mField(4, [
    ...vField(1, 1784664042351000000 % 2 ** 31), // walker only needs field shape
    ...sField(3, event),
    ...mField(4, [...sField(1, 'action_type'), ...sField(2, 'end_auction')]),
  ])
  const payload = [
    ...mField(1, [...sField(1, 'WebcastOecLiveCreatorMessage'), ...vField(2, 123), ...vField(3, 456), ...vField(4, 789)]),
    ...record,
    ...tracking,
  ]
  return [...sField(1, 'WebcastOecLiveCreatorMessage'), ...mField(2, payload)]
}

/** WebcastOecLiveManagerMessage — the result_update companion with the lot number. */
function managerMsg(r: { nickname: string; username: string; title: string; price: string; productId: string; lot: string; skuId: string; orderCreateMs: number }): number[] {
  const result = mField(11, [
    ...mField(1, [...vField(1, 7066048659), ...sField(3, r.nickname), ...sField(38, r.username)]),
    ...mField(2, [...sField(1, r.title), ...mField(3, sField(1, r.price)), ...sField(4, r.productId)]),
    ...mField(3, [...sField(1, r.lot), ...sField(4, r.skuId)]),
    ...vField64(5, r.orderCreateMs),
  ])
  const payload = [
    ...mField(1, [...sField(1, 'WebcastOecLiveManagerMessage'), ...vField(2, 123), ...vField(3, 456)]),
    ...vField(2, 7),
    ...result,
  ]
  return [...sField(1, 'WebcastOecLiveManagerMessage'), ...mField(2, payload)]
}

/** WebcastResponse envelope: repeated f1 { f1 method, f2 payload } + cursor/ext. */
function response(...msgs: number[][]): Uint8Array {
  return bytes(
    ...msgs.map((m) => mField(1, m)),
    sField(2, 'cursor-abc'),
    sField(5, 'fetch_time:1|next_cursor:x'),
  )
}

describe('decodeAuctionIm', () => {
  it('decodes an auction.end (winner + price + auction id, no lot number)', () => {
    const buf = response(creatorMsg('auction.end', {
      id: '8657621665243042570', status: 3, winner: 'Elizabeth', priceNum: '27', priceFmt: '$27.00', endMs: '1784664042251',
    }))
    const evs = decodeAuctionIm(buf)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toEqual({
      type: 'end',
      auctionId: '8657621665243042570',
      winner: 'Elizabeth',
      price: '$27.00',
      endMs: 1784664042251,
    })
  })

  it('ignores new_bid / start / result_update Creator messages (not actionable)', () => {
    const rec = { id: '8657621665243042570', status: 1, winner: 'lizarcia13', priceNum: '0', priceFmt: '$4.00', endMs: '1784664011306' }
    const buf = response(
      creatorMsg('auction.new_bid', rec),
      creatorMsg('auction.start', null),
      creatorMsg('auction.result_update', null),
    )
    expect(decodeAuctionIm(buf)).toHaveLength(0)
  })

  it('decodes the Manager result message (lot number, product, username, order time)', () => {
    const buf = response(managerMsg({
      nickname: 'Elizabeth', username: 'elizabeth_040206',
      title: 'Premium Denim - Final SALE NO CANCELS', price: '$27.00',
      productId: '1732504228699149283', lot: '17', skuId: '1732504232851903459',
      orderCreateMs: 1784664043222,
    }))
    const evs = decodeAuctionIm(buf)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toEqual({
      type: 'result',
      lotNumber: '17',
      winner: 'Elizabeth',
      username: 'elizabeth_040206',
      productName: 'Premium Denim - Final SALE NO CANCELS',
      price: '$27.00',
      productId: '1732504228699149283',
      skuId: '1732504232851903459',
      orderCreateMs: 1784664043222,
    })
  })

  it('decodes both event kinds from one mixed response', () => {
    const buf = response(
      creatorMsg('auction.end', { id: '86', status: 3, winner: 'Monique_DMD', priceNum: '11', priceFmt: '$11.00', endMs: '1784664091138' }),
      managerMsg({ nickname: 'Monique_DMD', username: 'moniquelugo5', title: 'T', price: '$11.00', productId: '1', lot: '18', skuId: '2', orderCreateMs: 1784664091000 }),
    )
    const evs = decodeAuctionIm(buf)
    expect(evs.map((e) => e.type)).toEqual(['end', 'result'])
  })

  it('survives garbage / truncated buffers', () => {
    expect(decodeAuctionIm(new Uint8Array([]))).toEqual([])
    expect(decodeAuctionIm(new Uint8Array([0x0a, 0xff, 0x00, 0x12, 0x03]))).toEqual([])
    // method marker with a payload cut short mid-record must not throw
    const buf = response(creatorMsg('auction.end', { id: '86', status: 3, winner: 'E', priceNum: '1', priceFmt: '$1.00', endMs: '1' }))
    expect(() => decodeAuctionIm(buf.subarray(0, buf.length - 7))).not.toThrow()
  })
})
