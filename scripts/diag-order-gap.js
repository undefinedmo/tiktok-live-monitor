/**
 * Investigate why v2 is missing orders that exist in v1.
 * Compares order counts/dates between v1 and v2 to identify the gap pattern.
 *
 * Usage: node scripts/diag-order-gap.js [username]
 *   e.g. node scripts/diag-order-gap.js trendywendy40
 */

const { Pool } = require('pg');

const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';

const v1 = new Pool({
  host: '207.244.240.42',
  port: 5432,
  database: 'luxesense',
  user: 'postgres',
  password: 'Lobnan#205',
  options: '-c timezone=UTC',
});
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

  console.log('='.repeat(72));
  console.log(`OVERALL ORDER COUNTS`);
  console.log('='.repeat(72));

  const v1Total = await v1.query(`SELECT COUNT(*)::int AS n FROM orders`);
  const v2Total = await v2.query(`SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1`, [TENANT_ID]);
  console.log(`v1 orders total            : ${v1Total.rows[0].n}`);
  console.log(`v2 orders total (tenant)   : ${v2Total.rows[0].n}`);

  const v1Range = await v1.query(`SELECT MIN(order_date) AS mn, MAX(order_date) AS mx FROM orders`);
  const v2Range = await v2.query(`SELECT MIN(order_date) AS mn, MAX(order_date) AS mx FROM orders WHERE tenant_id = $1`, [TENANT_ID]);
  console.log(`v1 order_date range        : ${v1Range.rows[0].mn?.toISOString() || 'n/a'}  →  ${v1Range.rows[0].mx?.toISOString() || 'n/a'}`);
  console.log(`v2 order_date range        : ${v2Range.rows[0].mn?.toISOString() || 'n/a'}  →  ${v2Range.rows[0].mx?.toISOString() || 'n/a'}`);

  // Counts by month — overall
  console.log('\n' + '='.repeat(72));
  console.log(`OVERALL ORDERS BY MONTH (v1 vs v2)`);
  console.log('='.repeat(72));
  const v1Months = await v1.query(`
    SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS m, COUNT(*)::int AS n
    FROM orders WHERE order_date IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `);
  const v2Months = await v2.query(`
    SELECT to_char(date_trunc('month', order_date), 'YYYY-MM') AS m, COUNT(*)::int AS n
    FROM orders WHERE tenant_id = $1 AND order_date IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `, [TENANT_ID]);
  const v2Map = new Map(v2Months.rows.map(r => [r.m, r.n]));
  console.log('  month     v1 count   v2 count   gap');
  console.log('  --------  ---------  ---------  ------');
  for (const r of v1Months.rows) {
    const v2n = v2Map.get(r.m) || 0;
    const gap = r.n - v2n;
    const flag = gap > 0 ? '  ← MISSING' : '';
    console.log(`  ${r.m}    ${String(r.n).padStart(8)}   ${String(v2n).padStart(8)}   ${String(gap).padStart(6)}${flag}`);
  }
  for (const r of v2Months.rows) {
    if (!v1Months.rows.find(x => x.m === r.m)) {
      console.log(`  ${r.m}           0   ${String(r.n).padStart(8)}   ${String(-r.n).padStart(6)}  ← v2 only`);
    }
  }

  // Per-buyer comparison
  console.log('\n' + '='.repeat(72));
  console.log(`USER ${username}: ORDERS IN V1 vs V2`);
  console.log('='.repeat(72));
  const v1User = await v1.query(`
    SELECT COUNT(*)::int AS n,
           SUM(total_amount) AS total,
           MIN(order_date) AS first,
           MAX(order_date) AS last
    FROM orders WHERE buyer_username = $1
  `, [username]);
  const v2User = await v2.query(`
    SELECT COUNT(*)::int AS n,
           SUM(total_amount) AS total,
           MIN(order_date) AS first,
           MAX(order_date) AS last
    FROM orders WHERE tenant_id = $1 AND buyer_username = $2
  `, [TENANT_ID, username]);
  console.log(`v1: ${v1User.rows[0].n} orders, $${v1User.rows[0].total}, ${v1User.rows[0].first?.toISOString()} → ${v1User.rows[0].last?.toISOString()}`);
  console.log(`v2: ${v2User.rows[0].n} orders, $${v2User.rows[0].total}, ${v2User.rows[0].first?.toISOString()} → ${v2User.rows[0].last?.toISOString()}`);

  // Find IDs that exist in v1 but not v2
  console.log('\n' + '='.repeat(72));
  console.log(`ORDER IDs IN V1 BUT MISSING FROM V2 (sample)`);
  console.log('='.repeat(72));
  const missingIds = await v1.query(`
    SELECT id, order_date, total_amount, show_id, show_title, status
    FROM orders WHERE buyer_username = $1
      AND id NOT IN (
        SELECT id FROM dblink('host=207.244.240.42 port=5432 dbname=luxesense_v2 user=postgres password=${'Lobnan#205'}',
          'SELECT id FROM orders WHERE tenant_id = ''${TENANT_ID}'' AND buyer_username = ''${username.replace(/'/g, "''")}'' '
        ) AS t(id varchar(255))
      )
    ORDER BY order_date DESC NULLS LAST
    LIMIT 10
  `).catch(async () => {
    // dblink may not be installed; do it in JS instead
    const v1Ids = await v1.query(`SELECT id, order_date, total_amount, show_id, show_title, status FROM orders WHERE buyer_username = $1`, [username]);
    const v2Ids = await v2.query(`SELECT id FROM orders WHERE tenant_id = $1 AND buyer_username = $2`, [TENANT_ID, username]);
    const v2Set = new Set(v2Ids.rows.map(r => r.id));
    return { rows: v1Ids.rows.filter(r => !v2Set.has(r.id)).slice(0, 10) };
  });
  console.log(`(showing up to 10 of ${'?'} missing)`);
  for (const r of missingIds.rows) {
    console.log(`  id=${r.id}  date=${r.order_date?.toISOString?.() || r.order_date}  $${r.total_amount}  show=${r.show_title || r.show_id || '-'}  status=${r.status || '-'}`);
  }

  // Check tenant filter — could v2 have these orders under a different tenant?
  console.log('\n' + '='.repeat(72));
  console.log(`SAFETY: are ALL v2 orders under tenant ${TENANT_ID}?`);
  console.log('='.repeat(72));
  const tenants = await v2.query(`SELECT tenant_id, COUNT(*)::int AS n FROM orders GROUP BY tenant_id ORDER BY n DESC`);
  for (const r of tenants.rows) {
    console.log(`  ${r.tenant_id}  →  ${r.n} orders`);
  }

  // Same for items table
  console.log('\n' + '='.repeat(72));
  console.log(`OVERALL ITEMS COUNTS`);
  console.log('='.repeat(72));
  const v1Items = await v1.query(`SELECT COUNT(*)::int AS n FROM items`);
  const v2Items = await v2.query(`SELECT COUNT(*)::int AS n FROM items WHERE tenant_id = $1`, [TENANT_ID]);
  console.log(`v1 items total             : ${v1Items.rows[0].n}`);
  console.log(`v2 items total (tenant)    : ${v2Items.rows[0].n}`);

  await v1.end();
  await v2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
