// Replays the captured real frontier session (capture/session.ndjson) through
// the EXACT decode path main.ts uses, proving the fix end-to-end on real data.
// Build: esbuild scripts/replay.ts --bundle --platform=node --outfile=dist/replay.cjs
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { parsePushFrame } from '../src/core/pushFrame'
import { LiveFeed } from '../src/core/liveFeed'
import type { LiveEvent } from '../src/core/types'

const recs = readFileSync('capture/session.ndjson', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { tag: string; b64?: string })

const feed = new LiveFeed()
let frames = 0
let sales = 0
let derivedSold = 0
let coreSold: number | null = null
let gmv = ''
let ts = 1_000

function handle(ev: LiveEvent) {
  if (ev.kind === 'sale') {
    sales++
    console.log(`  SALE …${ev.productId.slice(-6)}  +${ev.delta}  (total ${ev.totalForProduct})`)
  } else if (ev.kind === 'product_stats') derivedSold = ev.totalSold
  else if (ev.kind === 'core_stats') {
    if (ev.sales !== undefined) coreSold = ev.sales
    if (ev.gmv) gmv = ev.gmv.formatted
  }
}

for (const rec of recs) {
  if (rec.tag !== 'ws' || !rec.b64) continue
  const frame = parsePushFrame(Uint8Array.from(Buffer.from(rec.b64, 'base64')))
  if (!frame) continue
  let buf = Buffer.from(frame.payload)
  if (frame.payloadEncoding === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    try { buf = gunzipSync(buf) } catch { continue }
  }
  let payload: unknown
  try { payload = JSON.parse(buf.toString('utf8')) } catch { continue }
  frames++
  for (const ev of feed.ingest(payload, (ts += 1000))) handle(ev)
}

console.log('\n=== replay summary ===')
console.log('JSON frames decoded :', frames)
console.log('sale events derived :', sales)
console.log('derived sold (sum)  :', derivedSold)
console.log('dashboard sold      :', coreSold)
console.log('GMV                 :', gmv)
console.log('validation          :', coreSold === null ? 'n/a' : derivedSold === coreSold ? 'MATCH ✓' : `MISMATCH Δ${derivedSold - coreSold}`)
