/**
 * Replicates exactly what /api/pack-station/verify does for a given barcode + shipmentId.
 * Usage: node scripts/verify-decode-trace.js <barcode> <shipmentId>
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
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
function hashUsername(u) { return crc32(u.toLowerCase().trim()) % HASH_MOD; }

async function main() {
  const barcode = process.argv[2] || '7973450094';
  const shipmentId = process.argv[3] || 'U2hpcG1lbnROb2RlOjM1MTQ2MDEyNA==';

  console.log(`barcode=${barcode}  shipmentId=${shipmentId}\n`);

  if (!/^\d{10}$/.test(barcode)) {
    console.log('Not a 10-digit encoded barcode.');
    return;
  }
  const userHash = parseInt(barcode.slice(0, 6), 10);
  const itemNumber = parseInt(barcode.slice(6, 10), 10);
  console.log(`Decoded: userHash=${userHash}  itemNumber=${itemNumber}\n`);

  // Replicate prisma.shipmentItem.findMany({ where: {shipmentId, tenantId} })
  const itemsRes = await v2.query(`
    SELECT id, listing_title, buyer_username, quantity, order_id, order_item_id, tenant_id
    FROM shipment_items
    WHERE shipment_id = $1 AND tenant_id = $2
  `, [shipmentId, TENANT_ID]);

  console.log(`Items found in shipment (with tenant filter): ${itemsRes.rows.length}`);
  for (const item of itemsRes.rows) {
    const title = item.listing_title ?? '';
    const m = title.match(/#(\d+)/);
    const rowItemNumber = m ? parseInt(m[1], 10) : NaN;
    const buyer = item.buyer_username || '';
    const buyerHash = buyer ? hashUsername(buyer) : null;
    const itemNumberMatches = rowItemNumber === itemNumber;
    const userHashMatches = buyer && hashUsername(buyer) === userHash;
    const matched = itemNumberMatches && userHashMatches;

    console.log(`  ${matched ? '✅' : '  '} #${rowItemNumber}  buyer=@${buyer}  hash=${buyerHash}  | ${title.substring(0, 70)}`);
    if (rowItemNumber === itemNumber) {
      console.log(`     -> itemNumber matches (${rowItemNumber} == ${itemNumber})`);
      console.log(`     -> userHash matches: ${userHashMatches}  (got ${buyerHash}, want ${userHash})`);
    }
  }

  // Also try without tenant filter to see if rows exist but are filtered out
  console.log(`\nWithout tenant filter:`);
  const noTenant = await v2.query(`
    SELECT id, tenant_id, listing_title, buyer_username
    FROM shipment_items WHERE shipment_id = $1
  `, [shipmentId]);
  console.log(`  ${noTenant.rows.length} row(s)`);
  if (noTenant.rows.length > 0 && itemsRes.rows.length === 0) {
    console.log(`  ⚠️  Items exist but tenant_id mismatch! Found tenant_ids:`);
    const tenants = [...new Set(noTenant.rows.map(r => r.tenant_id))];
    for (const t of tenants) console.log(`     ${t}`);
  }

  await v2.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
