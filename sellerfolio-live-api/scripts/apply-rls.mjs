// Applies scripts/rls-policies.sql against DATABASE_URL.
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./rls-policies.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query(sql);
  console.log('RLS policies applied.');
} catch (e) {
  console.error('apply-rls failed:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
