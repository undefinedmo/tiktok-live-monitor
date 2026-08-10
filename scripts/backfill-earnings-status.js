/**
 * Backfill items.earnings_status for items whose order is cancelled.
 *
 * The middleware now writes earnings_status on every sync (orders.ts), but
 * existing items predating that fix have NULL. Until they're re-fetched, the
 * desktop's "isExcludedItem" check (Sales.tsx) and the PnL totals can't tell
 * a cancelled item from a paid one.
 *
 * This is a one-shot recovery — propagates the order's status to the item's
 * earnings_status using a conservative mapping. Idempotent: only updates rows
 * where earnings_status IS NULL.
 *
 *   Mapping
 *     orders.status ILIKE 'cancel%'   → items.earnings_status = 'Earnings Cancelled'
 *     orders.status ILIKE 'refund%'   → items.earnings_status = 'Refunded'
 *
 * Run:
 *   cd web && NODE_PATH=./node_modules node ../scripts/backfill-earnings-status.js
 *   cd web && NODE_PATH=./node_modules node ../scripts/backfill-earnings-status.js --apply   (actually write)
 */

const { Pool } = require('pg');

const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';
const APPLY = process.argv.includes('--apply');

const v2 = new Pool({
  host: '207.244.240.42',
  port: 5432,
  database: 'luxesense_v2',
  user: 'postgres',
  password: 'Lobnan#205',
  options: '-c timezone=UTC',
});

async function main() {
  console.log(APPLY ? 'APPLY mode — writing changes' : 'DRY-RUN — no writes (pass --apply to commit)');

  // Preview: how many items would be touched?
  const preview = await v2.query(`
    SELECT
      CASE
        WHEN o.status ILIKE 'cancel%' THEN 'Earnings Cancelled'
        WHEN o.status ILIKE 'refund%' THEN 'Refunded'
      END AS new_status,
      COUNT(*)::int AS n
      FROM items i
      JOIN orders o ON o.whatnot_order_id = i.order_id AND o.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1
       AND i.earnings_status IS NULL
       AND (o.status ILIKE 'cancel%' OR o.status ILIKE 'refund%')
     GROUP BY new_status
  `, [TENANT_ID]);
  console.log('\nWill update:');
  console.table(preview.rows);

  if (!APPLY) {
    await v2.end();
    return;
  }

  // Apply in a single SQL — atomic and fast.
  const result = await v2.query(`
    WITH targets AS (
      SELECT i.id,
             CASE
               WHEN o.status ILIKE 'cancel%' THEN 'Earnings Cancelled'
               WHEN o.status ILIKE 'refund%' THEN 'Refunded'
             END AS new_status
        FROM items i
        JOIN orders o ON o.whatnot_order_id = i.order_id AND o.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND i.earnings_status IS NULL
         AND (o.status ILIKE 'cancel%' OR o.status ILIKE 'refund%')
    )
    UPDATE items SET earnings_status = t.new_status, updated_at = NOW()
      FROM targets t
     WHERE items.id = t.id
    RETURNING items.id, items.earnings_status
  `, [TENANT_ID]);

  console.log(`\nUpdated ${result.rowCount} items.`);
  // Show a small sample
  console.log('Sample:');
  console.table(result.rows.slice(0, 5));

  // Also clear consignor_payout for cancelled items that are consigned and
  // haven't been paid yet — they wouldn't be reset by recomputeItemPayout
  // since that only fires when other fields change.
  const payoutClear = await v2.query(`
    UPDATE items
       SET consignor_payout = NULL, updated_at = NOW()
     WHERE tenant_id = $1
       AND consignment_id IS NOT NULL
       AND consignor_paid_at IS NULL
       AND consignor_payout IS NOT NULL
       AND earnings_status IN ('Earnings Cancelled', 'Refunded', 'Canceled', 'Cancelled')
    RETURNING id
  `, [TENANT_ID]);
  console.log(`Cleared consignor_payout on ${payoutClear.rowCount} cancelled consigned items.`);

  await v2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
