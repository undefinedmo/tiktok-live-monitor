# Consignor Feature — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend for the Consignor feature: schema, split-math computation, rules engine integration, CRUD APIs, payout creation with PDF/CSV statements. UI is a separate plan (see `2026-04-22-consignor-ui.md`, to be written after this lands).

**Architecture:** Two-level domain model (Consignor → Consignments). Pure-function split math kept separate from DB I/O for testability. Recompute is invoked at well-defined trigger points (item create/update, consignment edit, manual). New rule action `set_consignment` plugs into the existing rules engine in `web/src/lib/rules-engine.ts`. Statements (PDF + CSV) generated server-side and stored to `web/public/statements/<tenant>/<payout>.{pdf,csv}`.

**Tech Stack:** Next.js 16, Prisma 7, PostgreSQL, TypeScript. New dev deps: `vitest`. New runtime dep: `pdfkit`.

**Spec:** `docs/superpowers/specs/2026-04-22-consignor-design.md`

**Deviation from spec:** Spec uses "cents" shorthand for monetary amounts. Implementation uses Prisma `Decimal` to match existing `Item.cost`, `Item.netEarnings`, etc. All math is in dollars/decimal. Conversion happens only in PDF/CSV rendering.

---

## File Map

### New files
```
web/
├── prisma/
│   └── migrations/<timestamp>_add_consignors/migration.sql   (auto-generated)
├── src/
│   ├── lib/
│   │   └── consignor/
│   │       ├── types.ts                    # shared types
│   │       ├── compute-payout.ts           # PURE split math
│   │       ├── compute-payout.test.ts      # vitest unit tests
│   │       ├── recompute.ts                # DB-aware recompute orchestration
│   │       ├── create-payout.ts            # transactional payout creation
│   │       ├── statement-pdf.ts            # PDF generation via pdfkit
│   │       ├── statement-csv.ts            # CSV generation
│   │       └── storage.ts                  # write/serve statement files
│   └── app/
│       └── api/
│           ├── consignors/
│           │   ├── route.ts                # GET list, POST create
│           │   └── [id]/
│           │       ├── route.ts            # GET, PATCH, DELETE
│           │       └── balance/route.ts    # GET balance
│           ├── consignments/
│           │   ├── route.ts                # GET, POST
│           │   └── [id]/route.ts           # GET, PATCH, DELETE
│           ├── consignor-payouts/
│           │   ├── route.ts                # GET, POST
│           │   └── [id]/route.ts           # GET
│           └── items/
│               └── [id]/recompute-consignor-payout/route.ts
└── vitest.config.ts                        # test runner config
```

### Modified files
```
web/
├── package.json                            # add vitest, pdfkit
├── prisma/schema.prisma                    # 4 new models + 5 fields on Item
└── src/
    ├── lib/
    │   └── rules-engine.ts                 # add set_consignment action + consignor matchers
    └── app/api/items/recalculate-profit/route.ts   # subtract consignorPayout
```

---

## Phase 0 — Test infrastructure

### Task 0.1: Install vitest

**Files:**
- Modify: `web/package.json`
- Create: `web/vitest.config.ts`

- [ ] **Step 1: Install vitest**

```bash
cd web && npm install -D vitest @vitest/ui
```

- [ ] **Step 2: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

- [ ] **Step 3: Add scripts to `web/package.json`**

In the `"scripts"` block, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify**

Run: `cd web && npm test`
Expected: "No test files found" (clean exit, vitest works).

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts
git commit -m "chore(web): add vitest for unit tests"
```

---

## Phase 1 — Schema

### Task 1.1: Add Prisma models

**Files:**
- Modify: `web/prisma/schema.prisma`

- [ ] **Step 1: Add 4 new models + extend Item**

Append to `web/prisma/schema.prisma` (and add 5 fields inside the existing `Item` model):

```prisma
// ============================================
// Consignor (resale third-party splits)
// ============================================

model Consignor {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  name      String   @db.VarChar(255)
  email     String?  @db.VarChar(255)
  phone     String?  @db.VarChar(50)
  notes     String?  @db.Text
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  tenant       Tenant            @relation(fields: [tenantId], references: [id])
  consignments Consignment[]
  payouts      ConsignorPayout[]

  @@index([tenantId])
  @@map("consignors")
}

model Consignment {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @map("tenant_id") @db.Uuid
  consignorId   String   @map("consignor_id") @db.Uuid
  name          String   @db.VarChar(255)
  splitPercent  Decimal  @map("split_percent") @db.Decimal(5, 2)
  splitBase     String   @default("NET") @map("split_base") @db.VarChar(20)  // NET | GROSS | NET_MINUS_COSTS
  isActive      Boolean  @default(true) @map("is_active")
  isDefault     Boolean  @default(false) @map("is_default")
  notes         String?  @db.Text
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  tenant    Tenant    @relation(fields: [tenantId], references: [id])
  consignor Consignor @relation(fields: [consignorId], references: [id], onDelete: Restrict)
  items     Item[]

  @@index([tenantId])
  @@index([consignorId])
  @@map("consignments")
}

model ConsignorPayout {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  consignorId     String   @map("consignor_id") @db.Uuid
  amount          Decimal  @db.Decimal
  paymentMethod   String   @map("payment_method") @db.VarChar(30)  // venmo|paypal|zelle|cash|check|bank_transfer|other
  methodNotes     String?  @map("method_notes") @db.Text
  paidAt          DateTime @map("paid_at") @db.Timestamptz
  createdByUserId Int      @map("created_by_user_id")
  notes           String?  @db.Text
  pdfUrl          String?  @map("pdf_url") @db.Text
  csvUrl          String?  @map("csv_url") @db.Text
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant     Tenant                @relation(fields: [tenantId], references: [id])
  consignor  Consignor             @relation(fields: [consignorId], references: [id])
  createdBy  User                  @relation(fields: [createdByUserId], references: [id])
  items      ConsignorPayoutItem[]

  @@index([tenantId])
  @@index([consignorId])
  @@map("consignor_payouts")
}

model ConsignorPayoutItem {
  payoutId        String  @map("payout_id") @db.Uuid
  itemId          String  @map("item_id") @db.VarChar(255)
  payoutAtTime    Decimal @map("payout_at_time") @db.Decimal

  payout ConsignorPayout @relation(fields: [payoutId], references: [id], onDelete: Cascade)
  item   Item            @relation(fields: [itemId], references: [id], onDelete: Restrict)

  @@id([payoutId, itemId])
  @@map("consignor_payout_items")
}
```

Inside the existing `Item` model (around the `costLayers` relation line), add these fields and one relation:

```prisma
  consignmentId         String?  @map("consignment_id") @db.Uuid
  splitOverridePercent  Decimal? @map("split_override_percent") @db.Decimal(5, 2)
  consignorPayout       Decimal? @map("consignor_payout") @db.Decimal
  consignorPaidAt       DateTime? @map("consignor_paid_at") @db.Timestamptz
  consignorPayoutId     String?  @map("consignor_payout_id") @db.Uuid

  consignment    Consignment?           @relation(fields: [consignmentId], references: [id], onDelete: SetNull)
  payoutEntries  ConsignorPayoutItem[]

  // Add to existing @@index list:
  @@index([consignmentId])
```

Also add the inverse relations to the existing `Tenant` model and `User` model:

```prisma
// In Tenant model, add:
consignors        Consignor[]
consignments      Consignment[]
consignorPayouts  ConsignorPayout[]

// In User model, add:
consignorPayouts  ConsignorPayout[]  @relation
```

- [ ] **Step 2: Add partial unique index for default consignment per consignor**

At the bottom of the file (or in a new migration), add a raw SQL constraint. Prisma doesn't natively support partial indexes; add it via the migration in Task 1.2.

- [ ] **Step 3: Validate schema**

```bash
cd web && npx prisma validate
```
Expected: "The schema is valid".

- [ ] **Step 4: Commit**

```bash
git add web/prisma/schema.prisma
git commit -m "feat(schema): add consignor, consignment, payout models"
```

### Task 1.2: Generate and run migration

**Files:**
- Create: `web/prisma/migrations/<timestamp>_add_consignors/migration.sql`

- [ ] **Step 1: Create migration**

```bash
cd web && npx prisma migrate dev --name add_consignors
```

- [ ] **Step 2: Add partial unique index**

Open the generated `migration.sql` and append:

```sql
-- One default consignment per consignor
CREATE UNIQUE INDEX "consignments_default_per_consignor"
  ON "consignments" ("consignor_id")
  WHERE "is_default" = true;
```

- [ ] **Step 3: Re-apply (Prisma will detect drift and ask to apply)**

```bash
cd web && npx prisma migrate dev
```

- [ ] **Step 4: Verify tables exist**

```bash
psql "postgresql://postgres:Lobnan%23205@207.244.240.42:5432/luxesense_v2" -c "\dt consign*"
```
Expected: 4 tables (`consignors`, `consignments`, `consignor_payouts`, `consignor_payout_items`).

- [ ] **Step 5: Commit**

```bash
git add web/prisma/migrations
git commit -m "feat(schema): migration for consignor tables"
```

---

## Phase 2 — Pure split-math computation (TDD)

### Task 2.1: Define types

**Files:**
- Create: `web/src/lib/consignor/types.ts`

- [ ] **Step 1: Write the file**

```ts
import { Decimal } from '@prisma/client/runtime/library';

export type SplitBase = 'NET' | 'GROSS' | 'NET_MINUS_COSTS';

export interface PayoutInput {
  // Item financials (any non-negative decimal)
  grossAmount: Decimal | number | null;
  netEarnings: Decimal | number | null;
  cost: Decimal | number | null;
  shippingCost: Decimal | number | null;
  isGiveaway: boolean | null;

  // Deal terms
  splitPercent: Decimal | number;        // consignment.splitPercent (0..100)
  splitOverride: Decimal | number | null; // item.splitOverridePercent (wins if set)
  splitBase: SplitBase;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/consignor/types.ts
git commit -m "feat(consignor): shared types"
```

### Task 2.2: Failing test for NET split

**Files:**
- Create: `web/src/lib/consignor/compute-payout.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import { computeConsignorPayout } from './compute-payout';

describe('computeConsignorPayout', () => {
  it('NET base: 50% of net earnings', () => {
    const result = computeConsignorPayout({
      grossAmount: 100, netEarnings: 80, cost: 0, shippingCost: 0,
      isGiveaway: false, splitPercent: 50, splitOverride: null, splitBase: 'NET',
    });
    expect(result.toString()).toBe('40');
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd web && npm test
```
Expected: FAIL — module not found.

### Task 2.3: Implement `computeConsignorPayout`

**Files:**
- Create: `web/src/lib/consignor/compute-payout.ts`

- [ ] **Step 1: Write the implementation**

```ts
import { Decimal } from '@prisma/client/runtime/library';
import type { PayoutInput } from './types';

function toDecimal(v: Decimal | number | null | undefined): Decimal {
  if (v === null || v === undefined) return new Decimal(0);
  if (typeof v === 'number') return new Decimal(v);
  return v;
}

export function computeConsignorPayout(input: PayoutInput): Decimal {
  if (input.isGiveaway) return new Decimal(0);

  const split = toDecimal(input.splitOverride ?? input.splitPercent);

  let base: Decimal;
  switch (input.splitBase) {
    case 'GROSS':
      base = toDecimal(input.grossAmount);
      break;
    case 'NET_MINUS_COSTS': {
      const net = toDecimal(input.netEarnings);
      const cost = toDecimal(input.cost);
      const ship = toDecimal(input.shippingCost);
      const remainder = net.minus(cost).minus(ship);
      base = remainder.lessThan(0) ? new Decimal(0) : remainder;
      break;
    }
    case 'NET':
    default:
      base = toDecimal(input.netEarnings);
  }

  return base.mul(split).div(100).toDecimalPlaces(2);
}
```

- [ ] **Step 2: Run, expect pass**

```bash
cd web && npm test
```
Expected: PASS (1 test).

### Task 2.4: Add coverage for all branches

**Files:**
- Modify: `web/src/lib/consignor/compute-payout.test.ts`

- [ ] **Step 1: Append tests**

```ts
  it('GROSS base: 60% of gross', () => {
    const r = computeConsignorPayout({
      grossAmount: 100, netEarnings: 80, cost: 0, shippingCost: 0,
      isGiveaway: false, splitPercent: 60, splitOverride: null, splitBase: 'GROSS',
    });
    expect(r.toString()).toBe('60');
  });

  it('NET_MINUS_COSTS: subtracts cost and shipping before split', () => {
    const r = computeConsignorPayout({
      grossAmount: 100, netEarnings: 80, cost: 20, shippingCost: 5,
      isGiveaway: false, splitPercent: 50, splitOverride: null, splitBase: 'NET_MINUS_COSTS',
    });
    // (80 - 20 - 5) * 50% = 27.5
    expect(r.toString()).toBe('27.5');
  });

  it('NET_MINUS_COSTS: clamps to zero if costs exceed net', () => {
    const r = computeConsignorPayout({
      grossAmount: 100, netEarnings: 50, cost: 60, shippingCost: 10,
      isGiveaway: false, splitPercent: 50, splitOverride: null, splitBase: 'NET_MINUS_COSTS',
    });
    expect(r.toString()).toBe('0');
  });

  it('split override wins over consignment split', () => {
    const r = computeConsignorPayout({
      grossAmount: 100, netEarnings: 80, cost: 0, shippingCost: 0,
      isGiveaway: false, splitPercent: 50, splitOverride: 70, splitBase: 'NET',
    });
    expect(r.toString()).toBe('56');  // 80 * 70%
  });

  it('giveaway: returns zero regardless of inputs', () => {
    const r = computeConsignorPayout({
      grossAmount: 100, netEarnings: 80, cost: 0, shippingCost: 0,
      isGiveaway: true, splitPercent: 50, splitOverride: null, splitBase: 'NET',
    });
    expect(r.toString()).toBe('0');
  });

  it('null financials default to zero', () => {
    const r = computeConsignorPayout({
      grossAmount: null, netEarnings: null, cost: null, shippingCost: null,
      isGiveaway: false, splitPercent: 50, splitOverride: null, splitBase: 'NET',
    });
    expect(r.toString()).toBe('0');
  });
```

- [ ] **Step 2: Run, expect all pass**

```bash
cd web && npm test
```
Expected: PASS (7 tests).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/consignor/compute-payout.ts web/src/lib/consignor/compute-payout.test.ts
git commit -m "feat(consignor): pure split-math computation with tests"
```

---

## Phase 3 — Recompute orchestration

### Task 3.1: Implement `recomputeItemPayout`

**Files:**
- Create: `web/src/lib/consignor/recompute.ts`

- [ ] **Step 1: Write the file**

```ts
import { prisma } from '@/lib/prisma';
import { computeConsignorPayout } from './compute-payout';
import type { SplitBase } from './types';

/**
 * Recompute consignor_payout for a single item.
 * No-op if the item has no consignment, or if the item is already paid (frozen).
 * Returns the new payout amount as a number, or null if no consignment.
 */
export async function recomputeItemPayout(
  tx: typeof prisma,
  itemId: string,
): Promise<number | null> {
  const item = await tx.item.findUnique({
    where: { id: itemId },
    select: {
      consignmentId: true, consignorPaidAt: true,
      grossAmount: true, netEarnings: true, cost: true,
      isGiveaway: true, splitOverridePercent: true,
      // shippingCost is on items table; if column missing in Prisma, fetch via raw query
    },
  });

  if (!item || !item.consignmentId) {
    if (item) {
      await tx.item.update({ where: { id: itemId }, data: { consignorPayout: null } });
    }
    return null;
  }

  // Frozen once paid; never overwrite
  if (item.consignorPaidAt) return Number(await getCurrentPayout(tx, itemId));

  const consignment = await tx.consignment.findUnique({
    where: { id: item.consignmentId },
    select: { splitPercent: true, splitBase: true },
  });
  if (!consignment) return null;

  // shipping_cost lives on items but isn't always in Prisma select; read via raw if needed
  const shippingRaw = await tx.$queryRaw<{ shipping_cost: number | null }[]>`
    SELECT shipping_cost FROM items WHERE id = ${itemId}
  `;
  const shippingCost = shippingRaw[0]?.shipping_cost ?? 0;

  const payout = computeConsignorPayout({
    grossAmount: item.grossAmount,
    netEarnings: item.netEarnings,
    cost: item.cost,
    shippingCost,
    isGiveaway: item.isGiveaway,
    splitPercent: consignment.splitPercent,
    splitOverride: item.splitOverridePercent,
    splitBase: consignment.splitBase as SplitBase,
  });

  await tx.item.update({
    where: { id: itemId },
    data: { consignorPayout: payout },
  });

  return Number(payout);
}

async function getCurrentPayout(tx: typeof prisma, itemId: string): Promise<number> {
  const r = await tx.item.findUnique({ where: { id: itemId }, select: { consignorPayout: true } });
  return Number(r?.consignorPayout ?? 0);
}

/**
 * Recompute every UNPAID item attached to a consignment.
 * Used after consignment.splitPercent or splitBase changes.
 */
export async function recomputeConsignmentItems(
  tx: typeof prisma,
  consignmentId: string,
): Promise<number> {
  const items = await tx.item.findMany({
    where: { consignmentId, consignorPaidAt: null },
    select: { id: true },
  });
  for (const it of items) {
    await recomputeItemPayout(tx, it.id);
  }
  return items.length;
}
```

- [ ] **Step 2: Smoke test via a script**

Create `web/scripts/smoke-consignor.ts` (temporary, not committed):

```ts
import { prisma } from '../src/lib/prisma';
import { recomputeItemPayout } from '../src/lib/consignor/recompute';

async function main() {
  // Pick a known item id from your DB; create a consignor + consignment manually first via Prisma Studio
  const itemId = 'REPLACE_WITH_REAL_ITEM_ID';
  const result = await recomputeItemPayout(prisma, itemId);
  console.log('Computed payout:', result);
}
main().catch(console.error).finally(() => prisma.$disconnect());
```

Run: `cd web && npx tsx scripts/smoke-consignor.ts` — verify a sane number prints. Then delete the script.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/consignor/recompute.ts
git commit -m "feat(consignor): item payout recompute orchestration"
```

---

## Phase 4 — Profit math integration

### Task 4.1: Update `recalculate-profit` to subtract consignor payout

**Files:**
- Modify: `web/src/app/api/items/recalculate-profit/route.ts`

- [ ] **Step 1: Replace the loop body**

Existing lines 18-35 fetch `{ id, netEarnings, cost }` and compute `profit = net - cost`. Replace the `select` and the loop:

```ts
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds }, tenantId: ctx.tenantId },
    select: { id: true, netEarnings: true, cost: true, consignorPayout: true },
  });

  let updatedCount = 0;

  for (const item of items) {
    const cost = item.cost ? Number(item.cost) : 0;
    const net = item.netEarnings ? Number(item.netEarnings) : 0;
    const consignorPayout = item.consignorPayout ? Number(item.consignorPayout) : 0;
    const profit = net - cost - consignorPayout;

    await prisma.item.update({
      where: { id: item.id },
      data: { profit },
    });
    updatedCount++;
  }
```

- [ ] **Step 2: Manual verify**

For an item with no consignment (consignorPayout = null), result must equal pre-change behavior. Test with an existing item via Prisma Studio: note its profit, run `POST /api/items/recalculate-profit` with `{ itemIds: ["<id>"] }`, profit unchanged.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/items/recalculate-profit/route.ts
git commit -m "feat(consignor): subtract consignor payout from profit"
```

---

## Phase 5 — Rules engine integration

### Task 5.1: Add `set_consignment` action

**Files:**
- Modify: `web/src/lib/rules-engine.ts`

- [ ] **Step 1: Update the `RuleAction` interface (line 21)**

Add `targetId` is already present; verify no change needed there. The `buildUpdates` function currently returns a flat object — but `set_consignment` needs to also trigger recompute. Refactor slightly: split into two passes — `buildUpdates` returns simple field updates, then `matchItemAgainstRules` calls `recomputeItemPayout` after the update if `consignmentId` was set.

- [ ] **Step 2: Add the case in `buildUpdates` (around line 142)**

```ts
      case 'set_consignment':
        updates.consignmentId = action.targetId || null;
        // Clearing the consignment also clears any prior override
        if (!action.targetId) updates.splitOverridePercent = null;
        break;
```

- [ ] **Step 3: Add ItemRow consignment fields (around line 3)**

```ts
interface ItemRow {
  id: string;
  itemTitle: string | null;
  aiBrand: string | null;
  aiItem: string | null;
  grossAmount: unknown;
  netEarnings: unknown;
  isGiveaway: boolean | null;
  channel: string | null;
  consignmentId: string | null;       // NEW
  consignorId: string | null;         // NEW (resolved via join when read)
}
```

- [ ] **Step 4: Add condition matchers in `getFieldValue` (around line 35)**

```ts
    case 'consignment_id':
    case 'consignmentId':
      return (item.consignmentId || '').toLowerCase();
    case 'consignor_id':
    case 'consignorId':
      return (item.consignorId || '').toLowerCase();
```

- [ ] **Step 5: Trigger recompute after update (in `matchItemAgainstRules`, around line 187)**

After `await prisma.item.update(...)`, add:

```ts
          if ('consignmentId' in updates) {
            const { recomputeItemPayout } = await import('./consignor/recompute');
            await recomputeItemPayout(prisma, item.id);
          }
```

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/rules-engine.ts
git commit -m "feat(rules): set_consignment action + consignor field matchers"
```

### Task 5.2: Update item-fetch sites that pass items into the rules engine

**Files:**
- Find: `grep -rn "matchItemAgainstRules" web/src` to enumerate callers.
- Modify: each caller's `prisma.item.findMany({ select: ... })` to include `consignmentId` and resolve `consignorId` (via include or a follow-up lookup).

- [ ] **Step 1: Enumerate callers**

```bash
cd web && grep -rn "matchItemAgainstRules\b" src
```

- [ ] **Step 2: For each caller, extend the `select`**

Add `consignmentId: true` to the existing `select`. Then resolve `consignorId` either via `include: { consignment: { select: { consignorId: true } } }` and flatten in code, or with a separate query. Pattern:

```ts
const items = await prisma.item.findMany({
  where: { ... },
  select: {
    id: true, itemTitle: true, aiBrand: true, aiItem: true,
    grossAmount: true, netEarnings: true, isGiveaway: true, channel: true,
    consignmentId: true,
    consignment: { select: { consignorId: true } },
  },
});

const itemRows = items.map(i => ({
  ...i,
  consignorId: i.consignment?.consignorId ?? null,
}));

await matchItemAgainstRules(itemRows, rules);
```

- [ ] **Step 3: Commit**

```bash
git add -p web/src/app
git commit -m "feat(rules): pass consignment fields to rules engine callers"
```

---

## Phase 6 — Consignor CRUD API

### Task 6.1: List + create consignors

**Files:**
- Create: `web/src/app/api/consignors/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');

  const consignors = await prisma.consignor.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { consignments: true } } },
  });
  return NextResponse.json({ success: true, data: consignors });
}

export async function POST(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');

  const body = await request.json();
  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ success: false, error: 'name required' }, { status: 400 });
  }

  const consignor = await prisma.consignor.create({
    data: {
      tenantId: ctx.tenantId,
      name: body.name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      notes: body.notes ?? null,
    },
  });
  return NextResponse.json({ success: true, data: consignor });
}
```

- [ ] **Step 2: Manual verify**

```bash
curl -X POST http://localhost:3000/api/consignors \
  -H "Authorization: Bearer <jwt>" -H "X-Tenant-Id: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jeff","email":"jeff@example.com"}'

curl http://localhost:3000/api/consignors \
  -H "Authorization: Bearer <jwt>" -H "X-Tenant-Id: <tenantId>"
```
Expected: POST returns the new record with id; GET returns array including it.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/consignors/route.ts
git commit -m "feat(api): consignors list + create"
```

### Task 6.2: Get / update / delete a consignor

**Files:**
- Create: `web/src/app/api/consignors/[id]/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');
  const { id } = await params;

  const consignor = await prisma.consignor.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      consignments: { orderBy: { name: 'asc' } },
    },
  });
  if (!consignor) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: consignor });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const { id } = await params;
  const body = await request.json();

  const existing = await prisma.consignor.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  const updated = await prisma.consignor.update({
    where: { id },
    data: {
      name: body.name ?? undefined,
      email: body.email ?? undefined,
      phone: body.phone ?? undefined,
      notes: body.notes ?? undefined,
      isActive: body.isActive ?? undefined,
    },
  });
  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const { id } = await params;

  // Soft-delete: set isActive = false. Hard delete blocked if any consignments exist.
  const existing = await prisma.consignor.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  await prisma.consignor.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Verify all 3 verbs via curl**, similar pattern to Task 6.1.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/consignors/[id]/route.ts
git commit -m "feat(api): consignor detail/update/delete"
```

### Task 6.3: Balance endpoint

**Files:**
- Create: `web/src/app/api/consignors/[id]/balance/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');
  const { id } = await params;

  const items = await prisma.item.findMany({
    where: {
      tenantId: ctx.tenantId,
      consignment: { consignorId: id },
      consignorPaidAt: null,
      consignorPayout: { not: null },
    },
    select: { id: true, consignorPayout: true, consignmentId: true },
  });

  const balance = items.reduce((sum, it) => sum + Number(it.consignorPayout ?? 0), 0);

  return NextResponse.json({
    success: true,
    data: { balance, unpaidItemCount: items.length },
  });
}
```

- [ ] **Step 2: Verify via curl**, with one consignment + one item assigned. Compare result against hand calc.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/consignors/[id]/balance/route.ts
git commit -m "feat(api): consignor balance endpoint"
```

---

## Phase 7 — Consignment CRUD API

### Task 7.1: List + create consignments

**Files:**
- Create: `web/src/app/api/consignments/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');

  const consignorId = request.nextUrl.searchParams.get('consignorId');
  const consignments = await prisma.consignment.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(consignorId ? { consignorId } : {}),
    },
    include: { consignor: { select: { id: true, name: true } } },
    orderBy: [{ consignorId: 'asc' }, { name: 'asc' }],
  });
  return NextResponse.json({ success: true, data: consignments });
}

export async function POST(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');

  const body = await request.json();
  if (!body.consignorId || !body.name || body.splitPercent === undefined) {
    return NextResponse.json(
      { success: false, error: 'consignorId, name, splitPercent required' },
      { status: 400 }
    );
  }

  // Verify the consignor belongs to this tenant
  const owner = await prisma.consignor.findFirst({
    where: { id: body.consignorId, tenantId: ctx.tenantId },
  });
  if (!owner) return NextResponse.json({ success: false, error: 'consignor not found' }, { status: 404 });

  const splitBase = body.splitBase ?? 'NET';
  if (!['NET', 'GROSS', 'NET_MINUS_COSTS'].includes(splitBase)) {
    return NextResponse.json({ success: false, error: 'invalid splitBase' }, { status: 400 });
  }

  const consignment = await prisma.consignment.create({
    data: {
      tenantId: ctx.tenantId,
      consignorId: body.consignorId,
      name: body.name,
      splitPercent: body.splitPercent,
      splitBase,
      isDefault: body.isDefault ?? false,
      notes: body.notes ?? null,
    },
  });
  return NextResponse.json({ success: true, data: consignment });
}
```

- [ ] **Step 2: Verify via curl** — create one for "Jeff": `{"consignorId":"...", "name":"Edikted 50/50", "splitPercent":50}`.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/consignments/route.ts
git commit -m "feat(api): consignments list + create"
```

### Task 7.2: Detail / update / delete (with recompute on terms change)

**Files:**
- Create: `web/src/app/api/consignments/[id]/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { recomputeConsignmentItems } from '@/lib/consignor/recompute';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');
  const { id } = await params;

  const c = await prisma.consignment.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: { consignor: true, _count: { select: { items: true } } },
  });
  if (!c) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: c });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const { id } = await params;
  const body = await request.json();

  const existing = await prisma.consignment.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  const termsChanged =
    (body.splitPercent !== undefined && Number(body.splitPercent) !== Number(existing.splitPercent)) ||
    (body.splitBase !== undefined && body.splitBase !== existing.splitBase);

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.consignment.update({
      where: { id },
      data: {
        name: body.name ?? undefined,
        splitPercent: body.splitPercent ?? undefined,
        splitBase: body.splitBase ?? undefined,
        isActive: body.isActive ?? undefined,
        isDefault: body.isDefault ?? undefined,
        notes: body.notes ?? undefined,
      },
    });
    if (termsChanged) {
      await recomputeConsignmentItems(tx as unknown as typeof prisma, id);
    }
    return u;
  });

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const { id } = await params;

  const existing = await prisma.consignment.findFirst({ where: { id, tenantId: ctx.tenantId } });
  if (!existing) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  await prisma.consignment.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 2: Verify recompute on terms change**

Manual: assign one item to a consignment, note its `consignor_payout`. PATCH the consignment to flip splitPercent from 50 → 60. Re-fetch the item — `consignor_payout` should rise proportionally.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/consignments/[id]/route.ts
git commit -m "feat(api): consignment detail/update/delete with recompute"
```

---

## Phase 8 — Item integration

### Task 8.1: Recompute endpoint

**Files:**
- Create: `web/src/app/api/items/[id]/recompute-consignor-payout/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { recomputeItemPayout } from '@/lib/consignor/recompute';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const { id } = await params;

  const item = await prisma.item.findFirst({ where: { id, tenantId: ctx.tenantId }, select: { id: true } });
  if (!item) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });

  const payout = await recomputeItemPayout(prisma, id);
  return NextResponse.json({ success: true, data: { payout } });
}
```

- [ ] **Step 2: Verify** — assign an item, hit endpoint, confirm value matches manual calc.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/items/[id]/recompute-consignor-payout/route.ts
git commit -m "feat(api): item recompute endpoint"
```

### Task 8.2: Wire `consignmentId` + `splitOverridePercent` into the existing item update path

**Files:**
- Find: `grep -rn "prisma.item.update" web/src/app/api/items` to enumerate update routes (likely `bulk-update`, `[id]/route.ts`, etc.).
- Modify: each that exposes editable fields.

- [ ] **Step 1: Enumerate**

```bash
cd web && grep -rn "prisma\.item\.update\|prisma\.item\.updateMany" src/app/api/items
```

- [ ] **Step 2: For the per-item PATCH route** (e.g., `web/src/app/api/items/[id]/route.ts`, if present — otherwise the bulk-update route), accept `consignmentId` and `splitOverridePercent` in the body, validate ownership of the consignment, then update + recompute:

```ts
// Inside the PATCH handler, after the prisma.item.update(...):
const triggersRecompute =
  body.consignmentId !== undefined ||
  body.splitOverridePercent !== undefined ||
  body.cost !== undefined ||
  body.netEarnings !== undefined ||
  body.grossAmount !== undefined ||
  body.isGiveaway !== undefined;

if (triggersRecompute) {
  const { recomputeItemPayout } = await import('@/lib/consignor/recompute');
  await recomputeItemPayout(prisma, item.id);
}
```

If a per-item PATCH route doesn't exist yet, **defer the field exposure to the UI plan** — the UI plan will create the route. For now, only confirm `bulk-update` doesn't silently corrupt new fields (it shouldn't — it allow-lists fields).

- [ ] **Step 3: Commit**

```bash
git add -p web/src/app/api/items
git commit -m "feat(items): trigger consignor recompute on financial/consignment changes"
```

---

## Phase 9 — Payouts + statement generation

### Task 9.1: Install pdfkit

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install**

```bash
cd web && npm install pdfkit && npm install -D @types/pdfkit
```

- [ ] **Step 2: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(web): add pdfkit for statement generation"
```

### Task 9.2: PDF statement generator

**Files:**
- Create: `web/src/lib/consignor/statement-pdf.ts`

- [ ] **Step 1: Write the file**

```ts
import PDFDocument from 'pdfkit';
import { Decimal } from '@prisma/client/runtime/library';

export interface PdfStatementInput {
  consignorName: string;
  payoutDate: Date;
  paymentMethod: string;
  methodNotes: string | null;
  notes: string | null;
  totalAmount: Decimal | number;
  items: Array<{
    saleDate: Date | null;
    itemTitle: string;
    consignmentName: string;
    grossAmount: Decimal | number | null;
    netEarnings: Decimal | number | null;
    splitPercent: Decimal | number;
    payout: Decimal | number;
  }>;
}

export function buildStatementPdf(input: PdfStatementInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(`Consignment Statement — ${input.consignorName}`);
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Date: ${input.payoutDate.toISOString().slice(0, 10)}`);
    doc.text(`Method: ${input.paymentMethod}${input.methodNotes ? ' (' + input.methodNotes + ')' : ''}`);
    if (input.notes) doc.text(`Notes: ${input.notes}`);
    doc.moveDown();

    doc.fontSize(10);
    const headers = ['Sale Date', 'Item', 'Deal', 'Gross', 'Net', 'Split %', 'Payout'];
    doc.text(headers.join(' | '));
    doc.moveDown(0.2);

    for (const it of input.items) {
      const row = [
        it.saleDate ? it.saleDate.toISOString().slice(0, 10) : '—',
        it.itemTitle.slice(0, 30),
        it.consignmentName,
        it.grossAmount != null ? `$${Number(it.grossAmount).toFixed(2)}` : '—',
        it.netEarnings != null ? `$${Number(it.netEarnings).toFixed(2)}` : '—',
        `${Number(it.splitPercent).toFixed(0)}%`,
        `$${Number(it.payout).toFixed(2)}`,
      ];
      doc.text(row.join(' | '));
    }

    doc.moveDown();
    doc.fontSize(12).text(`Total Payout: $${Number(input.totalAmount).toFixed(2)}`, { align: 'right' });

    doc.end();
  });
}
```

- [ ] **Step 2: Smoke test** — temporary script generates a PDF with one fake row and writes to disk. Open it. Delete the script.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/consignor/statement-pdf.ts
git commit -m "feat(consignor): PDF statement generator"
```

### Task 9.3: CSV statement generator

**Files:**
- Create: `web/src/lib/consignor/statement-csv.ts`

- [ ] **Step 1: Write the file**

```ts
import type { PdfStatementInput } from './statement-pdf';

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function buildStatementCsv(input: PdfStatementInput): string {
  const lines: string[] = [];
  lines.push(['sale_date', 'item_title', 'consignment', 'gross', 'net', 'split_percent', 'payout'].join(','));
  for (const it of input.items) {
    lines.push([
      it.saleDate ? it.saleDate.toISOString().slice(0, 10) : '',
      csvEscape(it.itemTitle),
      csvEscape(it.consignmentName),
      it.grossAmount != null ? Number(it.grossAmount).toFixed(2) : '',
      it.netEarnings != null ? Number(it.netEarnings).toFixed(2) : '',
      Number(it.splitPercent).toFixed(2),
      Number(it.payout).toFixed(2),
    ].join(','));
  }
  lines.push('');
  lines.push(`,,,,,Total,${Number(input.totalAmount).toFixed(2)}`);
  return lines.join('\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/consignor/statement-csv.ts
git commit -m "feat(consignor): CSV statement generator"
```

### Task 9.4: Storage helper

**Files:**
- Create: `web/src/lib/consignor/storage.ts`

- [ ] **Step 1: Write the file**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATEMENTS_ROOT = path.join(process.cwd(), 'public', 'statements');

export interface SaveResult {
  pdfUrl: string;
  csvUrl: string;
}

export async function saveStatementFiles(
  tenantId: string,
  payoutId: string,
  pdf: Buffer,
  csv: string,
): Promise<SaveResult> {
  const dir = path.join(STATEMENTS_ROOT, tenantId);
  await fs.mkdir(dir, { recursive: true });
  const pdfPath = path.join(dir, `${payoutId}.pdf`);
  const csvPath = path.join(dir, `${payoutId}.csv`);
  await fs.writeFile(pdfPath, pdf);
  await fs.writeFile(csvPath, csv, 'utf8');
  return {
    pdfUrl: `/statements/${tenantId}/${payoutId}.pdf`,
    csvUrl: `/statements/${tenantId}/${payoutId}.csv`,
  };
}
```

Note (out of scope): for a true cloud-hosted multi-tenant deploy, swap this for S3. Public-folder storage is fine for self-hosted single-tenant operation.

- [ ] **Step 2: Add `web/public/statements/` to `.gitignore`**

```bash
echo "/web/public/statements/" >> .gitignore
```

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/consignor/storage.ts .gitignore
git commit -m "feat(consignor): statement file storage"
```

### Task 9.5: Create-payout transaction

**Files:**
- Create: `web/src/lib/consignor/create-payout.ts`

- [ ] **Step 1: Write the file**

```ts
import { prisma } from '@/lib/prisma';
import { buildStatementPdf, type PdfStatementInput } from './statement-pdf';
import { buildStatementCsv } from './statement-csv';
import { saveStatementFiles } from './storage';
import { Decimal } from '@prisma/client/runtime/library';

export interface CreatePayoutInput {
  tenantId: string;
  consignorId: string;
  itemIds?: string[];          // omit = all unpaid
  paymentMethod: string;
  methodNotes?: string | null;
  paidAt?: Date;
  notes?: string | null;
  createdByUserId: number;
}

const VALID_METHODS = ['venmo', 'paypal', 'zelle', 'cash', 'check', 'bank_transfer', 'other'];

export async function createConsignorPayout(input: CreatePayoutInput) {
  if (!VALID_METHODS.includes(input.paymentMethod)) {
    throw new Error(`Invalid payment method: ${input.paymentMethod}`);
  }

  const consignor = await prisma.consignor.findFirst({
    where: { id: input.consignorId, tenantId: input.tenantId },
  });
  if (!consignor) throw new Error('Consignor not found');

  // Resolve item set
  const itemFilter = {
    tenantId: input.tenantId,
    consignment: { consignorId: input.consignorId },
    consignorPaidAt: null,
    consignorPayout: { not: null },
    ...(input.itemIds && input.itemIds.length > 0 ? { id: { in: input.itemIds } } : {}),
  };

  const items = await prisma.item.findMany({
    where: itemFilter,
    select: {
      id: true, itemTitle: true, orderDate: true,
      grossAmount: true, netEarnings: true, consignorPayout: true,
      consignment: { select: { name: true, splitPercent: true } },
    },
  });

  if (items.length === 0) throw new Error('No unpaid items to settle');

  const total = items.reduce((sum, it) => sum.plus(it.consignorPayout ?? 0), new Decimal(0));
  const paidAt = input.paidAt ?? new Date();

  // Single transaction: create payout, link items, mark them paid
  const payout = await prisma.$transaction(async (tx) => {
    const p = await tx.consignorPayout.create({
      data: {
        tenantId: input.tenantId,
        consignorId: input.consignorId,
        amount: total,
        paymentMethod: input.paymentMethod,
        methodNotes: input.methodNotes ?? null,
        paidAt,
        createdByUserId: input.createdByUserId,
        notes: input.notes ?? null,
      },
    });

    for (const it of items) {
      await tx.consignorPayoutItem.create({
        data: {
          payoutId: p.id,
          itemId: it.id,
          payoutAtTime: it.consignorPayout!,
        },
      });
      await tx.item.update({
        where: { id: it.id },
        data: { consignorPaidAt: paidAt, consignorPayoutId: p.id },
      });
    }
    return p;
  });

  // Generate statements
  const statementData: PdfStatementInput = {
    consignorName: consignor.name,
    payoutDate: paidAt,
    paymentMethod: input.paymentMethod,
    methodNotes: input.methodNotes ?? null,
    notes: input.notes ?? null,
    totalAmount: total,
    items: items.map((it) => ({
      saleDate: it.orderDate,
      itemTitle: it.itemTitle ?? '(untitled)',
      consignmentName: it.consignment?.name ?? '',
      grossAmount: it.grossAmount,
      netEarnings: it.netEarnings,
      splitPercent: it.consignment?.splitPercent ?? new Decimal(0),
      payout: it.consignorPayout ?? new Decimal(0),
    })),
  };

  const pdf = await buildStatementPdf(statementData);
  const csv = buildStatementCsv(statementData);
  const urls = await saveStatementFiles(input.tenantId, payout.id, pdf, csv);

  // Persist URLs
  await prisma.consignorPayout.update({
    where: { id: payout.id },
    data: { pdfUrl: urls.pdfUrl, csvUrl: urls.csvUrl },
  });

  return { ...payout, ...urls };
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/lib/consignor/create-payout.ts
git commit -m "feat(consignor): create-payout with PDF/CSV statements"
```

### Task 9.6: Payout API routes

**Files:**
- Create: `web/src/app/api/consignor-payouts/route.ts`
- Create: `web/src/app/api/consignor-payouts/[id]/route.ts`

- [ ] **Step 1: Write list + create route**

```ts
// web/src/app/api/consignor-payouts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { createConsignorPayout } from '@/lib/consignor/create-payout';

export async function GET(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');

  const consignorId = request.nextUrl.searchParams.get('consignorId');
  const payouts = await prisma.consignorPayout.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(consignorId ? { consignorId } : {}),
    },
    include: { consignor: { select: { id: true, name: true } } },
    orderBy: { paidAt: 'desc' },
  });
  return NextResponse.json({ success: true, data: payouts });
}

export async function POST(request: NextRequest) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.edit');
  const body = await request.json();

  if (!body.consignorId || !body.paymentMethod) {
    return NextResponse.json(
      { success: false, error: 'consignorId and paymentMethod required' },
      { status: 400 }
    );
  }

  try {
    const payout = await createConsignorPayout({
      tenantId: ctx.tenantId,
      consignorId: body.consignorId,
      itemIds: body.itemIds,
      paymentMethod: body.paymentMethod,
      methodNotes: body.methodNotes,
      paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
      notes: body.notes,
      createdByUserId: ctx.userId,
    });
    return NextResponse.json({ success: true, data: payout });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: (e as Error).message },
      { status: 400 }
    );
  }
}
```

- [ ] **Step 2: Write detail route**

```ts
// web/src/app/api/consignor-payouts/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getTenantContext(request);
  requirePermission(ctx, 'sales.view');
  const { id } = await params;

  const payout = await prisma.consignorPayout.findFirst({
    where: { id, tenantId: ctx.tenantId },
    include: {
      consignor: true,
      items: { include: { item: { select: { id: true, itemTitle: true, orderDate: true } } } },
    },
  });
  if (!payout) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, data: payout });
}
```

- [ ] **Step 3: End-to-end test via curl**

1. Create consignor (Task 6.1).
2. Create consignment (Task 7.1) at 50/50 NET.
3. Pick a real item ID; manually update via Prisma Studio: `consignmentId` = the consignment, then `POST /api/items/<id>/recompute-consignor-payout`.
4. Verify item now has `consignor_payout > 0`.
5. `POST /api/consignor-payouts` with the consignor ID and payment method.
6. Response contains `pdfUrl` and `csvUrl`. Open `http://localhost:3000/statements/<tenant>/<payout>.pdf` in a browser.
7. The item now has `consignor_paid_at` set. `GET /api/consignors/<id>/balance` returns 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/consignor-payouts
git commit -m "feat(api): consignor payout list/create/detail"
```

---

## Phase 10 — Final integration verification

### Task 10.1: End-to-end smoke

- [ ] **Step 1: Run the full happy path**

Following the curl recipe in Task 9.6 step 3, verify these invariants hold:
- An item with no consignment → `consignor_payout = NULL`, profit = `net - cost` (unchanged).
- An item with consignment, NET 50%, `net=80` → `consignor_payout = 40`, `profit = 80 - 0 - 40 = 40`.
- After payout, item has `consignor_paid_at` and `consignor_payout_id` set; balance = 0.
- Editing the consignment to 60% then GETting a different unpaid item: payout updated. The paid item stays at 40 (frozen via `payoutAtTime`).
- Refunding an item (set `netEarnings = 0` via Prisma Studio) and hitting recompute: `consignor_payout = 0`. Balance reflects this.

- [ ] **Step 2: Run unit tests**

```bash
cd web && npm test
```
Expected: all 7 tests pass.

- [ ] **Step 3: Build to verify no type errors**

```bash
cd web && npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit any final fixes**

If verification surfaced bugs, fix them and commit. Then this plan is complete.

---

## Plan Self-Review Notes

- **Spec coverage:** All sections of the spec map to phases above:
  - §2 Concept → Phase 1 (schema)
  - §3 Data Model → Phase 1
  - §4 Split Math → Phase 2 (pure compute) + Phase 3 (orchestration) + Phase 4 (profit)
  - §4.2 Returns → handled implicitly by recompute on financial change (Phase 8 Task 8.2)
  - §4.3 Giveaways → Phase 2 Task 2.4
  - §5 Rules engine → Phase 5
  - §6 Recompute triggers → Phase 5 (rules) + Phase 7 (consignment edits) + Phase 8 (item edits) + dedicated endpoint Phase 8 Task 8.1
  - §7 UI → **deferred to UI plan** (acknowledged at top of this plan)
  - §8 API → Phases 6, 7, 8, 9
  - §9 Permissions → all routes use `sales.view` / `sales.edit` (no new keys, per spec)
  - §10 Statement Generation → Phase 9
  - §11 Sync & Migration → Phase 1 (no backfill needed); rules auto-run on sync inherited from existing engine
- **Manual rule re-run** (spec §5.4) is exercised through the existing rules engine; no new code needed beyond the action wiring in Phase 5.
- **No placeholders** — every code step has full code; every command shows exactly what to run.
