// Creates the target database (from DATABASE_URL) on the Postgres server if it doesn't exist.
// Connects to the server's maintenance `postgres` database using ADMIN_DATABASE_URL
// (falls back to DATABASE_URL's credentials). Safe + idempotent — never drops anything.
import 'dotenv/config';
import pg from 'pg';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL is not set (see .env.example)'); process.exit(1); }

const target = new URL(dbUrl).pathname.replace(/^\//, '').split('?')[0];
if (!target) { console.error('Could not parse target database name from DATABASE_URL'); process.exit(1); }

const adminUrl = new URL(process.env.ADMIN_DATABASE_URL || dbUrl);
adminUrl.pathname = '/postgres'; // maintenance db
adminUrl.search = '';

const client = new pg.Client({ connectionString: adminUrl.toString() });
try {
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  if (rowCount) {
    console.log(`database "${target}" already exists — nothing to do`);
  } else {
    await client.query(`CREATE DATABASE "${target}"`);
    console.log(`created database "${target}"`);
  }
} catch (e) {
  console.error('create-database failed:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
