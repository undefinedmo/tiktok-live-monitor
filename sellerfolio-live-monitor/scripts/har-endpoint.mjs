// Dumps the full response body + field inventory for HAR entries whose URL
// matches a substring. Usage: node scripts/har-endpoint.mjs <urlSubstring> [harPath]
import { readFileSync } from 'node:fs'

const match = process.argv[2] || 'added_auction_product/list'
const harPath = process.argv[3] || 'C:/Users/hammo/Downloads/shop.tiktok.com-v2.har'
const entries = JSON.parse(readFileSync(harPath, 'utf8')).log?.entries ?? []

function bodyOf(e) {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('utf8') } catch { /* ignore */ } }
  return t
}

function keyPaths(obj, prefix = '', out = new Map(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (Array.isArray(v)) {
      if (!out.has(path)) out.set(path, `array[${v.length}]`)
      if (v[0] && typeof v[0] === 'object') keyPaths(v[0], path + '[]', out, depth + 1)
      else if (v[0] !== undefined && !out.has(path + '[]')) out.set(path + '[]', JSON.stringify(v[0]))
    } else if (v && typeof v === 'object') {
      if (!out.has(path)) out.set(path, 'object')
      keyPaths(v, path, out, depth + 1)
    } else if (!out.has(path)) out.set(path, typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v))
  }
  return out
}

const hits = entries.filter((e) => (e.request?.url ?? '').includes(match))
console.log(`${hits.length} entries match "${match}"\n`)
let shown = 0
for (const e of hits) {
  const body = bodyOf(e)
  let obj
  try { obj = JSON.parse(body) } catch { continue }
  // pick the entry with the most data
  const paths = keyPaths(obj)
  if (shown === 0 || paths.size > 5) {
    console.log('=== ' + (e.request?.url ?? '').split('?')[0] + ' (status ' + e.response?.status + ', ' + body.length + ' bytes) ===')
    console.log('--- field inventory ---')
    for (const [p, sample] of [...paths].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${p} = ${sample}`)
    console.log('\n--- full body (pretty, first 6000 chars) ---')
    console.log(JSON.stringify(obj, null, 2).slice(0, 6000))
    console.log('\n')
    shown++
    if (shown >= 1) break
  }
}
