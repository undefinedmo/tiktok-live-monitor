// Find the room/status request format + the live_stream_url format in the HAR.
import { readFileSync } from 'node:fs'
const har = JSON.parse(readFileSync('C:/Users/hammo/Downloads/shop.tiktok.com-v2.har', 'utf8'))
const bodyOf = (e) => {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('utf8') } catch {} }
  return t
}

const rs = har.log.entries.find((x) => (x.request?.url ?? '').includes('room/status') && bodyOf(x).includes('stream'))
if (rs) {
  console.log('room/status URL :', rs.request.url.split('?')[0])
  console.log('method          :', rs.request.method)
  console.log('postData        :', rs.request.postData?.text ?? '(none)')
  console.log('response        :', bodyOf(rs).slice(0, 600))
}

console.log('\n--- distinct stream/pull URLs in HAR ---')
const re = /https?:\/\/[^"\\ ]*(?:pull|stream|flv|m3u8)[^"\\ ]*/gi
const seen = new Set()
for (const x of har.log.entries) {
  for (const m of bodyOf(x).matchAll(re)) {
    if (m[0].length < 200) seen.add(m[0])
  }
}
for (const u of [...seen].slice(0, 20)) console.log(' ', u)
