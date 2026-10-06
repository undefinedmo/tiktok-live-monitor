// Decodes auction lifecycle events from the webcast/im/fetch protobuf stream — the
// SAME responses decodeChat already reads for comments (the preload polls it ~1/s).
//
// Why: the sale appears in auction_result/get only after a server-side
// auction.result_update, measured 6.0-7.6s after the gavel. The im stream carries
// the close ~0.3-1.2s after it, so this is the universal low-latency sale signal —
// unlike pin/get it fires for EVERY auction, pinned or not.
//
// Field layouts (pinned against a 2026-07-21 live HAR, shop.tiktok.com streamer dashboard):
//
//   WebcastOecLiveCreatorMessage payload — auction.end (winner, price; NO lot number):
//     f1 common { f1 method, f2 msg_id, f3 room_id, f4 ts }
//     f3 → f2 → f1 auction record:
//       f1 str  auction instance id (19-digit)   f2 varint status (1 running / 3 ended)
//       f3 varint end time (sec)                 f5 str winner nickname
//       f6 str  price numeric ("27")             f7 str price formatted ("$27.00")
//       f8 str  winner avatar url                f9 str end time (ms)
//     f4 tracking { f3 str event name ("auction.end" | "auction.new_bid" | "auction.start"
//                   | "auction.result_update"), repeated f4 { f1 key, f2 value } }
//     (for start/result_update the f3 record is empty — the tracking name discriminates)
//
//   WebcastOecLiveManagerMessage payload — fires on EVERY BID (current leader + price +
//   lot number, no order time) and once more at result_update WITH the order time
//   (~6s after the close). `orderCreateMs` present ⇔ the confirmed result; its absence
//   marks a bid update, which is how the caller tracks the lot currently being auctioned:
//     f1 common · f2 varint type (7 observed)
//     f11 result:
//       f1 user    { f1 uid, f3 nickname, f38 username }
//       f2 product { f1 title, f3 { f1 formatted price }, f4 product_id }
//       f3 variant { f1 lot number ("17", no '#'), f4 sku_id }
//       f5 varint order_create_time (ms) — CONFIRMED RESULTS ONLY · f6 varint result time
//
// Self-contained protobuf reader, same marker-scan heuristic as chat.ts. Portable.

export interface AuctionEndIm {
  type: 'end'
  auctionId: string // 19-digit auction instance id (dedupe key; NOT the roster's auction_config_id)
  winner: string
  price?: string
  endMs?: number
}

export interface AuctionResultIm {
  type: 'result'
  lotNumber?: string // "17" — no '#' prefix (pin/get's variant_desc carries it)
  winner: string // the current leader on bid updates; the actual winner on the confirmed result
  username?: string
  productName?: string
  price?: string
  productId?: string
  skuId?: string
  orderCreateMs?: number // PRESENT ⇔ confirmed result (printable); absent ⇔ bid update
}

export type AuctionImEvent = AuctionEndIm | AuctionResultIm

const utf8 = (b: Uint8Array, s: number, e: number) => new TextDecoder().decode(b.subarray(s, e))

function readVarint(b: Uint8Array, p: number): [number, number] {
  let result = 0
  let shift = 0
  let byte = 0
  do {
    byte = b[p++]!
    result += (byte & 0x7f) * 2 ** shift
    shift += 7
  } while ((byte & 0x80) !== 0 && p < b.length)
  return [result, p]
}

/** Iterate top-level protobuf fields, calling back with (field, wire, start, end). */
function fields(b: Uint8Array, start: number, end: number, cb: (field: number, wire: number, s: number, e: number) => void) {
  let p = start
  while (p < end) {
    let tag: number
    ;[tag, p] = readVarint(b, p)
    const field = tag >> 3
    const wire = tag & 7
    if (field === 0) break
    if (wire === 0) {
      ;[, p] = readVarint(b, p)
    } else if (wire === 2) {
      let len: number
      ;[len, p] = readVarint(b, p)
      const e = Math.min(p + len, end)
      cb(field, wire, p, e)
      p = e
    } else if (wire === 1) {
      p += 8
    } else if (wire === 5) {
      p += 4
    } else {
      break
    }
  }
}

/** First string value of `target` (wire-2) directly under [s,e); '' when absent. */
function strField(b: Uint8Array, s: number, e: number, target: number): string {
  let out = ''
  fields(b, s, e, (field, wire, fs, fe) => {
    if (field === target && wire === 2 && !out) out = utf8(b, fs, fe)
  })
  return out
}

/** First varint value of `target` (wire-0) directly under [s,e); undefined when absent.
 *  The walker above doesn't surface wire-0 values, so this re-scans (same pattern as
 *  chat.ts's varintField). */
function varintField(b: Uint8Array, start: number, end: number, target: number): number | undefined {
  let out: number | undefined
  let p = start
  while (p < end) {
    let tag: number
    ;[tag, p] = readVarint(b, p)
    const field = tag >> 3
    const wire = tag & 7
    if (field === 0) break
    if (wire === 0) {
      let v: number
      ;[v, p] = readVarint(b, p)
      if (field === target && out === undefined) out = v
    } else if (wire === 2) {
      let len: number
      ;[len, p] = readVarint(b, p)
      p = Math.min(p + len, end)
    } else if (wire === 1) p += 8
    else if (wire === 5) p += 4
    else break
  }
  return out
}

// ── Creator payload → auction.end ────────────────────────────────────────────
function parseCreator(b: Uint8Array, s: number, e: number): AuctionEndIm | null {
  let record: AuctionEndIm | null = null
  let eventName = ''
  fields(b, s, e, (field, wire, fs, fe) => {
    if (wire !== 2) return
    if (field === 3) {
      // f3 → f2 → f1 = auction record
      fields(b, fs, fe, (f2n, w2, s2, e2) => {
        if (f2n !== 2 || w2 !== 2) return
        fields(b, s2, e2, (f1n, w1, s1, e1) => {
          if (f1n !== 1 || w1 !== 2) return
          const winner = strField(b, s1, e1, 5)
          if (!winner) return
          record = {
            type: 'end',
            auctionId: strField(b, s1, e1, 1),
            winner,
            price: strField(b, s1, e1, 7) || undefined,
            endMs: Number(strField(b, s1, e1, 9)) || undefined,
          }
        })
      })
    } else if (field === 4 && !eventName) {
      eventName = strField(b, fs, fe, 3)
    }
  })
  // Only the close is actionable fast. new_bid/start carry nothing we need, and
  // result_update's record is empty (its data rides the paired Manager message).
  return eventName === 'auction.end' ? record : null
}

// ── Manager payload → result (lot number + product + order time) ─────────────
function parseManager(b: Uint8Array, s: number, e: number): AuctionResultIm | null {
  let out: AuctionResultIm | null = null
  fields(b, s, e, (field, wire, fs, fe) => {
    if (field !== 11 || wire !== 2 || out) return
    let winner = ''
    let username = ''
    let productName = ''
    let price = ''
    let productId = ''
    let lotNumber = ''
    let skuId = ''
    fields(b, fs, fe, (rf, rw, rs, re) => {
      if (rw !== 2) return
      if (rf === 1) {
        winner = strField(b, rs, re, 3)
        username = strField(b, rs, re, 38)
      } else if (rf === 2) {
        productName = strField(b, rs, re, 1)
        productId = strField(b, rs, re, 4)
        // price rides one level down: product.f3 = msg { f1 = "$27.00" }
        fields(b, rs, re, (pf, pw, ps, pe) => {
          if (pf === 3 && pw === 2 && !price) price = strField(b, ps, pe, 1)
        })
      } else if (rf === 3) {
        lotNumber = strField(b, rs, re, 1)
        skuId = strField(b, rs, re, 4)
      }
    })
    const orderCreateMs = varintField(b, fs, fe, 5)
    if (winner && (lotNumber || productName)) {
      out = {
        type: 'result',
        lotNumber: lotNumber || undefined,
        winner,
        username: username || undefined,
        productName: productName || undefined,
        price: price || undefined,
        productId: productId || undefined,
        skuId: skuId || undefined,
        orderCreateMs,
      }
    }
  })
  return out
}

/** Extract the raw payload bytes of every occurrence of `name` in a WebcastResponse
 *  (same marker heuristic as decodeAuctionIm: the method name immediately followed by
 *  tag 0x12 + varint length). Used to self-collect samples of message types we can't
 *  decode yet — e.g. WebcastOecLiveShoppingMessage, which replaced the Creator/Manager
 *  auction messages (census 2026-07-28: those two are extinct; Shopping ×12/show). */
export function extractMessagePayloads(b: Uint8Array, name: string): Uint8Array[] {
  const out: Uint8Array[] = []
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c >= 32 && c < 127) {
      cur += String.fromCharCode(c)
      continue
    }
    if (c === 0x12 && cur.endsWith(name)) {
      let q = i + 1
      let len: number
      ;[len, q] = readVarint(b, q)
      out.push(b.subarray(q, Math.min(q + len, b.length)))
    }
    cur = ''
  }
  return out
}

/** Find every auction lifecycle message in a WebcastResponse and decode it.
 *  Same frame-split heuristic as decodeChat: the method-name marker is immediately
 *  followed by tag 0x12 (field 2, the payload). The method string also appears inside
 *  the payload's common block, but there it's followed by 0x10 (varint msg_id), so
 *  the 0x12 check skips it. */
export function decodeAuctionIm(b: Uint8Array): AuctionImEvent[] {
  const out: AuctionImEvent[] = []
  let cur = ''
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!
    if (c >= 32 && c < 127) {
      cur += String.fromCharCode(c)
      continue
    }
    if (c === 0x12 && (cur === 'WebcastOecLiveCreatorMessage' || cur === 'WebcastOecLiveManagerMessage')) {
      let q = i + 1
      let len: number
      ;[len, q] = readVarint(b, q)
      const end = Math.min(q + len, b.length)
      const ev = cur === 'WebcastOecLiveCreatorMessage' ? parseCreator(b, q, end) : parseManager(b, q, end)
      if (ev) out.push(ev)
    }
    cur = ''
  }
  return out
}
