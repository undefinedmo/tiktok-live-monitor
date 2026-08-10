/**
 * Diagnose seek_time_source='order' on the 2026-05-04 show.
 * Reliable match: items.show_id + items.buyer + items.gross_amount
 *               = live_auctions.show_id + winner_username + final_price_cents/100
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
  const shows = await v2.query(`
    SELECT id, title, start_time,
           to_timestamp(start_time::bigint / 1000.0) AS start_ts
      FROM shows
     WHERE tenant_id = $1
       AND (to_timestamp(start_time::bigint / 1000.0) AT TIME ZONE 'America/New_York')::date = '2026-05-04'
     ORDER BY start_time DESC
  `, [TENANT_ID]);

  console.log(`Shows on 2026-05-04 (ET): ${shows.rows.length}`);
  for (const s of shows.rows) {
    console.log(`  ${s.id}  ${s.title}  start=${s.start_ts?.toISOString?.() || s.start_ts}`);
  }
  if (shows.rows.length === 0) { await v2.end(); return; }

  for (const show of shows.rows) {
    console.log('\n' + '='.repeat(72));
    console.log(`Show: ${show.id} — ${show.title}`);
    console.log('='.repeat(72));

    const itemCounts = await v2.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE seek_time_source = 'order')::int AS order_src,
             COUNT(*) FILTER (WHERE seek_time_source = 'live')::int AS live_src,
             COUNT(*) FILTER (WHERE seek_time_source IS NULL)::int AS null_src,
             COUNT(*) FILTER (WHERE is_giveaway = true)::int AS giveaway
        FROM items
       WHERE tenant_id = $1 AND show_id = $2
    `, [TENANT_ID, show.id]);
    console.log('Items:', itemCounts.rows[0]);

    const auctions = await v2.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE end_time IS NOT NULL)::int AS with_end_time,
             COUNT(*) FILTER (WHERE winner_username IS NOT NULL AND final_price_cents IS NOT NULL)::int AS with_winner_price
        FROM live_auctions
       WHERE tenant_id = $1 AND show_id = $2
    `, [TENANT_ID, show.id]);
    console.log('Live auctions:', auctions.rows[0]);

    // How many items can we match via buyer + price?
    const matchable = await v2.query(`
      SELECT COUNT(*)::int AS items_matched
        FROM items i
        JOIN live_auctions la
          ON la.show_id = i.show_id
         AND la.tenant_id = i.tenant_id
         AND la.winner_username = i.buyer
         AND la.final_price_cents = ROUND(i.gross_amount * 100)::int
       WHERE i.tenant_id = $1 AND i.show_id = $2
         AND (i.is_giveaway IS NULL OR i.is_giveaway = false)
    `, [TENANT_ID, show.id]);
    console.log('Items matchable via (buyer + price):', matchable.rows[0].items_matched);

    // Sample items currently on 'order' that would match
    const samples = await v2.query(`
      SELECT i.item_title, i.buyer, i.gross_amount, i.order_date,
             la.item_name AS auction_item_name,
             la.end_time AS auction_end_time,
             la.winner_username, la.final_price_cents
        FROM items i
        LEFT JOIN live_auctions la
          ON la.show_id = i.show_id
         AND la.tenant_id = i.tenant_id
         AND la.winner_username = i.buyer
         AND la.final_price_cents = ROUND(i.gross_amount * 100)::int
       WHERE i.tenant_id = $1 AND i.show_id = $2
         AND i.seek_time_source = 'order'
         AND (i.is_giveaway IS NULL OR i.is_giveaway = false)
       ORDER BY i.order_date
       LIMIT 5
    `, [TENANT_ID, show.id]);

    console.log('\nSample items on order_date — matched auction:');
    for (const r of samples.rows) {
      console.log(`  item:    ${r.item_title} | buyer=${r.buyer} | $${r.gross_amount}`);
      console.log(`           order_date: ${r.order_date?.toISOString?.() || r.order_date}`);
      if (r.auction_end_time) {
        console.log(`  auction: ${r.auction_item_name} | end=${r.auction_end_time?.toISOString?.()}`);
      } else {
        console.log(`  auction: NO MATCH`);
      }
      console.log('');
    }
  }

  await v2.end();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
