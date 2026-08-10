/**
 * Find which buyer username matches a given barcode userHash (CRC32 % 1_000_000).
 * Usage: node scripts/find-username-by-hash.js <hash>
 *   e.g. node scripts/find-username-by-hash.js 797345
 *
 * Also reports diagnostic info about a scanned item barcode + shipment.
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

const HASH_MOD = 1_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  let crc = 0xffffffff;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hashUsername(username) {
  return crc32(username.toLowerCase().trim()) % HASH_MOD;
}

async function main() {
  const targetHash = parseInt(process.argv[2] || '797345', 10);
  console.log(`Searching for username with hash ${targetHash}...\n`);

  const buyers = await v2.query(`
    SELECT DISTINCT buyer_username FROM shipment_items
    WHERE tenant_id = $1 AND buyer_username IS NOT NULL
    UNION
    SELECT DISTINCT buyer_username FROM shipments
    WHERE tenant_id = $1 AND buyer_username IS NOT NULL
    UNION
    SELECT DISTINCT buyer FROM items
    WHERE tenant_id = $1 AND buyer IS NOT NULL
  `, [TENANT_ID]);

  console.log(`Checked ${buyers.rows.length} distinct buyer usernames.\n`);

  const matches = [];
  for (const row of buyers.rows) {
    const u = row.buyer_username || row.buyer;
    if (!u) continue;
    if (hashUsername(u) === targetHash) {
      matches.push(u);
    }
  }

  if (matches.length === 0) {
    console.log(`❌ No buyer username in this tenant hashes to ${targetHash}.`);
    console.log(`   The label was printed for a buyer not in the DB, or hashing differs.`);
  } else {
    console.log(`✅ Match(es) for hash ${targetHash}:`);
    for (const u of matches) {
      console.log(`   @${u}  (hash check: ${hashUsername(u)})`);

      const counts = await v2.query(`
        SELECT
          (SELECT COUNT(*) FROM shipment_items WHERE tenant_id = $1 AND lower(buyer_username) = lower($2)) AS shipment_items,
          (SELECT COUNT(*) FROM shipments WHERE tenant_id = $1 AND lower(buyer_username) = lower($2)) AS shipments,
          (SELECT COUNT(*) FROM items WHERE tenant_id = $1 AND lower(buyer) = lower($2)) AS items
      `, [TENANT_ID, u]);
      const c = counts.rows[0];
      console.log(`     shipment_items=${c.shipment_items}  shipments=${c.shipments}  items=${c.items}`);
    }
  }

  // If a tracking barcode is supplied as $3, dump the shipment and its items
  const trackingArg = process.argv[3];
  if (trackingArg) {
    console.log(`\n--- Shipment dump for tracking ${trackingArg} ---`);
    const ship = await v2.query(`
      SELECT id, tracking_code, tracking_number, buyer_username, address_full_name, status
      FROM shipments
      WHERE tenant_id = $1 AND (
        tracking_code = $2 OR tracking_number = $2
        OR (length(tracking_code) > 10 AND position(tracking_code in $2) > 0)
        OR (length(tracking_number) > 10 AND position(tracking_number in $2) > 0)
      )
      LIMIT 1
    `, [TENANT_ID, trackingArg]);

    if (ship.rows.length === 0) {
      console.log('  No shipment matches this tracking.');
    } else {
      const s = ship.rows[0];
      console.log(`  shipment_id=${s.id}  tracking=${s.tracking_code}  buyer=@${s.buyer_username}  status=${s.status}`);
      const items = await v2.query(`
        SELECT id, listing_title, buyer_username, quantity
        FROM shipment_items WHERE shipment_id = $1
      `, [s.id]);
      console.log(`  ${items.rows.length} item(s):`);
      for (const it of items.rows) {
        const titleMatch = (it.listing_title || '').match(/#(\d+)/);
        const itemNumber = titleMatch ? titleMatch[1] : '(no #)';
        const buyer = it.buyer_username || '(null)';
        const buyerHash = it.buyer_username ? hashUsername(it.buyer_username) : '(null)';
        console.log(`    #${itemNumber.padEnd(4)} qty=${it.quantity}  buyer=@${buyer}  hash=${buyerHash}  | ${it.listing_title}`);
      }
    }
  }

  await v2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
