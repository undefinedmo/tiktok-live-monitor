# Activity Logging Coverage — Design

**Date:** 2026-04-28
**Status:** Approved (pending user review of written spec)

## Problem

The Activity screen shows no data on populated tenants because the `ActivityLog` table is mostly empty. Only six API routes write to it today (customer favorites, notes, CLV recalc, pack-station mark-packed, cost templates, sync config). Core CRUD on items, products, purchases, expenses, customers, shows, consignors, rules, alerts, tags, shipments, users, and settings produces no audit trail.

This spec defines comprehensive activity logging across the curated set of resources users would expect to see in an audit log.

A separate, recently-fixed bug — the desktop `useActivity` hook reading `result.logs` instead of `result.data?.activities` — is already resolved and out of scope here.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| Coverage | Curated set of audit-worthy resources (items, products, purchases, expenses, customers, shows, consignors, consignments, consignor-payouts, rules, alerts, tags, shipments, users, settings) | Match user expectation of "audit trail"; exclude transient operations (sync jobs, AI suggestions, Shippo rate fetches, label generation, message sends) |
| Strategy | Manual `logActivity()` helper called from each route after success | Hand-curated entries beat generic auto-log rows; no AsyncLocalStorage / extension edge cases; ~30-40 routes is manageable |
| User attribution | Add proper `userId Int?` FK to `ActivityLog` | Single source of truth, joins work, `userInfo` becomes a display string only |
| Bulk operations | One summary row per bulk action with capped affected IDs (max 100) | Avoid table bloat; bulk endpoints become single human-readable entries |
| Sensitive fields | Allowlist per resource — caller passes only fields to log | Safe by default; secrets never enter the diff |
| Read permission | New `activity.view` key, Owner/Admin only | Audit logs are an admin concern; current `sales.view` gate leaks too much once logging expands |
| Failure mode | `logActivity` swallows errors, logs to `console.error` | Logging is observational; must not take down writes |

## Architecture

A single helper `logActivity()` lives at `web/src/lib/activity.ts`. Every covered API route calls it after a successful mutation. The helper writes one row to `ActivityLog` and never throws.

A small Prisma migration adds a `userId` FK column on `ActivityLog` and two composite indexes to keep the activity feed query fast as the table grows.

A new permission key `activity.view` gates `/api/activity` and hides the Activity nav item for users without it.

No middleware, no Prisma extension, no AsyncLocalStorage. The desktop hook (already fixed) and the web Activity page need no changes — they consume whatever rows exist.

## The Helper

`web/src/lib/activity.ts`:

```ts
type ActivityAction =
  | "create" | "update" | "delete"
  | "bulk_update" | "bulk_delete" | "bulk_giveaway" | "bulk_tag" | "bulk_msrp"
  | "merge" | "import" | "pack" | "verify"
  | "favorite_set" | "note_add" | "note_delete"
  | "rule_run" | "sync_run" | "permissions_update";

type ActivityResource =
  | "item" | "product" | "purchase" | "expense" | "expense_category"
  | "customer" | "show" | "consignor" | "consignment" | "consignor_payout"
  | "rule" | "alert" | "tag" | "shipment" | "message_template"
  | "user" | "setting" | "sync_config";

interface LogActivityInput {
  tenantId: string;
  userId: number;
  resourceType: ActivityResource;
  resourceId: string;
  action: ActivityAction;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

export async function logActivity(input: LogActivityInput): Promise<void>;
```

Behavior:

- Writes one `ActivityLog` row inside a try/catch. Errors hit `console.error` and never rethrow.
- Does **not** auto-strip fields. Callers pass an explicit allowlist of fields to log.
- Resolves `userInfo` (display string like "Mo R.") at write time from the `User` table for read-side convenience.
- Caller is responsible for calling only after the mutation succeeds.

Two thin wrappers cover the common shapes:

```ts
logActivity.bulk({
  tenantId, userId, resourceType, action,
  affectedIds: number[],
  patch: Record<string, unknown>,
})
// resourceId = `bulk:<resourceType>:<count>`
// newValues  = { patch, ids: affectedIds.slice(0, 100) }

logActivity.diff({
  tenantId, userId, resourceType, resourceId, action,
  oldRow: object,
  newRow: object,
  fields: string[],            // allowlist
})
// oldValues / newValues = pick(oldRow, fields), pick(newRow, fields)
```

## Schema Migration

Add `userId` and two composite indexes:

```prisma
model ActivityLog {
  id           Int       @id @default(autoincrement())
  resourceType String?   @map("resource_type") @db.VarChar(100)
  resourceId   String?   @map("resource_id") @db.VarChar(255)
  action       String?   @db.VarChar(100)
  oldValues    Json?     @map("old_values") @db.JsonB
  newValues    Json?     @map("new_values") @db.JsonB
  userInfo     String?   @map("user_info") @db.VarChar(255)
  userId       Int?      @map("user_id")        // NEW
  createdAt    DateTime? @default(now()) @map("created_at") @db.Timestamptz
  tenantId     String?   @map("tenant_id") @db.Uuid

  tenant Tenant? @relation(fields: [tenantId], references: [id])
  user   User?   @relation(fields: [userId], references: [id])  // NEW

  @@index([tenantId])
  @@index([tenantId, resourceType, resourceId])  // NEW
  @@index([tenantId, createdAt])                  // NEW
  @@map("activity_log")
}
```

`User` gets the inverse relation `activityLogs ActivityLog[]`.

All columns nullable. No backfill — existing rows stay as-is.

## Permission Change

`web/src/lib/permissions.ts`:

- Add `activity.view`.
- Role defaults: Owner ✓, Admin ✓, Manager ✗, Viewer ✗.
- Per-user override continues to work via the existing override mechanism.

`web/src/app/api/activity/route.ts:8` — change `requirePermission(ctx, 'sales.view')` to `requirePermission(ctx, 'activity.view')`.

Hide the Activity nav item for users without `activity.view`. Exact location to be identified during implementation; if the dashboard has no existing pattern for permission-gated nav, the page returning 403 is acceptable as a fallback.

## Coverage Map

The following ~30-40 routes get `logActivity` calls after their mutation succeeds. The list is a checklist for implementation, not a hard contract — if a listed route doesn't exist it gets dropped, and any equivalent route discovered during implementation gets added.

**Items** — `items/[id]` PATCH/DELETE, `items/bulk` POST/DELETE, `items/bulk-patch`, `items/bulk-update`, `items/bulk-giveaway`, `items/bulk-tag`, `items/classify`, `items/apply-cost-duplicates`, `items/[id]/recompute-consignor-payout`

**Products** — `products/[id]` PATCH, `products/bulk-msrp`

**Purchases** — `purchases` POST, `purchases/[id]` PATCH/DELETE *(if these exist; confirm at impl time)*

**Expenses** — `expenses` POST, `expenses/[id]` PATCH/DELETE, `expenses/categories` POST, `expenses/categories/[id]` PATCH/DELETE

**Customers** — `customers/[id]` mutations, `customers/duplicates/dismiss`. Existing favorite, notes, CLV writers route through the new helper.

**Shows** — `shows` POST, `shows/[id]/enrich-seeks`

**Consignors / Consignments / Payouts** — `consignors` + `[id]`, `consignments` + `[id]`, `consignor-payouts` POST

**Rules / Alerts / Tags** — `rules` + `[id]`, `rules/reorder`, `rules/[id]/duplicate`, `alerts` + `[id]`, `tags` + `[id]`

**Shipments** — `shipments/[id]` PATCH, `shipments/bulk-status`, `shipments/[id]/items`. Existing `pack-station/mark-packed` writer routes through the new helper.

**Users / Settings** — `users/[id]` PATCH/DELETE, `users/[id]/permissions`, `users/invite`, `settings` PATCH (allowlist applied). Existing `sync/config` writer routes through the new helper.

**Out of scope** (transient/noisy): sync triggers, Shippo rate fetches, Whatnot cookie register, AI suggest/rephrase, label generation, message sends, review/classify endpoints, admin tenant routes (master-admin actions merit a separate audit log if needed).

## Sensitive Field Handling

The allowlist is the only mechanism. For each route, the developer chooses which fields go into `oldValues` / `newValues`. The helper does no automatic stripping.

Resources that demand particular care:

- **Setting / SyncConfig / Tenant** — never log API keys, OAuth tokens, Whatnot cookies, Twilio credentials, AI keys, or anything matching `*token*`, `*secret*`, `*password*`, `*apiKey*`, `*cookies*`. Log only the changed non-sensitive fields plus a boolean indicator if a sensitive field was updated.
- **User** — never log password hashes, MFA secrets, or session tokens. For permission updates, log the role/permission changes only.
- **Customer** — `email`, `phone` are personal data; log them only if the field itself was changed (so the diff makes sense), never log them just for context.

## Bulk Operation Shape

`logActivity.bulk` produces one row per bulk action:

- `resourceId = "bulk:<resourceType>:<count>"` (e.g. `"bulk:items:87"`)
- `action = "bulk_<verb>"` (`bulk_giveaway`, `bulk_tag`, `bulk_update`, etc.)
- `newValues = { patch: {...}, ids: number[] }` — `ids` capped at first 100 affected
- `oldValues = null` (per-row before-state would defeat the purpose)

The Activity UI renders bulk rows as `"<action> · <count> items"` and shows the patch + capped ID list when expanded.

## Failure Mode

`logActivity` is best-effort. If the `prisma.activityLog.create` call throws, the helper logs `console.error("[activity] failed to write log", err, input)` and returns. The caller's mutation has already succeeded; the user-visible request still returns success.

This trades comprehensive coverage for reliability — a degraded `activity_log` table never takes down writes. Operational monitoring (Sentry/log aggregator) is responsible for surfacing repeated failures.

## Testing

Three layers, kept light.

**Helper unit tests** — `web/src/lib/__tests__/activity.test.ts`:

- `logActivity` writes a row with the expected shape (tenantId, userId, resource, action, values, userInfo resolved).
- `logActivity.bulk` caps `ids` at 100 and sets `resourceId` to `"bulk:<type>:<count>"`.
- `logActivity.diff` picks only the requested fields from old/new rows.
- Helper swallows errors when `prisma.activityLog.create` rejects — caller does not see the error.

**Route integration tests** — three representative routes only:

- `items/[id]` PATCH — single update with diff.
- `items/bulk-giveaway` — bulk summary row.
- `users/[id]/permissions` — sensitive resource, confirms allowlist behavior (no secret fields in `newValues`).

Each test hits the route, asserts the mutation happened, and asserts an `ActivityLog` row was created with correct `tenantId`, `userId`, `resourceType`, `action`, and field shape.

**Read-side smoke** — one test confirming `/api/activity` returns 403 for a Viewer-role user and 200 for an Admin. Validates the permission swap landed.

**Not tested**: every individual route's logging call (too much surface, low value); `userInfo` display formatting (cosmetic); the migration itself (Prisma migrations are validated by being applied).

## Build Sequence

1. **Migration + schema** — add `userId` FK, two composite indexes, `User.activityLogs` inverse. Generate Prisma client. No code uses the new column yet.
2. **Permission key** — add `activity.view` to `permissions.ts`, swap `sales.view` → `activity.view` on `/api/activity`, hide nav item.
3. **`logActivity` helper** — write `web/src/lib/activity.ts` with the three forms. Unit tests pass.
4. **Route existing 6 writers through the helper** — favorites, notes, CLV, mark-packed, sync-config (skip cost-templates; that's a separate follow-up). Validates helper handles real shapes.
5. **Add logging to high-value routes** — items (single + bulk), products, customers. Most-used surfaces. Manual smoke against a populated tenant.
6. **Fan out to remaining resources** — purchases, expenses, shows, consignors/consignments/payouts, rules/alerts/tags, shipments, users/settings. Group by directory; can be split into multiple PRs.
7. **Integration tests + final verification** — the three route tests, the permission smoke test, manual check against the Activity page.

Steps 1-3 are the platform. Steps 4-6 are mechanical fan-out. Step 7 is verification.

## Out of Scope / Follow-ups

- **`settings/cost-templates` abuse.** That route uses `ActivityLog` as a storage table, which is a separate problem. Tracked as a follow-up; not addressed here so this spec stays focused.
- **Master-admin audit log.** Admin tenant management (`/api/admin/*`) would benefit from its own audit trail, possibly with stricter retention. Out of scope.
- **Retention policy.** No automatic cleanup of old `ActivityLog` rows. Bulk-summary rows keep volume manageable; if growth becomes a problem, a periodic prune job is a future addition.
- **Per-item bulk audit.** If forensic per-item history is ever required, the underlying tables already have `updatedAt` and a separate audit table can be introduced without changing this design.
