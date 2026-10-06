// Headless 2b slice: exercise the REAL db.ts persistence path under the Electron runtime,
// against an on-disk SQLite file, across a simulated app restart (close + reopen).
// Proves: order + cost survive a restart, the address-PII strip holds on disk, and the
// Phase 2/3 deadline/flag fields round-trip through sale_json. (Renderer↔main IPC still
// needs a GUI — not covered here.) Throwaway.
import { app } from 'electron'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, upsertOrders, setCost, getSnapshot } from '../src/electron/db'
import { mapTiktokOrder } from '../src/electron/tiktok-orders'

function run(): string {
  const dbPath = join(app.getPath('userData'), 'tiktok-2b-test.db')
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s, { force: true }) } catch { /* ignore */ } } }
  cleanup()
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'order-list-sample.json'), 'utf8'))
  const order = mapTiktokOrder(fixture)

  // session 1: open the file, upsert an order, set an order-level cost, close.
  let db = openDb(dbPath)
  upsertOrders(db, [order], 1_700_000_000_000)
  setCost(db, 'order', order.externalOrderId, 4242, 1_700_000_000_000)
  db.close()

  // session 2: reopen the SAME file (simulates an app restart) and read it back.
  db = openDb(dbPath)
  const snap = getSnapshot(db)
  db.close()
  cleanup()

  const o = snap.orders.find((s) => s.orderId === order.externalOrderId)
  const cost = snap.costs[order.externalOrderId]
  if (!o) return 'FAIL: order did not persist across reopen'
  if (cost !== 4242) return `FAIL: cost did not persist across reopen (got ${cost})`
  if (o.detail && (o.detail as { address?: string }).address) return 'FAIL: address PII leaked into sale_json on disk'
  return [
    'OK',
    `order=${o.orderId}`,
    `productId=${o.productId}`,
    `cost=${cost}`,
    `priceBreakdown=${!!o.priceBreakdown}`,
    `deadlines=${!!o.deadlines}`,
    `fulfillment=${!!o.fulfillment}`,
    `flags=${!!o.flags}`,
    `abi=${process.versions.modules}`,
    `electron=${process.versions.electron}`,
  ].join(' ')
}

app.disableHardwareAcceleration()
app.whenReady().then(() => {
  let result: string
  try { result = run() } catch (e) { result = 'FAIL(threw): ' + (e as Error).message }
  console.log('2B_DB ' + result)
  app.exit(result.startsWith('OK') ? 0 : 2)
})
setTimeout(() => { console.log('2B_DB TIMEOUT'); app.exit(3) }, 12000)
