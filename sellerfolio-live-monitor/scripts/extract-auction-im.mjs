// Extracts webcast/im/fetch responses containing auction lifecycle markers from a HAR,
// and dumps the protobuf field layout around them so the decoder can be pinned down.
// Usage: node scripts/extract-auction-im.mjs <har-path>
import fs from 'node:fs'

const harPath = process.argv[2]
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'))

function bodyOf(entry) {
  const c = entry.response?.content
  if (!c?.text) return null
  return c.encoding === 'base64' ? Buffer.from(c.text, 'base64') : Buffer.from(c.text, 'utf8')
}

// --- minimal protobuf walker -------------------------------------------------
function readVarint(b, p) {
  let result = 0n, shift = 0n, byte = 0
  do { byte = b[p++]; result |= BigInt(byte & 0x7f) << shift; shift += 7n } while ((byte & 0x80) && p < b.length)
  return [result, p]
}
function* fields(b, start, end) {
  let p = start
  while (p < end) {
    let tag; [tag, p] = readVarint(b, p)
    const field = Number(tag >> 3n), wire = Number(tag & 7n)
    if (field === 0) return
    if (wire === 0) { let v; [v, p] = readVarint(b, p); yield { field, wire, varint: v } }
    else if (wire === 2) { let len; [len, p] = readVarint(b, p); const e = Math.min(p + Number(len), end); yield { field, wire, s: p, e }; p = e }
    else if (wire === 1) { p += 8 } else if (wire === 5) { p += 4 } else return
  }
}
const isStr = (b, s, e) => { // printable-utf8 heuristic
  if (e - s < 1 || e - s > 400) return false
  let ok = 0
  for (let i = s; i < e; i++) { const c = b[i]; if ((c >= 32 && c < 127) || c > 127) ok++; else return false }
  return ok === e - s
}
const txt = (b, s, e) => Buffer.from(b.subarray(s, e)).toString('utf8')

function describe(b, start, end, depth, out, budget) {
  for (const f of fields(b, start, end)) {
    if (budget.n-- <= 0) return
    const pad = '  '.repeat(depth)
    if (f.wire === 0) out.push(`${pad}f${f.field} varint ${f.varint}`)
    else if (f.wire === 2) {
      if (isStr(b, f.s, f.e)) out.push(`${pad}f${f.field} str "${txt(b, f.s, f.e)}"`)
      else {
        out.push(`${pad}f${f.field} msg[${f.e - f.s}]`)
        if (depth < 6) describe(b, f.s, f.e, depth + 1, out, budget)
      }
    }
  }
}

// --- scan im/fetch responses for auction markers ------------------------------
const MARKERS = ['auction.end', 'auction.result_update', 'end_auction', 'auction_result_update']
const entries = har.log.entries.filter((e) => /webcast\/im\/fetch/.test(e.request.url))
let dumped = 0
for (const entry of entries) {
  const body = bodyOf(entry)
  if (!body) continue
  const ascii = body.toString('latin1')
  const hit = MARKERS.find((m) => ascii.includes(m))
  if (!hit) continue
  const t = entry.startedDateTime
  console.log(`\n=== ${t}  (${body.length} bytes) marker=${hit} ===`)
  // The WebcastResponse wraps messages as { method: "Webcast...", payload: bytes }.
  // Find each marker string, then dump the enclosing message's fields.
  for (const m of MARKERS) {
    let idx = ascii.indexOf(m)
    while (idx !== -1) {
      console.log(`--- marker "${m}" @${idx}`)
      idx = ascii.indexOf(m, idx + 1)
    }
  }
  if (dumped < 4) {
    dumped++
    const out = []
    describe(body, 0, body.length, 0, out, { n: 400 })
    console.log(out.join('\n'))
  }
}
console.log('\ndone')
