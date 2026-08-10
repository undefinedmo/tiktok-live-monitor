const { Pool } = require('pg');
const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';
const v2 = new Pool({
  host: '207.244.240.42', port: 5432, database: 'luxesense_v2',
  user: 'postgres', password: 'Lobnan#205', options: '-c timezone=UTC',
});

async function main() {
  // Find shows around May 9
  const shows = await v2.query(
    `SELECT id, title, start_time, total_items
     FROM shows
     WHERE tenant_id = $1
       AND start_time IS NOT NULL
       AND to_timestamp(start_time::bigint / 1000) BETWEEN '2026-05-08' AND '2026-05-11'
     ORDER BY start_time DESC`,
    [TENANT_ID]
  );
  console.log('--- shows around May 9 ---');
  for (const r of shows.rows) {
    console.log(`  ${r.id}  ${r.title}  start=${new Date(Number(r.start_time)).toISOString()}  items=${r.total_items}`);
  }
  if (shows.rows.length === 0) {
    console.log('  none — searching wider window');
    const wider = await v2.query(
      `SELECT id, title, start_time, total_items
       FROM shows
       WHERE tenant_id = $1
         AND start_time IS NOT NULL
         AND to_timestamp(start_time::bigint / 1000) BETWEEN '2026-04-25' AND '2026-05-15'
       ORDER BY start_time DESC`,
      [TENANT_ID]
    );
    for (const r of wider.rows) {
      console.log(`  ${r.id}  ${r.title}  start=${new Date(Number(r.start_time)).toISOString()}`);
    }
  }

  // Pick the first show in range and inspect
  if (shows.rows.length > 0) {
    const showId = shows.rows[0].id;
    console.log(`\n--- inspecting show ${showId} ---`);

    const ords = await v2.query(
      `SELECT id, show_id, status, ordered_at, buyer_username
       FROM orders
       WHERE tenant_id = $1 AND show_id = $2
       LIMIT 5`,
      [TENANT_ID, showId]
    );
    console.log(`orders with this show_id: ${ords.rowCount}`);
    for (const r of ords.rows) console.log(`  ${r.id} buyer=${r.buyer_username}`);

    const items = await v2.query(
      `SELECT COUNT(*)::int AS n FROM items WHERE tenant_id = $1 AND show_id = $2`,
      [TENANT_ID, showId]
    );
    console.log(`items with this show_id: ${items.rows[0].n}`);

    const ords2 = await v2.query(
      `SELECT DISTINCT i.order_id, o.id IS NOT NULL AS order_exists, o.show_id
       FROM items i LEFT JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1 AND i.show_id = $2
       LIMIT 5`,
      [TENANT_ID, showId]
    );
    console.log('items->orders linkage:');
    for (const r of ords2.rows) console.log(`  item.order_id=${r.order_id} exists=${r.order_exists} order.show_id=${r.show_id}`);

    const ships = await v2.query(
      `SELECT COUNT(*)::int AS n
       FROM shipments s
       JOIN shipment_items si ON si.shipment_id = s.id
       JOIN orders o ON o.whatnot_order_id = si.order_id AND o.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1 AND o.show_id = $2`,
      [TENANT_ID, showId]
    );
    console.log(`shipments linked via shipment_items->orders matching this show: ${ships.rows[0].n}`);
  }

  await v2.end();
}
main().catch(e => { console.error(e); process.exit(1); });
