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
  // For the 73 cancelled orders, what does their item look like?
  const r = await v2.query(`
    SELECT i.id AS item_id, i.order_id, o.status AS order_status,
           i.earnings_status, i.is_giveaway,
           i.gross_amount, i.net_earnings, i.buyer
      FROM items i
      JOIN orders o ON o.whatnot_order_id = i.order_id AND o.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1
       AND o.status ILIKE '%cancel%'
     ORDER BY i.updated_at DESC
     LIMIT 10
  `, [TENANT_ID]);
  console.log(`Items tied to cancelled orders: ${r.rows.length}`);
  console.table(r.rows);

  // earnings_status distribution across all items
  console.log('\n=== earnings_status distribution (items table) ===');
  const dist = await v2.query(`
    SELECT earnings_status, COUNT(*)::int AS n
      FROM items
     WHERE tenant_id = $1
     GROUP BY earnings_status
     ORDER BY n DESC
  `, [TENANT_ID]);
  console.table(dist.rows);

  await v2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
