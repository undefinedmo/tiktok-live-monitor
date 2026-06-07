# Consignment Intake M2 — Reconcile Engine + Payout Eligibility (Web) — Task Detail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: COMPLETE** — tag `consignment-intake-m2-complete` on web `feature/v1-parity-port`. 10 tasks + M2.1 reverse-idempotency fix shipped; 76 tests green; tsc clean. Built subagent-driven (implementer → spec review → quality review per task), with a final holistic cross-cutting review.
>
> **M2.1 (shipped):** A holistic review found `reverseReconciliation` was non-idempotent (a retry restored inventory twice). Fixed via an append-only `reversedAt`/`reversedByUserId` tombstone on `ItemInventoryLink` (additive nullable columns, applied via guarded `ADD COLUMN IF NOT EXISTS`): reverse short-circuits if already reversed, clears `Item.consignmentId`, and `deriveStatus` now filters `reversedAt: null`. R5 intent preserved (attribution never mutated, only a consumed-by-reversal flag added).
>
> **Deferred follow-ups (not blocking M2; address before/with the milestone noted):**
> - **[before prod] Migration application:** the M2.1 `reverse_marker` migration SQL was applied to the dev DB via `prisma db execute`; like M1's migration it is NOT cleanly replayable on a fresh/prod DB until the drift reconciliation (coordination-plan Task 14) lands. Fold the reverse_marker columns into that reconciliation.
> - **[with M6 payout UI] Silent hold-drop:** `createConsignorPayout` silently excludes items held by the eligibility gate (unreconciled / in 14-day window). The return shape doesn't tell the caller which/how many were skipped — an operator could believe a consignor is fully cleared. Surface `skippedItems`/`droppedCount` when the payout UI is built; consider distinguishing the "No eligible items" error from "no unpaid items".
> - **[nice-to-have] Owned-reconcile attribution audit:** when a previously-consignment item is reconciled as `reconciled_owned`, `Item.consignmentId` is cleared but the audit row records `old*: null` (the dropped consignment isn't captured). Capture the prior `Item.consignmentId` in the audit for traceability.
> - **[convention] `reversedByUserId` FK:** add a `reversedBy User @relation(...)` to match `createdByUserId` on `ItemInventoryLink` (column already exists; schema-only + `prisma generate`).
> - **[convention] `ReconcileResult` shape:** consider a discriminated union instead of the flat optional-bag for compiler-enforced exhaustiveness at call sites (M4/M5 consumers).

**Goal:** Build the server-side reconcile engine — the *only* legitimate writer of `ItemInventoryLink`, `sold` movements, and attribution — plus the payout-eligibility gate (14-day refund hold), with zero regression to existing consignor payouts.

**Architecture:** A pure decision/write library (`src/lib/inventory/reconcile.ts`) is wired into two thin API routes (`reconcile`, `reverse-reconcile`). Inventory depletion is a single atomic SQL `UPDATE … WHERE qty >= 1 RETURNING *` (R3) — zero rows means the lot is already depleted. Each reconcile writes an append-only `ItemInventoryLink` whose attribution (consignor/consignment/cost) is **snapshotted at write time** (R4) and never mutated; corrections go through `reverseReconciliation` (R5). UPC scans that match more than one source lot return `{ ambiguous, lots }` and write nothing until the caller supplies a `choice` (R2). Payout eligibility is a pure function consulted when building payout batches; it bypasses the gate for `legacy_skipped` items so pre-v2 consignors keep getting paid.

**Tech Stack:** Next.js 16, Prisma 7, PostgreSQL, Vitest.

**Coordination plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-execution.md` (M2 section)
**M1 (prerequisite, complete):** `docs/superpowers/plans/2026-05-31-consignment-intake-m1-schema-codec.md` — tag `consignment-intake-m1-complete`
**Working branch:** `feature/v1-parity-port` (web repo — note: `web/` is its OWN git repo, nested inside the platform repo)
**Working dir:** `web/`

**Locked decisions referenced here:**
- Atomic guarded depletion (R3): `UPDATE … WHERE qty >= 1 RETURNING *`; zero rows → `ALREADY_DEPLETED`.
- Force-explicit-choice on UPC↔source collision (R2): no `choice` → `{ ambiguous: true, lots }`, no mutation.
- Frozen attribution snapshot (R4): the link captures consignor/consignment/cost at reconcile time.
- Append-only (R5): corrections via `reverseReconciliation`, never mutation of an existing link.
- 14-day refund hold from `Order.shippedAt` before a consignment item is payout-eligible.
- `legacy_skipped` items bypass the reconcile + hold gates (preserves existing payout behavior).

---

## Contracts this milestone builds on (verified against current code)

**Schema (already shipped in M1):**
- `Inventory`: `id Int`, `tenantId`, `userId Int?`, `upc String?`, `labelCode String?` (`@@unique([tenantId, labelCode])`), `qty Int`, `sourceType String @default("owned")`, `consignorId String?`, `consignmentId String?`, `condition`, `intakeValue`, `cost`, `updatedAt`.
- `InventoryMovement`: `id Int`, `tenantId`, `userId Int?`, `inventoryId Int`, `qtyDelta Int`, `sourceType String`, `itemId String?`, `notes`, `reversalMovementId Int?`, `reason String?`, `createdByUserId Int?`, `createdAt`.
- `ItemInventoryLink`: `id Int`, `tenantId`, `itemId String`, `inventoryId Int`, `qty Int @default(1)`, `sourceType String`, `consignorId String?`, `consignmentId String?`, `unitCost Decimal?`, `grossAllocated Decimal?`, `netAllocated Decimal?`, `reason String?`, `createdByUserId Int`, `createdAt`.
- `AttributionAudit`: `id Int`, `tenantId`, `itemId String?`, `inventoryId Int?`, `oldConsignorId/newConsignorId/oldConsignmentId/newConsignmentId String?`, `reason String` (required), `station String?`, `actorUserId Int`, `createdAt`.
- `Item`: `id String`, `reconciliationStatus String @default("legacy_skipped")`, `consignmentId String?`, `consignorPaidAt DateTime?`, `consignorPayout Decimal?`, `orderId String?`. No Prisma relation to `Order`; join by `Order.id == Item.orderId`.
- `Order`: `id String @id`, `shippedAt DateTime?`.

**Reconciliation status vocabulary** (`Item.reconciliationStatus`):
`unreconciled | pending_sync | reconciled_owned | reconciled_consignment | reconciled_mixed | exception | legacy_skipped | reversed`.

**Existing functions to reuse (do not reimplement):**
- `recomputeItemPayout(tx, itemId)` — `src/lib/consignor/recompute.ts`. Recomputes & writes `Item.consignorPayout`; no-op if no `consignmentId`; frozen once `consignorPaidAt` set. Call it after a reconcile write.
- Route helpers — `src/lib/tenant.ts`: `getTenantContext(req)`, `requirePermission(ctx, key)`, `handleAuthError(error)`, `class AuthError { status }`. `TenantContext = { userId: number; tenantId: string; role; overrides }`.
- Codec — `src/lib/inventory/label-codec.ts`: `verifyLabelCode(input): boolean`.

**Test convention:** Route tests `vi.mock('@/lib/prisma')` and `vi.mock('@/lib/tenant')` (see `src/app/api/items/[id]/__tests__/log.test.ts`). Lib tests are pure (see `src/lib/consignor/compute-payout.test.ts`). `reconcile.ts` takes a `tx` param, so its tests pass a hand-built mock `tx` of `vi.fn()`s.

---

## File Structure

**Create:**
- `web/src/lib/payout/eligibility.ts` + `web/src/lib/payout/eligibility.test.ts`
- `web/src/lib/inventory/audit.ts` + `web/src/lib/inventory/audit.test.ts`
- `web/src/lib/inventory/reconcile.ts` + `web/src/lib/inventory/reconcile.test.ts`
- `web/src/app/api/inventory/reconcile/route.ts` + `web/src/app/api/inventory/reconcile/__tests__/route.test.ts`
- `web/src/app/api/inventory/reverse-reconcile/route.ts` + `web/src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts`

**Modify:**
- `web/src/lib/inventory/types.ts` — extend `InventoryItemDTO` + `toItemDTO` + `InventoryRow` with `sourceType`, `labelCode`, `consignorId`, `consignmentId`.
- `web/src/lib/consignor/create-payout.ts` — filter the candidate items through `isPayoutEligible` before settling.

**No deletes.**

---

## Task 1: Expand `InventoryItemDTO` to carry source/attribution (M2's first work item)

M2's API contract needs the desktop (M4) to see `sourceType`, `labelCode`, `consignorId`, `consignmentId`. Surface them through the existing DTO without breaking current callers.

**Files:**
- Modify: `web/src/lib/inventory/types.ts`
- Modify: `web/src/lib/inventory/types.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `web/src/lib/inventory/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toItemDTO } from './types';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, tenantId: 't', userId: 9, upc: '012345678905',
    brand: null, title: null, styleCode: null, colorCode: null, colorName: null,
    retailPrice: null, salePrice: null, cost: null, qty: 3, notes: null,
    sourceType: 'owned', labelCode: null, consignorId: null, consignmentId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  } as Parameters<typeof toItemDTO>[0];
}

describe('toItemDTO — source/attribution fields', () => {
  it('surfaces sourceType and null attribution for owned stock', () => {
    const dto = toItemDTO(row());
    expect(dto.sourceType).toBe('owned');
    expect(dto.labelCode).toBeNull();
    expect(dto.consignorId).toBeNull();
    expect(dto.consignmentId).toBeNull();
  });

  it('surfaces labelCode + consignment attribution for a consignment piece', () => {
    const dto = toItemDTO(row({
      sourceType: 'consignment', labelCode: 'ABCDEFGH7',
      consignorId: 'c-uuid', consignmentId: 'g-uuid', upc: null,
    }));
    expect(dto.sourceType).toBe('consignment');
    expect(dto.labelCode).toBe('ABCDEFGH7');
    expect(dto.consignorId).toBe('c-uuid');
    expect(dto.consignmentId).toBe('g-uuid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/types.test.ts`
Expected: FAIL — `dto.sourceType` is `undefined`.

- [ ] **Step 3: Extend the DTO, row type, and mapper**

In `web/src/lib/inventory/types.ts`:

Add to `interface InventoryItemDTO` (after `qty`):

```ts
  sourceType: string;
  labelCode: string | null;
  consignorId: string | null;
  consignmentId: string | null;
```

Add to the `InventoryRow` type (after `qty: number;`):

```ts
  sourceType: string;
  labelCode: string | null;
  consignorId: string | null;
  consignmentId: string | null;
```

Add to the object returned by `toItemDTO` (after `qty: row.qty,`):

```ts
    sourceType: row.sourceType,
    labelCode: row.labelCode,
    consignorId: row.consignorId,
    consignmentId: row.consignmentId,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no regression in callers**

Run: `npx tsc --noEmit`
Expected: clean. (The scan route passes a full Prisma `inventory` row, which already includes the new columns — no caller change needed.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory/types.ts src/lib/inventory/types.test.ts
git commit -m "feat(inventory): surface sourceType/labelCode/consignor attribution in InventoryItemDTO"
```

---

## Task 2: Payout eligibility gate (pure function)

`isPayoutEligible(item, now)` decides whether a sold item may be swept into a new consignor payout. Excludes in-flight reconcile states and the 14-day post-ship refund window; **bypasses the gate for `legacy_skipped`** so pre-v2 items stay payable.

**Files:**
- Create: `web/src/lib/payout/eligibility.ts`
- Create: `web/src/lib/payout/eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/payout/eligibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isPayoutEligible, REFUND_HOLD_DAYS } from './eligibility';

const NOW = new Date('2026-06-01T00:00:00Z');
const longAgo = new Date('2026-05-01T00:00:00Z');           // 31 days before NOW
const recently = new Date('2026-05-28T00:00:00Z');          // 4 days before NOW

describe('isPayoutEligible', () => {
  it('legacy_skipped bypasses the gate entirely (pre-v2 items stay payable)', () => {
    expect(isPayoutEligible(
      { reconciliationStatus: 'legacy_skipped', shippedAt: null, consignorPaidAt: null }, NOW,
    )).toBe(true);
  });

  it('excludes unreconciled and exception and reversed and pending_sync', () => {
    for (const s of ['unreconciled', 'pending_sync', 'exception', 'reversed']) {
      expect(isPayoutEligible(
        { reconciliationStatus: s, shippedAt: longAgo, consignorPaidAt: null }, NOW,
      )).toBe(false);
    }
  });

  it('excludes a reconciled item still inside the 14-day refund window', () => {
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_consignment', shippedAt: recently, consignorPaidAt: null }, NOW,
    )).toBe(false);
  });

  it('excludes a reconciled item not yet shipped (window has not started)', () => {
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_consignment', shippedAt: null, consignorPaidAt: null }, NOW,
    )).toBe(false);
  });

  it('includes a reconciled item past the 14-day window', () => {
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_consignment', shippedAt: longAgo, consignorPaidAt: null }, NOW,
    )).toBe(true);
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_mixed', shippedAt: longAgo, consignorPaidAt: null }, NOW,
    )).toBe(true);
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_owned', shippedAt: longAgo, consignorPaidAt: null }, NOW,
    )).toBe(true);
  });

  it('excludes an already-paid item (no double-pay), even if otherwise eligible', () => {
    expect(isPayoutEligible(
      { reconciliationStatus: 'reconciled_consignment', shippedAt: longAgo, consignorPaidAt: longAgo }, NOW,
    )).toBe(false);
  });

  it('exposes the hold window as 14 days', () => {
    expect(REFUND_HOLD_DAYS).toBe(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/payout/eligibility.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web/src/lib/payout/eligibility.ts`:

```ts
// Payout eligibility for the consignment intake v2 flow.
//
// A sold item is eligible to be swept into a NEW consignor payout only when its
// reconciliation has settled AND the buyer refund window has closed. Legacy
// (pre-v2) items predate reconciliation and the hold window, so they bypass the
// gate to preserve existing payout behavior — see recompute.ts / create-payout.ts.

export const REFUND_HOLD_DAYS = 14;

const RECONCILED_STATUSES = new Set([
  'reconciled_owned',
  'reconciled_consignment',
  'reconciled_mixed',
]);

export interface PayoutEligibilityInput {
  reconciliationStatus: string;
  shippedAt: Date | null;
  consignorPaidAt: Date | null;
}

export function isPayoutEligible(item: PayoutEligibilityInput, now: Date): boolean {
  // Never re-pay a frozen item.
  if (item.consignorPaidAt) return false;

  // Pre-v2 items: no reconciliation, no hold. Stay payable exactly as before.
  if (item.reconciliationStatus === 'legacy_skipped') return true;

  // New-flow items must be fully reconciled (not unreconciled / pending_sync /
  // exception / reversed).
  if (!RECONCILED_STATUSES.has(item.reconciliationStatus)) return false;

  // Refund hold runs from ship time. Not shipped yet → hold has not closed.
  if (!item.shippedAt) return false;

  const holdMs = REFUND_HOLD_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - item.shippedAt.getTime() >= holdMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/payout/eligibility.test.ts`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/payout/eligibility.ts src/lib/payout/eligibility.test.ts
git commit -m "feat(payout): 14-day refund-hold eligibility gate (legacy items bypass)"
```

---

## Task 3: Attribution audit write helper

A single choke-point for writing `AttributionAudit` rows so every ownership/attribution change is traceable.

**Files:**
- Create: `web/src/lib/inventory/audit.ts`
- Create: `web/src/lib/inventory/audit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/inventory/audit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { writeAttributionAudit } from './audit';

function mockTx() {
  return { attributionAudit: { create: vi.fn().mockResolvedValue({ id: 1 }) } };
}

describe('writeAttributionAudit', () => {
  it('writes a row with all attribution deltas and the actor', async () => {
    const tx = mockTx();
    await writeAttributionAudit(tx as never, {
      tenantId: 't', itemId: 'i-1', inventoryId: 5,
      oldConsignorId: null, newConsignorId: 'c-2',
      oldConsignmentId: null, newConsignmentId: 'g-2',
      reason: 'reconcile: consignment QR scan', station: 'pack-1', actorUserId: 9,
    });
    expect(tx.attributionAudit.create).toHaveBeenCalledTimes(1);
    expect(tx.attributionAudit.create.mock.calls[0][0]).toEqual({
      data: {
        tenantId: 't', itemId: 'i-1', inventoryId: 5,
        oldConsignorId: null, newConsignorId: 'c-2',
        oldConsignmentId: null, newConsignmentId: 'g-2',
        reason: 'reconcile: consignment QR scan', station: 'pack-1', actorUserId: 9,
      },
    });
  });

  it('defaults optional ids to null and station to null', async () => {
    const tx = mockTx();
    await writeAttributionAudit(tx as never, {
      tenantId: 't', itemId: 'i-1', inventoryId: 5,
      newConsignorId: 'c-2', newConsignmentId: 'g-2',
      reason: 'reconcile', actorUserId: 9,
    });
    const data = tx.attributionAudit.create.mock.calls[0][0].data;
    expect(data.oldConsignorId).toBeNull();
    expect(data.oldConsignmentId).toBeNull();
    expect(data.station).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `web/src/lib/inventory/audit.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client';

type DbClient = Prisma.TransactionClient | PrismaClient;

export interface AttributionAuditInput {
  tenantId: string;
  itemId?: string | null;
  inventoryId?: number | null;
  oldConsignorId?: string | null;
  newConsignorId?: string | null;
  oldConsignmentId?: string | null;
  newConsignmentId?: string | null;
  reason: string;
  station?: string | null;
  actorUserId: number;
}

export async function writeAttributionAudit(
  tx: DbClient,
  input: AttributionAuditInput,
): Promise<void> {
  await tx.attributionAudit.create({
    data: {
      tenantId: input.tenantId,
      itemId: input.itemId ?? null,
      inventoryId: input.inventoryId ?? null,
      oldConsignorId: input.oldConsignorId ?? null,
      newConsignorId: input.newConsignorId ?? null,
      oldConsignmentId: input.oldConsignmentId ?? null,
      newConsignmentId: input.newConsignmentId ?? null,
      reason: input.reason,
      station: input.station ?? null,
      actorUserId: input.actorUserId,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/audit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/audit.ts src/lib/inventory/audit.test.ts
git commit -m "feat(inventory): attribution audit write helper"
```

---

## Task 4: Reconcile engine — lot lookup + atomic depletion (R3) + ALREADY_DEPLETED

Build the core write primitive first: given a single resolved inventory lot, atomically deplete one unit and report failure when the lot is already empty. Higher-level scan resolution (Tasks 5–6) calls into this.

**Files:**
- Create: `web/src/lib/inventory/reconcile.ts`
- Create: `web/src/lib/inventory/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/inventory/reconcile.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { depleteOneUnit } from './reconcile';

describe('depleteOneUnit (R3 atomic guarded depletion)', () => {
  it('returns the updated row when qty was >= 1', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 5, qty: 2, source_type: 'consignment', consignor_id: 'c-1', consignment_id: 'g-1', cost: null },
      ]),
    };
    const row = await depleteOneUnit(tx as never, 't', 5);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(5);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns null (ALREADY_DEPLETED) when the guarded UPDATE matched zero rows', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const row = await depleteOneUnit(tx as never, 't', 5);
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: FAIL — `depleteOneUnit` not exported.

- [ ] **Step 3: Implement the depletion primitive + shared types**

Create `web/src/lib/inventory/reconcile.ts`:

```ts
import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = Prisma.TransactionClient | PrismaClient;

// Raw row shape returned by the guarded depletion UPDATE … RETURNING.
export interface DepletedLot {
  id: number;
  qty: number;
  source_type: string;
  consignor_id: string | null;
  consignment_id: string | null;
  cost: Prisma.Decimal | null;
}

/**
 * R3 — atomic guarded depletion. Decrements qty by 1 only if the row still has
 * stock, in a single statement so concurrent scans cannot both succeed. Returns
 * the updated row, or null when zero rows matched (already depleted / wrong
 * tenant / missing).
 */
export async function depleteOneUnit(
  tx: DbClient,
  tenantId: string,
  inventoryId: number,
): Promise<DepletedLot | null> {
  const rows = await tx.$queryRaw<DepletedLot[]>(Prisma.sql`
    UPDATE inventory
       SET qty = qty - 1, updated_at = now()
     WHERE id = ${inventoryId}
       AND tenant_id = ${tenantId}::uuid
       AND qty >= 1
    RETURNING id, qty, source_type, consignor_id, consignment_id, cost
  `);
  return rows.length === 1 ? rows[0] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/reconcile.ts src/lib/inventory/reconcile.test.ts
git commit -m "feat(reconcile): atomic guarded inventory depletion primitive (R3)"
```

---

## Task 5: Reconcile engine — scan resolution (labelCode unambiguous; UPC collision → ambiguous, R2)

Resolve a scan to exactly one lot. A `labelCode` scan is per-piece and unambiguous. A `upc` scan may match multiple source lots (owned + one or more consignments); with no `choice` it returns `{ ambiguous, lots }` and writes nothing.

**Files:**
- Modify: `web/src/lib/inventory/reconcile.ts`
- Modify: `web/src/lib/inventory/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/inventory/reconcile.test.ts`:

```ts
import { resolveScanLot } from './reconcile';

function lot(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, sourceType: 'owned', consignorId: null, consignmentId: null,
    upc: '012345678905', labelCode: null, qty: 1, cost: null, ...over,
  };
}

describe('resolveScanLot — labelCode path', () => {
  it('returns the single lot matched by labelCode', async () => {
    const tx = { inventory: { findFirst: vi.fn().mockResolvedValue(lot({ id: 7, sourceType: 'consignment', labelCode: 'ABCDEFGH7', consignmentId: 'g-1', consignorId: 'c-1' })) } };
    const r = await resolveScanLot(tx as never, 't', { labelCode: 'ABCDEFGH7' });
    expect(r.kind).toBe('lot');
    if (r.kind === 'lot') expect(r.lot.id).toBe(7);
  });

  it('returns not-found when the labelCode matches nothing', async () => {
    const tx = { inventory: { findFirst: vi.fn().mockResolvedValue(null) } };
    const r = await resolveScanLot(tx as never, 't', { labelCode: 'ABCDEFGH7' });
    expect(r.kind).toBe('not_found');
  });
});

describe('resolveScanLot — UPC path (R2 force choice)', () => {
  it('resolves directly when only one lot matches the UPC', async () => {
    const tx = { inventory: { findMany: vi.fn().mockResolvedValue([lot({ id: 3, sourceType: 'owned' })]) } };
    const r = await resolveScanLot(tx as never, 't', { upc: '012345678905' });
    expect(r.kind).toBe('lot');
    if (r.kind === 'lot') expect(r.lot.id).toBe(3);
  });

  it('returns ambiguous with the lot list when >1 source matches and no choice given', async () => {
    const tx = { inventory: { findMany: vi.fn().mockResolvedValue([
      lot({ id: 3, sourceType: 'owned' }),
      lot({ id: 4, sourceType: 'consignment', consignmentId: 'g-1', consignorId: 'c-1' }),
    ]) } };
    const r = await resolveScanLot(tx as never, 't', { upc: '012345678905' });
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.lots).toHaveLength(2);
      expect(r.lots.map((l) => l.id).sort()).toEqual([3, 4]);
    }
  });

  it('resolves to the chosen lot when choice.inventoryId is supplied on collision', async () => {
    const tx = { inventory: { findMany: vi.fn().mockResolvedValue([
      lot({ id: 3, sourceType: 'owned' }),
      lot({ id: 4, sourceType: 'consignment', consignmentId: 'g-1', consignorId: 'c-1' }),
    ]) } };
    const r = await resolveScanLot(tx as never, 't', { upc: '012345678905' }, { inventoryId: 4 });
    expect(r.kind).toBe('lot');
    if (r.kind === 'lot') expect(r.lot.id).toBe(4);
  });

  it('returns not-found when neither labelCode nor upc matches', async () => {
    const tx = { inventory: { findMany: vi.fn().mockResolvedValue([]) } };
    const r = await resolveScanLot(tx as never, 't', { upc: 'nope' });
    expect(r.kind).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: FAIL — `resolveScanLot` not exported.

- [ ] **Step 3: Implement scan resolution**

Append to `web/src/lib/inventory/reconcile.ts`:

```ts
export interface Lot {
  id: number;
  sourceType: string;
  consignorId: string | null;
  consignmentId: string | null;
  upc: string | null;
  labelCode: string | null;
  qty: number;
  cost: Prisma.Decimal | null;
}

export interface ScanInput {
  labelCode?: string;
  upc?: string;
}

export interface ScanChoice {
  inventoryId: number;
}

export type ScanResolution =
  | { kind: 'lot'; lot: Lot }
  | { kind: 'ambiguous'; lots: Lot[] }
  | { kind: 'not_found' };

const LOT_SELECT = {
  id: true, sourceType: true, consignorId: true, consignmentId: true,
  upc: true, labelCode: true, qty: true, cost: true,
} as const;

/**
 * R2 — resolve a scan to one lot. labelCode is per-piece (unambiguous). A UPC
 * may match several source lots; with no `choice` the caller must pick, so we
 * return `ambiguous` and write nothing.
 */
export async function resolveScanLot(
  tx: DbClient,
  tenantId: string,
  scan: ScanInput,
  choice?: ScanChoice,
): Promise<ScanResolution> {
  if (scan.labelCode) {
    // Non-null labelCode → safe to use the unique-ish lookup via findFirst.
    const lot = await tx.inventory.findFirst({
      where: { tenantId, labelCode: scan.labelCode },
      select: LOT_SELECT,
    });
    return lot ? { kind: 'lot', lot } : { kind: 'not_found' };
  }

  if (scan.upc) {
    const lots = await tx.inventory.findMany({
      where: { tenantId, upc: scan.upc },
      select: LOT_SELECT,
    });
    if (lots.length === 0) return { kind: 'not_found' };
    if (choice) {
      const picked = lots.find((l) => l.id === choice.inventoryId);
      return picked ? { kind: 'lot', lot: picked } : { kind: 'not_found' };
    }
    if (lots.length === 1) return { kind: 'lot', lot: lots[0] };
    return { kind: 'ambiguous', lots };
  }

  return { kind: 'not_found' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/reconcile.ts src/lib/inventory/reconcile.test.ts
git commit -m "feat(reconcile): scan resolution — labelCode + UPC collision force-choice (R2)"
```

---

## Task 6: Reconcile engine — `reconcileItem` orchestrator (link write R4 + status + audit + payout)

Tie it together: resolve the scan, atomically deplete (R3), write the frozen-attribution `ItemInventoryLink` (R4), write the `sold` movement, recompute `Item.reconciliationStatus` from all its links, set `Item.consignmentId` only for the single-source consignment case, write an audit row, and recompute the payout.

**Files:**
- Modify: `web/src/lib/inventory/reconcile.ts`
- Modify: `web/src/lib/inventory/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/inventory/reconcile.test.ts`:

```ts
import { reconcileItem } from './reconcile';

// A reusable mock tx whose behavior is tuned per test.
function fullTx(opts: {
  resolveFindFirst?: unknown;
  resolveFindMany?: unknown[];
  depleteRows?: unknown[];
  existingLinks?: unknown[];
}) {
  return {
    inventory: {
      findFirst: vi.fn().mockResolvedValue(opts.resolveFindFirst ?? null),
      findMany: vi.fn().mockResolvedValue(opts.resolveFindMany ?? []),
    },
    $queryRaw: vi.fn().mockResolvedValue(opts.depleteRows ?? []),
    itemInventoryLink: {
      create: vi.fn().mockResolvedValue({ id: 100 }),
      findMany: vi.fn().mockResolvedValue(opts.existingLinks ?? []),
    },
    inventoryMovement: { create: vi.fn().mockResolvedValue({ id: 200 }) },
    item: { update: vi.fn().mockResolvedValue({}) },
    attributionAudit: { create: vi.fn().mockResolvedValue({ id: 300 }) },
  };
}

// recomputeItemPayout is exercised separately; stub it here.
vi.mock('@/lib/consignor/recompute', () => ({
  recomputeItemPayout: vi.fn().mockResolvedValue(42),
}));

const BASE = { tenantId: 't', itemId: 'i-1', actorUserId: 9, station: 'pack-1' as string | undefined };

describe('reconcileItem', () => {
  it('clean consignment QR scan → link written with frozen attribution, status reconciled_consignment', async () => {
    const tx = fullTx({
      resolveFindFirst: { id: 7, sourceType: 'consignment', consignorId: 'c-1', consignmentId: 'g-1', upc: null, labelCode: 'ABCDEFGH7', qty: 1, cost: null },
      depleteRows: [{ id: 7, qty: 0, source_type: 'consignment', consignor_id: 'c-1', consignment_id: 'g-1', cost: null }],
      existingLinks: [{ sourceType: 'consignment', consignmentId: 'g-1' }],
    });
    const r = await reconcileItem(tx as never, { ...BASE, scan: { labelCode: 'ABCDEFGH7' } });
    expect(r.status).toBe('reconciled_consignment');
    // R4: link snapshots the lot's attribution
    const linkData = tx.itemInventoryLink.create.mock.calls[0][0].data;
    expect(linkData).toMatchObject({ inventoryId: 7, sourceType: 'consignment', consignorId: 'c-1', consignmentId: 'g-1', qty: 1, createdByUserId: 9 });
    // sold movement written against the depleted lot
    expect(tx.inventoryMovement.create.mock.calls[0][0].data).toMatchObject({ inventoryId: 7, qtyDelta: -1, sourceType: 'sold', itemId: 'i-1' });
    // single-source consignment → Item.consignmentId set
    const itemUpdate = tx.item.update.mock.calls.find((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.consignmentId !== undefined);
    expect(itemUpdate).toBeTruthy();
  });

  it('clean owned scan → status reconciled_owned, Item.consignmentId left null', async () => {
    const tx = fullTx({
      resolveFindMany: [{ id: 3, sourceType: 'owned', consignorId: null, consignmentId: null, upc: 'u', labelCode: null, qty: 2, cost: null }],
      depleteRows: [{ id: 3, qty: 1, source_type: 'owned', consignor_id: null, consignment_id: null, cost: null }],
      existingLinks: [{ sourceType: 'owned', consignmentId: null }],
    });
    const r = await reconcileItem(tx as never, { ...BASE, scan: { upc: 'u' } });
    expect(r.status).toBe('reconciled_owned');
  });

  it('UPC collision with no choice → ambiguous, NOTHING written (no deplete, no link)', async () => {
    const tx = fullTx({
      resolveFindMany: [
        { id: 3, sourceType: 'owned', consignorId: null, consignmentId: null, upc: 'u', labelCode: null, qty: 1, cost: null },
        { id: 4, sourceType: 'consignment', consignorId: 'c-1', consignmentId: 'g-1', upc: 'u', labelCode: null, qty: 1, cost: null },
      ],
    });
    const r = await reconcileItem(tx as never, { ...BASE, scan: { upc: 'u' } });
    expect(r.ambiguous).toBe(true);
    expect(r.lots?.map((l) => l.id).sort()).toEqual([3, 4]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.itemInventoryLink.create).not.toHaveBeenCalled();
  });

  it('double-scan against a depleted lot → ALREADY_DEPLETED, nothing else written', async () => {
    const tx = fullTx({
      resolveFindFirst: { id: 7, sourceType: 'consignment', consignorId: 'c-1', consignmentId: 'g-1', upc: null, labelCode: 'ABCDEFGH7', qty: 0, cost: null },
      depleteRows: [], // guarded UPDATE matched zero rows
    });
    const r = await reconcileItem(tx as never, { ...BASE, scan: { labelCode: 'ABCDEFGH7' } });
    expect(r.error).toBe('ALREADY_DEPLETED');
    expect(tx.itemInventoryLink.create).not.toHaveBeenCalled();
  });

  it('mixed sources on the same item → status reconciled_mixed, Item.consignmentId cleared', async () => {
    const tx = fullTx({
      resolveFindFirst: { id: 7, sourceType: 'consignment', consignorId: 'c-2', consignmentId: 'g-2', upc: null, labelCode: 'ABCDEFGH7', qty: 1, cost: null },
      depleteRows: [{ id: 7, qty: 0, source_type: 'consignment', consignor_id: 'c-2', consignment_id: 'g-2', cost: null }],
      existingLinks: [
        { sourceType: 'owned', consignmentId: null },
        { sourceType: 'consignment', consignmentId: 'g-2' },
      ],
    });
    const r = await reconcileItem(tx as never, { ...BASE, scan: { labelCode: 'ABCDEFGH7' } });
    expect(r.status).toBe('reconciled_mixed');
    const statusUpdate = tx.item.update.mock.calls.find((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data.reconciliationStatus === 'reconciled_mixed');
    expect((statusUpdate![0] as { data: Record<string, unknown> }).data.consignmentId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: FAIL — `reconcileItem` not exported.

- [ ] **Step 3: Implement the orchestrator**

First, **add these two imports to the TOP of `web/src/lib/inventory/reconcile.ts`** (alongside the existing `import { Prisma, PrismaClient } from '@prisma/client';` — imports must be at file top to satisfy ESLint `import/first`):

```ts
import { writeAttributionAudit } from './audit';
import { recomputeItemPayout } from '@/lib/consignor/recompute';
```

Then append the rest to the bottom of `web/src/lib/inventory/reconcile.ts`:

```ts
export interface ReconcileArgs {
  tenantId: string;
  itemId: string;
  scan: ScanInput;
  actorUserId: number;
  choice?: ScanChoice;
  station?: string;
}

export type ReconciledStatus =
  | 'reconciled_owned'
  | 'reconciled_consignment'
  | 'reconciled_mixed';

export interface ReconcileResult {
  status?: ReconciledStatus;
  linkId?: number;
  ambiguous?: boolean;
  badChoice?: boolean;       // a choice was given but matched none of the collision lots
  lots?: Lot[];
  error?: 'ALREADY_DEPLETED' | 'NOT_FOUND';
}

/**
 * Derive an item's reconciliation status from ALL of its links:
 *   every link owned            → reconciled_owned
 *   every link one consignment  → reconciled_consignment
 *   anything else (multi-source)→ reconciled_mixed
 */
function deriveStatus(
  links: Array<{ sourceType: string; consignmentId: string | null }>,
): { status: ReconciledStatus; consignmentId: string | null } {
  const allOwned = links.every((l) => l.sourceType === 'owned');
  if (allOwned) return { status: 'reconciled_owned', consignmentId: null };

  const consignmentIds = new Set(links.map((l) => l.consignmentId ?? '∅'));
  const allConsignment = links.every((l) => l.sourceType === 'consignment');
  if (allConsignment && consignmentIds.size === 1) {
    return { status: 'reconciled_consignment', consignmentId: links[0].consignmentId };
  }
  // Bundle / multi-source: payout recompute can't attribute to a single
  // consignment, so clear Item.consignmentId (per-link attribution lives on
  // ItemInventoryLink, which downstream reporting reads instead).
  return { status: 'reconciled_mixed', consignmentId: null };
}

export async function reconcileItem(
  tx: DbClient,
  args: ReconcileArgs,
): Promise<ReconcileResult> {
  const { tenantId, itemId, scan, actorUserId, choice, station } = args;

  const resolution = await resolveScanLot(tx, tenantId, scan, choice);
  if (resolution.kind === 'not_found') return { error: 'NOT_FOUND' };
  if (resolution.kind === 'ambiguous') return { ambiguous: true, lots: resolution.lots };
  if (resolution.kind === 'bad_choice') return { badChoice: true, lots: resolution.lots };

  // R3 — atomic guarded depletion. Zero rows → someone already took the unit.
  const depleted = await depleteOneUnit(tx, tenantId, resolution.lot.id);
  if (!depleted) return { error: 'ALREADY_DEPLETED' };

  // R4 — snapshot attribution onto the append-only link at write time.
  const link = await tx.itemInventoryLink.create({
    data: {
      tenantId,
      itemId,
      inventoryId: depleted.id,
      qty: 1,
      sourceType: depleted.source_type,
      consignorId: depleted.consignor_id,
      consignmentId: depleted.consignment_id,
      unitCost: depleted.cost,
      reason: scan.labelCode ? 'reconcile: labelCode scan' : 'reconcile: UPC scan',
      createdByUserId: actorUserId,
    },
  });

  await tx.inventoryMovement.create({
    data: {
      tenantId,
      inventoryId: depleted.id,
      qtyDelta: -1,
      sourceType: 'sold',
      itemId,
      createdByUserId: actorUserId,
      userId: actorUserId,
    },
  });

  // Recompute the item-level status from every link this item now has.
  const links = await tx.itemInventoryLink.findMany({
    where: { tenantId, itemId },
    select: { sourceType: true, consignmentId: true },
  });
  const { status, consignmentId } = deriveStatus(links);

  await tx.item.update({
    where: { id: itemId },
    data: { reconciliationStatus: status, consignmentId },
  });

  await writeAttributionAudit(tx, {
    tenantId,
    itemId,
    inventoryId: depleted.id,
    newConsignorId: depleted.consignor_id,
    newConsignmentId: depleted.consignment_id,
    reason: `reconcile → ${status}`,
    station,
    actorUserId,
  });

  // Keep payout in sync (no-op when not a single-source consignment).
  await recomputeItemPayout(tx, itemId);

  return { status, linkId: link.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory/reconcile.ts src/lib/inventory/reconcile.test.ts
git commit -m "feat(reconcile): reconcileItem orchestrator — link/movement/status/audit/payout (R4)"
```

---

## Task 7: Reconcile engine — `reverseReconciliation` (append-only correction, R5)

Corrections never mutate a link. Reversal writes a positive `+1` movement that restores the unit, references the original `sold` movement, flips `Item.reconciliationStatus` to `reversed`, voids the payout, and audits the change.

**Files:**
- Modify: `web/src/lib/inventory/reconcile.ts`
- Modify: `web/src/lib/inventory/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/inventory/reconcile.test.ts`:

```ts
import { reverseReconciliation } from './reconcile';

describe('reverseReconciliation (R5 append-only)', () => {
  it('restores the unit, flips status to reversed, voids payout, audits — without mutating the link', async () => {
    const tx = {
      itemInventoryLink: {
        findFirst: vi.fn().mockResolvedValue({
          id: 100, tenantId: 't', itemId: 'i-1', inventoryId: 7, sourceType: 'consignment',
          consignorId: 'c-1', consignmentId: 'g-1',
        }),
        update: vi.fn(),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      inventoryMovement: { create: vi.fn().mockResolvedValue({ id: 201 }) },
      item: { update: vi.fn().mockResolvedValue({}) },
      attributionAudit: { create: vi.fn().mockResolvedValue({ id: 301 }) },
    };
    const r = await reverseReconciliation(tx as never, {
      tenantId: 't', linkId: 100, reason: 'mis-scan', actorUserId: 9,
    });
    expect(r.reversed).toBe(true);
    // +1 restore movement, flagged as a reversal
    expect(tx.inventoryMovement.create.mock.calls[0][0].data).toMatchObject({ inventoryId: 7, qtyDelta: 1, sourceType: 'reversal', itemId: 'i-1' });
    // status flipped + payout voided
    const upd = tx.item.update.mock.calls[0][0].data;
    expect(upd.reconciliationStatus).toBe('reversed');
    expect(upd.consignorPayout).toBeNull();
    // append-only: the link row is NOT updated
    expect(tx.itemInventoryLink.update).not.toHaveBeenCalled();
    // audit written
    expect(tx.attributionAudit.create).toHaveBeenCalledTimes(1);
  });

  it('returns reversed=false when the link does not exist for this tenant', async () => {
    const tx = { itemInventoryLink: { findFirst: vi.fn().mockResolvedValue(null) } };
    const r = await reverseReconciliation(tx as never, {
      tenantId: 't', linkId: 999, reason: 'x', actorUserId: 9,
    });
    expect(r.reversed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: FAIL — `reverseReconciliation` not exported.

- [ ] **Step 3: Implement**

Append to `web/src/lib/inventory/reconcile.ts`:

```ts
export interface ReverseArgs {
  tenantId: string;
  linkId: number;
  reason: string;
  actorUserId: number;
  station?: string;
}

export async function reverseReconciliation(
  tx: DbClient,
  args: ReverseArgs,
): Promise<{ reversed: boolean }> {
  const { tenantId, linkId, reason, actorUserId, station } = args;

  const link = await tx.itemInventoryLink.findFirst({
    where: { id: linkId, tenantId },
  });
  if (!link) return { reversed: false };

  // Restore the depleted unit (append-only; not a mutation of the sold row).
  await tx.$executeRaw(Prisma.sql`
    UPDATE inventory SET qty = qty + ${link.qty}, updated_at = now()
     WHERE id = ${link.inventoryId} AND tenant_id = ${tenantId}::uuid
  `);

  await tx.inventoryMovement.create({
    data: {
      tenantId,
      inventoryId: link.inventoryId,
      qtyDelta: link.qty,
      sourceType: 'reversal',
      itemId: link.itemId,
      reason,
      createdByUserId: actorUserId,
      userId: actorUserId,
    },
  });

  await tx.item.update({
    where: { id: link.itemId },
    data: { reconciliationStatus: 'reversed', consignorPayout: null },
  });

  await writeAttributionAudit(tx, {
    tenantId,
    itemId: link.itemId,
    inventoryId: link.inventoryId,
    oldConsignorId: link.consignorId,
    oldConsignmentId: link.consignmentId,
    reason: `reverse-reconcile: ${reason}`,
    station,
    actorUserId,
  });

  return { reversed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory/reconcile.ts src/lib/inventory/reconcile.test.ts
git commit -m "feat(reconcile): append-only reverseReconciliation (R5)"
```

---

## Task 8: `POST /api/inventory/reconcile` route

Thin wrapper: auth + permission, tenant-scoped transaction, pass through the `ambiguous`/`error` shapes.

**Files:**
- Create: `web/src/app/api/inventory/reconcile/route.ts`
- Create: `web/src/app/api/inventory/reconcile/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/api/inventory/reconcile/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
}));
vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(err.message, { status: err.status ?? 500 });
  }),
}));
vi.mock('@/lib/inventory/reconcile', () => ({ reconcileItem: vi.fn() }));

import { getTenantContext, requirePermission } from '@/lib/tenant';
import { reconcileItem } from '@/lib/inventory/reconcile';
import { POST } from '../route';

function req(body: unknown) {
  return new Request('http://localhost/api/inventory/reconcile', {
    method: 'POST', body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 9, tenantId: 't', role: 'OWNER', overrides: [] });
});

describe('POST /api/inventory/reconcile', () => {
  it('400s when neither labelCode nor upc is provided', async () => {
    const res = await POST(req({ itemId: 'i-1' }));
    expect(res.status).toBe(400);
  });

  it('checks inventory.write permission', async () => {
    (reconcileItem as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'reconciled_owned', linkId: 1 });
    await POST(req({ itemId: 'i-1', upc: 'u' }));
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'inventory.write');
  });

  it('returns the ambiguous shape with 409 when the engine reports collision', async () => {
    (reconcileItem as ReturnType<typeof vi.fn>).mockResolvedValue({ ambiguous: true, lots: [{ id: 3 }, { id: 4 }] });
    const res = await POST(req({ itemId: 'i-1', upc: 'u' }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, ambiguous: true });
    expect(body.lots).toHaveLength(2);
  });

  it('returns 409 ALREADY_DEPLETED on double-scan', async () => {
    (reconcileItem as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'ALREADY_DEPLETED' });
    const res = await POST(req({ itemId: 'i-1', labelCode: 'ABCDEFGH7' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_DEPLETED');
  });

  it('returns 200 with the link + status on success', async () => {
    (reconcileItem as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'reconciled_consignment', linkId: 100 });
    const res = await POST(req({ itemId: 'i-1', labelCode: 'ABCDEFGH7' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: { status: 'reconciled_consignment', linkId: 100 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/inventory/reconcile/__tests__/route.test.ts"`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement**

Create `web/src/app/api/inventory/reconcile/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { reconcileItem } from '@/lib/inventory/reconcile';

export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantContext(request);
    requirePermission(ctx, 'inventory.write');

    const { itemId, labelCode, upc, choice, station } = await request.json();
    if (!itemId || typeof itemId !== 'string') {
      return NextResponse.json({ success: false, error: 'itemId required' }, { status: 400 });
    }
    if (!labelCode && !upc) {
      return NextResponse.json({ success: false, error: 'labelCode or upc required' }, { status: 400 });
    }

    const result = await prisma.$transaction((tx) =>
      reconcileItem(tx, {
        tenantId: ctx.tenantId,
        itemId,
        scan: { labelCode, upc },
        actorUserId: ctx.userId,
        choice: choice && typeof choice.inventoryId === 'number' ? { inventoryId: choice.inventoryId } : undefined,
        station: typeof station === 'string' ? station : undefined,
      }),
    );

    if (result.ambiguous) {
      return NextResponse.json({ success: false, ambiguous: true, lots: result.lots }, { status: 409 });
    }
    if (result.badChoice) {
      return NextResponse.json({ success: false, code: 'BAD_CHOICE', lots: result.lots }, { status: 409 });
    }
    if (result.error) {
      const status = result.error === 'NOT_FOUND' ? 404 : 409;
      return NextResponse.json({ success: false, code: result.error }, { status });
    }
    return NextResponse.json({ success: true, data: { status: result.status, linkId: result.linkId } });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/inventory/reconcile/__tests__/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/inventory/reconcile/route.ts" "src/app/api/inventory/reconcile/__tests__/route.test.ts"
git commit -m "feat(api): POST /api/inventory/reconcile"
```

---

## Task 9: `POST /api/inventory/reverse-reconcile` route

**Files:**
- Create: `web/src/app/api/inventory/reverse-reconcile/route.ts`
- Create: `web/src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) },
}));
vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(err.message, { status: err.status ?? 500 });
  }),
}));
vi.mock('@/lib/inventory/reconcile', () => ({ reverseReconciliation: vi.fn() }));

import { getTenantContext, requirePermission } from '@/lib/tenant';
import { reverseReconciliation } from '@/lib/inventory/reconcile';
import { POST } from '../route';

function req(body: unknown) {
  return new Request('http://localhost/api/inventory/reverse-reconcile', {
    method: 'POST', body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 9, tenantId: 't', role: 'OWNER', overrides: [] });
});

describe('POST /api/inventory/reverse-reconcile', () => {
  it('400s without linkId', async () => {
    expect((await POST(req({ reason: 'x' }))).status).toBe(400);
  });

  it('400s without reason', async () => {
    expect((await POST(req({ linkId: 1 }))).status).toBe(400);
  });

  it('requires inventory.write', async () => {
    (reverseReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({ reversed: true });
    await POST(req({ linkId: 1, reason: 'mis-scan' }));
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), 'inventory.write');
  });

  it('404s when the link is not found', async () => {
    (reverseReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({ reversed: false });
    expect((await POST(req({ linkId: 999, reason: 'x' }))).status).toBe(404);
  });

  it('200s on success', async () => {
    (reverseReconciliation as ReturnType<typeof vi.fn>).mockResolvedValue({ reversed: true });
    const res = await POST(req({ linkId: 1, reason: 'mis-scan' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts"`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement**

Create `web/src/app/api/inventory/reverse-reconcile/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { reverseReconciliation } from '@/lib/inventory/reconcile';

export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantContext(request);
    requirePermission(ctx, 'inventory.write');

    const { linkId, reason, station } = await request.json();
    if (typeof linkId !== 'number') {
      return NextResponse.json({ success: false, error: 'linkId required' }, { status: 400 });
    }
    if (!reason || typeof reason !== 'string') {
      return NextResponse.json({ success: false, error: 'reason required' }, { status: 400 });
    }

    const result = await prisma.$transaction((tx) =>
      reverseReconciliation(tx, {
        tenantId: ctx.tenantId,
        linkId,
        reason,
        actorUserId: ctx.userId,
        station: typeof station === 'string' ? station : undefined,
      }),
    );

    if (!result.reversed) {
      return NextResponse.json({ success: false, error: 'link not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/inventory/reverse-reconcile/route.ts" "src/app/api/inventory/reverse-reconcile/__tests__/route.test.ts"
git commit -m "feat(api): POST /api/inventory/reverse-reconcile"
```

---

## Task 10: Gate payout batching on eligibility (`create-payout.ts`)

`createConsignorPayout` currently sweeps every item with `consignorPaidAt: null` and a non-null payout. Add the eligibility gate so unreconciled / in-hold items are held back — while leaving `legacy_skipped` items (the entire existing book) untouched.

**Files:**
- Modify: `web/src/lib/consignor/create-payout.ts`
- Create: `web/src/lib/consignor/create-payout.eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/consignor/create-payout.eligibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterEligibleForPayout } from './create-payout';

const NOW = new Date('2026-06-01T00:00:00Z');
const longAgo = new Date('2026-05-01T00:00:00Z');
const recently = new Date('2026-05-28T00:00:00Z');

type Row = {
  id: string;
  reconciliationStatus: string;
  consignorPaidAt: Date | null;
  shippedAt: Date | null;
};

describe('filterEligibleForPayout', () => {
  it('keeps legacy_skipped items (existing book unchanged) regardless of ship date', () => {
    const rows: Row[] = [{ id: 'a', reconciliationStatus: 'legacy_skipped', consignorPaidAt: null, shippedAt: null }];
    expect(filterEligibleForPayout(rows, NOW).map((r) => r.id)).toEqual(['a']);
  });

  it('drops unreconciled and in-hold items but keeps settled past-window ones', () => {
    const rows: Row[] = [
      { id: 'unrec', reconciliationStatus: 'unreconciled', consignorPaidAt: null, shippedAt: longAgo },
      { id: 'hold', reconciliationStatus: 'reconciled_consignment', consignorPaidAt: null, shippedAt: recently },
      { id: 'ok', reconciliationStatus: 'reconciled_consignment', consignorPaidAt: null, shippedAt: longAgo },
    ];
    expect(filterEligibleForPayout(rows, NOW).map((r) => r.id)).toEqual(['ok']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/consignor/create-payout.eligibility.test.ts`
Expected: FAIL — `filterEligibleForPayout` not exported.

- [ ] **Step 3: Implement the filter and wire it in**

In `web/src/lib/consignor/create-payout.ts`:

Add the import near the top:

```ts
import { isPayoutEligible } from '@/lib/payout/eligibility';
```

Export a pure, testable filter (add above `createConsignorPayout`):

```ts
export function filterEligibleForPayout<
  T extends { reconciliationStatus: string; consignorPaidAt: Date | null; shippedAt: Date | null },
>(rows: T[], now: Date): T[] {
  return rows.filter((r) => isPayoutEligible(r, now));
}
```

Extend the item query `select` (add these fields) so the gate has its inputs:

```ts
      reconciliationStatus: true,
      consignorPaidAt: true,
      orderId: true,
```

After the `items` query and before the `if (items.length === 0)` check, resolve ship dates and apply the gate:

```ts
  // Resolve ship dates (Item has no Order relation; join by Order.id == orderId)
  // to enforce the 14-day refund hold. legacy_skipped items bypass the gate.
  const orderIds = [...new Set(items.map((it) => it.orderId).filter((x): x is string => !!x))];
  const orders = orderIds.length
    ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, shippedAt: true } })
    : [];
  const shippedAtByOrder = new Map(orders.map((o) => [o.id, o.shippedAt]));

  const eligibleRows = filterEligibleForPayout(
    items.map((it) => ({ ...it, shippedAt: it.orderId ? shippedAtByOrder.get(it.orderId) ?? null : null })),
    input.paidAt ?? new Date(),
  );
```

Then change the downstream code to use `eligibleRows` instead of `items`:
- The empty check: `if (eligibleRows.length === 0) throw new Error('No eligible items to settle');`
- The `total` reduce: iterate `eligibleRows`.
- The `for (const it of items)` settle loop: iterate `eligibleRows`.
- The `statementData.items` map: map over `eligibleRows`.

> Note: `eligibleRows` carries the extra `shippedAt`/`reconciliationStatus`/`orderId` fields; the existing `.consignorPayout`, `.itemTitle`, `.orderDate`, `.grossAmount`, `.netEarnings`, `.consignment` selections are all still present, so the statement builder is unaffected.

- [ ] **Step 4: Run the eligibility unit test**

Run: `npx vitest run src/lib/consignor/create-payout.eligibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression — existing payout math unchanged**

Run: `npx vitest run src/lib/consignor`
Expected: PASS — `compute-payout.test.ts` and any existing payout tests still green (legacy items default to `legacy_skipped`, so they remain eligible and the swept set is identical for the existing book).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/consignor/create-payout.ts src/lib/consignor/create-payout.eligibility.test.ts
git commit -m "feat(payout): gate consignor payout batching on reconciliation + 14-day hold"
```

---

## Final verification

- [ ] **Run the full inventory + payout suites**

Run: `npx vitest run src/lib/inventory src/lib/payout src/lib/consignor "src/app/api/inventory"`
Expected: all green.

- [ ] **Typecheck the whole package**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Tag the milestone**

```bash
git tag consignment-intake-m2-complete
```

---

## Acceptance criteria (from coordination plan M2) → task mapping

- [ ] `reconcile.ts`: clean owned scan → Task 6 (`reconciled_owned`)
- [ ] `reconcile.ts`: clean consignment QR scan → Task 6 (`reconciled_consignment`)
- [ ] `reconcile.ts`: UPC collision → `ambiguous` → Task 5 + Task 6
- [ ] `reconcile.ts`: UPC collision with `choice` → resolves → Task 5 (`choice.inventoryId`)
- [ ] `reconcile.ts`: double-scan → `ALREADY_DEPLETED` → Task 4 + Task 6
- [ ] `reconcile.ts`: R4 frozen attribution snapshot on the link → Task 6 (link `data` asserts snapshot)
- [ ] `reverseReconciliation` writes negative→positive restore movement, flips status to `reversed` → Task 7
- [ ] Route test for `/api/inventory/reconcile`: permission, tenant isolation, ambiguous shape → Task 8
- [ ] `eligibility.test.ts`: unreconciled / exception / in-window excluded, post-window included, paid path → Task 2
- [ ] `recompute`/payout regression: existing single-source consignment math unchanged → Task 10 Step 5

> **R4 note on the "mid-pack consignor change" acceptance case:** the engine snapshots `consignorId`/`consignmentId` onto the `ItemInventoryLink` at reconcile time (Task 6) and never reads back from `Inventory` for attribution. A later change to the lot's consignor therefore cannot alter an existing link — that invariant is what Task 6's link-`data` assertions lock in. A full concurrency/integration test against a live DB is deferred to the M2→M3 integration pass (logged as a follow-up, consistent with M1's deferred fresh-DB replay).

## Notes / non-goals
- **Real-DB concurrency** of the R3 guard is enforced by the SQL (`qty >= 1` in the same statement); unit tests assert the zero-rows code path, not Postgres locking. Add a `@vitest` integration test in the M3 pass if a test DB becomes available (Task 14 in the tracked follow-ups gates a clean test-DB setup).
- **`pending_sync`** (pack-time scan before order sync) is M3 scope, not here. M2 leaves the status vocabulary in place but does not queue.
- **DTO consumers (desktop M4)** read the Task 1 fields; no desktop change in this milestone.
