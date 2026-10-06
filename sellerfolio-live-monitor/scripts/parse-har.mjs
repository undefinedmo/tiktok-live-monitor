// Parses a HAR export of the TikTok Shop live manager to enumerate ALL
// endpoints + sockets and locate the per-product-name / buyer / order / auction
// data the stats socket lacks. Usage: node scripts/parse-har.mjs <path-to.har>
import { readFileSync, writeFileSync } from 'node:fs'

const harPath = process.argv[2] || 'C:/Users/hammo/Downloads/shop.tiktok.com-v2.har'
const har = JSON.parse(readFileSync(harPath, 'utf8'))
const entries = har.log?.entries ?? []

// HAR stores some response bodies base64-encoded; decode so we can see through them.
function bodyOf(e) {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('utf8') } catch { /* ignore */ } }
  return t
}

const CAT = {
  product: /product_name|product_title|"title"|item_name|"name"\s*:/i,
  buyer: /win_username|"username"|buyer_user|"nickname"|"user_name"|customer/i,
  order: /order_id|order_no|order_status|sub_order|"order"/i,
  auction: /auction_id|"bid"|num_of_bids|win_username|winner|bidding|auction_config_id/i,
}
const SKIP = /\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ico|mp4|m3u8|ts)(\?|$)/i
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname } catch { return (u || '').split('?')[0] } }

const sockets = new Map() // url -> {msgs, sample}
const endpoints = new Map() // method host+path -> {count, statuses, cats:Set, sampleHot, mime}

for (const e of entries) {
  const url = e.request?.url ?? ''
  const method = e.request?.method ?? 'GET'
  // WebSocket entries
  if (url.startsWith('ws://') || url.startsWith('wss://') || e._resourceType === 'websocket' || e._webSocketMessages) {
    const s = sockets.get(hostPath(url)) ?? { fullUrl: url, msgs: 0, sample: '' }
    const msgs = e._webSocketMessages ?? []
    s.msgs += msgs.length
    if (!s.sample && msgs.length) { const m = msgs.find((x) => x.data); if (m) s.sample = String(m.data).slice(0, 80) }
    sockets.set(hostPath(url), s)
    continue
  }
  if (SKIP.test(url)) continue
  const body = bodyOf(e)
  const mime = e.response?.content?.mimeType ?? ''
  if (!/json|text|javascript/.test(mime) && !body) { /* still record */ }
  const key = `${method} ${hostPath(url)}`
  const g = endpoints.get(key) ?? { count: 0, statuses: new Set(), cats: new Set(), hotBody: '', mime }
  g.count++
  g.statuses.add(e.response?.status ?? 0)
  for (const [cat, re] of Object.entries(CAT)) {
    if (re.test(body)) { g.cats.add(cat); if (!g.hotBody && (cat === 'product' || cat === 'order' || cat === 'auction' || cat === 'buyer')) g.hotBody = body }
  }
  endpoints.set(key, g)
}

// Build markdown
const md = ['# TikTok live manager — HAR endpoint + socket catalog\n', `Source: ${harPath}\nEntries: ${entries.length}\n`]

md.push('## WebSockets')
if (sockets.size === 0) md.push('- (no websocket entries in HAR — HAR may omit WS frames)')
for (const [hp, s] of sockets) md.push(`- \`${hp}\` — ${s.msgs} messages\n  - full: \`${s.fullUrl.slice(0, 160)}\``)

const byCat = (cat) => [...endpoints].filter(([, g]) => g.cats.has(cat)).sort((a, b) => b[1].count - a[1].count)
for (const cat of ['product', 'buyer', 'order', 'auction']) {
  md.push(`\n## Endpoints carrying ${cat.toUpperCase()} data`)
  const list = byCat(cat)
  if (!list.length) { md.push('- (none found)'); continue }
  for (const [key, g] of list) {
    md.push(`\n### \`${key}\` (${g.count}× · status ${[...g.statuses].join(',')} · cats: ${[...g.cats].join(',')})`)
    if (g.hotBody) {
      let pretty = g.hotBody
      try { pretty = JSON.stringify(JSON.parse(g.hotBody)) } catch {}
      md.push('```json\n' + pretty.slice(0, 1800) + (pretty.length > 1800 ? '…' : '') + '\n```')
    }
  }
}

md.push('\n## All API endpoints (excluding static assets)')
for (const [key, g] of [...endpoints].sort((a, b) => a[0].localeCompare(b[0]))) {
  md.push(`- \`${key}\` — ${g.count}× ${g.cats.size ? '⭐ [' + [...g.cats].join(',') + ']' : ''}`)
}

writeFileSync('capture/har-catalog.md', md.join('\n'))
console.log(`parsed ${entries.length} HAR entries`)
console.log(`sockets: ${[...sockets.keys()].join(' | ') || '(none in HAR)'}`)
console.log('\nendpoints by data type:')
for (const cat of ['product', 'buyer', 'order', 'auction']) {
  const list = byCat(cat)
  console.log(`\n  ${cat.toUpperCase()} (${list.length}):`)
  for (const [key, g] of list.slice(0, 12)) console.log(`    ${key}  (${g.count}×) [${[...g.cats].join(',')}]`)
}
console.log('\nwrote capture/har-catalog.md')
