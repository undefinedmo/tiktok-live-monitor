/**
 * Backfill customers.first_order_date / last_order_date / address columns
 * from their orders, and orders' broken-out shipping_* columns from any
 * legacy joined `shipping_address` text where structured fields are NULL.
 *
 * Reason: prior to the orders.ts sync fix, the customer upsert wrote only
 * `last_order_at` (a column nothing reads) and never propagated the buyer's
 * shipping address onto the Customer row. Order shipping was joined into a
 * single text column with the structured columns left NULL on freshly
 * synced rows. Going forward orders.ts populates everything correctly; this
 * script repairs historical rows.
 *
 * Usage:
 *   cd web && node ../scripts/backfill-customer-fields.js              # dry-run
 *   cd web && node ../scripts/backfill-customer-fields.js --apply      # writes changes
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

  // --- 1. Customer date fields from orders ---
  const dateGap = await v2.query(
    `SELECT
       SUM(CASE WHEN c.last_order_date IS NULL  AND o.last_dt  IS NOT NULL THEN 1 ELSE 0 END)::int AS missing_last,
       SUM(CASE WHEN c.first_order_date IS NULL AND o.first_dt IS NOT NULL THEN 1 ELSE 0 END)::int AS missing_first
     FROM customers c
     LEFT JOIN (
       SELECT customer_id, MAX(order_date) AS last_dt, MIN(order_date) AS first_dt
         FROM orders
        WHERE tenant_id = $1 AND customer_id IS NOT NULL AND order_date IS NOT NULL
        GROUP BY customer_id
     ) o ON o.customer_id = c.id
     WHERE c.tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(
    `Step 1: ${dateGap.rows[0].missing_last} customers missing last_order_date, ${dateGap.rows[0].missing_first} missing first_order_date`
  );

  if (APPLY) {
    const upd = await v2.query(
      `UPDATE customers c
          SET last_order_date  = COALESCE(c.last_order_date,  o.last_dt),
              first_order_date = COALESCE(c.first_order_date, o.first_dt)
         FROM (
           SELECT customer_id,
                  MAX(COALESCE(order_date, ordered_at)) AS last_dt,
                  MIN(COALESCE(order_date, ordered_at)) AS first_dt
             FROM orders
            WHERE tenant_id = $1 AND customer_id IS NOT NULL
              AND COALESCE(order_date, ordered_at) IS NOT NULL
            GROUP BY customer_id
         ) o
        WHERE c.tenant_id = $1
          AND c.id = o.customer_id
          AND (c.last_order_date IS NULL OR c.first_order_date IS NULL)`,
      [TENANT_ID]
    );
    console.log(`  → updated ${upd.rowCount} customers`);
  }

  // --- 2. Customer address from most recent order with structured shipping ---
  const addrGap = await v2.query(
    `SELECT COUNT(*)::int AS n
       FROM customers c
      WHERE c.tenant_id = $1
        AND c.city IS NULL
        AND EXISTS (
          SELECT 1 FROM orders o
           WHERE o.tenant_id = $1
             AND o.customer_id = c.id
             AND o.shipping_city IS NOT NULL
        )`,
    [TENANT_ID]
  );
  console.log(`\nStep 2: ${addrGap.rows[0].n} customers can have address backfilled from their orders`);

  if (APPLY) {
    // Pick each customer's most-recent order that has structured shipping.
    const upd = await v2.query(
      `UPDATE customers c
          SET address_line1 = COALESCE(c.address_line1, o.shipping_line1),
              address_line2 = COALESCE(c.address_line2, o.shipping_line2),
              city          = COALESCE(c.city,          o.shipping_city),
              state         = COALESCE(c.state,         o.shipping_state),
              postal_code   = COALESCE(c.postal_code,   o.shipping_postal),
              country_code  = COALESCE(c.country_code,  o.shipping_country),
              full_name     = COALESCE(c.full_name,     o.shipping_name)
         FROM (
           SELECT DISTINCT ON (customer_id)
                  customer_id, shipping_line1, shipping_line2, shipping_city,
                  shipping_state, shipping_postal, shipping_country, shipping_name
             FROM orders
            WHERE tenant_id = $1
              AND customer_id IS NOT NULL
              AND shipping_city IS NOT NULL
            ORDER BY customer_id, order_date DESC NULLS LAST
         ) o
        WHERE c.tenant_id = $1
          AND c.id = o.customer_id
          AND c.city IS NULL`,
      [TENANT_ID]
    );
    console.log(`  → updated ${upd.rowCount} customers`);
  }

  // --- 3. Final summary ---
  const after = await v2.query(
    `SELECT
       COUNT(*) FILTER (WHERE total_orders > 0)                                              AS buyers,
       COUNT(*) FILTER (WHERE total_orders > 0 AND last_order_date IS NULL)                  AS still_no_last,
       COUNT(*) FILTER (WHERE total_orders > 0 AND city IS NULL)                             AS still_no_city
     FROM customers WHERE tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(`\nFinal:`, after.rows[0]);

  await v2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
