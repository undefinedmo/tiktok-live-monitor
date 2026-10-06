// Inventories captured REST responses (capture/rest.ndjson) to find the
// per-buyer / per-order / per-auction data the stats socket lacks. Groups by
// endpoint, shows response shape, and flags endpoints whose bodies contain
// buyer/order/auction-shaped fields. Output -> capture/rest-catalog.md
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

if (!existsSync('capture/rest.ndjson')) { console.log('no capture/rest.ndjson yet — run the app with TT_CAPTURE=1 and open the Orders/Activity panels'); process.exit(0) }
const recs = readFileSync('capture/rest.ndjson', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const HOT = /username|buyer|customer|order_id|order_no|auction|win_|winner|bid|sku|product_name|item_name|paid|payment|recipient|nickname|avatar/i
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname } catch { return u } }

function keysOf(obj, prefix = '', out = new Set(), depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    out.add(path)
    if (Array.isArray(v)) { if (v[0] && typeof v[0] === 'object') keysOf(v[0], path + '[]', out, depth + 1) }
    else if (v && typeof v === 'object') keysOf(v, path, out, depth + 1)
  }
  return out
}

const groups = new Map()
for (const r of recs) {
  const key = `${r.method} ${hostPath(r.url)}`
  let g = groups.get(key)
  if (!g) { g = { count: 0, statuses: new Set(), keys: new Set(), sample: '', hot: false, hotKeys: new Set() }; groups.set(key, g) }
  g.count++
  g.statuses.add(r.status)
  if (HOT.test(r.body)) g.hot = true
  let obj
  try { obj = JSON.parse(r.body) } catch {}
  if (obj) {
    for (const k of keysOf(obj)) { g.keys.add(k); if (HOT.test(k)) g.hotKeys.add(k) }
    if (!g.sample || (obj && JSON.stringify(obj).length > g.sample.length && g.hot)) g.sample = JSON.stringify(obj)
  } else if (!g.sample) g.sample = r.body
}

const sorted = [...groups].sort((a, b) => (b[1].hot - a[1].hot) || b[1].hotKeys.size - a[1].hotKeys.size)
const md = ['# REST endpoint catalog (hunting buyer/order/auction data)\n', `${recs.length} captured responses across ${groups.size} endpoints.\n`]
md.push('## Endpoints (⭐ = contains buyer/order/auction-shaped fields)\n')
for (const [key, g] of sorted) {
  md.push(`### ${g.hot ? '⭐ ' : ''}\`${key}\`  (${g.count}× · status ${[...g.statuses].join(',')})`)
  if (g.hotKeys.size) md.push(`**hot fields:** ${[...g.hotKeys].slice(0, 40).map((k) => '`' + k + '`').join(', ')}`)
  const allKeys = [...g.keys].sort()
  md.push(`<details><summary>${allKeys.length} keys</summary>\n\n${allKeys.map((k) => '- `' + k + '`').join('\n')}\n</details>`)
  if (g.hot && g.sample) md.push('```json\n' + (g.sample.length > 2000 ? g.sample.slice(0, 2000) + '…' : g.sample) + '\n```')
  md.push('')
}
writeFileSync('capture/rest-catalog.md', md.join('\n'))
console.log(`cataloged ${recs.length} responses → ${groups.size} endpoints`)
console.log('endpoints with buyer/order/auction data:')
for (const [key, g] of sorted) if (g.hot) console.log(`  ⭐ ${key}  [${[...g.hotKeys].slice(0, 12).join(', ')}]`)
console.log('all endpoints:')
for (const [key, g] of sorted) if (!g.hot) console.log(`     ${key}`)
console.log('wrote capture/rest-catalog.md')
