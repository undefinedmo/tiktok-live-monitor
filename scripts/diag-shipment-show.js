const { Pool } = require('pg');

const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';

const v2 = new Pool({
  host: '207.244.240.42',
  port: 5432,
  database: 'luxesense_v2',
  user: 'postgres',
  password: 'Lobnan#205',
  options: '-c timezone=UTC',
});

async function main() {
  console.log('--- shipments with NULL show_id, sample ---');
  const ships = await v2.query(
    `SELECT s.id, s.buyer_username, s.shipped_at, s.created_at,
            COUNT(si.id)::int AS item_count,
            ARRAY_AGG(DISTINCT si.order_id) FILTER (WHERE si.order_id IS NOT NULL) AS si_order_ids
     FROM shipments s
     LEFT JOIN shipment_items si ON si.shipment_id = s.id
     WHERE s.tenant_id = $1 AND s.show_id IS NULL
     GROUP BY s.id
     ORDER BY s.shipped_at DESC NULLS LAST
     LIMIT 5`,
    [TENANT_ID]
  );
  for (const r of ships.rows) {
    console.log(`  ${r.id}  buyer=${r.buyer_username}  items=${r.item_count}  shipped=${r.shipped_at}`);
    console.log(`    si.order_ids: ${JSON.stringify(r.si_order_ids)}`);
  }

  console.log('\n--- shipment_items.order_id sample (non-null) ---');
  const items = await v2.query(
    `SELECT si.shipment_id, si.order_id, si.order_item_id, si.listing_title
     FROM shipment_items si
     JOIN shipments s ON s.id = si.shipment_id
     WHERE s.tenant_id = $1 AND s.show_id IS NULL AND si.order_id IS NOT NULL
     LIMIT 5`,
    [TENANT_ID]
  );
  for (const r of items.rows) {
    console.log(`  shipment=${r.shipment_id}  order_id=${r.order_id}  oitem=${r.order_item_id}`);
  }

  console.log('\n--- orders sample for tenant ---');
  const orders = await v2.query(
    `SELECT id, whatnot_order_id, show_id, show_title, buyer_username, ordered_at
     FROM orders WHERE tenant_id = $1
     ORDER BY ordered_at DESC NULLS LAST
     LIMIT 5`,
    [TENANT_ID]
  );
  for (const r of orders.rows) {
    console.log(`  id=${r.id}  wn=${r.whatnot_order_id}  show=${r.show_id}  buyer=${r.buyer_username}`);
  }

  console.log('\n--- order_id format counts (si.order_id) ---');
  const fmt = await v2.query(
    `SELECT
       COUNT(*) FILTER (WHERE si.order_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-')::int AS uuid_form,
       COUNT(*) FILTER (WHERE si.order_id IS NOT NULL AND si.order_id !~ '^[0-9a-f]{8}-')::int AS non_uuid,
       COUNT(*) FILTER (WHERE si.order_id IS NULL)::int AS nulls,
       COUNT(*)::int AS total
     FROM shipment_items si
     JOIN shipments s ON s.id = si.shipment_id
     WHERE s.tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(fmt.rows[0]);

  console.log('\n--- match rate: si.order_id <-> orders.whatnot_order_id ---');
  const match = await v2.query(
    `SELECT
       COUNT(*)::int AS items,
       COUNT(o.id)::int AS matched,
       COUNT(o.id) FILTER (WHERE o.show_id IS NOT NULL)::int AS matched_with_show
     FROM shipment_items si
     JOIN shipments s ON s.id = si.shipment_id
     LEFT JOIN orders o ON o.whatnot_order_id = si.order_id AND o.tenant_id = s.tenant_id
     WHERE s.tenant_id = $1 AND s.show_id IS NULL AND si.order_id IS NOT NULL`,
    [TENANT_ID]
  );
  console.log(match.rows[0]);

  console.log('\n--- orders.show_id coverage ---');
  const cov = await v2.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(show_id)::int AS with_show,
       COUNT(whatnot_order_id)::int AS with_wn_id
     FROM orders WHERE tenant_id = $1`,
    [TENANT_ID]
  );
  console.log(cov.rows[0]);

  await v2.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
