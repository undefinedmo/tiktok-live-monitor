import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mapTiktokOrder } = require('../../live-ledger-desktop/orders.js');

const TOKEN = process.argv[2];
const BASE = 'http://127.0.0.1:8788';

// 1) ensure the test org can take 272 orders → put it on the 'pro' plan
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const pro = (await c.query("select id from plans where key='pro'")).rows[0];
const org = (await c.query("select id from organizations where slug='luxesense-live'")).rows[0];
await c.query('update subscriptions set plan_id=$1 where organization_id=$2', [pro.id, org.id]);
console.log('org on pro plan');

// 2) map captured orders
const raw = JSON.parse(readFileSync(homedir() + '/Downloads/tiktok-orders-all-272.json', 'utf8'));
const orders = (raw.orders || raw).map(mapTiktokOrder);
console.log('mapped', orders.length, 'orders; sample:', JSON.stringify(orders[0]).slice(0, 240));

// 3) POST to the API
const res = await fetch(BASE + '/v1/sync/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  body: JSON.stringify(orders),
});
console.log('sync status', res.status, await res.text());

// 4) verify in DB
const cnt = (await c.query("select count(*) n, sum(total_cents) gross from orders o join organizations g on g.id=o.organization_id where g.slug='luxesense-live'")).rows[0];
const items = (await c.query("select count(*) n from order_items")).rows[0];
const byStatus = (await c.query("select status, count(*) n from orders group by status order by 2 desc")).rows;
console.log('DB orders:', cnt.n, '· gross cents:', cnt.gross, '· order_items:', items.n);
console.log('by status:', byStatus.map(r=>r.status+':'+r.n).join(' '));
await c.end();
