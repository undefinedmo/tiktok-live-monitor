/**
 * Backfill orders.show_id and shipments.show_id so the Shipping page's
 * Shows-filter actually returns rows.
 *
 * Historical state:
 *   - Order sync never set Order.show_id (only Item.show_id was populated).
 *   - Shipment sync never set Shipment.show_id at all.
 * Going forward the middleware now writes both. This script repairs prior
 * rows in two passes:
 *   1. orders.show_id  ← items.show_id   (same order_id)
 *   2. shipments.show_id ← orders.show_id (via shipment_items.order_id =
 *      orders.whatnot_order_id)
 *
 * Usage:
 *   cd web && node ../scripts/backfill-shipment-show-id.js          # dry-run
 *   cd web && node ../scripts/backfill-shipment-show-id.js --apply  # writes
 *
 * Run from `web/` because that's where the `pg` module lives.
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
  console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}  tenant: ${TENANT_ID}\n`);

  // -------- pass 1: orders.show_id ← items.show_id --------
  console.log('=== pass 1: orders.show_id from items.show_id ===');
  const orderGap = await v2.query(
    `SELECT
       COUNT(*) FILTER (WHERE show_id IS NULL)::int AS null_show_id,
       COUNT(*)::int AS total
     FROM orders WHERE tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(
    `orders: ${orderGap.rows[0].total} total, ${orderGap.rows[0].null_show_id} missing show_id`
  );

  const orderDerivable = await v2.query(
    `SELECT COUNT(DISTINCT o.id)::int AS will_update
     FROM orders o
     JOIN items i
       ON i.order_id = o.id
      AND i.tenant_id = o.tenant_id
      AND i.show_id IS NOT NULL
     WHERE o.tenant_id = $1 AND o.show_id IS NULL`,
    [TENANT_ID]
  );
  console.log(`derivable from items: ${orderDerivable.rows[0].will_update} orders`);

  if (APPLY && orderDerivable.rows[0].will_update > 0) {
    const orderUpdate = await v2.query(
      `UPDATE orders o
       SET show_id = c.show_id,
           show_title = COALESCE(o.show_title, c.show_title)
       FROM (
         SELECT DISTINCT ON (i.order_id) i.order_id, i.show_id, i.show_title
         FROM items i
         JOIN orders o2 ON o2.id = i.order_id AND o2.tenant_id = i.tenant_id
         WHERE i.tenant_id = $1
           AND i.show_id IS NOT NULL
           AND o2.show_id IS NULL
         ORDER BY i.order_id, i.order_date DESC NULLS LAST
       ) c
       WHERE o.id = c.order_id`,
      [TENANT_ID]
    );
    console.log(`updated ${orderUpdate.rowCount} orders\n`);
  }

  // -------- pass 2: shipments.show_id ← orders.show_id --------
  console.log('=== pass 2: shipments.show_id from orders.show_id ===');
  const gap = await v2.query(
    `SELECT
       COUNT(*) FILTER (WHERE show_id IS NULL)::int AS null_show_id,
       COUNT(*)::int AS total
     FROM shipments
     WHERE tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(
    `shipments: ${gap.rows[0].total} total, ${gap.rows[0].null_show_id} missing show_id`
  );

  const preview = await v2.query(
    `WITH candidates AS (
       SELECT DISTINCT ON (s.id)
         s.id          AS shipment_id,
         o.show_id     AS derived_show_id,
         o.show_title  AS derived_show_title
       FROM shipments s
       JOIN shipment_items si ON si.shipment_id = s.id
       JOIN orders o
         ON o.whatnot_order_id = si.order_id
        AND o.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
         AND s.show_id IS NULL
         AND o.show_id IS NOT NULL
       ORDER BY s.id, o.ordered_at DESC NULLS LAST
     )
     SELECT
       COUNT(*)::int                                          AS will_update,
       COUNT(DISTINCT derived_show_id)::int                   AS distinct_shows
     FROM candidates`,
    [TENANT_ID]
  );
  console.log(
    `derivable: ${preview.rows[0].will_update} rows across ${preview.rows[0].distinct_shows} shows`
  );

  const sample = await v2.query(
    `SELECT DISTINCT ON (s.id)
       s.id, o.show_id, o.show_title
     FROM shipments s
     JOIN shipment_items si ON si.shipment_id = s.id
     JOIN orders o
       ON o.whatnot_order_id = si.order_id
      AND o.tenant_id = s.tenant_id
     WHERE s.tenant_id = $1
       AND s.show_id IS NULL
       AND o.show_id IS NOT NULL
     ORDER BY s.id, o.ordered_at DESC NULLS LAST
     LIMIT 5`,
    [TENANT_ID]
  );
  if (sample.rows.length > 0) {
    console.log('\nsample updates:');
    for (const r of sample.rows) {
      console.log(`  ${r.id}  →  ${r.show_id}  (${r.show_title})`);
    }
  }

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write.');
    await v2.end();
    return;
  }

  const result = await v2.query(
    `UPDATE shipments s
     SET show_id = c.show_id
     FROM (
       SELECT DISTINCT ON (s.id) s.id AS shipment_id, o.show_id
       FROM shipments s
       JOIN shipment_items si ON si.shipment_id = s.id
       JOIN orders o
         ON o.whatnot_order_id = si.order_id
        AND o.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
         AND s.show_id IS NULL
         AND o.show_id IS NOT NULL
       ORDER BY s.id, o.ordered_at DESC NULLS LAST
     ) c
     WHERE s.id = c.shipment_id`,
    [TENANT_ID]
  );
  console.log(`\nupdated ${result.rowCount} shipments`);

  await v2.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
