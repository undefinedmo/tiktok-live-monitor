# SellerFolio Live — API & database

Standalone multi-tenant backend for the live-selling product (LIVE LEDGER desktop app now,
web UI later). Its own Postgres database, **separate from `luxesense_v2`**, on the same server.

## Architecture

- **Postgres + Prisma 7**, UUID PKs, snake_case columns, `organization_id` on every business
  table, soft delete (`deleted_at`), RLS-ready.
- **Multi-tenant**: `Organization` (tenant) ← `Membership` (user + role) ← `PermissionOverride`.
- **Tiers & billing**: `Plan` catalog (limits + feature flags as JSON) + `PlanPrice` +
  per-org `Subscription` (Stripe IDs, status, period, trial) + `Invoice` + `UsageCounter` /
  `UsageEvent` for metered quotas.
- **Auth**: `User`, OAuth `AuthAccount`, web `Session`, and `ApiToken` (how the desktop app
  authenticates — only the hash is stored).
- **Domain**: `PlatformConnection` (TikTok/Whatnot link metadata + status — *never cookies*),
  `Show`, `Customer`, `Order`, `OrderItem`, `Shipment`, `Receipt` (video receipt + transcript).
- **Admin/audit**: `PlatformAdmin`, `AuditLog`.

## Roles & permissions

Effective permissions = **role defaults** (`OWNER`/`ADMIN`/`MANAGER`/`VIEWER`) **+** per-member
`PermissionOverride` (ALLOW/DENY). Catalog and resolution live in `src/permissions.ts`.

## Setup

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL (new db name, e.g. sellerfolio_live)

npm run db:create             # CREATE DATABASE if missing (additive, never drops)
npm run prisma:migrate        # create tables (initial migration)
npm run db:seed               # seed the Plan catalog (free/starter/pro/enterprise)
npm run db:rls                # optional: apply Row-Level Security policies

npm run prisma:studio         # browse the data
```

## Notes

- `db:create` connects to the server's maintenance `postgres` database to run `CREATE DATABASE`;
  it never touches `luxesense_v2`.
- Stripe product/price IDs on `Plan`/`PlanPrice` are filled in when billing is wired.
- RLS requires the app to connect as a non-superuser role and `SET app.organization_id` per
  request; see `scripts/rls-policies.sql`.
