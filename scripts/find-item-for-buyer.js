/**
 * Find which shipment contains a given item number for a given buyer.
 * Usage: node scripts/find-item-for-buyer.js <itemNumber> <buyerUsername>
 *   e.g. node scripts/find-item-for-buyer.js 94 trendywendy40
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
  const itemNumber = process.argv[2] || '94';
  const buyer = process.argv[3] || 'trendywendy40';

  console.log(`Searching shipments for item #${itemNumber} of @${buyer}...\n`);

  const matches = await v2.query(`
    SELECT s.id, s.tracking_code, s.status, s.buyer_username, s.address_full_name,
           si.listing_title, si.quantity, si.show_id, si.order_item_id
    FROM shipment_items si
    JOIN shipments s ON s.id = si.shipment_id
    WHERE si.tenant_id = $1
      AND lower(si.buyer_username) = lower($2)
      AND si.listing_title ~ ('#' || $3 || '\\M')
    ORDER BY s.created_at DESC
  `, [TENANT_ID, buyer, itemNumber]);

  if (matches.rows.length === 0) {
    console.log(`❌ No shipment_items found with title containing #${itemNumber} for @${buyer}.`);
    console.log(`\nChecking 'items' table (sales records, not shipped yet)...`);
    const items = await v2.query(`
      SELECT id, item_title, show_id, show_title, order_id
      FROM items
      WHERE tenant_id = $1
        AND lower(buyer) = lower($2)
        AND item_title ~ ('#' || $3 || '\\M')
      ORDER BY order_date DESC
      LIMIT 5
    `, [TENANT_ID, buyer, itemNumber]);

    if (items.rows.length === 0) {
      console.log(`   No items match either. Item may be from a show not yet synced,`);
      console.log(`   or label was printed against a different itemNumber.`);
    } else {
      console.log(`   Found ${items.rows.length} item(s) in 'items' table (not yet shipped?):`);
      for (const it of items.rows) {
        console.log(`     order=${it.order_id}  show=${it.show_title || it.show_id}`);
        console.log(`       title: ${it.item_title}`);
      }
    }
  } else {
    console.log(`✅ Found ${matches.rows.length} matching shipment_item(s):`);
    for (const m of matches.rows) {
      console.log(`\n  shipment_id=${m.id}`);
      console.log(`    tracking=${m.tracking_code}  status=${m.status}`);
      console.log(`    buyer=@${m.buyer_username}  ship_to="${m.address_full_name}"`);
      console.log(`    show_id=${m.show_id}  qty=${m.quantity}`);
      console.log(`    title: ${m.listing_title}`);
    }
  }

  // Also list all items currently associated with that buyer's shipments,
  // so the operator can see which item numbers DO exist
  console.log(`\n--- All shipped items for @${buyer} (last 30 by created) ---`);
  const all = await v2.query(`
    SELECT s.tracking_code, si.listing_title, s.status
    FROM shipment_items si
    JOIN shipments s ON s.id = si.shipment_id
    WHERE si.tenant_id = $1 AND lower(si.buyer_username) = lower($2)
    ORDER BY s.created_at DESC
    LIMIT 30
  `, [TENANT_ID, buyer]);
  for (const r of all.rows) {
    const m = (r.listing_title || '').match(/#(\d+)/);
    const num = m ? `#${m[1].padStart(3, ' ')}` : '#???';
    console.log(`  ${num}  [${r.status}]  ${r.tracking_code?.slice(-8) || ''}  ${r.listing_title}`);
  }

  await v2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
