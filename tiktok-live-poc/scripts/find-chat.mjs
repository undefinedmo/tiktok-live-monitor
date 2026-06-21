// Scan the HAR for chat/comment capture + send endpoints.
import { readFileSync } from 'node:fs'
const har = JSON.parse(readFileSync('C:/Users/hammo/Downloads/shop.tiktok.com-v2.har', 'utf8'))
const bodyOf = (e) => {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('latin1') } catch {} }
  return t
}
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname } catch { return (u || '').split('?')[0] } }

// 1. All webcast / chat / comment-ish endpoints
console.log('=== webcast / chat / comment endpoints ===')
const seen = new Map()
for (const e of har.log.entries) {
  const u = e.request?.url ?? ''
  if (!/webcast|comment|\/chat|\/im\/|message|mention|reply/i.test(u)) continue
  const key = `${e.request.method} ${hostPath(u)}`
  const g = seen.get(key) ?? { count: 0, statuses: new Set(), ct: '', sample: '', hasPost: false }
  g.count++
  g.statuses.add(e.response?.status ?? 0)
  g.ct = e.response?.content?.mimeType ?? g.ct
  if (e.request?.postData?.text) { g.hasPost = true; if (!g.sample) g.sample = e.request.postData.text.slice(0, 200) }
  seen.set(key, g)
}
for (const [k, g] of [...seen].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${k}  (${g.count}× · ${[...g.statuses].join(',')} · ${g.ct})${g.hasPost ? '  POST-body: ' + g.sample : ''}`)
}

// 2. im/fetch payload: format + readable strings (protobuf has ascii method names)
console.log('\n=== webcast/im/fetch payloads (format + readable bits) ===')
const fetches = har.log.entries.filter((e) => /webcast\/im\/fetch/.test(e.request?.url ?? ''))
console.log(`im/fetch responses: ${fetches.length}`)
let shown = 0
for (const e of fetches) {
  const enc = e.response?.content?.encoding
  const ct = e.response?.content?.mimeType
  const raw = bodyOf(e)
  if (!raw || shown >= 2) continue
  // pull ascii runs (protobuf method names / json)
  const ascii = raw.replace(/[^\x20-\x7e]+/g, ' ')
  const words = [...new Set((ascii.match(/[A-Za-z_]{4,40}/g) || []))].slice(0, 40)
  console.log(`\n[#${++shown}] ct=${ct} enc=${enc} bytes=${raw.length}`)
  console.log('  readable tokens:', words.join(' '))
}

// 3. look for any "send message" style request anywhere (room_id + content/text in postData)
console.log('\n=== POST requests whose body mentions content/comment/text/message ===')
for (const e of har.log.entries) {
  const pd = e.request?.postData?.text
  if (!pd || e.request.method !== 'POST') continue
  if (!/comment|"content"|"text"|message|chat/i.test(pd)) continue
  const u = hostPath(e.request.url)
  if (/mcs|monitor|collect|report|feelgood|webcast\/im/i.test(u)) continue
  console.log(`  POST ${u}\n    body: ${pd.slice(0, 220)}`)
}
