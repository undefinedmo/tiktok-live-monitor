// Extract representative real frontier WS frames from capture/session.ndjson
// into fixtures/ for unit tests. TEMP tool.
import { readFileSync, writeFileSync } from 'node:fs'

const recs = readFileSync(new URL('../capture/session.ndjson', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.tag === 'ws')

function readVarint(b, p) { let r = 0n, s = 0n, byte; do { byte = b[p++]; r |= BigInt(byte & 0x7f) << s; s += 7n } while (byte & 0x80 && p < b.length); return [r, p] }
function field8(b) {
  let p = 0
  while (p < b.length) {
    let tag; [tag, p] = readVarint(b, p)
    const f = Number(tag >> 3n), w = Number(tag & 7n)
    if (f === 0) break
    if (w === 0) { ;[, p] = readVarint(b, p) }
    else if (w === 2) { let len; [len, p] = readVarint(b, p); const L = Number(len); if (f === 8) return b.subarray(p, p + L); p += L }
    else if (w === 1) p += 8
    else if (w === 5) p += 4
    else break
  }
  return null
}

const want = { productStats: 'product_stats', coreStats: 'current_viewers', session: 'current_session', room: 'live_room_info' }
const out = {}
for (const rec of recs) {
  const b = Buffer.from(rec.b64, 'base64')
  const pl = field8(b)
  if (!pl) continue
  const json = pl.toString('utf8')
  for (const [key, marker] of Object.entries(want)) {
    if (!out[key] && json.includes(marker)) out[key] = { b64: rec.b64, bytes: rec.bytes, payload: JSON.parse(json) }
  }
}
// Two successive product_stats frames (for the sales-increment diff test)
const ps = []
for (const rec of recs) {
  const pl = field8(Buffer.from(rec.b64, 'base64'))
  if (pl && pl.toString('utf8').includes('product_stats')) ps.push(JSON.parse(pl.toString('utf8')))
}
out.productStatsSeries = ps.slice(0, 4)

writeFileSync(new URL('../fixtures/ws-frames.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('wrote fixtures/ws-frames.json with keys:', Object.keys(out).join(', '))
console.log('product_stats series sales:', ps.slice(0, 4).map((p) => Object.entries(p.product_stats).map(([id, v]) => `${id.slice(-4)}:${v.sales}`).join(' ')))
