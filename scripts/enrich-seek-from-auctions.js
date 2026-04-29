/**
 * Temp seek-time enrichment: items ← live_auctions (v2 only)
 *
 * Matches each item to the nearest live_auction in the same show within ±2 min of order_date,
 * then overwrites video_seek_seconds/formatted and sets seek_time_source = 'auction'.
 *
 * Usage: node scripts/enrich-seek-from-auctions.js [--show=<id>] [--dry-run]
 * Run from sellerfolio-desktop (needs pg):
 *   NODE_PATH="../sellerfolio-desktop/node_modules" node scripts/enrich-seek-from-auctions.js
 */

const { Pool } = require('pg');

const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';
const SEEK_BUFFER = 30;
const MATCH_WINDOW = '2 minutes';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showArg = args.find(a => a.startsWith('--show='));
const onlyShow = showArg ? showArg.split('=')[1] : null;

const v2 = new Pool({
  host: '207.244.240.42', port: 5432, database: 'luxesense_v2',
  user: 'postgres', password: 'Lobnan#205', options: '-c timezone=UTC',
});

function formatSeek(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

async function main() {
  console.log('Seek enrichment (items ← live_auctions)');
  console.log(`Tenant: ${TENANT_ID}${onlyShow ? ` | Show: ${onlyShow}` : ''}${dryRun ? ' | DRY RUN' : ''}`);

  const params = [TENANT_ID];
  let showFilter = '';
  if (onlyShow) { params.push(onlyShow); showFilter = `AND i.show_id = $${params.length}`; }

  const { rows } = await v2.query(`
    SELECT i.id AS item_id,
           i.seek_time_source AS current_source,
           i.video_seek_seconds AS current_seconds,
           EXTRACT(EPOCH FROM la.end_time) AS auction_end_epoch,
           (s.start_time::float8) / 1000.0 AS show_start_secs,
           la.auction_id
      FROM items i
      JOIN shows s ON s.id = i.show_id AND s.tenant_id = i.tenant_id
      JOIN LATERAL (
        SELECT la.end_time, la.auction_id
          FROM live_auctions la
         WHERE la.show_id = i.show_id
           AND la.tenant_id = i.tenant_id
           AND la.end_time BETWEEN i.order_date - interval '${MATCH_WINDOW}'
                               AND i.order_date + interval '${MATCH_WINDOW}'
         ORDER BY ABS(EXTRACT(EPOCH FROM (la.end_time - i.order_date)))
         LIMIT 1
      ) la ON true
     WHERE i.tenant_id = $1
       AND i.show_id IS NOT NULL
       AND i.order_date IS NOT NULL
       AND s.start_time IS NOT NULL
       AND (i.is_giveaway IS NULL OR i.is_giveaway = false)
       ${showFilter}
  `, params);

  console.log(`\nCandidate items matched to an auction: ${rows.length}`);

  let willUpdate = 0, alreadyAuction = 0, flipFromOrder = 0, newSource = 0, changedSeconds = 0;
  const updates = [];

  for (const r of rows) {
    const seekSeconds = Math.max(0, Math.floor(r.auction_end_epoch - r.show_start_secs) - SEEK_BUFFER);
    const formatted = formatSeek(seekSeconds);

    if (r.current_source === 'auction') alreadyAuction++;
    else if (r.current_source === 'order') flipFromOrder++;
    else newSource++;

    if (r.current_seconds !== seekSeconds || r.current_source !== 'auction') {
      changedSeconds++;
      updates.push({ id: r.item_id, seekSeconds, formatted });
    }
  }

  willUpdate = updates.length;
  console.log(`  flip from 'order' → 'auction':  ${flipFromOrder}`);
  console.log(`  set source where null/other:    ${newSource}`);
  console.log(`  already 'auction' (no change):  ${alreadyAuction}`);
  console.log(`  rows needing UPDATE:            ${willUpdate}`);

  if (dryRun || willUpdate === 0) {
    if (updates.slice(0, 3).length) {
      console.log('\nSample updates:');
      updates.slice(0, 3).forEach(u => console.log(`  ${u.id} → ${u.seekSeconds}s (${u.formatted})`));
    }
    console.log(dryRun ? '\n[DRY RUN] No writes performed' : '\nNothing to write');
    await v2.end();
    return;
  }

  console.log('\nApplying updates...');
  let done = 0;
  const client = await v2.connect();
  try {
    await client.query('BEGIN');
    for (const u of updates) {
      await client.query(
        `UPDATE items
            SET video_seek_seconds = $1,
                video_seek_formatted = $2,
                seek_time_source = 'auction',
                updated_at = NOW()
          WHERE id = $3`,
        [u.seekSeconds, u.formatted, u.id]
      );
      done++;
      if (done % 500 === 0) console.log(`  ${done}/${willUpdate}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`  ${done}/${willUpdate} updated`);
  await v2.end();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
