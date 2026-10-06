// Dumps the full protobuf field tree of every WebcastOecLiveCreatorMessage whose
// tracking event matches a target (default auction.start / auction.new_bid), so the
// decoder layout can be pinned. Usage: node scripts/dump-creator-msg.mjs <har> [event]
import fs from 'node:fs'

const har = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const target = process.argv[3] || 'auction.start'

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
const isStr = (b, s, e) => {
  if (e - s < 1 || e - s > 400) return false
  for (let i = s; i < e; i++) { const c = b[i]; if (!((c >= 32 && c < 127) || c > 127)) return false }
  return true
}
const txt = (b, s, e) => Buffer.from(b.subarray(s, e)).toString('utf8')
function describe(b, start, end, depth, out, budget) {
  for (const f of fields(b, start, end)) {
    if (budget.n-- <= 0) return
    const pad = '  '.repeat(depth)
    if (f.wire === 0) out.push(`${pad}f${f.field} varint ${f.varint}`)
    else if (f.wire === 2) {
      if (isStr(b, f.s, f.e)) out.push(`${pad}f${f.field} str "${txt(b, f.s, f.e)}"`)
      else { out.push(`${pad}f${f.field} msg[${f.e - f.s}]`); if (depth < 7) describe(b, f.s, f.e, depth + 1, out, budget) }
    }
  }
}

const ims = har.log.entries.filter((e) => /webcast\/im\/fetch/.test(e.request.url))
let dumped = 0
for (const entry of ims) {
  const c = entry.response.content
  if (!c?.text) continue
  const body = c.encoding === 'base64' ? Buffer.from(c.text, 'base64') : Buffer.from(c.text, 'utf8')
  if (!body.includes(Buffer.from(target))) continue
  // walk top-level messages; for each Creator message, check its tracking event
  for (const top of fields(body, 0, body.length)) {
    if (top.wire !== 2) continue
    let method = '', payload = null
    for (const f of fields(body, top.s, top.e)) {
      if (f.field === 1 && f.wire === 2) method = txt(body, f.s, f.e)
      if (f.field === 2 && f.wire === 2) payload = f
    }
    if (method !== 'WebcastOecLiveCreatorMessage' || !payload) continue
    const pl = body.subarray(payload.s, payload.e)
    if (!pl.includes(Buffer.from(target))) continue
    console.log(`\n=== ${entry.startedDateTime} ${target} ===`)
    const out = []
    describe(body, payload.s, payload.e, 0, out, { n: 300 })
    console.log(out.join('\n'))
    if (++dumped >= 2) process.exit(0)
  }
}
console.log('done, dumped', dumped)
