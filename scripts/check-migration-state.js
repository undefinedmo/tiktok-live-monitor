const { Pool } = require('pg');
const v2 = new Pool({
  host: '207.244.240.42', port: 5432, database: 'luxesense_v2',
  user: 'postgres', password: 'Lobnan#205', options: '-c timezone=UTC',
});

async function main() {
  const mig = await v2.query(
    `SELECT migration_name, started_at, finished_at, rolled_back_at, logs
       FROM _prisma_migrations
      WHERE migration_name LIKE '%v1_parity%' OR migration_name LIKE '%ad_spend%'
      ORDER BY started_at DESC`,
  );
  console.log('--- migration tracking rows ---');
  for (const r of mig.rows) {
    console.log(JSON.stringify({
      name: r.migration_name,
      started: r.started_at,
      finished: r.finished_at,
      rolled_back: r.rolled_back_at,
      logs: (r.logs || '').slice(0, 240),
    }, null, 2));
  }

  const checks = [
    ['customers.is_blocked', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'is_blocked') AS x"],
    ['items.earnings_status', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'earnings_status') AS x"],
    ['dismissed_duplicates table', "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dismissed_duplicates') AS x"],
    ['shows.ad_spend_total_cents', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shows' AND column_name = 'ad_spend_total_cents') AS x"],
    ['consignments.include_ad_spend_in_cost', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'consignments' AND column_name = 'include_ad_spend_in_cost') AS x"],
  ];
  console.log('\n--- DB object existence ---');
  for (const [label, sql] of checks) {
    const r = await v2.query(sql);
    console.log(`  ${r.rows[0].x ? '✓' : '✗'}  ${label}`);
  }

  await v2.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
