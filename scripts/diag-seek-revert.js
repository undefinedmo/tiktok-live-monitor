const { Pool } = require('pg');
const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';
const SHOW_ID = '1ab97c5b-3aa0-4cae-b356-a61f16e50cb3';

const v2 = new Pool({
  host: '207.244.240.42',
  port: 5432,
  database: 'luxesense_v2',
  user: 'postgres',
  password: 'Lobnan#205',
  options: '-c timezone=UTC',
});

async function main() {
  // When was live_auctions populated for this show?
  const la = await v2.query(`
    SELECT MIN(created_at) AS first_la, MAX(created_at) AS last_la,
           COUNT(*)::int AS n
      FROM live_auctions
     WHERE show_id = $1
  `, [SHOW_ID]);
  console.log('live_auctions created_at range for show:');
  console.table(la.rows);

  // When was items.updated_at (most recent batch update)
  const it = await v2.query(`
    SELECT MIN(updated_at) AS first_upd, MAX(updated_at) AS last_upd,
           COUNT(*)::int AS n
      FROM items
     WHERE tenant_id = $1 AND show_id = $2
       AND updated_at > NOW() - interval '2 hours'
  `, [TENANT_ID, SHOW_ID]);
  console.log('\nitems updated in last 2 hours for show:');
  console.table(it.rows);

  // Look at a single item and trace its values vs auction match
  const sample = await v2.query(`
    SELECT i.id, i.order_date, i.video_seek_seconds, i.seek_time_source, i.ai_status,
           i.updated_at, i.transcript IS NOT NULL AS has_t,
           la.end_time AS la_end, la.created_at AS la_created
      FROM items i
      LEFT JOIN LATERAL (
        SELECT la.end_time, la.created_at
          FROM live_auctions la
         WHERE la.show_id = i.show_id AND la.tenant_id = i.tenant_id
           AND la.end_time BETWEEN i.order_date - interval '2 minutes'
                               AND i.order_date + interval '2 minutes'
         ORDER BY ABS(EXTRACT(EPOCH FROM (la.end_time - i.order_date)))
         LIMIT 1
      ) la ON true
     WHERE i.tenant_id = $1 AND i.show_id = $2
     ORDER BY i.updated_at DESC
     LIMIT 5
  `, [TENANT_ID, SHOW_ID]);
  console.log('\nSample items with auction match info:');
  console.table(sample.rows);

  await v2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
