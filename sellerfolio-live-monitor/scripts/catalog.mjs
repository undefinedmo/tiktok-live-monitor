// Builds a complete field inventory of the frontier WebSocket from a raw
// capture (capture/ws-raw.ndjson, written by main.ts when TT_CAPTURE=1).
// Decodes every PushFrame -> JSON and enumerates: sockets, payloadTypes,
// distinct payload shapes (by top-level key set), and the full union of every
// nested key-path with a sample value + frequency. Output -> capture/catalog.md
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'

const recs = readFileSync('capture/ws-raw.ndjson', 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))

function readVarint(b, p) { let r = 0n, s = 0n, byte; do { byte = b[p++]; r |= BigInt(byte & 0x7f) << s; s += 7n } while (byte & 0x80 && p < b.length); return [r, p] }
function parseFrame(b) {
  let p = 0, payload, ptype, penc
  while (p < b.length) {
    let tag; [tag, p] = readVarint(b, p)
    const f = Number(tag >> 3n), w = Number(tag & 7n)
    if (f === 0) break
    if (w === 0) { ;[, p] = readVarint(b, p) }
    else if (w === 2) { let len; [len, p] = readVarint(b, p); const L = Number(len); const e = Math.min(p + L, b.length); if (f === 6) penc = b.subarray(p, e).toString('utf8'); else if (f === 7) ptype = b.subarray(p, e).toString('utf8'); else if (f === 8) payload = b.subarray(p, e); p = e }
    else if (w === 1) p += 8
    else if (w === 5) p += 4
    else break
  }
  return { payload, ptype, penc }
}
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname } catch { return u } }
const sampleVal = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + '…' : s }

const paths = new Map() // path -> {count, type, sample}
const shapes = new Map() // top-level key signature -> {count, example}
const sockets = new Map() // host+path -> count
const ptypes = new Map() // payloadType -> count
let jsonFrames = 0, nonJson = 0, textFrames = 0

function record(path, type, sample) {
  const e = paths.get(path)
  if (e) { e.count++; if (e.sample === undefined && sample !== undefined) e.sample = sampleVal(sample) }
  else paths.set(path, { count: 1, type, sample: sample === undefined ? undefined : sampleVal(sample) })
}
function flatten(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) { record(path, 'object'); flatten(v, path) }
    else if (Array.isArray(v)) {
      record(path, 'array', `[len ${v.length}]`)
      const el = v[0]
      if (el && typeof el === 'object' && !Array.isArray(el)) flatten(el, path + '[]')
      else if (el !== undefined) record(path + '[]', typeof el, el)
    } else record(path, v === null ? 'null' : typeof v, v)
  }
}

for (const rec of recs) {
  sockets.set(hostPath(rec.url ?? ''), (sockets.get(hostPath(rec.url ?? '')) ?? 0) + 1)
  if (rec.kind === 'text') { textFrames++; continue }
  const b = Buffer.from(rec.b64, 'base64')
  const { payload, ptype, penc } = parseFrame(b)
  if (ptype) ptypes.set(ptype, (ptypes.get(ptype) ?? 0) + 1)
  if (!payload) { nonJson++; continue }
  let buf = Buffer.from(payload)
  if (penc === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) { try { buf = gunzipSync(buf) } catch { try { buf = inflateSync(buf) } catch { nonJson++; continue } } }
  let obj
  try { obj = JSON.parse(buf.toString('utf8')) } catch { nonJson++; continue }
  if (!obj || typeof obj !== 'object') { nonJson++; continue }
  jsonFrames++
  const sig = Object.keys(obj).sort().join(', ')
  const sh = shapes.get(sig)
  if (sh) sh.count++
  else shapes.set(sig, { count: 1, example: JSON.stringify(obj) })
  flatten(obj, '')
}

const md = []
md.push('# Frontier WebSocket — full data-point catalog\n')
md.push(`Frames: ${recs.length} total · ${jsonFrames} JSON · ${textFrames} text · ${nonJson} non-JSON/binary\n`)
md.push('## Sockets')
for (const [u, c] of [...sockets].sort((a, b) => b[1] - a[1])) md.push(`- \`${u}\` — ${c} frames`)
md.push('\n## payloadType (PushFrame field 7)')
md.push(ptypes.size ? [...ptypes].map(([t, c]) => `- \`${t || '(empty)'}\` — ${c}`).join('\n') : '- (none set)')
md.push('\n## Distinct payload shapes (by top-level keys)')
for (const [sig, { count, example }] of [...shapes].sort((a, b) => b[1].count - a[1].count)) {
  md.push(`\n### { ${sig} } — ${count}×`)
  md.push('```json\n' + (example.length > 1400 ? example.slice(0, 1400) + '…' : example) + '\n```')
}
md.push('\n## Every field (union of all key-paths)\n')
md.push('| path | type | count | sample |')
md.push('|---|---|---|---|')
for (const [path, { type, count, sample }] of [...paths].sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`| \`${path}\` | ${type} | ${count} | ${sample === undefined ? '' : '`' + String(sample).replace(/\|/g, '\\|') + '`'} |`)
}

writeFileSync('capture/catalog.md', md.join('\n'))
console.log(`cataloged ${jsonFrames} JSON frames → ${paths.size} distinct fields, ${shapes.size} payload shapes`)
console.log('sockets:', [...sockets.keys()].join(' | '))
console.log('payload shapes:', [...shapes.keys()].map((s) => `{${s}}`).join('  '))
console.log('wrote capture/catalog.md')
