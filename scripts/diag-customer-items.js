/**
 * Diagnose why a customer's items count is much lower than their orders count.
 * Usage: node scripts/diag-customer-items.js <username>
 *   e.g. node scripts/diag-customer-items.js trendywendy40
 */

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
  const username = process.argv[2] || 'trendywendy40';

  const customerRow = await v2.query(
    `SELECT id, username, whatnot_username, total_orders, total_spent
       FROM customers
      WHERE tenant_id = $1 AND lower(username) = lower($2)`,
    [TENANT_ID, username]
  );
  if (customerRow.rows.length === 0) {
    console.log(`No customer found for ${username}`);
    process.exit(0);
  }
  const c = customerRow.rows[0];
  console.log(`Customer: ${c.username} (id=${c.id}) wn=${c.whatnot_username}`);
  console.log(`  recorded total_orders=${c.total_orders}  total_spent=${c.total_spent}`);

  const orderCount = await v2.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1 AND customer_id = $2`,
    [TENANT_ID, c.id]
  );
  console.log(`\nOrders linked by customer_id: ${orderCount.rows[0].n}`);

  const orderByBuyer = await v2.query(
    `SELECT COUNT(*)::int AS n FROM orders
      WHERE tenant_id = $1 AND lower(buyer_username) = lower($2)`,
    [TENANT_ID, c.username]
  );
  console.log(`Orders linked by buyer_username='${c.username}': ${orderByBuyer.rows[0].n}`);

  const itemsByOrderJoin = await v2.query(
    `SELECT COUNT(*)::int AS n
       FROM items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.tenant_id = $1 AND o.tenant_id = $1 AND o.customer_id = $2`,
    [TENANT_ID, c.id]
  );
  console.log(`\nItems via Order.id join (this is what the API now uses): ${itemsByOrderJoin.rows[0].n}`);

  const itemsByBuyerName = await v2.query(
    `SELECT COUNT(*)::int AS n FROM items
      WHERE tenant_id = $1 AND lower(buyer) = lower($2)`,
    [TENANT_ID, c.username]
  );
  console.log(`Items by Item.buyer = '${c.username}': ${itemsByBuyerName.rows[0].n}`);

  const itemsByBuyerWN = await v2.query(
    `SELECT COUNT(*)::int AS n FROM items
      WHERE tenant_id = $1 AND lower(buyer) = lower($2)`,
    [TENANT_ID, c.whatnot_username]
  );
  console.log(`Items by Item.buyer = whatnot '${c.whatnot_username}': ${itemsByBuyerWN.rows[0].n}`);

  const buyerNullCheck = await v2.query(
    `SELECT
       SUM(CASE WHEN i.buyer IS NULL THEN 1 ELSE 0 END)::int AS null_count,
       SUM(CASE WHEN i.buyer IS NOT NULL THEN 1 ELSE 0 END)::int AS not_null_count
     FROM items i
     JOIN orders o ON o.id = i.order_id
     WHERE i.tenant_id = $1 AND o.customer_id = $2`,
    [TENANT_ID, c.id]
  );
  console.log(
    `\nOf items joined via order_id, items.buyer is NULL on ${buyerNullCheck.rows[0].null_count}, set on ${buyerNullCheck.rows[0].not_null_count}`
  );

  const ordersWithItems = await v2.query(
    `SELECT COUNT(DISTINCT o.id)::int AS n
       FROM orders o
       LEFT JOIN items i ON i.order_id = o.id AND i.tenant_id = $1
      WHERE o.tenant_id = $1 AND o.customer_id = $2 AND i.id IS NOT NULL`,
    [TENANT_ID, c.id]
  );
  console.log(`\nOrders that have at least one item row: ${ordersWithItems.rows[0].n}`);

  const ordersNoItems = await v2.query(
    `SELECT COUNT(*)::int AS n
       FROM orders o
      WHERE o.tenant_id = $1
        AND o.customer_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM items i WHERE i.tenant_id = $1 AND i.order_id = o.id
        )`,
    [TENANT_ID, c.id]
  );
  console.log(`Orders with NO item rows: ${ordersNoItems.rows[0].n}`);

  const giveawaySplit = await v2.query(
    `SELECT
       SUM(CASE WHEN i.is_giveaway = true THEN 1 ELSE 0 END)::int AS giveaway,
       SUM(CASE WHEN i.is_giveaway = false THEN 1 ELSE 0 END)::int AS not_giveaway,
       SUM(CASE WHEN i.is_giveaway IS NULL THEN 1 ELSE 0 END)::int AS null_giveaway
     FROM items i
     JOIN orders o ON o.id = i.order_id
     WHERE i.tenant_id = $1 AND o.customer_id = $2`,
    [TENANT_ID, c.id]
  );
  console.log(
    `\nis_giveaway breakdown for items: true=${giveawaySplit.rows[0].giveaway}, false=${giveawaySplit.rows[0].not_giveaway}, null=${giveawaySplit.rows[0].null_giveaway}`
  );

  console.log('\n--- 5 sample orders without items ---');
  const sample = await v2.query(
    `SELECT o.id, o.order_date, o.show_id, o.show_title, o.total_amount, o.item_count
       FROM orders o
      WHERE o.tenant_id = $1
        AND o.customer_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM items i WHERE i.tenant_id = $1 AND i.order_id = o.id
        )
      ORDER BY o.order_date DESC NULLS LAST
      LIMIT 5`,
    [TENANT_ID, c.id]
  );
  for (const r of sample.rows) {
    console.log(
      `  order=${r.id} date=${r.order_date?.toISOString?.() || r.order_date} show=${r.show_title || r.show_id} amount=${r.total_amount} item_count=${r.item_count}`
    );
  }

  await v2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
