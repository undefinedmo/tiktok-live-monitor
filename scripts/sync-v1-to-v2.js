/**
 * V1 → V2 Data Sync Script
 *
 * Syncs all business data from luxesense (v1) to luxesense_v2 (v2).
 * Safe to run repeatedly — uses ON CONFLICT for upserts, COALESCE to preserve v2 user-entered data.
 *
 * Usage: node scripts/sync-v1-to-v2.js [--table=shows,items,...] [--dry-run]
 *
 * Run from the sellerfolio-desktop directory (needs pg module):
 *   cd sellerfolio-desktop && node ../sellerfolio-platform/scripts/sync-v1-to-v2.js
 */

const { Pool } = require('pg');

const TENANT_ID = '0f7fcbec-0e59-411c-8c4b-bd8ec09d8c4b';
const USER_ID = 1;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tableArg = args.find(a => a.startsWith('--table='));
const onlyTables = tableArg ? tableArg.split('=')[1].split(',') : null;

const v1 = new Pool({ host: '207.244.240.42', port: 5432, database: 'luxesense', user: 'postgres', password: 'Lobnan#205' });
const v2 = new Pool({ host: '207.244.240.42', port: 5432, database: 'luxesense_v2', user: 'postgres', password: 'Lobnan#205', options: '-c timezone=UTC' });

function shouldSync(table) {
  return !onlyTables || onlyTables.includes(table);
}

async function syncTable(name, { query, transform, conflictCols, updateCols, preserveCols = [], casts = {} }) {
  if (!shouldSync(name)) return;
  console.log(`\n=== Syncing ${name} ===`);

  const rows = await v1.query(query);
  console.log(`  v1 rows: ${rows.rows.length}`);
  if (dryRun) { console.log('  [DRY RUN] Skipping insert'); return; }
  if (rows.rows.length === 0) return;

  let inserted = 0, updated = 0, errors = 0;

  for (const row of rows.rows) {
    const record = transform(row);
    const cols = Object.keys(record);
    const vals = Object.values(record);
    const placeholders = cols.map((c, i) => casts[c] ? `$${i + 1}::${casts[c]}` : `$${i + 1}`).join(', ');
    const colList = cols.map(c => `"${c}"`).join(', ');

    // Build ON CONFLICT SET clause — use COALESCE for preserved columns
    const setClauses = updateCols.map(c => {
      if (preserveCols.includes(c)) {
        return `"${c}" = COALESCE("${name}"."${c}", EXCLUDED."${c}")`;
      }
      return `"${c}" = EXCLUDED."${c}"`;
    }).join(', ');

    const conflictColList = conflictCols.map(c => `"${c}"`).join(', ');
    const sql = `INSERT INTO "${name}" (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictColList}) DO UPDATE SET ${setClauses}`;

    try {
      await v2.query(sql, vals);
      inserted++;
    } catch (e) {
      errors++;
      if (errors <= 3) console.log(`  Error: ${e.message.substring(0, 100)}`);
    }
  }

  console.log(`  Synced: ${inserted} | Errors: ${errors}`);
}

async function main() {
  console.log('V1 → V2 Data Sync');
  console.log(`Tenant: ${TENANT_ID} | User: ${USER_ID} | Full sync (no cutoff)`);
  if (dryRun) console.log('*** DRY RUN — no data will be written ***');
  if (onlyTables) console.log(`Tables: ${onlyTables.join(', ')}`);

  // ─── Shows ───
  await syncTable('shows', {
    query: `SELECT id, title, start_time, end_time, total_items, total_gross, total_net,
                   created_at, updated_at, user_id, is_hidden_by_seller
            FROM shows WHERE is_hidden_by_seller = false OR is_hidden_by_seller IS NULL
            ORDER BY created_at`,
    transform: (r) => ({
      id: r.id,
      title: r.title,
      start_time: r.start_time ? BigInt(Math.round(Number(r.start_time))) : null,
      end_time: r.end_time ? BigInt(Math.round(Number(r.end_time))) : null,
      total_items: r.total_items,
      total_gross: r.total_gross,
      total_net: r.total_net,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: ['title', 'start_time', 'end_time', 'total_items', 'total_gross', 'total_net', 'updated_at'],
  });

  // ─── Items ───
  await syncTable('items', {
    query: `SELECT id, order_id, order_date, buyer, item_title, quantity, gross_amount, net_earnings,
                   show_id, show_title, video_url, video_seek_seconds, video_seek_formatted, stream_id,
                   transcript, ai_brand, ai_item, ai_color, ai_size, ai_msrp, cost, profit,
                   is_giveaway, flag, transcribed_at, channel, purchase_id, actual_cost,
                   classification, rule_id, shipping_cost, ai_status, earnings_status,
                   seek_time_source, created_at, updated_at, user_id
            FROM items
            ORDER BY created_at`,
    transform: (r) => ({
      id: r.id,
      order_id: r.order_id,
      order_date: r.order_date,
      buyer: r.buyer,
      item_title: r.item_title,
      quantity: r.quantity,
      gross_amount: r.gross_amount,
      net_earnings: r.net_earnings,
      show_id: r.show_id,
      show_title: r.show_title,
      video_url: r.video_url,
      video_seek_seconds: r.video_seek_seconds,
      video_seek_formatted: r.video_seek_formatted,
      stream_id: r.stream_id,
      transcript: r.transcript,
      ai_brand: r.ai_brand,
      ai_item: r.ai_item,
      ai_color: r.ai_color,
      ai_size: r.ai_size,
      ai_msrp: r.ai_msrp,
      cost: r.cost,
      profit: r.profit,
      is_giveaway: r.is_giveaway || false,
      flag: r.flag,
      transcribed_at: r.transcribed_at,
      channel: r.channel || 'whatnot',
      purchase_id: r.purchase_id,
      actual_cost: r.actual_cost,
      classification: r.classification,
      rule_id: r.rule_id,
      shipping_cost: r.shipping_cost,
      transcription_status: r.ai_status,
      earnings_status: r.earnings_status,
      seek_time_source: r.seek_time_source,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: [
      'order_date', 'gross_amount', 'net_earnings', 'show_title',
      'video_url', 'video_seek_seconds', 'video_seek_formatted', 'seek_time_source',
      'updated_at',
    ],
    // These columns should NOT be overwritten if v2 already has data
    preserveCols: [
      'cost', 'ai_brand', 'ai_item', 'ai_color', 'ai_size', 'ai_msrp',
      'profit', 'classification', 'rule_id', 'transcription_status', 'earnings_status',
      'transcript', 'flag',
    ],
  });

  // ─── Customers ───
  await syncTable('customers', {
    query: `SELECT id, username, whatnot_username, display_name, full_name, profile_image,
                   address_line1, address_line2, city, state, postal_code, country_code,
                   total_orders, total_spent, first_order_date, last_order_date,
                   created_at, updated_at, user_id
            FROM customers ORDER BY created_at`,
    transform: (r) => ({
      username: r.username || r.whatnot_username,
      whatnot_username: r.whatnot_username || r.username,
      display_name: r.display_name || r.username,
      full_name: r.full_name,
      profile_image: r.profile_image,
      address_line1: r.address_line1,
      address_line2: r.address_line2,
      city: r.city,
      state: r.state,
      postal_code: r.postal_code,
      country_code: r.country_code || 'US',
      total_orders: r.total_orders || 0,
      total_spent: r.total_spent || 0,
      first_order_date: r.first_order_date,
      last_order_date: r.last_order_date,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['whatnot_username', 'tenant_id'],
    updateCols: [
      'display_name', 'full_name', 'profile_image',
      'address_line1', 'address_line2', 'city', 'state', 'postal_code',
      'total_orders', 'total_spent', 'first_order_date', 'last_order_date', 'updated_at',
    ],
  });

  // ─── Orders ───
  await syncTable('orders', {
    query: `SELECT id, whatnot_order_id, buyer_username, item_title, item_count,
                   order_date, ordered_at, total_amount, subtotal, taxes, shipping_price,
                   status, shipping_name, shipping_address, shipping_line1, shipping_line2,
                   shipping_city, shipping_state, shipping_postal, shipping_country,
                   tracking_number, carrier, shipped_at, show_id, show_title,
                   created_at, updated_at, user_id
            FROM orders
            ORDER BY created_at`,
    transform: (r) => ({
      id: r.id,
      whatnot_order_id: r.whatnot_order_id || r.id,
      buyer_username: r.buyer_username,
      item_title: r.item_title,
      item_count: r.item_count,
      order_date: r.order_date || r.ordered_at,
      ordered_at: r.ordered_at || r.order_date,
      total_amount: r.total_amount,
      subtotal: r.subtotal,
      taxes: r.taxes,
      shipping_price: r.shipping_price,
      status: r.status,
      shipping_name: r.shipping_name,
      shipping_address: r.shipping_address,
      shipping_line1: r.shipping_line1,
      shipping_line2: r.shipping_line2,
      shipping_city: r.shipping_city,
      shipping_state: r.shipping_state,
      shipping_postal: r.shipping_postal,
      shipping_country: r.shipping_country,
      tracking_number: r.tracking_number,
      carrier: r.carrier,
      shipped_at: r.shipped_at,
      show_id: r.show_id,
      show_title: r.show_title,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: [
      'whatnot_order_id', 'buyer_username', 'item_title', 'item_count',
      'order_date', 'ordered_at', 'total_amount', 'status',
      'shipping_name', 'tracking_number', 'carrier', 'shipped_at',
      'show_id', 'show_title', 'updated_at',
    ],
  });

  // ─── Shipments ───
  await syncTable('shipments', {
    query: `SELECT id, status, tracking_number, carrier, shipped_at,
                   tracking_url, tracking_code, buyer_username, address_full_name,
                   address_country_code, total_items, total_value_cents,
                   label_url, bundled_label_url, courier, show_id,
                   last_tracking_check, tracking_status_summary, tracking_last_location,
                   tracking_delivery_date, printed_at, synced_at,
                   created_at, updated_at, user_id
            FROM shipments
            ORDER BY created_at`,
    transform: (r) => ({
      id: r.id,
      whatnot_shipment_id: r.id,
      show_id: r.show_id,
      status: r.status,
      tracking_url: r.tracking_url,
      tracking_code: r.tracking_code,
      tracking_number: r.tracking_number,
      label_url: r.label_url,
      bundled_label_url: r.bundled_label_url,
      courier: r.courier,
      carrier: r.carrier,
      buyer_username: r.buyer_username,
      address_full_name: r.address_full_name,
      address_country_code: r.address_country_code,
      total_items: r.total_items,
      total_value_cents: r.total_value_cents,
      printed_at: r.printed_at,
      shipped_at: r.shipped_at,
      synced_at: r.synced_at,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: [
      'status', 'tracking_url', 'tracking_code', 'tracking_number',
      'label_url', 'courier', 'carrier', 'shipped_at', 'synced_at', 'updated_at',
    ],
  });

  // ─── Conversations ───
  await syncTable('conversations', {
    query: `SELECT whatnot_id, participant_username, participant_name, participant_image,
                   has_unread, last_message_body, last_message_at,
                   created_at, updated_at, user_id
            FROM conversations ORDER BY created_at`,
    transform: (r) => ({
      whatnot_id: r.whatnot_id,
      participant_id: '',
      participant_username: r.participant_username,
      participant_name: r.participant_name || r.participant_username,
      participant_image: r.participant_image,
      has_unread: r.has_unread || false,
      status: 'open',
      last_message_body: r.last_message_body,
      last_message_at: r.last_message_at,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['whatnot_id', 'tenant_id'],
    updateCols: ['participant_name', 'has_unread', 'last_message_body', 'last_message_at', 'updated_at'],
  });

  // ─── Messages ───
  await syncTable('messages', {
    query: `SELECT whatnot_id, conversation_id, body, sender_type, sender_username,
                   media_url, media_type, is_read, sent_at, created_at, user_id
            FROM messages ORDER BY created_at`,
    transform: (r) => {
      // conversation_id in v1 might be whatnot_id string, v2 needs integer FK
      // We'll need to look up the conversation, but for now use a placeholder
      return {
        whatnot_id: r.whatnot_id,
        conversation_id: r.conversation_id, // This might need mapping
        body: r.body || '',
        sender_type: r.sender_type || (r.is_from_me ? 'me' : 'them'),
        sender_username: r.sender_username || '',
        media_url: r.media_url,
        media_type: r.media_type,
        is_read: r.is_read || false,
        sent_at: r.sent_at || new Date(),
        created_at: r.created_at || new Date(),
        user_id: r.user_id || USER_ID,
        tenant_id: TENANT_ID,
      };
    },
    conflictCols: ['whatnot_id', 'tenant_id'],
    updateCols: ['body', 'is_read'],
  });

  // ─── Live Auctions ───
  // Ensure unique index exists for conflict resolution
  try { await v2.query('CREATE UNIQUE INDEX IF NOT EXISTS live_auctions_auction_id_tenant_id_key ON live_auctions (auction_id, tenant_id)'); } catch {}
  await syncTable('live_auctions', {
    query: `SELECT show_id, auction_id, item_name, start_time, end_time, duration_seconds,
                   start_price_cents, final_price_cents, winner_username, total_bids,
                   unique_bidders, bid_data, bidder_max_bids, created_at
            FROM live_auctions
            ORDER BY created_at`,
    transform: (r) => ({
      show_id: r.show_id,
      auction_id: r.auction_id,
      item_name: r.item_name,
      start_time: r.start_time,
      end_time: r.end_time,
      duration_seconds: r.duration_seconds,
      start_price_cents: r.start_price_cents,
      final_price_cents: r.final_price_cents,
      winner_username: r.winner_username,
      total_bids: r.total_bids,
      unique_bidders: r.unique_bidders,
      bid_data: r.bid_data ? JSON.stringify(r.bid_data) : null,
      bidder_max_bids: r.bidder_max_bids ? JSON.stringify(r.bidder_max_bids) : null,
      created_at: r.created_at || new Date(),
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['auction_id', 'tenant_id'],
    updateCols: ['item_name', 'final_price_cents', 'winner_username', 'total_bids', 'unique_bidders', 'bid_data', 'bidder_max_bids'],
    casts: { bid_data: 'jsonb', bidder_max_bids: 'jsonb' },
  });

  // ─── Rules ───
  await syncTable('rules', {
    query: `SELECT id, name, description, priority, is_enabled, logic_type,
                   is_system, system_key, auto_confirm, stop_processing,
                   created_at, updated_at, user_id
            FROM rules ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      priority: r.priority || 0,
      is_enabled: r.is_enabled ?? true,
      logic_type: r.logic_type || 'AND',
      is_system: r.is_system || false,
      system_key: r.system_key,
      auto_confirm: r.auto_confirm ?? true,
      stop_processing: r.stop_processing ?? true,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: ['name', 'description', 'priority', 'is_enabled', 'logic_type', 'updated_at'],
  });

  // ─── Rule Conditions ───
  await syncTable('rule_conditions', {
    query: `SELECT id, rule_id, field, operator, value, created_at FROM rule_conditions ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      rule_id: r.rule_id,
      field: r.field,
      operator: r.operator,
      value: r.value,
      created_at: r.created_at || new Date(),
    }),
    conflictCols: ['id'],
    updateCols: ['field', 'operator', 'value'],
  });

  // ─── Rule Actions ───
  await syncTable('rule_actions', {
    query: `SELECT id, rule_id, action_type, target_value, created_at FROM rule_actions ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      rule_id: r.rule_id,
      action_type: r.action_type,
      target_value: r.target_value,
      created_at: r.created_at || new Date(),
    }),
    conflictCols: ['id'],
    updateCols: ['action_type', 'target_value'],
  });

  // ─── Expenses ───
  await syncTable('expenses', {
    query: `SELECT id, date, amount, category_id, channel, notes,
                   created_at, updated_at, user_id
            FROM expenses ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      date: r.date,
      amount: r.amount,
      category_id: r.category_id,
      channel: r.channel,
      notes: r.notes,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: ['amount', 'category_id', 'channel', 'notes', 'updated_at'],
  });

  // ─── Expense Categories ───
  await syncTable('expense_categories', {
    query: `SELECT id, name, description, created_at, user_id FROM expense_categories ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      created_at: r.created_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: ['name', 'description'],
  });

  // ─── Products ───
  await syncTable('products', {
    query: `SELECT id, brand, item_name, msrp, msrp_source, min_msrp, max_msrp,
                   item_count, first_seen, last_seen, created_at, updated_at, user_id
            FROM products ORDER BY id`,
    transform: (r) => ({
      id: r.id,
      brand: r.brand,
      item_name: r.item_name,
      msrp: r.msrp,
      msrp_source: r.msrp_source,
      min_msrp: r.min_msrp,
      max_msrp: r.max_msrp,
      item_count: r.item_count || 0,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      created_at: r.created_at || new Date(),
      updated_at: r.updated_at || new Date(),
      user_id: r.user_id || USER_ID,
      tenant_id: TENANT_ID,
    }),
    conflictCols: ['id'],
    updateCols: ['brand', 'item_name', 'msrp', 'item_count', 'last_seen', 'updated_at'],
  });

  // ─── Verify ───
  console.log('\n=== Final Counts ===');
  const tables = ['shows', 'items', 'orders', 'customers', 'shipments', 'conversations', 'messages', 'live_auctions', 'rules', 'expenses', 'products'];
  for (const t of tables) {
    try {
      const r1 = await v1.query(`SELECT COUNT(*) as cnt FROM ${t}`);
      const r2 = await v2.query(`SELECT COUNT(*) as cnt FROM ${t} WHERE tenant_id = $1`, [TENANT_ID]);
      const status = Number(r2.rows[0].cnt) >= Number(r1.rows[0].cnt) ? '✓' : `MISSING ${Number(r1.rows[0].cnt) - Number(r2.rows[0].cnt)}`;
      console.log(`  ${t.padEnd(20)} v1=${String(r1.rows[0].cnt).padEnd(6)} v2=${String(r2.rows[0].cnt).padEnd(6)} ${status}`);
    } catch (e) {
      try {
        const r1 = await v1.query(`SELECT COUNT(*) as cnt FROM ${t}`);
        const r2 = await v2.query(`SELECT COUNT(*) as cnt FROM ${t}`);
        console.log(`  ${t.padEnd(20)} v1=${String(r1.rows[0].cnt).padEnd(6)} v2=${String(r2.rows[0].cnt).padEnd(6)} (no tenant_id)`);
      } catch { console.log(`  ${t.padEnd(20)} ERROR`); }
    }
  }

  await v1.end();
  await v2.end();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
