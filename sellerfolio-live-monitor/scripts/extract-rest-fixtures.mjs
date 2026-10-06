// Extracts real REST response bodies from the HAR into fixtures/rest-samples.json
// for unit-testing the roster + auction-results core. Usage: node scripts/extract-rest-fixtures.mjs [harPath]
import { readFileSync, writeFileSync } from 'node:fs'

const harPath = process.argv[2] || 'C:/Users/hammo/Downloads/shop.tiktok.com-v2.har'
const entries = JSON.parse(readFileSync(harPath, 'utf8')).log?.entries ?? []

const bodyOf = (e) => {
  const c = e.response?.content
  if (!c) return ''
  let t = c.text ?? ''
  if (c.encoding === 'base64') { try { t = Buffer.from(t, 'base64').toString('utf8') } catch { /* ignore */ } }
  return t
}
const firstJson = (sub) => {
  for (const e of entries) {
    if (!(e.request?.url ?? '').includes(sub)) continue
    try { return JSON.parse(bodyOf(e)) } catch { /* ignore */ }
  }
  return null
}

const rosterFull = firstJson('added_auction_product/list')
const pinFull = firstJson('streamer_desktop/pin/get')
const arFull = firstJson('auction_result/get')

// Trim auction_result to a small, representative slice incl. a failed payment.
const rows = arFull?.auction_result_data ?? []
const failed = rows.find((r) => r.is_payment_successful === false)
const ok = rows.filter((r) => r.is_payment_successful !== false).slice(0, 7)
const sample = [...ok, ...(failed ? [failed] : [])]

const out = {
  roster: rosterFull,
  pin: pinFull,
  // a curated subset of real sale rows (keys preserved) for parsing tests
  auctionResultRows: sample,
  auctionResultTotal: arFull?.total_result_count ?? rows.length,
}
writeFileSync(new URL('../fixtures/rest-samples.json', import.meta.url), JSON.stringify(out, null, 2))
console.log('wrote fixtures/rest-samples.json')
console.log('  roster products:', rosterFull?.auction_config_list?.length, '· pinned winner:', rosterFull?.pinned_auction_config?.latest_auction_item?.win_username)
console.log('  auctionResult total:', out.auctionResultTotal, '· sample rows:', sample.length, '· incl failed:', !!failed)
console.log('  sample buyers:', sample.map((r) => r.user_name).join(', '))
