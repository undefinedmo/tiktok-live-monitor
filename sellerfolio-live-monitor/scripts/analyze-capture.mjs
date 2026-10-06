// Offline analysis of capture/session.ndjson — decode frontier PushFrame
// envelopes and summarize XHR/fetch bodies. TEMP diagnostic tool.
import { readFileSync } from 'node:fs'
import { gunzipSync, inflateSync } from 'node:zlib'

const lines = readFileSync(new URL('../capture/session.ndjson', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))

function readVarint(b, p) {
  let r = 0n, s = 0n, byte
  do { byte = b[p++]; r |= BigInt(byte & 0x7f) << s; s += 7n } while (byte & 0x80 && p < b.length)
  return [r, p]
}
// Walk one protobuf level; return {fieldNum: [ {wire, raw|num} ]}
function walk(b, start = 0, end = b.length) {
  const out = {}
  let p = start
  while (p < end) {
    let tag; [tag, p] = readVarint(b, p)
    const f = Number(tag >> 3n), w = Number(tag & 7n)
    if (f === 0) break
    let val
    if (w === 0) { [val, p] = readVarint(b, p); val = { num: val } }
    else if (w === 2) { let len; [len, p] = readVarint(b, p); const L = Number(len); val = { raw: b.subarray(p, p + L) }; p += L }
    else if (w === 1) { val = { raw: b.subarray(p, p + 8) }; p += 8 }
    else if (w === 5) { val = { raw: b.subarray(p, p + 4) }; p += 4 }
    else break
    ;(out[f] ??= []).push(val)
  }
  return out
}
const ascii = (b) => { let s = ''; for (const c of b) s += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; return s }

console.log('=== WS PushFrame analysis ===')
const methodCounts = {}
for (const rec of lines.filter((r) => r.tag === 'ws')) {
  const b = Buffer.from(rec.b64, 'base64')
  const top = walk(b)
  // PushFrame: 1=seqId 2=logId 4=method? 5=headers 6=payloadEncoding 7=payloadType 8=payload
  const headers = (top[5] ?? []).map((h) => { const kv = walk(h.raw); return [kv[1]?.[0]?.raw ? ascii(kv[1][0].raw) : '', kv[2]?.[0]?.raw ? ascii(kv[2][0].raw) : ''] })
  const enc = top[6]?.[0]?.raw ? ascii(top[6][0].raw) : ''
  const ptype = top[7]?.[0]?.raw ? ascii(top[7][0].raw) : ''
  let payload = top[8]?.[0]?.raw
  let decoded = ''
  if (payload) {
    let buf = Buffer.from(payload)
    if (buf[0] === 0x1f && buf[1] === 0x8b) { try { buf = gunzipSync(buf) } catch {} }
    else if (enc === 'gzip') { try { buf = gunzipSync(buf) } catch { try { buf = inflateSync(buf) } catch {} } }
    decoded = ascii(buf).replace(/\.{2,}/g, '.')
  }
  // pull WebcastXxxMessage method names out of the payload ascii
  const methods = [...decoded.matchAll(/Webcast[A-Za-z]+Message/g)].map((m) => m[0])
  for (const m of methods) methodCounts[m] = (methodCounts[m] ?? 0) + 1
  const tags = headers.map((h) => h[0]).filter(Boolean).join(',')
  console.log(`#${rec.seq} bytes=${rec.bytes} ptype=${ptype || '-'} enc=${enc || '-'} hdr=[${tags}]`)
  if (decoded) console.log(`    payload: ${decoded.slice(0, 360)}`)
}
console.log('\nmethod names seen in WS payloads:', JSON.stringify(methodCounts))

console.log('\n=== XHR/fetch captured bodies ===')
for (const rec of lines.filter((r) => r.tag === 'xhr' || r.tag === 'fetch')) {
  let host = rec.url
  try { const u = new URL(rec.url); host = u.host + u.pathname } catch {}
  let pretty = rec.body.slice(0, 500)
  try { const j = JSON.parse(rec.body); pretty = JSON.stringify(j).slice(0, 500) } catch {}
  console.log(`[${rec.tag}] ${host} len=${rec.body.length}`)
  console.log(`    ${pretty}`)
}
