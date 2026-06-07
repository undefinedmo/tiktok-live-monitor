# Consignment Intake M1 — Schema + Label Codec (Web) — Task Detail

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema foundation and opaque `labelCode` codec for the consignment intake v2 flow on the web side, with zero regressions to the existing owned-stock UPC+qty path.

**Architecture:** Schema additions live in `web/prisma/schema.prisma`; partial-index constraints (Prisma 7 can't express them in DSL) live in custom SQL inside the generated migration. The codec is a pure TS module — opaque base32 (Crockford) with a single check char. Existing `/api/inventory/scan` owned-stock dedup is preserved by changing its `findUnique({ tenantId_upc })` lookup to `findFirst` filtered by `sourceType='owned'`. Listing-prep and attribution-audit tables ship in this milestone even though their consumers don't — they need to exist so future milestones don't conditionally branch on table presence.

**Tech Stack:** Next.js 16, Prisma 7, PostgreSQL, Vitest.

**Coordination plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-execution.md`
**Source spec:** `docs/plans/2026-05-30-consignment-intake-qr-implementation.md` on `claude/consignment-intake-plan-aHd1n` (luxesense-web-v2)
**Working branch:** `feature/v1-parity-port` (web)
**Working dir:** `web/`

**Locked decisions referenced here:**
- Per-piece `labelCode` for consignment; UPC+qty preserved for fungible owned
- Force-explicit-choice on UPC↔consignment collision (no schema impact, surfaces at reconcile in M2)
- `ItemInventoryLink` bridge built in this milestone
- 14-day refund hold window (no schema impact, surfaces in payout eligibility in M2)

---

## File Structure

**Create:**
- `web/src/lib/inventory/label-codec.ts`
- `web/src/lib/inventory/label-codec.test.ts`
- `web/prisma/migrations/<timestamp>_consignment_intake_v2/migration.sql` (Prisma generates the skeleton; we hand-edit to add partial constraints)
- `web/scripts/backfill-consignment-intake-v2.ts`

**Modify:**
- `web/prisma/schema.prisma` — multiple model additions/extensions (Inventory, Item, InventoryReceipt, InventoryMovement) + 3 new models (AttributionAudit, ListingPrepCapture, ItemInventoryLink)
- `web/src/app/api/inventory/scan/route.ts:14-30` — replace `findUnique({ tenantId_upc })` with `findFirst({ tenantId, upc, sourceType: 'owned' })`

**No deletes.**

---

## Task 1: Label codec — opaque base32 with check char

**Files:**
- Create: `web/src/lib/inventory/label-codec.ts`
- Create: `web/src/lib/inventory/label-codec.test.ts`

Codec: 8 data chars from Crockford base32 (`0-9` + `A-Z` minus `I L O U`) drawn from `crypto.randomBytes`, plus a 1-char checksum = 9-char `labelCode`. Checksum is the sum of data-char indices mod 32, mapped back into the alphabet. Verifier rejects wrong length, illegal chars, or bad checksum.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/inventory/label-codec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateLabelCode, verifyLabelCode, CROCKFORD_ALPHABET } from './label-codec';

describe('generateLabelCode', () => {
  it('returns a 9-char Crockford base32 string', () => {
    const code = generateLabelCode();
    expect(code).toHaveLength(9);
    expect(code).toMatch(new RegExp(`^[${CROCKFORD_ALPHABET}]{9}$`));
  });

  it('produces unique codes across 1000 calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) codes.add(generateLabelCode());
    expect(codes.size).toBe(1000);
  });

  it('round-trips through verifyLabelCode', () => {
    for (let i = 0; i < 50; i++) {
      expect(verifyLabelCode(generateLabelCode())).toBe(true);
    }
  });
});

describe('verifyLabelCode', () => {
  it('rejects null, undefined, empty, and wrong-length', () => {
    expect(verifyLabelCode(null as unknown as string)).toBe(false);
    expect(verifyLabelCode(undefined as unknown as string)).toBe(false);
    expect(verifyLabelCode('')).toBe(false);
    expect(verifyLabelCode('ABCD1234')).toBe(false); // 8 chars
    expect(verifyLabelCode('ABCD12345Z')).toBe(false); // 10 chars
  });

  it('rejects codes containing excluded letters (I, L, O, U)', () => {
    expect(verifyLabelCode('IIIIIIII0')).toBe(false);
    expect(verifyLabelCode('LLLLLLLL0')).toBe(false);
    expect(verifyLabelCode('OOOOOOOO0')).toBe(false);
    expect(verifyLabelCode('UUUUUUUU0')).toBe(false);
  });

  it('rejects single-character mutations of a valid code', () => {
    const valid = generateLabelCode();
    // Flip one character to a different valid-alphabet char; check char should reject most.
    let caughtCount = 0;
    for (let i = 0; i < 8; i++) {
      const otherChar = CROCKFORD_ALPHABET[(CROCKFORD_ALPHABET.indexOf(valid[i]) + 1) % CROCKFORD_ALPHABET.length];
      const mutated = valid.slice(0, i) + otherChar + valid.slice(i + 1);
      if (!verifyLabelCode(mutated)) caughtCount++;
    }
    // Mod-32 checksum catches ~31/32 single-char errors. Expect at least 7/8.
    expect(caughtCount).toBeGreaterThanOrEqual(7);
  });

  it('is case-insensitive on input but emits uppercase', () => {
    const code = generateLabelCode();
    expect(code).toBe(code.toUpperCase());
    expect(verifyLabelCode(code.toLowerCase())).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail with "module not found"**

Run: `npm run test -- src/lib/inventory/label-codec`
Expected: FAIL — `Cannot find module './label-codec'`

- [ ] **Step 3: Implement `label-codec.ts`**

Create `web/src/lib/inventory/label-codec.ts`:

```ts
import { randomInt } from 'node:crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 chars, excludes I L O U
const ALPHABET_INDEX: Record<string, number> = Object.fromEntries(
  CROCKFORD_ALPHABET.split('').map((c, i) => [c, i])
);

function checksum(dataChars: string): string {
  let sum = 0;
  for (const c of dataChars) sum = (sum + ALPHABET_INDEX[c]) % 32;
  return CROCKFORD_ALPHABET[sum];
}

export function generateLabelCode(): string {
  let data = '';
  for (let i = 0; i < 8; i++) data += CROCKFORD_ALPHABET[randomInt(32)];
  return data + checksum(data);
}

export function verifyLabelCode(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const code = input.toUpperCase();
  if (code.length !== 9) return false;
  for (const c of code) if (!(c in ALPHABET_INDEX)) return false;
  return checksum(code.slice(0, 8)) === code[8];
}
```

- [ ] **Step 4: Run tests, confirm all pass**

Run: `npm run test -- src/lib/inventory/label-codec`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/inventory/label-codec.ts web/src/lib/inventory/label-codec.test.ts
git commit -m "feat(inventory): add opaque labelCode codec with check char"
```

---

## Task 2: New models in schema.prisma

**Files:**
- Modify: `web/prisma/schema.prisma` (append three new models near the inventory cluster)

Three new models, all isolated from existing data:
1. `AttributionAudit` — immutable audit trail for ownership/attribution changes
2. `ListingPrepCapture` — `labelCode ↔ listing` link (consumed in M7 and middleware Phase 2; table lives now)
3. `ItemInventoryLink` — bridge for bundles / multi-qty / mixed-consignor (one sold Item → N physical sources)

- [ ] **Step 1: Append new models to schema.prisma**

Append after the existing `InventoryMovement` block (around line 1380):

```prisma
model AttributionAudit {
  id              Int      @id @default(autoincrement())
  tenantId        String   @map("tenant_id") @db.Uuid
  itemId          String?  @map("item_id") @db.VarChar(255)
  inventoryId     Int?     @map("inventory_id")
  oldConsignorId  String?  @map("old_consignor_id") @db.Uuid
  newConsignorId  String?  @map("new_consignor_id") @db.Uuid
  oldConsignmentId String? @map("old_consignment_id") @db.Uuid
  newConsignmentId String? @map("new_consignment_id") @db.Uuid
  reason          String   @db.Text
  station         String?  @db.VarChar(64)
  actorUserId     Int      @map("actor_user_id")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant      Tenant     @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  actor       User       @relation(fields: [actorUserId], references: [id], onDelete: Restrict)
  item        Item?      @relation(fields: [itemId], references: [id], onDelete: SetNull)
  inventory   Inventory? @relation(fields: [inventoryId], references: [id], onDelete: SetNull)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([itemId])
  @@index([inventoryId])
  @@map("attribution_audit")
}

model ListingPrepCapture {
  id                Int      @id @default(autoincrement())
  tenantId          String   @map("tenant_id") @db.Uuid
  labelCode         String   @map("label_code") @db.VarChar(9)
  showId            String?  @map("show_id") @db.VarChar(255)
  listingTitle      String?  @map("listing_title") @db.Text
  externalListingId String?  @map("external_listing_id") @db.VarChar(255)
  capturedByUserId  Int      @map("captured_by_user_id")
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant     Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  capturedBy User   @relation(fields: [capturedByUserId], references: [id], onDelete: Restrict)
  show       Show?  @relation(fields: [showId], references: [id], onDelete: SetNull)

  @@unique([tenantId, labelCode])
  @@index([tenantId, externalListingId])
  @@map("listing_prep_capture")
}

model ItemInventoryLink {
  id             Int      @id @default(autoincrement())
  tenantId       String   @map("tenant_id") @db.Uuid
  itemId         String   @map("item_id") @db.VarChar(255)
  inventoryId    Int      @map("inventory_id")
  qty            Int      @default(1)
  sourceType     String   @map("source_type") @db.VarChar(20)
  consignorId    String?  @map("consignor_id") @db.Uuid
  consignmentId  String?  @map("consignment_id") @db.Uuid
  unitCost       Decimal? @map("unit_cost") @db.Decimal
  grossAllocated Decimal? @map("gross_allocated") @db.Decimal
  netAllocated   Decimal? @map("net_allocated") @db.Decimal
  reason         String?  @db.Text
  createdByUserId Int     @map("created_by_user_id")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  item        Item         @relation(fields: [itemId], references: [id], onDelete: Cascade)
  inventory   Inventory    @relation(fields: [inventoryId], references: [id], onDelete: Restrict)
  consignor   Consignor?   @relation(fields: [consignorId], references: [id], onDelete: SetNull)
  consignment Consignment? @relation(fields: [consignmentId], references: [id], onDelete: SetNull)
  createdBy   User         @relation(fields: [createdByUserId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@index([itemId])
  @@index([inventoryId])
  @@map("item_inventory_links")
}
```

Add the reverse-relation fields on the existing models the new models point to:

- `Tenant` model — append to relation block: `attributionAudits AttributionAudit[]`, `listingPrepCaptures ListingPrepCapture[]`, `itemInventoryLinks ItemInventoryLink[]`
- `User` model — append: `attributionAudits AttributionAudit[]`, `listingPrepCaptures ListingPrepCapture[]`, `itemInventoryLinks ItemInventoryLink[]`
- `Item` model — append: `attributionAudits AttributionAudit[]`, `inventoryLinks ItemInventoryLink[]`
- `Inventory` model — append: `attributionAudits AttributionAudit[]`, `inventoryLinks ItemInventoryLink[]`
- `Show` model — append: `listingPrepCaptures ListingPrepCapture[]`
- `Consignor` model — append: `inventoryLinks ItemInventoryLink[]`
- `Consignment` model — append: `inventoryLinks ItemInventoryLink[]`

- [ ] **Step 2: Verify schema is syntactically valid**

Run: `cd web && npx prisma format && npx prisma validate`
Expected: no errors. Schema reformats consistently.

- [ ] **Step 3: Commit**

```bash
git add web/prisma/schema.prisma
git commit -m "feat(prisma): add AttributionAudit, ListingPrepCapture, ItemInventoryLink models"
```

---

## Task 3: Extend existing models in schema.prisma

**Files:**
- Modify: `web/prisma/schema.prisma`

Add fields to existing `Inventory`, `Item`, `InventoryReceipt`, `InventoryMovement`. Critically:
- `Inventory.@@unique([tenantId, upc])` → remove this line. The partial unique (only when `sourceType='owned'`) is added via custom SQL in Task 5.
- Keep an `@@index([tenantId, upc])` so the lookup is still fast.

- [ ] **Step 1: Modify the `Inventory` model**

Replace the existing `Inventory` model (lines ~1312-1337) body with:

```prisma
model Inventory {
  id            Int      @id @default(autoincrement())
  tenantId      String   @map("tenant_id") @db.Uuid
  userId        Int?     @map("user_id")
  upc           String?  @db.VarChar(255)
  labelCode     String?  @map("label_code") @db.VarChar(9)
  brand         String?  @db.VarChar(255)
  title         String?
  styleCode     String?  @map("style_code") @db.VarChar(255)
  colorCode     String?  @map("color_code") @db.VarChar(255)
  colorName     String?  @map("color_name") @db.VarChar(255)
  retailPrice   Decimal? @map("retail_price") @db.Decimal
  salePrice     Decimal? @map("sale_price") @db.Decimal
  cost          Decimal? @db.Decimal
  qty           Int      @default(0)
  sourceType    String   @default("owned") @map("source_type") @db.VarChar(20)
  consignorId   String?  @map("consignor_id") @db.Uuid
  consignmentId String?  @map("consignment_id") @db.Uuid
  condition     String?  @db.VarChar(40)
  intakeValue   Decimal? @map("intake_value") @db.Decimal
  notes         String?
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime @default(now()) @map("updated_at") @db.Timestamptz

  tenant            Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  user              User?               @relation(fields: [userId], references: [id], onDelete: SetNull)
  consignor         Consignor?          @relation(fields: [consignorId], references: [id], onDelete: SetNull)
  consignment       Consignment?        @relation(fields: [consignmentId], references: [id], onDelete: SetNull)
  movements         InventoryMovement[]
  attributionAudits AttributionAudit[]
  inventoryLinks    ItemInventoryLink[]

  @@unique([tenantId, labelCode])
  @@index([tenantId, upc])
  @@index([tenantId, brand])
  @@index([tenantId, sourceType])
  @@map("inventory")
}
```

Add reverse-relation on `Consignor`: `inventories Inventory[]`
Add reverse-relation on `Consignment`: `inventories Inventory[]`

- [ ] **Step 2: Modify the `Item` model**

Add inside the `Item` model (near the `consignmentId` block, around line 363):

```prisma
  reconciliationStatus String  @default("legacy_skipped") @map("reconciliation_status") @db.VarChar(40)
```

And add the `@@index([tenantId, reconciliationStatus])` near the other indices.

- [ ] **Step 3: Modify the `InventoryReceipt` model**

Add to the field block (after `vendor`, around line 1343):

```prisma
  consignorId   String? @map("consignor_id") @db.Uuid
  consignmentId String? @map("consignment_id") @db.Uuid
```

Add the relations:

```prisma
  consignor   Consignor?   @relation(fields: [consignorId], references: [id], onDelete: SetNull)
  consignment Consignment? @relation(fields: [consignmentId], references: [id], onDelete: SetNull)
```

Add reverse on `Consignor`: `receipts InventoryReceipt[]`
Add reverse on `Consignment`: `receipts InventoryReceipt[]`

- [ ] **Step 4: Modify the `InventoryMovement` model**

Add fields after `notes`:

```prisma
  reversalMovementId Int?    @map("reversal_movement_id")
  reason             String? @db.Text
  createdByUserId    Int?    @map("created_by_user_id")
```

Add the self-relation for reversal pairing:

```prisma
  reversal     InventoryMovement?  @relation("MovementReversal", fields: [reversalMovementId], references: [id], onDelete: SetNull)
  reversedBy   InventoryMovement[] @relation("MovementReversal")
  createdBy    User?               @relation("MovementCreatedBy", fields: [createdByUserId], references: [id], onDelete: SetNull)
```

Add reverse-relation on `User`: `movementsCreated InventoryMovement[] @relation("MovementCreatedBy")` (the existing `user` field becomes the legacy actor; new code uses `createdBy`).

- [ ] **Step 5: Validate schema**

Run: `cd web && npx prisma format && npx prisma validate`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/prisma/schema.prisma
git commit -m "feat(prisma): extend Inventory/Item/Receipt/Movement for consignment intake v2"
```

---

## Task 4: Generate migration + hand-edit for partial constraints

**Files:**
- Create: `web/prisma/migrations/<timestamp>_consignment_intake_v2/migration.sql`

Prisma can't express partial-unique-indexes in the DSL, so we generate the migration, then append SQL for:
1. Partial unique on `inventory(tenant_id, upc) WHERE source_type = 'owned' AND upc IS NOT NULL`
2. CHECK constraint on `inventory_movements`: `source_type <> 'sold' OR item_id IS NOT NULL`

- [ ] **Step 1: Generate migration without applying**

Run: `cd web && npx prisma migrate dev --create-only --name consignment_intake_v2`
Expected: Prisma creates `web/prisma/migrations/<timestamp>_consignment_intake_v2/migration.sql` and prints the path.

- [ ] **Step 2: Inspect the generated SQL**

Open the file. Verify all expected DDL is present: new tables (`attribution_audit`, `listing_prep_capture`, `item_inventory_links`), new columns on `inventory`, `items`, `inventory_receipts`, `inventory_movements`, and the `DROP INDEX inventory_tenant_id_upc_key`.

Confirm the file does NOT contain a `DROP COLUMN` on any existing data column — if it does, stop and review.

- [ ] **Step 3: Append partial-constraint SQL**

Append to the bottom of `migration.sql`:

```sql
-- Partial unique: preserve owned-stock UPC dedup, allow per-piece consignment rows.
CREATE UNIQUE INDEX "inventory_tenant_upc_owned_unique"
  ON "inventory" ("tenant_id", "upc")
  WHERE "source_type" = 'owned' AND "upc" IS NOT NULL;

-- A sold movement must always carry an itemId — silent unattributed sales are forbidden.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_sold_requires_item"
  CHECK ("source_type" <> 'sold' OR "item_id" IS NOT NULL);
```

- [ ] **Step 4: Apply the migration to dev DB**

Run: `cd web && npx prisma migrate dev`
Expected: migration applies cleanly; Prisma client regenerates. No errors.

- [ ] **Step 5: Sanity check — connect with prisma studio or psql**

Run: `cd web && npx prisma studio` (or `psql` against `DATABASE_URL`)
Expected: new tables visible, `inventory.label_code`, `inventory.source_type`, `items.reconciliation_status` columns visible, indices present.

Confirm partial unique exists:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'inventory_tenant_upc_owned_unique';
```

Expected: index definition includes the `WHERE source_type = 'owned' AND upc IS NOT NULL` clause.

- [ ] **Step 6: Commit**

```bash
git add web/prisma/migrations/
git commit -m "feat(prisma): migration for consignment intake v2 (with partial constraints)"
```

---

## Task 5: Backfill existing rows

**Files:**
- Create: `web/scripts/backfill-consignment-intake-v2.ts`

Backfill is required because the migration in Task 4 added columns with defaults, but the design's escape hatch — `Item.reconciliationStatus = 'legacy_skipped'` for pre-v2 sold items — needs to be applied explicitly to all rows that already have an `orderId`. Without this, the M2 reconcile gate would catch every historical sale.

- [ ] **Step 1: Write the backfill script**

Create `web/scripts/backfill-consignment-intake-v2.ts`:

```ts
/**
 * Backfill for consignment intake v2 migration.
 * - Inventory.source_type defaults to 'owned' via DDL; no row-level work needed.
 * - Item.reconciliation_status defaults to 'legacy_skipped' via DDL; but we
 *   want to be explicit for any sold item created before this migration so
 *   future reports show the pre-v2 cohort distinctly. The DDL default already
 *   covers them; this script is here for assertion + idempotency.
 *
 * Run after migration applies. Idempotent.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Counting rows...');
  const [invTotal, invMissingSourceType, itemTotal, itemMissingStatus] = await Promise.all([
    prisma.inventory.count(),
    prisma.inventory.count({ where: { sourceType: { equals: '' } } }),
    prisma.item.count(),
    prisma.item.count({ where: { reconciliationStatus: { equals: '' } } }),
  ]);
  console.log(`inventory: ${invTotal} (missing source_type: ${invMissingSourceType})`);
  console.log(`items: ${itemTotal} (missing reconciliation_status: ${itemMissingStatus})`);

  if (invMissingSourceType > 0) {
    const r = await prisma.inventory.updateMany({
      where: { sourceType: { equals: '' } },
      data: { sourceType: 'owned' },
    });
    console.log(`backfilled inventory.source_type for ${r.count} rows`);
  }

  if (itemMissingStatus > 0) {
    const r = await prisma.item.updateMany({
      where: { reconciliationStatus: { equals: '' } },
      data: { reconciliationStatus: 'legacy_skipped' },
    });
    console.log(`backfilled items.reconciliation_status for ${r.count} rows`);
  }

  // Assertion pass: after backfill, no rows should have empty values.
  const [invStillEmpty, itemStillEmpty] = await Promise.all([
    prisma.inventory.count({ where: { sourceType: { equals: '' } } }),
    prisma.item.count({ where: { reconciliationStatus: { equals: '' } } }),
  ]);
  if (invStillEmpty || itemStillEmpty) {
    throw new Error(`backfill incomplete: inventory=${invStillEmpty} items=${itemStillEmpty}`);
  }
  console.log('backfill complete — all rows have non-empty source_type / reconciliation_status');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run the backfill**

Run: `cd web && npx tsx scripts/backfill-consignment-intake-v2.ts`
Expected: prints counts; either backfills missing values (if any rows snuck in without defaults) or reports `0` updates. Final line: `backfill complete`.

- [ ] **Step 3: Run again — confirm idempotency**

Run: `cd web && npx tsx scripts/backfill-consignment-intake-v2.ts`
Expected: identical output the second time, both `updateMany` calls report `0` rows updated.

- [ ] **Step 4: Commit**

```bash
git add web/scripts/backfill-consignment-intake-v2.ts
git commit -m "chore(inventory): idempotent backfill for v2 sourceType + reconciliationStatus"
```

---

## Task 6: Refactor inventory scan route to preserve owned-stock dedup

**Files:**
- Modify: `web/src/app/api/inventory/scan/route.ts`

The migration removed `Inventory.@@unique([tenantId, upc])`, so the existing `findUnique({ where: { tenantId_upc: ... } })` no longer compiles (Prisma client no longer generates that key). Replace with `findFirst` filtered by `sourceType='owned'`. The scan route's owned-stock dedup behavior is preserved.

- [ ] **Step 1: Verify the typecheck error exists**

Run: `cd web && npx tsc --noEmit`
Expected: error on `src/app/api/inventory/scan/route.ts` near the `tenantId_upc` reference.

- [ ] **Step 2: Edit the route**

In `web/src/app/api/inventory/scan/route.ts`, replace the `findUnique` block:

```ts
// OLD:
const existing = await tx.inventory.findUnique({
  where: { tenantId_upc: { tenantId: ctx.tenantId, upc } },
});

// NEW:
const existing = await tx.inventory.findFirst({
  where: { tenantId: ctx.tenantId, upc, sourceType: 'owned' },
});
```

In the `create` block, explicitly set `sourceType: 'owned'`:

```ts
const created = await tx.inventory.create({
  data: { tenantId: ctx.tenantId, userId: ctx.userId, upc, qty: 1, sourceType: 'owned' },
});
```

- [ ] **Step 3: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean — no errors.

- [ ] **Step 4: Run existing inventory tests**

Run: `cd web && npm run test -- src/app/api/inventory src/lib/inventory`
Expected: all pass (label-codec from Task 1, plus any pre-existing inventory tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/inventory/scan/route.ts
git commit -m "refactor(inventory): scan route filters by sourceType=owned (UPC no longer unique alone)"
```

---

## Task 7: Full verification pass

**Files:** None modified. This task is an acceptance gate.

- [ ] **Step 1: Run the full web test suite**

Run: `cd web && npm run test`
Expected: all tests pass. If any fail that referenced `tenantId_upc` or implicit Inventory uniqueness assumptions, fix them inline and recommit before proceeding — those are real regressions.

- [ ] **Step 2: Run typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run lint**

Run: `cd web && npm run lint`
Expected: clean.

- [ ] **Step 4: Migration replay on a fresh DB**

Spin a throwaway Postgres (Docker), point `DATABASE_URL` at it, run:

```bash
cd web && npx prisma migrate deploy
```

Expected: every migration in `prisma/migrations/` applies in order, ending with `consignment_intake_v2`. No errors, partial unique exists on the fresh DB.

- [ ] **Step 5: Migration replay on a prod-snapshot DB (manual)**

Per the locked decision and `feedback_v2_db_backup_before_destructive` rule, take a `pg_dump` of prod, restore to a throwaway, then run `npx prisma migrate deploy` against the restored DB. Verify:
- No errors
- Row counts in `inventory`, `inventory_movements`, `items` match the dump
- Partial unique exists; the `inventory_movements_sold_requires_item` CHECK exists
- Backfill script reports `0` updates (the DDL defaults already populated everything)

This step is a manual gate for go-no-go on prod migration timing. Document the result in this task's commit message or PR description.

- [ ] **Step 6: Tag the M1 completion**

```bash
git tag consignment-intake-m1-complete
git push origin consignment-intake-m1-complete
```

(Tag is local-only if you don't want it on the remote — use `git tag` without `push`.)

---

## Acceptance Gate (mirrors M1 in coordination plan)

- [ ] `npx prisma migrate dev` runs clean against fresh DB ✓ (Task 4 Step 4, Task 7 Step 4)
- [ ] `npx prisma generate` produces a client with the new types ✓ (Task 4 Step 4 implies this)
- [ ] `vitest run src/lib/inventory/label-codec` passes ✓ (Task 1 Step 4, Task 7 Step 1)
- [ ] No data loss: row counts unchanged post-migration ✓ (Task 7 Step 5)
- [ ] Web typecheck + existing test suite still pass ✓ (Task 7 Steps 1–3)
- [ ] Cross-repo codec algorithm is the algorithm desktop will mirror in M4 — fixture for desktop validation is implicit in `CROCKFORD_ALPHABET` + checksum spec above

---

## Self-Review

Spec coverage (against M1 in coordination plan):
- Schema additions (AttributionAudit, ListingPrepCapture, ItemInventoryLink, Inventory extensions, Item.reconciliationStatus, InventoryMovement extensions, InventoryReceipt FKs) → Tasks 2 & 3 ✓
- Partial unique constraint + sold⇒itemId CHECK → Task 4 Step 3 ✓
- label-codec.ts + tests → Task 1 ✓
- Backfill → Task 5 ✓
- Migration round-trip verification (fresh + prod snapshot) → Task 7 Steps 4–5 ✓
- Scan-route regression caught and fixed → Task 6 ✓

Placeholders: none — all code blocks contain complete content.

Type consistency: `labelCode` (camelCase TS, `label_code` snake-case SQL), `sourceType`, `reconciliationStatus`, `consignmentId`, `consignorId`, `inventoryLinks`, `attributionAudits` — used consistently across all tasks.

Cut points if M1 grows: Task 5 (backfill) can be deferred to M2 if migration defaults are sufficient (DDL defaults make it idempotent already). Task 7 Step 5 (prod-snapshot replay) is a manual gate; if no snapshot available, run in deploy window with rollback plan.
