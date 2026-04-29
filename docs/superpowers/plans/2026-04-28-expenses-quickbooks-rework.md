# Expenses QuickBooks-style Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the desktop Expenses screen into a QuickBooks-style structure with first-class Vendors, Payment Accounts, split lines, receipt attachments (Vercel Blob), and an Expenses tab in the existing Reports screen.

**Architecture:** Postgres adds four new tables (vendors, payment_accounts, expense_splits, expense_receipts) and extends `expenses`. Web (Next.js) gains REST routes for each + receipt upload via Vercel Blob. Desktop (React) gets a reusable `SlideOverDrawer`, three sub-tabs (Expenses · Vendors · Accounts) replacing the modal-driven UI, plus a new Expenses tab in `Reports.tsx`.

**Tech Stack:** Next.js 16 (web API), Prisma 7 + Postgres, React 19 + TypeScript + Tailwind 4 (desktop), Vercel Blob (`@vercel/blob`), Vitest for tests, NextAuth JWT auth.

**Spec:** `docs/superpowers/specs/2026-04-28-expenses-quickbooks-rework-design.md`

---

## File-structure overview

**Web (`web/`):**
```
prisma/schema.prisma                                        (modify)
prisma/migrations/<ts>_expenses_quickbooks_rework/          (new)
src/lib/blob.ts                                             (new)
src/lib/expenses-helpers.ts                                 (new)
src/app/api/vendors/route.ts                                (new)
src/app/api/vendors/[id]/route.ts                           (new)
src/app/api/payment-accounts/route.ts                       (new)
src/app/api/payment-accounts/[id]/route.ts                  (new)
src/app/api/expenses/route.ts                               (modify)
src/app/api/expenses/[id]/route.ts                          (modify)
src/app/api/expenses/[id]/receipts/route.ts                 (new)
src/app/api/expenses/[id]/receipts/[rid]/route.ts           (new)
src/app/api/reports/expenses/route.ts                       (new)
src/app/api/expenses/summary/route.ts                       (modify — vendor/account)
```

**Desktop (`desktop/`):**
```
src/components/SlideOverDrawer.tsx                          (new)
src/components/expenses/ExpenseDrawer.tsx                   (new)
src/components/expenses/ExpenseSplitsEditor.tsx             (new)
src/components/expenses/ReceiptUploader.tsx                 (new)
src/components/expenses/VendorCombobox.tsx                  (new)
src/components/expenses/AccountSelect.tsx                   (new)
src/components/expenses/ExpenseSummaryTiles.tsx             (new)
src/components/expenses/ExpenseFilterBar.tsx                (new)
src/components/expenses/ExpenseBulkActions.tsx              (new)
src/components/expenses/ManageCategoriesDrawer.tsx          (new)
src/components/vendors/VendorsList.tsx                      (new)
src/components/vendors/VendorDrawer.tsx                     (new)
src/components/accounts/AccountsList.tsx                    (new)
src/components/accounts/AccountDrawer.tsx                   (new)
src/hooks/useExpenses.ts                                    (modify, large)
src/hooks/useVendors.ts                                     (new)
src/hooks/usePaymentAccounts.ts                             (new)
src/hooks/useExpenseReports.ts                              (new)
src/pages/Expenses.tsx                                      (rewrite)
src/pages/reports/ExpensesTab.tsx                           (new)
src/pages/Reports.tsx                                       (modify — register tab)
```

**Conventions used everywhere:**
- API routes return `{ success: true, data: ... }` or `{ success: false, error: ... }` and use `getTenantContext(req)` → `requirePermission(ctx, 'expenses.view'|'expenses.edit'|'expenses.delete')` → `handleAuthError(error)`.
- Every Prisma query includes `tenantId: ctx.tenantId` in `where`.
- All mutations call `logActivity(...)` (see `web/src/lib/activity.ts`).
- Web tests use **vitest with mocked `@/lib/prisma` and `@/lib/tenant`**, matching the existing pattern in `web/src/app/api/activity/__tests__/permission.test.ts`.
- Desktop hooks call `apiClient.get/post/patch/delete`; type imports come from `'../lib/apiClient'`.
- Money is sent over the wire as `number`. Prisma `Decimal` → `Number(value)` on read; `parseFloat(input)` on write.

---

## Phase 1 — Database schema

### Task 1.1: Add new Prisma models

**Files:**
- Modify: `web/prisma/schema.prisma`

- [ ] **Step 1: Add the four new models below the existing `ExpenseCategory` model**

Insert after the closing `}` of `model ExpenseCategory` (around line 533):

```prisma
model Vendor {
  id                Int       @id @default(autoincrement())
  tenantId          String    @map("tenant_id") @db.Uuid
  name              String    @db.VarChar(255)
  notes             String?   @db.Text
  defaultCategoryId Int?      @map("default_category_id")
  archivedAt        DateTime? @map("archived_at") @db.Timestamptz
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  tenant          Tenant           @relation(fields: [tenantId], references: [id])
  defaultCategory ExpenseCategory? @relation(fields: [defaultCategoryId], references: [id])
  expenses        Expense[]

  @@unique([name, tenantId])
  @@index([tenantId])
  @@map("vendors")
}

model PaymentAccount {
  id             Int       @id @default(autoincrement())
  tenantId       String    @map("tenant_id") @db.Uuid
  name           String    @db.VarChar(255)
  type           String    @db.VarChar(20)
  openingBalance Decimal?  @map("opening_balance") @db.Decimal
  currency       String    @default("USD") @db.VarChar(3)
  notes          String?   @db.Text
  archivedAt     DateTime? @map("archived_at") @db.Timestamptz
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

  tenant   Tenant    @relation(fields: [tenantId], references: [id])
  expenses Expense[]

  @@unique([name, tenantId])
  @@index([tenantId])
  @@map("payment_accounts")
}

model ExpenseSplit {
  id          Int     @id @default(autoincrement())
  expenseId   Int     @map("expense_id")
  categoryId  Int?    @map("category_id")
  amount      Decimal @db.Decimal
  description String? @db.Text
  sortOrder   Int     @default(0) @map("sort_order")

  expense  Expense          @relation(fields: [expenseId], references: [id], onDelete: Cascade)
  category ExpenseCategory? @relation(fields: [categoryId], references: [id])

  @@index([expenseId])
  @@map("expense_splits")
}

model ExpenseReceipt {
  id         Int      @id @default(autoincrement())
  expenseId  Int      @map("expense_id")
  blobUrl    String   @map("blob_url") @db.Text
  blobKey    String   @map("blob_key") @db.Text
  filename   String   @db.VarChar(255)
  mimeType   String   @map("mime_type") @db.VarChar(100)
  sizeBytes  Int      @map("size_bytes")
  uploadedAt DateTime @default(now()) @map("uploaded_at") @db.Timestamptz

  expense Expense @relation(fields: [expenseId], references: [id], onDelete: Cascade)

  @@index([expenseId])
  @@map("expense_receipts")
}
```

- [ ] **Step 2: Add the back-relations on `Tenant` and `ExpenseCategory`**

Add to the `Tenant` model (both occurrences — there appear to be two `Tenant`-shaped blocks, lines ~33 and ~190):

```
  vendors          Vendor[]
  paymentAccounts  PaymentAccount[]
```

Add to the `ExpenseCategory` model (line ~517):

```
  vendors VendorAsDefault Vendor[] @relation()  // ⚠ remove this line — see Step 3
  splits  ExpenseSplit[]
```

- [ ] **Step 3: Wire the `defaultCategory` back-relation correctly**

The `Vendor.defaultCategory` field references `ExpenseCategory`. Prisma needs the back-relation. Add this single line to `ExpenseCategory`:

```
  vendorsAsDefault Vendor[]      @relation("VendorDefaultCategory")
  splits           ExpenseSplit[]
```

And update the `Vendor.defaultCategory` field to name the relation:

```
  defaultCategory ExpenseCategory? @relation("VendorDefaultCategory", fields: [defaultCategoryId], references: [id])
```

- [ ] **Step 4: Modify `Expense` model — add `vendorId`, `paymentAccountId`, `hasSplits`; remove `brandId`**

Replace the body of `model Expense { ... }` (lines ~535-563) with:

```prisma
model Expense {
  id               Int       @id @default(autoincrement())
  date             DateTime? @db.Date
  amount           Decimal?  @db.Decimal
  description      String?   @db.Text
  categoryId       Int?      @map("category_id")
  vendorId         Int?      @map("vendor_id")
  paymentAccountId Int?      @map("payment_account_id")  // nullable for migration step; see Task 1.2
  showId           String?   @map("show_id") @db.VarChar(255)
  channel          String?   @db.VarChar(50)
  notes            String?   @db.Text
  hasSplits        Boolean   @default(false) @map("has_splits")
  createdAt        DateTime? @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime? @default(now()) @updatedAt @map("updated_at") @db.Timestamptz
  userId           Int?      @map("user_id")
  tenantId         String    @map("tenant_id") @db.Uuid

  user           User?            @relation(fields: [userId], references: [id])
  tenant         Tenant           @relation(fields: [tenantId], references: [id])
  category       ExpenseCategory? @relation(fields: [categoryId], references: [id])
  vendor         Vendor?          @relation(fields: [vendorId], references: [id])
  paymentAccount PaymentAccount?  @relation(fields: [paymentAccountId], references: [id])
  show           Show?            @relation(fields: [showId], references: [id])
  splits         ExpenseSplit[]
  receipts       ExpenseReceipt[]

  @@index([date])
  @@index([categoryId])
  @@index([vendorId])
  @@index([paymentAccountId])
  @@index([channel])
  @@index([showId])
  @@index([userId])
  @@index([tenantId])
  @@map("expenses")
}
```

The `brandId` column and `brand` relation are dropped. Find and remove the matching `expenses Expense[]` line in the `Brand` model (line ~480) — replace with nothing (delete the line).

- [ ] **Step 5: Generate the migration**

```bash
cd web
npx prisma migrate dev --name expenses_quickbooks_rework_schema --create-only
```

Expected: a new folder `prisma/migrations/<ts>_expenses_quickbooks_rework_schema/` with `migration.sql`. Do **not** apply yet — Task 1.2 edits this SQL.

- [ ] **Step 6: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/
git commit -m "feat(expenses): schema additions for QB-style rework"
```

---

### Task 1.2: Edit migration SQL to seed and backfill

The auto-generated migration drops `brand_id` and adds `payment_account_id NOT NULL`, which would fail on existing rows. We need: create new tables → seed `Cash` and `Unassigned` accounts per tenant → backfill `payment_account_id` → make NOT NULL → drop `brand_id`.

**Files:**
- Modify: `web/prisma/migrations/<ts>_expenses_quickbooks_rework_schema/migration.sql`

- [ ] **Step 1: Open the generated migration.sql and reorganize**

Replace the whole file contents with:

```sql
-- ============================================
-- Expenses QuickBooks-style rework
-- ============================================

-- 1. New tables -------------------------------------------------------

CREATE TABLE "vendors" (
    "id" SERIAL PRIMARY KEY,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "notes" TEXT,
    "default_category_id" INTEGER,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "vendors_name_tenant_id_key" ON "vendors"("name", "tenant_id");
CREATE INDEX "vendors_tenant_id_idx" ON "vendors"("tenant_id");
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_category_fk" FOREIGN KEY ("default_category_id") REFERENCES "expense_categories"("id");

CREATE TABLE "payment_accounts" (
    "id" SERIAL PRIMARY KEY,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "opening_balance" DECIMAL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "payment_accounts_name_tenant_id_key" ON "payment_accounts"("name", "tenant_id");
CREATE INDEX "payment_accounts_tenant_id_idx" ON "payment_accounts"("tenant_id");
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");

CREATE TABLE "expense_splits" (
    "id" SERIAL PRIMARY KEY,
    "expense_id" INTEGER NOT NULL,
    "category_id" INTEGER,
    "amount" DECIMAL NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "expense_splits_expense_id_idx" ON "expense_splits"("expense_id");
ALTER TABLE "expense_splits" ADD CONSTRAINT "expense_splits_expense_fk" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE;
ALTER TABLE "expense_splits" ADD CONSTRAINT "expense_splits_category_fk" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id");

CREATE TABLE "expense_receipts" (
    "id" SERIAL PRIMARY KEY,
    "expense_id" INTEGER NOT NULL,
    "blob_url" TEXT NOT NULL,
    "blob_key" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "expense_receipts_expense_id_idx" ON "expense_receipts"("expense_id");
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_expense_fk" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE;

-- 2. Add new columns to expenses (nullable for now) -------------------

ALTER TABLE "expenses"
  ADD COLUMN "vendor_id" INTEGER,
  ADD COLUMN "payment_account_id" INTEGER,
  ADD COLUMN "has_splits" BOOLEAN NOT NULL DEFAULT false;

-- 3. Seed default accounts per tenant ---------------------------------

INSERT INTO "payment_accounts" ("tenant_id", "name", "type")
SELECT id, 'Cash', 'cash' FROM "tenants"
ON CONFLICT ("name", "tenant_id") DO NOTHING;

INSERT INTO "payment_accounts" ("tenant_id", "name", "type")
SELECT id, 'Unassigned', 'other' FROM "tenants"
ON CONFLICT ("name", "tenant_id") DO NOTHING;

INSERT INTO "payment_accounts" ("tenant_id", "name", "type")
SELECT DISTINCT e.tenant_id, 'Whatnot Balance', 'other'
FROM "expenses" e
WHERE e.channel = 'whatnot'
ON CONFLICT ("name", "tenant_id") DO NOTHING;

-- 4. Backfill payment_account_id --------------------------------------

UPDATE "expenses" e
SET "payment_account_id" = pa.id
FROM "payment_accounts" pa
WHERE pa.tenant_id = e.tenant_id
  AND pa.name = 'Whatnot Balance'
  AND e.channel = 'whatnot'
  AND e.payment_account_id IS NULL;

UPDATE "expenses" e
SET "payment_account_id" = pa.id
FROM "payment_accounts" pa
WHERE pa.tenant_id = e.tenant_id
  AND pa.name = 'Unassigned'
  AND e.payment_account_id IS NULL;

-- 5. Make payment_account_id NOT NULL and add FKs ---------------------

ALTER TABLE "expenses" ALTER COLUMN "payment_account_id" SET NOT NULL;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_vendor_fk"          FOREIGN KEY ("vendor_id")          REFERENCES "vendors"("id"),
  ADD CONSTRAINT "expenses_payment_account_fk" FOREIGN KEY ("payment_account_id") REFERENCES "payment_accounts"("id");

CREATE INDEX "expenses_vendor_id_idx"          ON "expenses"("vendor_id");
CREATE INDEX "expenses_payment_account_id_idx" ON "expenses"("payment_account_id");

-- 6. Drop brand_id ----------------------------------------------------

ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_brand_id_fkey";
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "brand_id";
```

- [ ] **Step 2: Apply the migration to dev**

```bash
cd web
npx prisma migrate dev
```

Expected: migration applies cleanly, Prisma client regenerates.

- [ ] **Step 3: Verify the data**

```bash
cd web
npx prisma studio
```

Open `payment_accounts` — every tenant should have `Cash` and `Unassigned` rows. Open `expenses` — `payment_account_id` should be populated for every existing row.

- [ ] **Step 4: Commit**

```bash
git add web/prisma/migrations/
git commit -m "feat(expenses): migration with seed and backfill"
```

---

## Phase 2 — Web library helpers

### Task 2.1: Vercel Blob client wrapper

**Files:**
- Create: `web/src/lib/blob.ts`

- [ ] **Step 1: Install `@vercel/blob`**

```bash
cd web
npm install @vercel/blob
```

- [ ] **Step 2: Add `BLOB_READ_WRITE_TOKEN` placeholder**

Edit `web/.env.example` (create if it doesn't exist):

```
BLOB_READ_WRITE_TOKEN=
```

Document in the README or a follow-up commit that this must be set in Vercel project settings and `.env.local` for local dev.

- [ ] **Step 3: Write the helper**

Create `web/src/lib/blob.ts`:

```typescript
import { put, del } from '@vercel/blob';
import { randomUUID } from 'node:crypto';

export const ALLOWED_RECEIPT_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

export const MAX_RECEIPT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_RECEIPTS_PER_EXPENSE = 10;

export type AllowedReceiptMime = typeof ALLOWED_RECEIPT_MIME[number];

export function isAllowedReceiptMime(mime: string): mime is AllowedReceiptMime {
  return (ALLOWED_RECEIPT_MIME as readonly string[]).includes(mime);
}

export function buildReceiptKey(tenantId: string, expenseId: number, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `expenses/${tenantId}/${expenseId}/${randomUUID()}-${safe}`;
}

export async function uploadReceipt(args: {
  key: string;
  body: Buffer | Blob;
  contentType: string;
}): Promise<{ url: string }> {
  const result = await put(args.key, args.body, {
    access: 'public',
    contentType: args.contentType,
    addRandomSuffix: false,
  });
  return { url: result.url };
}

export async function deleteReceipt(key: string): Promise<void> {
  await del(key);
}
```

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/blob.ts web/.env.example
git commit -m "feat(blob): Vercel Blob helper for receipt uploads"
```

---

### Task 2.2: Expense calculation helpers (splits invariant)

**Files:**
- Create: `web/src/lib/expenses-helpers.ts`
- Create: `web/src/lib/__tests__/expenses-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/__tests__/expenses-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateSplitsSum, normalizeSplits } from '../expenses-helpers';

describe('validateSplitsSum', () => {
  it('passes when splits sum equals header amount within 1 cent tolerance', () => {
    expect(() => validateSplitsSum(100, [{ amount: 60 }, { amount: 40 }])).not.toThrow();
    expect(() => validateSplitsSum(100, [{ amount: 60.005 }, { amount: 39.995 }])).not.toThrow();
  });

  it('throws when splits sum diverges from header amount', () => {
    expect(() => validateSplitsSum(100, [{ amount: 60 }, { amount: 30 }])).toThrow(/sum/i);
  });

  it('throws when splits array is empty', () => {
    expect(() => validateSplitsSum(100, [])).toThrow(/at least one/i);
  });

  it('throws when any split amount is non-positive', () => {
    expect(() => validateSplitsSum(100, [{ amount: 100 }, { amount: 0 }])).toThrow(/positive/i);
    expect(() => validateSplitsSum(100, [{ amount: 100 }, { amount: -1 }])).toThrow(/positive/i);
  });
});

describe('normalizeSplits', () => {
  it('assigns sort_order based on input order', () => {
    const out = normalizeSplits([
      { amount: 10, categoryId: 1 },
      { amount: 20, categoryId: 2 },
    ]);
    expect(out[0].sortOrder).toBe(0);
    expect(out[1].sortOrder).toBe(1);
  });

  it('coerces description empty-string to null', () => {
    const out = normalizeSplits([{ amount: 10, description: '' }]);
    expect(out[0].description).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

```bash
cd web
npm test -- expenses-helpers
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `web/src/lib/expenses-helpers.ts`:

```typescript
export interface SplitInput {
  categoryId?: number | null;
  amount: number;
  description?: string | null;
}

export interface NormalizedSplit {
  categoryId: number | null;
  amount: number;
  description: string | null;
  sortOrder: number;
}

const TOLERANCE_CENTS = 0.011;

export function validateSplitsSum(headerAmount: number, splits: SplitInput[]): void {
  if (!splits || splits.length === 0) {
    throw new Error('Splits must contain at least one line.');
  }
  let sum = 0;
  for (const s of splits) {
    if (typeof s.amount !== 'number' || !isFinite(s.amount) || s.amount <= 0) {
      throw new Error('Each split amount must be a positive number.');
    }
    sum += s.amount;
  }
  if (Math.abs(sum - headerAmount) > TOLERANCE_CENTS) {
    throw new Error(
      `Splits sum (${sum.toFixed(2)}) does not match expense amount (${headerAmount.toFixed(2)}).`
    );
  }
}

export function normalizeSplits(splits: SplitInput[]): NormalizedSplit[] {
  return splits.map((s, i) => ({
    categoryId: s.categoryId ?? null,
    amount: s.amount,
    description: s.description ? s.description : null,
    sortOrder: i,
  }));
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
cd web
npm test -- expenses-helpers
```

Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/expenses-helpers.ts web/src/lib/__tests__/expenses-helpers.test.ts
git commit -m "feat(expenses): splits validation helper"
```

---

## Phase 3 — Web API: Vendors

### Task 3.1: `GET /api/vendors` — list with stats

**Files:**
- Create: `web/src/app/api/vendors/route.ts`
- Create: `web/src/app/api/vendors/__tests__/list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/api/vendors/__tests__/list.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    vendor: {
      findMany: vi.fn(),
    },
    expense: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn((ctx: { role: string }, key: string) => {
    if (ctx.role === 'viewer' && key.endsWith('.edit')) {
      const e = Object.assign(new Error(`Permission denied: ${key}`), { status: 403 });
      throw e;
    }
  }),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: err.status ?? 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

import { getTenantContext } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { GET } from '../route';

function req(url = 'http://localhost/api/vendors') {
  return new Request(url) as unknown as import('next/server').NextRequest;
}

describe('GET /api/vendors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenantId: 't-1', userId: 1, role: 'owner', overrides: [],
    });
  });

  it('returns vendors with expense counts and totals', async () => {
    (prisma.vendor.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, name: 'USPS', notes: null, defaultCategoryId: null, archivedAt: null,
        defaultCategory: null, _count: { expenses: 18 } },
    ]);
    (prisma.expense.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vendorId: 1, _sum: { amount: 410.5 } },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.vendors).toHaveLength(1);
    expect(body.data.vendors[0]).toMatchObject({
      id: 1, name: 'USPS', expenseCount: 18, totalSpent: 410.5,
    });
  });

  it('only returns vendors for the current tenant', async () => {
    (prisma.vendor.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.expense.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(req());

    expect(prisma.vendor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't-1' }) })
    );
    expect(prisma.expense.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't-1' }) })
    );
  });
});
```

- [ ] **Step 2: Run the test (expect failure — module not found)**

```bash
cd web
npm test -- src/app/api/vendors
```

Expected: FAIL.

- [ ] **Step 3: Implement the route**

Create `web/src/app/api/vendors/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');

    const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1';

    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (!includeArchived) where.archivedAt = null;

    const [vendors, totals] = await Promise.all([
      prisma.vendor.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          defaultCategory: { select: { id: true, name: true } },
          _count: { select: { expenses: true } },
        },
      }),
      prisma.expense.groupBy({
        by: ['vendorId'],
        where: { tenantId: ctx.tenantId, vendorId: { not: null } },
        _sum: { amount: true },
      }),
    ]);

    const totalByVendor = new Map<number, number>();
    for (const t of totals) {
      if (t.vendorId != null) totalByVendor.set(t.vendorId, Number(t._sum?.amount) || 0);
    }

    return NextResponse.json({
      success: true,
      data: {
        vendors: vendors.map((v) => ({
          id: v.id,
          name: v.name,
          notes: v.notes,
          defaultCategoryId: v.defaultCategoryId,
          defaultCategoryName: v.defaultCategory?.name ?? null,
          archivedAt: v.archivedAt,
          expenseCount: v._count.expenses,
          totalSpent: totalByVendor.get(v.id) ?? 0,
        })),
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');

    const body = await req.json();
    const name = (body.name ?? '').trim();
    if (!name) {
      return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
    }

    const created = await prisma.vendor.create({
      data: {
        tenantId: ctx.tenantId,
        name,
        notes: body.notes || null,
        defaultCategoryId: body.defaultCategoryId ? parseInt(body.defaultCategoryId) : null,
      },
    });

    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'vendor',
      resourceId: String(created.id),
      action: 'create',
      oldValues: null,
      newValues: { name: created.name, notes: created.notes, defaultCategoryId: created.defaultCategoryId },
    });

    return NextResponse.json({
      success: true,
      data: { vendor: { id: created.id, name: created.name, notes: created.notes,
        defaultCategoryId: created.defaultCategoryId, archivedAt: null,
        expenseCount: 0, totalSpent: 0 } },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
cd web
npm test -- src/app/api/vendors
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/api/vendors/
git commit -m "feat(api): GET/POST /api/vendors with stats"
```

---

### Task 3.2: `/api/vendors/[id]` — detail, update, archive

**Files:**
- Create: `web/src/app/api/vendors/[id]/route.ts`

- [ ] **Step 1: Implement detail/update/delete**

Create `web/src/app/api/vendors/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

async function getOwned(id: number, tenantId: string) {
  return prisma.vendor.findFirst({
    where: { id, tenantId },
    include: { defaultCategory: { select: { id: true, name: true } } },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');
    const { id } = await params;
    const vendorId = parseInt(id);

    const vendor = await getOwned(vendorId, ctx.tenantId);
    if (!vendor) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

    const recent = await prisma.expense.findMany({
      where: { tenantId: ctx.tenantId, vendorId },
      orderBy: { date: 'desc' },
      take: 10,
      select: {
        id: true, date: true, amount: true, description: true,
        category: { select: { name: true } },
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        vendor: {
          id: vendor.id, name: vendor.name, notes: vendor.notes,
          defaultCategoryId: vendor.defaultCategoryId,
          defaultCategoryName: vendor.defaultCategory?.name ?? null,
          archivedAt: vendor.archivedAt,
        },
        recentExpenses: recent.map((e) => ({
          id: e.id, date: e.date, amount: Number(e.amount) || 0,
          description: e.description, categoryName: e.category?.name ?? null,
        })),
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');
    const { id } = await params;
    const vendorId = parseInt(id);

    const existing = await getOwned(vendorId, ctx.tenantId);
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

    const body = await req.json();
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.defaultCategoryId !== undefined)
      data.defaultCategoryId = body.defaultCategoryId ? parseInt(body.defaultCategoryId) : null;
    if (body.archived !== undefined)
      data.archivedAt = body.archived ? new Date() : null;

    const updated = await prisma.vendor.update({ where: { id: vendorId }, data });

    await logActivity.diff({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'vendor',
      resourceId: String(vendorId),
      action: 'update',
      oldRow: existing as unknown as Record<string, unknown>,
      newRow: updated as unknown as Record<string, unknown>,
      fields: ['name', 'notes', 'defaultCategoryId', 'archivedAt'],
    });

    return NextResponse.json({ success: true, data: { vendor: updated } });
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.delete');
    const { id } = await params;
    const vendorId = parseInt(id);

    const existing = await getOwned(vendorId, ctx.tenantId);
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

    const refCount = await prisma.expense.count({
      where: { tenantId: ctx.tenantId, vendorId },
    });
    if (refCount > 0) {
      return NextResponse.json(
        { success: false, error: `Cannot delete: ${refCount} expense(s) reference this vendor. Archive instead.` },
        { status: 409 }
      );
    }

    await prisma.vendor.delete({ where: { id: vendorId } });
    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'vendor',
      resourceId: String(vendorId),
      action: 'delete',
      oldValues: { name: existing.name },
      newValues: null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 2: Test happy path + 409 on delete with refs**

Create `web/src/app/api/vendors/__tests__/by-id.test.ts` with tests for:
- GET 404 on cross-tenant fetch
- PATCH happy path
- DELETE returns 409 when `expense.count > 0`
- DELETE happy path when no refs

(Mock pattern same as Task 3.1; use `prisma.expense.count` mock returning 5 for the 409 case.)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    vendor: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
    expense: { count: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('@/lib/tenant', () => ({
  getTenantContext: vi.fn(),
  requirePermission: vi.fn(),
  handleAuthError: vi.fn((e: unknown) => {
    const err = e as Error & { status?: number };
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: err.status ?? 500,
    });
  }),
}));
vi.mock('@/lib/activity', () => ({
  logActivity: Object.assign(vi.fn(), { diff: vi.fn() }),
}));

import { getTenantContext } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { DELETE } from '../[id]/route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/vendors/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      tenantId: 't-1', userId: 1, role: 'owner', overrides: [],
    });
  });

  it('returns 409 when vendor has expenses', async () => {
    (prisma.vendor.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, name: 'USPS', tenantId: 't-1' });
    (prisma.expense.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);

    const req = new Request('http://localhost/api/vendors/1', { method: 'DELETE' });
    const res = await DELETE(req as unknown as import('next/server').NextRequest, params('1'));
    expect(res.status).toBe(409);
    expect(prisma.vendor.delete).not.toHaveBeenCalled();
  });

  it('deletes when no references', async () => {
    (prisma.vendor.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, name: 'USPS', tenantId: 't-1' });
    (prisma.expense.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const req = new Request('http://localhost/api/vendors/1', { method: 'DELETE' });
    const res = await DELETE(req as unknown as import('next/server').NextRequest, params('1'));
    expect(res.status).toBe(200);
    expect(prisma.vendor.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});
```

- [ ] **Step 3: Run tests (expect pass)**

```bash
cd web && npm test -- src/app/api/vendors
```

- [ ] **Step 4: Commit**

```bash
git add web/src/app/api/vendors/
git commit -m "feat(api): vendor detail/update/delete with archive"
```

---

## Phase 4 — Web API: Payment Accounts

### Task 4.1: `/api/payment-accounts` — list, create

**Files:**
- Create: `web/src/app/api/payment-accounts/route.ts`
- Create: `web/src/app/api/payment-accounts/__tests__/list.test.ts`

- [ ] **Step 1: Implement the route**

Create `web/src/app/api/payment-accounts/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

const ALLOWED_TYPES = ['cash', 'credit', 'bank', 'other'] as const;
type AccountType = typeof ALLOWED_TYPES[number];
function isAccountType(t: unknown): t is AccountType {
  return typeof t === 'string' && (ALLOWED_TYPES as readonly string[]).includes(t);
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');

    const startDate = req.nextUrl.searchParams.get('startDate');
    const endDate = req.nextUrl.searchParams.get('endDate');
    const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1';

    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (!includeArchived) where.archivedAt = null;

    const [accounts, totals, lastUsed] = await Promise.all([
      prisma.paymentAccount.findMany({ where, orderBy: { name: 'asc' } }),
      prisma.expense.groupBy({
        by: ['paymentAccountId'],
        where: {
          tenantId: ctx.tenantId,
          ...(startDate || endDate ? {
            date: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          } : {}),
        },
        _sum: { amount: true },
      }),
      prisma.expense.groupBy({
        by: ['paymentAccountId'],
        where: { tenantId: ctx.tenantId },
        _max: { date: true },
      }),
    ]);

    const totalMap = new Map<number, number>();
    for (const t of totals) {
      if (t.paymentAccountId != null) totalMap.set(t.paymentAccountId, Number(t._sum?.amount) || 0);
    }
    const lastMap = new Map<number, Date | null>();
    for (const t of lastUsed) {
      if (t.paymentAccountId != null) lastMap.set(t.paymentAccountId, t._max?.date ?? null);
    }

    return NextResponse.json({
      success: true,
      data: {
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          openingBalance: a.openingBalance ? Number(a.openingBalance) : null,
          currency: a.currency,
          notes: a.notes,
          archivedAt: a.archivedAt,
          spent: totalMap.get(a.id) ?? 0,
          lastUsed: lastMap.get(a.id) ?? null,
        })),
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');

    const body = await req.json();
    const name = (body.name ?? '').trim();
    if (!name) return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
    if (!isAccountType(body.type))
      return NextResponse.json({ success: false, error: `Type must be one of: ${ALLOWED_TYPES.join(', ')}` }, { status: 400 });

    const created = await prisma.paymentAccount.create({
      data: {
        tenantId: ctx.tenantId,
        name,
        type: body.type,
        openingBalance: body.openingBalance != null ? parseFloat(body.openingBalance) : null,
        currency: body.currency || 'USD',
        notes: body.notes || null,
      },
    });

    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'payment_account',
      resourceId: String(created.id),
      action: 'create',
      oldValues: null,
      newValues: { name: created.name, type: created.type },
    });

    return NextResponse.json({ success: true, data: { account: created } });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 2: Write a parallel test**

Create `web/src/app/api/payment-accounts/__tests__/list.test.ts` mirroring the structure of `vendors/__tests__/list.test.ts`. Assert:
- list returns accounts with `spent` and `lastUsed`
- `tenantId` is in every `where` clause
- POST returns 400 when type is invalid

- [ ] **Step 3: Run, fix, commit**

```bash
cd web && npm test -- src/app/api/payment-accounts
git add web/src/app/api/payment-accounts/
git commit -m "feat(api): GET/POST /api/payment-accounts with period totals"
```

---

### Task 4.2: `/api/payment-accounts/[id]` — detail, update, delete

**Files:**
- Create: `web/src/app/api/payment-accounts/[id]/route.ts`

- [ ] **Step 1: Implement (mirror Vendor detail/update/delete)**

Create `web/src/app/api/payment-accounts/[id]/route.ts` following the same pattern as `web/src/app/api/vendors/[id]/route.ts`. Differences:
- Type validation on PATCH (same `isAccountType` guard)
- DELETE returns 409 when `prisma.expense.count({ where: { tenantId, paymentAccountId } }) > 0`
- Detail GET returns vendor → use `paymentAccount`. Returns recent 10 expenses on the account.

(Use the Vendor file from Task 3.2 as a template; replace `vendor` → `paymentAccount`, drop `defaultCategory` join, keep the same archive/delete semantics.)

- [ ] **Step 2: Mirror tests for 409, archive, type validation**

- [ ] **Step 3: Run, commit**

```bash
cd web && npm test -- src/app/api/payment-accounts
git add web/src/app/api/payment-accounts/
git commit -m "feat(api): payment account detail/update/delete"
```

---

## Phase 5 — Web API: Receipts

### Task 5.1: Receipt upload endpoint

**Files:**
- Create: `web/src/app/api/expenses/[id]/receipts/route.ts`

- [ ] **Step 1: Implement POST and GET (list-on-expense)**

Create `web/src/app/api/expenses/[id]/receipts/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import {
  ALLOWED_RECEIPT_MIME,
  MAX_RECEIPT_SIZE_BYTES,
  MAX_RECEIPTS_PER_EXPENSE,
  isAllowedReceiptMime,
  buildReceiptKey,
  uploadReceipt,
} from '@/lib/blob';

async function ownedExpense(id: number, tenantId: string) {
  return prisma.expense.findFirst({ where: { id, tenantId }, select: { id: true } });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');
    const { id } = await params;
    const expenseId = parseInt(id);
    if (!(await ownedExpense(expenseId, ctx.tenantId))) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    const receipts = await prisma.expenseReceipt.findMany({
      where: { expenseId },
      orderBy: { uploadedAt: 'asc' },
    });
    return NextResponse.json({ success: true, data: { receipts } });
  } catch (error) {
    return handleAuthError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');
    const { id } = await params;
    const expenseId = parseInt(id);
    if (!(await ownedExpense(expenseId, ctx.tenantId))) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    const existingCount = await prisma.expenseReceipt.count({ where: { expenseId } });
    if (existingCount >= MAX_RECEIPTS_PER_EXPENSE) {
      return NextResponse.json(
        { success: false, error: `Max ${MAX_RECEIPTS_PER_EXPENSE} receipts per expense.` },
        { status: 400 }
      );
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'File is required (multipart field "file")' }, { status: 400 });
    }
    if (!isAllowedReceiptMime(file.type)) {
      return NextResponse.json(
        { success: false, error: `Unsupported type. Allowed: ${ALLOWED_RECEIPT_MIME.join(', ')}` },
        { status: 400 }
      );
    }
    if (file.size > MAX_RECEIPT_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, error: `File too large. Max ${MAX_RECEIPT_SIZE_BYTES / 1024 / 1024} MB.` },
        { status: 400 }
      );
    }

    const key = buildReceiptKey(ctx.tenantId, expenseId, file.name);
    const { url } = await uploadReceipt({
      key,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
    });

    const receipt = await prisma.expenseReceipt.create({
      data: {
        expenseId,
        blobUrl: url,
        blobKey: key,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      },
    });

    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'expense_receipt',
      resourceId: String(receipt.id),
      action: 'create',
      oldValues: null,
      newValues: { expenseId, filename: receipt.filename, sizeBytes: receipt.sizeBytes },
    });

    return NextResponse.json({ success: true, data: { receipt } });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 2: Write validation tests (mock `@/lib/blob`)**

Create `web/src/app/api/expenses/[id]/receipts/__tests__/upload.test.ts`. Mock `@/lib/blob` so `uploadReceipt` returns a fake URL without hitting Vercel. Cover:
- 400 when file missing
- 400 when MIME not allowed
- 400 when over size limit
- 400 when count limit reached
- 200 + receipt row created on happy path

- [ ] **Step 3: Run, commit**

```bash
cd web && npm test -- src/app/api/expenses
git add web/src/app/api/expenses/[id]/receipts/
git commit -m "feat(api): receipt upload via Vercel Blob with validation"
```

---

### Task 5.2: Receipt delete endpoint

**Files:**
- Create: `web/src/app/api/expenses/[id]/receipts/[rid]/route.ts`

- [ ] **Step 1: Implement DELETE**

Create the file:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { deleteReceipt } from '@/lib/blob';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; rid: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');
    const { id, rid } = await params;
    const expenseId = parseInt(id);
    const receiptId = parseInt(rid);

    const receipt = await prisma.expenseReceipt.findFirst({
      where: { id: receiptId, expenseId, expense: { tenantId: ctx.tenantId } },
    });
    if (!receipt) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    await deleteReceipt(receipt.blobKey);
    await prisma.expenseReceipt.delete({ where: { id: receiptId } });

    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'expense_receipt',
      resourceId: String(receiptId),
      action: 'delete',
      oldValues: { filename: receipt.filename },
      newValues: null,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 2: Test cross-tenant isolation**

Test: a request from tenant `t-2` for a receipt belonging to expense in tenant `t-1` returns 404 (because `expense.tenantId` doesn't match).

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/expenses/[id]/receipts/[rid]/
git commit -m "feat(api): receipt delete"
```

---

## Phase 6 — Web API: Extend Expenses

### Task 6.1: Extend `GET /api/expenses` with vendor/account filters and includes

**Files:**
- Modify: `web/src/app/api/expenses/route.ts`

- [ ] **Step 1: Replace the GET handler**

Replace the GET handler in `web/src/app/api/expenses/route.ts` with a version that:
- Accepts `vendorId`, `paymentAccountId`, `search`, plus existing `category`, `startDate`, `endDate`, `page`, `limit`
- Includes `vendor`, `paymentAccount`, `splits`, `_count.receipts` in the response payload
- Drops `brand` from the include and the response (no longer in schema)

```typescript
export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');

    const sp = req.nextUrl.searchParams;
    const page = parseInt(sp.get('page') || '1');
    const limit = parseInt(sp.get('limit') || '50');
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (sp.get('category'))         where.categoryId = parseInt(sp.get('category')!);
    if (sp.get('vendorId'))         where.vendorId = parseInt(sp.get('vendorId')!);
    if (sp.get('paymentAccountId')) where.paymentAccountId = parseInt(sp.get('paymentAccountId')!);
    if (sp.get('channel'))          where.channel = sp.get('channel');

    const startDate = sp.get('startDate');
    const endDate = sp.get('endDate');
    if (startDate || endDate) {
      where.date = {} as Record<string, Date>;
      if (startDate) (where.date as Record<string, Date>).gte = new Date(startDate);
      if (endDate)   (where.date as Record<string, Date>).lte = new Date(endDate);
    }

    const search = sp.get('search');
    if (search) {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        orderBy: { date: 'desc' },
        skip, take: limit,
        include: {
          category:       { select: { id: true, name: true } },
          vendor:         { select: { id: true, name: true } },
          paymentAccount: { select: { id: true, name: true, type: true } },
          show:           { select: { id: true, title: true } },
          splits:         { orderBy: { sortOrder: 'asc' } },
          _count:         { select: { receipts: true } },
        },
      }),
      prisma.expense.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        expenses: expenses.map((e) => ({
          id: e.id,
          date: e.date,
          amount: Number(e.amount) || 0,
          description: e.description,
          categoryId: e.categoryId,
          categoryName: e.category?.name ?? null,
          vendorId: e.vendorId,
          vendorName: e.vendor?.name ?? null,
          paymentAccountId: e.paymentAccountId,
          paymentAccountName: e.paymentAccount?.name ?? null,
          paymentAccountType: e.paymentAccount?.type ?? null,
          showId: e.showId,
          showTitle: e.show?.title ?? null,
          channel: e.channel,
          notes: e.notes,
          hasSplits: e.hasSplits,
          splits: e.splits.map((s) => ({
            id: s.id, categoryId: s.categoryId,
            amount: Number(s.amount) || 0,
            description: s.description, sortOrder: s.sortOrder,
          })),
          receiptCount: e._count.receipts,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 2: Replace the POST handler — accept vendor/account/splits**

```typescript
import { validateSplitsSum, normalizeSplits, SplitInput } from '@/lib/expenses-helpers';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');

    const body = await req.json();
    const { date, amount, description, categoryId, vendorId, paymentAccountId,
            showId, notes, channel, splits } = body;

    if (!date || amount == null || !paymentAccountId) {
      return NextResponse.json(
        { success: false, error: 'date, amount, and paymentAccountId are required' },
        { status: 400 }
      );
    }
    const amt = parseFloat(amount);

    const account = await prisma.paymentAccount.findFirst({
      where: { id: parseInt(paymentAccountId), tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!account) return NextResponse.json({ success: false, error: 'Invalid paymentAccountId' }, { status: 400 });

    if (vendorId) {
      const v = await prisma.vendor.findFirst({
        where: { id: parseInt(vendorId), tenantId: ctx.tenantId }, select: { id: true },
      });
      if (!v) return NextResponse.json({ success: false, error: 'Invalid vendorId' }, { status: 400 });
    }

    const hasSplits = Array.isArray(splits) && splits.length > 0;
    if (hasSplits) {
      validateSplitsSum(amt, splits as SplitInput[]);
    }

    const created = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.create({
        data: {
          tenantId: ctx.tenantId,
          date: new Date(date),
          amount: amt,
          description: description || null,
          categoryId: categoryId && !hasSplits ? parseInt(categoryId) : null,
          vendorId: vendorId ? parseInt(vendorId) : null,
          paymentAccountId: parseInt(paymentAccountId),
          showId: showId || null,
          channel: channel || null,
          notes: notes || null,
          hasSplits,
        },
      });
      if (hasSplits) {
        await tx.expenseSplit.createMany({
          data: normalizeSplits(splits as SplitInput[]).map((s) => ({
            expenseId: expense.id,
            categoryId: s.categoryId,
            amount: s.amount,
            description: s.description,
            sortOrder: s.sortOrder,
          })),
        });
      }
      return expense;
    });

    await logActivity({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'expense',
      resourceId: String(created.id),
      action: 'create',
      oldValues: null,
      newValues: { date: created.date, amount: Number(created.amount), vendorId: created.vendorId,
        paymentAccountId: created.paymentAccountId, hasSplits: created.hasSplits },
    });

    return NextResponse.json({ success: true, data: { id: created.id } });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 3: Move `summary` GET (current end of route file) into a new `summary/route.ts` if it isn't already**

Check `web/src/app/api/expenses/summary/route.ts` — if it exists, it stays; the changes there are limited to optionally accepting `vendorId` and `paymentAccountId` filters. Apply the same `where` builder to that route.

- [ ] **Step 4: Test the splits-sum invariant**

Create `web/src/app/api/expenses/__tests__/post.test.ts`. Mock prisma so `paymentAccount.findFirst` returns a valid record. Assert:
- POST with no `paymentAccountId` → 400
- POST with `splits` summing to a different total → 400 with message containing "Splits sum"
- POST with valid splits → calls `tx.expenseSplit.createMany` and `expense.hasSplits=true`

- [ ] **Step 5: Run, commit**

```bash
cd web && npm test -- src/app/api/expenses
git add web/src/app/api/expenses/
git commit -m "feat(api): extend expenses GET/POST with vendor, account, splits"
```

---

### Task 6.2: Extend `PATCH /api/expenses/[id]`

**Files:**
- Modify: `web/src/app/api/expenses/[id]/route.ts`

- [ ] **Step 1: Update the PATCH handler**

Replace the body of `PATCH` with logic that:
- Removes `brandId` handling (column dropped)
- Adds `vendorId` and `paymentAccountId` handling, validating tenant ownership when provided
- Accepts a `splits` array (or `null` to clear). Within a transaction:
  - If `splits` is an array with length > 0: validate sum vs new amount (or existing amount if amount not changed), delete existing splits, create new, set `hasSplits=true`, set `categoryId=null`.
  - If `splits === null` or empty array: delete existing splits, set `hasSplits=false`.
- Returns the updated expense in the same shape as GET (with vendor, paymentAccount, splits).

```typescript
import { validateSplitsSum, normalizeSplits, SplitInput } from '@/lib/expenses-helpers';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.edit');

    const { id } = await params;
    const expenseId = parseInt(id);
    const body = await req.json();

    const existing = await prisma.expense.findFirst({
      where: { id: expenseId, tenantId: ctx.tenantId },
    });
    if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

    if (body.paymentAccountId !== undefined && body.paymentAccountId !== null) {
      const a = await prisma.paymentAccount.findFirst({
        where: { id: parseInt(body.paymentAccountId), tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!a) return NextResponse.json({ success: false, error: 'Invalid paymentAccountId' }, { status: 400 });
    }
    if (body.vendorId !== undefined && body.vendorId !== null) {
      const v = await prisma.vendor.findFirst({
        where: { id: parseInt(body.vendorId), tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!v) return NextResponse.json({ success: false, error: 'Invalid vendorId' }, { status: 400 });
    }

    const update: Record<string, unknown> = {};
    if (body.date !== undefined)             update.date = new Date(body.date);
    if (body.amount !== undefined)           update.amount = parseFloat(body.amount);
    if (body.description !== undefined)      update.description = body.description || null;
    if (body.vendorId !== undefined)         update.vendorId = body.vendorId ? parseInt(body.vendorId) : null;
    if (body.paymentAccountId !== undefined) update.paymentAccountId = parseInt(body.paymentAccountId);
    if (body.showId !== undefined)           update.showId = body.showId || null;
    if (body.channel !== undefined)          update.channel = body.channel || null;
    if (body.notes !== undefined)            update.notes = body.notes || null;

    const splitsProvided = body.splits !== undefined;
    const newAmount = update.amount !== undefined ? Number(update.amount) : Number(existing.amount);
    const willHaveSplits = splitsProvided && Array.isArray(body.splits) && body.splits.length > 0;

    if (willHaveSplits) {
      validateSplitsSum(newAmount, body.splits as SplitInput[]);
      update.hasSplits = true;
      update.categoryId = null;
    } else if (splitsProvided) {
      update.hasSplits = false;
    } else if (body.categoryId !== undefined) {
      update.categoryId = body.categoryId ? parseInt(body.categoryId) : null;
    }

    await prisma.$transaction(async (tx) => {
      await tx.expense.update({ where: { id: expenseId }, data: update });
      if (splitsProvided) {
        await tx.expenseSplit.deleteMany({ where: { expenseId } });
        if (willHaveSplits) {
          await tx.expenseSplit.createMany({
            data: normalizeSplits(body.splits as SplitInput[]).map((s) => ({
              expenseId,
              categoryId: s.categoryId,
              amount: s.amount,
              description: s.description,
              sortOrder: s.sortOrder,
            })),
          });
        }
      }
    });

    await logActivity.diff({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      resourceType: 'expense',
      resourceId: String(expenseId),
      action: 'update',
      oldRow: existing as unknown as Record<string, unknown>,
      newRow: { ...existing, ...update } as unknown as Record<string, unknown>,
      fields: ['date', 'amount', 'description', 'categoryId', 'vendorId', 'paymentAccountId',
               'showId', 'notes', 'channel', 'hasSplits'],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

The `DELETE` handler in this file remains unchanged.

- [ ] **Step 2: Test PATCH split transitions**

Add to the existing `[id]/__tests__/...test.ts` (or create one). Cover:
- PATCH with `splits=[…]` valid sum → splits replaced, `hasSplits=true`, `categoryId` cleared
- PATCH with `splits=[]` → splits deleted, `hasSplits=false`
- PATCH with `splits` whose sum mismatches → 400

- [ ] **Step 3: Run, commit**

```bash
cd web && npm test -- src/app/api/expenses
git add web/src/app/api/expenses/
git commit -m "feat(api): PATCH expense with splits transitions"
```

---

## Phase 7 — Web API: Reports

### Task 7.1: `GET /api/reports/expenses`

**Files:**
- Create: `web/src/app/api/reports/expenses/route.ts`

- [ ] **Step 1: Implement aggregations**

Create the route that returns four breakdowns + an over-time series:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

type Granularity = 'day' | 'week' | 'month';
function isGranularity(s: string | null): s is Granularity {
  return s === 'day' || s === 'week' || s === 'month';
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');

    const sp = req.nextUrl.searchParams;
    const startDate = sp.get('startDate');
    const endDate   = sp.get('endDate');
    const granularity: Granularity = isGranularity(sp.get('period')) ? (sp.get('period') as Granularity) : 'month';

    const dateFilter: Record<string, Date> = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate)   dateFilter.lte = new Date(endDate);
    const dateClause = (startDate || endDate) ? { date: dateFilter } : {};

    const where = { tenantId: ctx.tenantId, ...dateClause };

    const [byCategory, byVendor, byAccount, totals] = await Promise.all([
      prisma.expense.groupBy({ by: ['categoryId'], where, _sum: { amount: true }, _count: true }),
      prisma.expense.groupBy({ by: ['vendorId'],   where, _sum: { amount: true }, _count: true }),
      prisma.expense.groupBy({ by: ['paymentAccountId'], where, _sum: { amount: true }, _count: true }),
      prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true }),
    ]);

    const [categories, vendors, accounts] = await Promise.all([
      prisma.expenseCategory.findMany({
        where: { tenantId: ctx.tenantId, id: { in: byCategory.map((b) => b.categoryId).filter((x): x is number => x != null) } },
        select: { id: true, name: true },
      }),
      prisma.vendor.findMany({
        where: { tenantId: ctx.tenantId, id: { in: byVendor.map((b) => b.vendorId).filter((x): x is number => x != null) } },
        select: { id: true, name: true },
      }),
      prisma.paymentAccount.findMany({
        where: { tenantId: ctx.tenantId, id: { in: byAccount.map((b) => b.paymentAccountId).filter((x): x is number => x != null) } },
        select: { id: true, name: true, type: true },
      }),
    ]);

    const catName = new Map(categories.map((c) => [c.id, c.name]));
    const venName = new Map(vendors.map((v) => [v.id, v.name]));
    const accInfo = new Map(accounts.map((a) => [a.id, a]));

    // Over-time using raw SQL for date_trunc support
    const trunc = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';
    const overTime = await prisma.$queryRawUnsafe<Array<{ bucket: Date; total: number; count: bigint }>>(`
      SELECT date_trunc('${trunc}', date) AS bucket,
             COALESCE(SUM(amount), 0)::float AS total,
             COUNT(*) AS count
      FROM expenses
      WHERE tenant_id = $1::uuid
        ${startDate ? 'AND date >= $2' : ''}
        ${endDate   ? `AND date <= $${startDate ? '3' : '2'}` : ''}
      GROUP BY bucket
      ORDER BY bucket ASC
    `, ctx.tenantId, ...(startDate ? [startDate] : []), ...(endDate ? [endDate] : []));

    return NextResponse.json({
      success: true,
      data: {
        totals: {
          total: Number(totals._sum?.amount) || 0,
          count: totals._count || 0,
          average: totals._count ? (Number(totals._sum?.amount) || 0) / totals._count : 0,
        },
        byCategory: byCategory
          .map((b) => ({
            categoryId: b.categoryId,
            categoryName: b.categoryId ? (catName.get(b.categoryId) ?? 'Unknown') : 'Uncategorized',
            total: Number(b._sum?.amount) || 0,
            count: b._count,
          }))
          .sort((a, b) => b.total - a.total),
        byVendor: byVendor
          .map((b) => ({
            vendorId: b.vendorId,
            vendorName: b.vendorId ? (venName.get(b.vendorId) ?? 'Unknown') : 'No vendor',
            total: Number(b._sum?.amount) || 0,
            count: b._count,
          }))
          .sort((a, b) => b.total - a.total),
        byAccount: byAccount
          .map((b) => ({
            accountId: b.paymentAccountId,
            accountName: b.paymentAccountId ? (accInfo.get(b.paymentAccountId)?.name ?? 'Unknown') : 'None',
            accountType: b.paymentAccountId ? (accInfo.get(b.paymentAccountId)?.type ?? null) : null,
            total: Number(b._sum?.amount) || 0,
            count: b._count,
          }))
          .sort((a, b) => b.total - a.total),
        overTime: overTime.map((r) => ({
          bucket: r.bucket,
          total: r.total,
          count: Number(r.count),
        })),
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

> Note on splits: this v1 aggregates by header `categoryId` (which is `null` when the expense has splits). A future iteration can union header categories with split categories. For v1, expenses with splits show as "Uncategorized" in the by-category breakdown. Document this in the UI.

- [ ] **Step 2: Smoke test the route shape**

Add `web/src/app/api/reports/expenses/__tests__/shape.test.ts`. Mock prisma to return empty arrays/aggregates. Assert the response shape contains `totals`, `byCategory`, `byVendor`, `byAccount`, `overTime`.

- [ ] **Step 3: Commit**

```bash
cd web && npm test -- src/app/api/reports/expenses
git add web/src/app/api/reports/expenses/
git commit -m "feat(api): expense reports aggregation endpoint"
```

---

## Phase 8 — Desktop: Reusable SlideOverDrawer

### Task 8.1: SlideOverDrawer component

**Files:**
- Create: `desktop/src/components/SlideOverDrawer.tsx`

- [ ] **Step 1: Implement the component**

Create `desktop/src/components/SlideOverDrawer.tsx`:

```tsx
import { useEffect, useRef, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronUp, ChevronDown } from 'lucide-react';

export interface SlideOverDrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  side?: 'right' | 'left';
  footer?: ReactNode;
  onPrev?: () => void;
  onNext?: () => void;
  children: ReactNode;
}

const WIDTH_CLASS: Record<NonNullable<SlideOverDrawerProps['width']>, string> = {
  sm: 'w-[400px]',
  md: 'w-[520px]',
  lg: 'w-[720px]',
};

export function SlideOverDrawer({
  open, onClose, title, subtitle, width = 'md', side = 'right',
  footer, onPrev, onNext, children,
}: SlideOverDrawerProps) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && onNext) {
        e.preventDefault();
        onNext();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && onPrev) {
        e.preventDefault();
        onPrev();
      }
    };
    window.addEventListener('keydown', onKey);

    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
        ?? panelRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      previousFocus.current?.focus();
    };
  }, [open, onClose, onPrev, onNext]);

  if (!open) return null;

  const sideClass = side === 'right' ? 'right-0' : 'left-0';
  const enterFrom  = side === 'right' ? 'translate-x-full' : '-translate-x-full';

  return createPortal(
    <div className="fixed inset-0 z-[9999]" aria-modal="true" role="dialog">
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-200"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`
          absolute top-0 bottom-0 ${sideClass} ${WIDTH_CLASS[width]}
          bg-bg-secondary border-l border-border-subtle shadow-2xl
          flex flex-col outline-none
          transition-transform duration-200 ease-out
          ${open ? 'translate-x-0' : enterFrom}
        `}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 p-4 border-b border-border-subtle">
          <div className="min-w-0">
            <div className="text-lg font-semibold text-text-primary truncate">{title}</div>
            {subtitle && <div className="text-sm text-text-secondary truncate">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1">
            {(onPrev || onNext) && (
              <>
                <button
                  onClick={onPrev}
                  disabled={!onPrev}
                  className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Previous (↑)"
                >
                  <ChevronUp className="w-5 h-5" />
                </button>
                <button
                  onClick={onNext}
                  disabled={!onNext}
                  className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Next (↓)"
                >
                  <ChevronDown className="w-5 h-5" />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary rounded transition-colors"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-border-subtle p-4 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 2: Light unit test (open/close, esc handling)**

Create `desktop/src/components/__tests__/SlideOverDrawer.test.tsx`. If desktop doesn't have a test runner set up yet (check `desktop/package.json`), skip this step and put a TODO in the implementation plan completion notes — the component is small enough that manual verification works for v1.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/SlideOverDrawer.tsx
git commit -m "feat(ui): reusable SlideOverDrawer component"
```

---

## Phase 9 — Desktop: Hooks

### Task 9.1: `useVendors` hook

**Files:**
- Create: `desktop/src/hooks/useVendors.ts`

- [ ] **Step 1: Implement**

```typescript
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export interface Vendor {
  id: number;
  name: string;
  notes: string | null;
  defaultCategoryId: number | null;
  defaultCategoryName: string | null;
  archivedAt: string | null;
  expenseCount: number;
  totalSpent: number;
}

export interface VendorDetail {
  vendor: Vendor;
  recentExpenses: Array<{
    id: number; date: string; amount: number;
    description: string | null; categoryName: string | null;
  }>;
}

export function useVendors() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadVendors = useCallback(async (includeArchived = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiClient.get<{ data: { vendors: Vendor[] } }>(
        '/api/vendors',
        includeArchived ? { includeArchived: 1 } : {}
      );
      setVendors(r.data?.vendors || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vendors');
    } finally {
      setLoading(false);
    }
  }, []);

  const addVendor = useCallback(async (input: { name: string; notes?: string; defaultCategoryId?: number | null }) => {
    try {
      const r = await apiClient.post<{ data: { vendor: Vendor } }>('/api/vendors', input);
      const v = r.data?.vendor;
      if (v) setVendors((prev) => [...prev, v].sort((a, b) => a.name.localeCompare(b.name)));
      return { success: true, vendor: v };
    } catch {
      return { success: false };
    }
  }, []);

  const updateVendor = useCallback(async (id: number, patch: Partial<Pick<Vendor, 'name' | 'notes' | 'defaultCategoryId'>> & { archived?: boolean }) => {
    try {
      await apiClient.patch(`/api/vendors/${id}`, patch);
      setVendors((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } as Vendor : v)));
      return { success: true };
    } catch {
      return { success: false };
    }
  }, []);

  const deleteVendor = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/api/vendors/${id}`);
      setVendors((prev) => prev.filter((v) => v.id !== id));
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Delete failed' };
    }
  }, []);

  const loadVendorDetail = useCallback(async (id: number) => {
    return apiClient.get<{ data: VendorDetail }>(`/api/vendors/${id}`);
  }, []);

  return { vendors, loading, error, loadVendors, addVendor, updateVendor, deleteVendor, loadVendorDetail };
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/hooks/useVendors.ts
git commit -m "feat(hooks): useVendors"
```

---

### Task 9.2: `usePaymentAccounts` hook

**Files:**
- Create: `desktop/src/hooks/usePaymentAccounts.ts`

- [ ] **Step 1: Implement (mirror `useVendors`)**

```typescript
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export type AccountType = 'cash' | 'credit' | 'bank' | 'other';

export interface PaymentAccount {
  id: number;
  name: string;
  type: AccountType;
  openingBalance: number | null;
  currency: string;
  notes: string | null;
  archivedAt: string | null;
  spent: number;
  lastUsed: string | null;
}

export function usePaymentAccounts() {
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async (filters?: { startDate?: string; endDate?: string; includeArchived?: boolean }) => {
    setLoading(true); setError(null);
    try {
      const params: Record<string, string | number> = {};
      if (filters?.startDate) params.startDate = filters.startDate;
      if (filters?.endDate)   params.endDate = filters.endDate;
      if (filters?.includeArchived) params.includeArchived = 1;
      const r = await apiClient.get<{ data: { accounts: PaymentAccount[] } }>('/api/payment-accounts', params);
      setAccounts(r.data?.accounts || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  const addAccount = useCallback(async (input: { name: string; type: AccountType; openingBalance?: number | null; notes?: string }) => {
    try {
      const r = await apiClient.post<{ data: { account: PaymentAccount } }>('/api/payment-accounts', input);
      const a = r.data?.account;
      if (a) setAccounts((prev) => [...prev, a].sort((x, y) => x.name.localeCompare(y.name)));
      return { success: true, account: a };
    } catch {
      return { success: false };
    }
  }, []);

  const updateAccount = useCallback(async (id: number, patch: Partial<Omit<PaymentAccount, 'id' | 'spent' | 'lastUsed'>> & { archived?: boolean }) => {
    try {
      await apiClient.patch(`/api/payment-accounts/${id}`, patch);
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } as PaymentAccount : a)));
      return { success: true };
    } catch {
      return { success: false };
    }
  }, []);

  const deleteAccount = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/api/payment-accounts/${id}`);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Delete failed' };
    }
  }, []);

  return { accounts, loading, error, loadAccounts, addAccount, updateAccount, deleteAccount };
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/hooks/usePaymentAccounts.ts
git commit -m "feat(hooks): usePaymentAccounts"
```

---

### Task 9.3: Extend `useExpenses` hook

**Files:**
- Modify: `desktop/src/hooks/useExpenses.ts`

- [ ] **Step 1: Replace `Expense` type and CRUD methods with extended versions**

Open `desktop/src/hooks/useExpenses.ts`. Replace the file contents with:

```typescript
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export interface ExpenseSplit {
  id?: number;
  categoryId: number | null;
  amount: number;
  description: string | null;
  sortOrder: number;
}

export interface Expense {
  id: number;
  date: string;
  amount: number;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  paymentAccountId: number;
  paymentAccountName: string | null;
  paymentAccountType: 'cash' | 'credit' | 'bank' | 'other' | null;
  showId: string | null;
  showTitle: string | null;
  channel: string | null;
  notes: string | null;
  hasSplits: boolean;
  splits: ExpenseSplit[];
  receiptCount: number;
}

export interface ExpenseCategory {
  id: number;
  name: string;
  description?: string | null;
}

export interface ExpenseFilters {
  startDate?: string;
  endDate?: string;
  categoryId?: number;
  vendorId?: number;
  paymentAccountId?: number;
  channel?: string;
  search?: string;
}

export interface ExpenseSummary {
  total: number;
  topVendor: { name: string; total: number } | null;
  topCategory: { name: string; total: number } | null;
}

export interface ExpenseInput {
  date: string;
  amount: number;
  description?: string | null;
  categoryId?: number | null;
  vendorId?: number | null;
  paymentAccountId: number;
  channel?: string | null;
  showId?: string | null;
  notes?: string | null;
  splits?: Array<{ categoryId: number | null; amount: number; description?: string | null }>;
}

export function useExpenses() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadExpenses = useCallback(async (filters?: ExpenseFilters) => {
    setLoading(true); setError(null);
    try {
      const params: Record<string, string | number | undefined> = {};
      if (filters?.startDate)        params.startDate = filters.startDate;
      if (filters?.endDate)          params.endDate = filters.endDate;
      if (filters?.categoryId)       params.category = filters.categoryId;
      if (filters?.vendorId)         params.vendorId = filters.vendorId;
      if (filters?.paymentAccountId) params.paymentAccountId = filters.paymentAccountId;
      if (filters?.channel)          params.channel = filters.channel;
      if (filters?.search)           params.search = filters.search;

      const r = await apiClient.get<{ data: { expenses: Expense[] } }>('/api/expenses', params);
      setExpenses(r.data?.expenses || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load expenses');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const r = await apiClient.get<{ data: { categories: ExpenseCategory[] } }>('/api/expenses/categories');
      setCategories(r.data?.categories || []);
    } catch { /* ignore */ }
  }, []);

  const loadSummary = useCallback(async (filters?: ExpenseFilters) => {
    try {
      const params: Record<string, string | number | undefined> = {};
      if (filters?.startDate)        params.startDate = filters.startDate;
      if (filters?.endDate)          params.endDate = filters.endDate;
      if (filters?.categoryId)       params.categoryId = filters.categoryId;
      if (filters?.vendorId)         params.vendorId = filters.vendorId;
      if (filters?.paymentAccountId) params.paymentAccountId = filters.paymentAccountId;
      if (filters?.channel)          params.channel = filters.channel;

      const r = await apiClient.get<{
        data: {
          grandTotal: number;
          topVendor: { name: string; total: number } | null;
          topCategory: { name: string; total: number } | null;
        };
      }>('/api/expenses/summary', params);
      setSummary({
        total: r.data?.grandTotal || 0,
        topVendor: r.data?.topVendor ?? null,
        topCategory: r.data?.topCategory ?? null,
      });
    } catch { /* ignore */ }
  }, []);

  const addExpense = useCallback(async (input: ExpenseInput) => {
    try {
      const r = await apiClient.post<{ data: { id: number } }>('/api/expenses', input);
      return { success: true, id: r.data?.id };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Failed to create' };
    }
  }, []);

  const updateExpense = useCallback(async (id: number, patch: Partial<ExpenseInput>) => {
    try {
      await apiClient.patch(`/api/expenses/${id}`, patch);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Failed to update' };
    }
  }, []);

  const deleteExpense = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/api/expenses/${id}`);
      setExpenses((prev) => prev.filter((e) => e.id !== id));
      return { success: true };
    } catch {
      return { success: false };
    }
  }, []);

  const addCategory = useCallback(async (name: string) => {
    try {
      const r = await apiClient.post<{ data: { category: ExpenseCategory } }>('/api/expenses/categories', { name });
      const created = r.data?.category;
      if (created) setCategories((prev) => [...prev, created]);
      return { success: true, category: created };
    } catch {
      return { success: false };
    }
  }, []);

  const deleteCategory = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/api/expenses/categories/${id}`);
      setCategories((prev) => prev.filter((c) => c.id !== id));
      return { success: true };
    } catch {
      return { success: false };
    }
  }, []);

  return {
    expenses, categories, summary, loading, error,
    loadExpenses, loadCategories, loadSummary,
    addExpense, updateExpense, deleteExpense,
    addCategory, deleteCategory,
  };
}
```

- [ ] **Step 2: Update `web/src/app/api/expenses/summary/route.ts` to return `topVendor` and `topCategory`**

Replace the GET handler with:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getTenantContext, requirePermission, handleAuthError } from '@/lib/tenant';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, 'expenses.view');

    const sp = req.nextUrl.searchParams;
    const where: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (sp.get('categoryId'))       where.categoryId = parseInt(sp.get('categoryId')!);
    if (sp.get('vendorId'))         where.vendorId = parseInt(sp.get('vendorId')!);
    if (sp.get('paymentAccountId')) where.paymentAccountId = parseInt(sp.get('paymentAccountId')!);
    if (sp.get('channel'))          where.channel = sp.get('channel');
    const startDate = sp.get('startDate'); const endDate = sp.get('endDate');
    if (startDate || endDate) {
      where.date = {} as Record<string, Date>;
      if (startDate) (where.date as Record<string, Date>).gte = new Date(startDate);
      if (endDate)   (where.date as Record<string, Date>).lte = new Date(endDate);
    }

    const [grand, byVendor, byCategory] = await Promise.all([
      prisma.expense.aggregate({ where, _sum: { amount: true } }),
      prisma.expense.groupBy({ by: ['vendorId'], where, _sum: { amount: true } }),
      prisma.expense.groupBy({ by: ['categoryId'], where, _sum: { amount: true } }),
    ]);

    const topVenRow = byVendor
      .filter((r) => r.vendorId != null)
      .sort((a, b) => Number(b._sum?.amount || 0) - Number(a._sum?.amount || 0))[0];
    const topCatRow = byCategory
      .filter((r) => r.categoryId != null)
      .sort((a, b) => Number(b._sum?.amount || 0) - Number(a._sum?.amount || 0))[0];

    const [topVendor, topCategory] = await Promise.all([
      topVenRow
        ? prisma.vendor.findUnique({ where: { id: topVenRow.vendorId! }, select: { name: true } })
            .then((v) => v ? { name: v.name, total: Number(topVenRow._sum?.amount || 0) } : null)
        : Promise.resolve(null),
      topCatRow
        ? prisma.expenseCategory.findUnique({ where: { id: topCatRow.categoryId! }, select: { name: true } })
            .then((c) => c ? { name: c.name, total: Number(topCatRow._sum?.amount || 0) } : null)
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        grandTotal: Number(grand._sum?.amount) || 0,
        topVendor,
        topCategory,
      },
    });
  } catch (error) {
    return handleAuthError(error);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/hooks/useExpenses.ts web/src/app/api/expenses/summary/
git commit -m "feat(hooks): extend useExpenses; summary returns topVendor/topCategory"
```

---

### Task 9.4: `useExpenseReports` hook

**Files:**
- Create: `desktop/src/hooks/useExpenseReports.ts`

- [ ] **Step 1: Implement**

```typescript
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export interface ExpenseReport {
  totals: { total: number; count: number; average: number };
  byCategory: Array<{ categoryId: number | null; categoryName: string; total: number; count: number }>;
  byVendor:   Array<{ vendorId: number | null;   vendorName: string;   total: number; count: number }>;
  byAccount:  Array<{ accountId: number | null;  accountName: string;  accountType: string | null; total: number; count: number }>;
  overTime:   Array<{ bucket: string; total: number; count: number }>;
}

export function useExpenseReports() {
  const [report, setReport] = useState<ExpenseReport | null>(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async (filters: { startDate?: string; endDate?: string; period?: 'day' | 'week' | 'month' }) => {
    setLoading(true);
    try {
      const r = await apiClient.get<{ data: ExpenseReport }>('/api/reports/expenses', filters);
      setReport(r.data || null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { report, loading, loadReport };
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/hooks/useExpenseReports.ts
git commit -m "feat(hooks): useExpenseReports"
```

---

## Phase 10 — Desktop: Expenses-tab supporting components

### Task 10.1: `VendorCombobox`

**Files:**
- Create: `desktop/src/components/expenses/VendorCombobox.tsx`

- [ ] **Step 1: Implement**

A combobox that filters a vendor list by typed text and shows a "Create new vendor: {input}" option at the bottom when no exact match. On select, returns vendor id (or `null` for "no vendor").

```tsx
import { useState, useMemo, useRef, useEffect } from 'react';
import { Vendor } from '../../hooks/useVendors';
import { Plus, Check } from 'lucide-react';

interface Props {
  vendors: Vendor[];
  value: number | null;
  onChange: (vendorId: number | null) => void;
  onCreate: (name: string) => Promise<{ success: boolean; vendor?: Vendor }>;
  placeholder?: string;
  disabled?: boolean;
}

export function VendorCombobox({ vendors, value, onChange, onCreate, placeholder = 'Select vendor…', disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => vendors.find((v) => v.id === value) ?? null, [vendors, value]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = vendors.filter((v) => !v.archivedAt);
    if (!q) return active;
    return active.filter((v) => v.name.toLowerCase().includes(q));
  }, [vendors, query]);

  const exactMatch = filtered.some((v) => v.name.toLowerCase() === query.trim().toLowerCase());

  const handleCreate = async () => {
    const name = query.trim();
    if (!name) return;
    const r = await onCreate(name);
    if (r.success && r.vendor) {
      onChange(r.vendor.id);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-left text-text-primary focus:outline-none focus:border-accent disabled:opacity-50"
      >
        {selected ? selected.name : <span className="text-text-tertiary">{placeholder}</span>}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full bg-bg-secondary border border-border-subtle rounded-lg shadow-xl max-h-72 overflow-hidden">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } }}
            placeholder="Type to filter or create…"
            className="w-full px-3 py-2 bg-bg-tertiary border-b border-border-subtle text-text-primary focus:outline-none"
          />
          <div className="overflow-y-auto max-h-56">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary flex items-center justify-between"
            >
              <span className="italic">No vendor</span>
              {value === null && <Check className="w-4 h-4" />}
            </button>
            {filtered.map((v) => (
              <button
                type="button"
                key={v.id}
                onClick={() => { onChange(v.id); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-bg-tertiary flex items-center justify-between"
              >
                <span>{v.name}</span>
                {value === v.id && <Check className="w-4 h-4" />}
              </button>
            ))}
            {query.trim() && !exactMatch && (
              <button
                type="button"
                onClick={handleCreate}
                className="w-full text-left px-3 py-2 text-sm text-accent hover:bg-bg-tertiary flex items-center gap-2 border-t border-border-subtle"
              >
                <Plus className="w-4 h-4" />
                Create vendor: <strong>{query.trim()}</strong>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/VendorCombobox.tsx
git commit -m "feat(ui): VendorCombobox with inline create"
```

---

### Task 10.2: `AccountSelect`

**Files:**
- Create: `desktop/src/components/expenses/AccountSelect.tsx`

- [ ] **Step 1: Implement**

A native `<select>`-style dropdown listing non-archived payment accounts grouped by type. Required (no "none" option in the expense drawer).

```tsx
import { PaymentAccount } from '../../hooks/usePaymentAccounts';

interface Props {
  accounts: PaymentAccount[];
  value: number | null;
  onChange: (id: number) => void;
  required?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  cash: 'Cash',
  credit: 'Credit',
  bank: 'Bank',
  other: 'Other',
};

export function AccountSelect({ accounts, value, onChange, required }: Props) {
  const active = accounts.filter((a) => !a.archivedAt);
  const grouped: Record<string, PaymentAccount[]> = {};
  for (const a of active) {
    grouped[a.type] = grouped[a.type] || [];
    grouped[a.type].push(a);
  }

  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(parseInt(e.target.value))}
      required={required}
      className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent"
    >
      {value == null && <option value="" disabled>Select account…</option>}
      {Object.keys(TYPE_LABEL).filter((t) => grouped[t]?.length).map((t) => (
        <optgroup key={t} label={TYPE_LABEL[t]}>
          {grouped[t].map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/AccountSelect.tsx
git commit -m "feat(ui): AccountSelect"
```

---

### Task 10.3: `ExpenseSplitsEditor`

**Files:**
- Create: `desktop/src/components/expenses/ExpenseSplitsEditor.tsx`

- [ ] **Step 1: Implement**

```tsx
import { ExpenseSplit } from '../../hooks/useExpenses';
import { ExpenseCategory } from '../../hooks/useExpenses';
import { Plus, Trash2 } from 'lucide-react';

interface Props {
  amount: number;
  splits: ExpenseSplit[];
  categories: ExpenseCategory[];
  onChange: (splits: ExpenseSplit[]) => void;
}

export function ExpenseSplitsEditor({ amount, splits, categories, onChange }: Props) {
  const total = splits.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const diff = amount - total;
  const balanced = Math.abs(diff) < 0.011;

  const update = (i: number, patch: Partial<ExpenseSplit>) => {
    const next = splits.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const add = () =>
    onChange([
      ...splits,
      { categoryId: null, amount: Math.max(diff, 0), description: null, sortOrder: splits.length },
    ]);
  const remove = (i: number) => onChange(splits.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {splits.map((s, i) => (
        <div key={i} className="grid grid-cols-[1fr_120px_32px] gap-2 items-center">
          <select
            value={s.categoryId ?? ''}
            onChange={(e) => update(i, { categoryId: e.target.value ? parseInt(e.target.value) : null })}
            className="px-2 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-sm text-text-primary"
          >
            <option value="">Uncategorized</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            type="number" step="0.01" min="0"
            value={s.amount}
            onChange={(e) => update(i, { amount: parseFloat(e.target.value) || 0 })}
            className="px-2 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-sm text-text-primary text-right"
          />
          <button type="button" onClick={() => remove(i)} className="p-1 text-text-tertiary hover:text-red-400 rounded" title="Remove">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        type="button" onClick={add}
        className="flex items-center gap-1 text-sm text-accent hover:underline"
      >
        <Plus className="w-4 h-4" /> Add line
      </button>
      <div className={`mt-2 px-2 py-1 rounded text-xs flex justify-between ${balanced ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
        <span>Sum: ${total.toFixed(2)} / ${amount.toFixed(2)}</span>
        <span>{balanced ? 'Balanced' : `Off by ${diff.toFixed(2)}`}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/ExpenseSplitsEditor.tsx
git commit -m "feat(ui): ExpenseSplitsEditor with sum validation"
```

---

### Task 10.4: `ReceiptUploader`

**Files:**
- Create: `desktop/src/components/expenses/ReceiptUploader.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState, useRef, DragEvent } from 'react';
import { Trash2, FileText, Upload } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';

export interface Receipt {
  id: number;
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

interface Props {
  expenseId: number | null;          // null when expense not yet saved (pending mode)
  receipts: Receipt[];
  onChange: (receipts: Receipt[]) => void;
}

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

export function ReceiptUploader({ expenseId, receipts, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList) => {
    if (expenseId == null) {
      setError('Save the expense first to attach receipts.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const next = receipts.slice();
      for (const file of Array.from(files)) {
        if (!ALLOWED.includes(file.type)) { setError(`Unsupported type: ${file.name}`); continue; }
        if (file.size > MAX_BYTES) { setError(`Too large: ${file.name}`); continue; }
        const fd = new FormData();
        fd.append('file', file);
        // apiClient is JSON-only; call fetch directly with auth headers from localStorage:
        const token = localStorage.getItem('authToken');
        const tenantId = localStorage.getItem('tenantId');
        const baseUrl = localStorage.getItem('webAppUrl') || 'http://localhost:3000';
        const res = await fetch(`${baseUrl}/api/expenses/${expenseId}/receipts`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
          },
          body: fd,
        });
        const data = await res.json();
        if (!res.ok || !data.success) { setError(data.error || `Upload failed for ${file.name}`); continue; }
        next.push(data.data.receipt);
      }
      onChange(next);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (rid: number) => {
    if (expenseId == null) return;
    await apiClient.delete(`/api/expenses/${expenseId}/receipts/${rid}`);
    onChange(receipts.filter((r) => r.id !== rid));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className="border-2 border-dashed border-border-subtle rounded-lg p-4 text-center cursor-pointer hover:border-accent transition-colors"
      >
        <Upload className="w-5 h-5 mx-auto mb-2 text-text-tertiary" />
        <div className="text-sm text-text-secondary">
          {uploading ? 'Uploading…' : 'Drop receipts here or click to browse'}
        </div>
        <div className="text-xs text-text-tertiary mt-1">PNG, JPG, WEBP, PDF · max 10 MB · max 10 files</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED.join(',')}
          className="hidden"
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
      {receipts.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {receipts.map((r) => (
            <div key={r.id} className="flex items-center gap-2 p-2 bg-bg-tertiary rounded">
              {r.mimeType.startsWith('image/') ? (
                <img src={r.blobUrl} alt={r.filename} className="w-10 h-10 object-cover rounded" />
              ) : (
                <FileText className="w-10 h-10 text-text-tertiary" />
              )}
              <div className="flex-1 min-w-0">
                <a href={r.blobUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-text-primary hover:text-accent block truncate">
                  {r.filename}
                </a>
                <div className="text-xs text-text-tertiary">{(r.sizeBytes / 1024).toFixed(0)} KB</div>
              </div>
              <button type="button" onClick={() => remove(r.id)} className="p-1 text-text-tertiary hover:text-red-400 rounded">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/ReceiptUploader.tsx
git commit -m "feat(ui): ReceiptUploader with drag-and-drop"
```

---

### Task 10.5: `ExpenseDrawer` (combines header form + splits + receipts)

**Files:**
- Create: `desktop/src/components/expenses/ExpenseDrawer.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { SlideOverDrawer } from '../SlideOverDrawer';
import { Expense, ExpenseInput, useExpenses, ExpenseSplit, ExpenseCategory } from '../../hooks/useExpenses';
import { Vendor, useVendors } from '../../hooks/useVendors';
import { PaymentAccount } from '../../hooks/usePaymentAccounts';
import { useShows } from '../../contexts/ShowsContext';
import { VendorCombobox } from './VendorCombobox';
import { AccountSelect } from './AccountSelect';
import { ExpenseSplitsEditor } from './ExpenseSplitsEditor';
import { ReceiptUploader, Receipt } from './ReceiptUploader';
import { apiClient } from '../../lib/apiClient';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  expense: Expense | null;          // null = create mode
  vendors: Vendor[];
  accounts: PaymentAccount[];
  categories: ExpenseCategory[];
  addVendor: ReturnType<typeof useVendors>['addVendor'];
  addCategory: ReturnType<typeof useExpenses>['addCategory'];
  onPrev?: () => void;
  onNext?: () => void;
}

export function ExpenseDrawer({
  open, onClose, onSaved, expense, vendors, accounts, categories,
  addVendor, addCategory, onPrev, onNext,
}: Props) {
  const isEdit = expense !== null;
  const { addExpense, updateExpense, deleteExpense } = useExpenses();
  const { shows } = useShows();

  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [paymentAccountId, setPaymentAccountId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [channel, setChannel] = useState('');
  const [showId, setShowId] = useState('');
  const [notes, setNotes] = useState('');
  const [splitsOn, setSplitsOn] = useState(false);
  const [splits, setSplits] = useState<ExpenseSplit[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hydrate when entering edit mode or switching expense
  useEffect(() => {
    if (!open) return;
    if (expense) {
      setDate(new Date(expense.date).toISOString().slice(0, 10));
      setAmount(String(expense.amount));
      setDescription(expense.description ?? '');
      setVendorId(expense.vendorId);
      setPaymentAccountId(expense.paymentAccountId);
      setCategoryId(expense.categoryId);
      setChannel(expense.channel ?? '');
      setShowId(expense.showId ?? '');
      setNotes(expense.notes ?? '');
      setSplitsOn(expense.hasSplits);
      setSplits(expense.splits || []);
      // Load receipts
      apiClient.get<{ data: { receipts: Receipt[] } }>(`/api/expenses/${expense.id}/receipts`)
        .then((r) => setReceipts(r.data?.receipts || []))
        .catch(() => setReceipts([]));
    } else {
      setDate(new Date().toISOString().slice(0, 10));
      setAmount('');
      setDescription('');
      setVendorId(null);
      setPaymentAccountId(accounts.find((a) => a.name === 'Cash')?.id ?? accounts[0]?.id ?? null);
      setCategoryId(null);
      setChannel('');
      setShowId('');
      setNotes('');
      setSplitsOn(false);
      setSplits([]);
      setReceipts([]);
    }
    setSubmitError(null);
  }, [open, expense, accounts]);

  const amountNum = parseFloat(amount) || 0;

  const handleSave = async () => {
    setSubmitError(null);
    if (!date || amountNum <= 0 || !paymentAccountId) {
      setSubmitError('Date, amount, and payment account are required.');
      return;
    }
    if (splitsOn) {
      const sum = splits.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      if (Math.abs(sum - amountNum) > 0.011) {
        setSubmitError(`Splits must sum to ${amountNum.toFixed(2)} (currently ${sum.toFixed(2)}).`);
        return;
      }
    }
    const input: ExpenseInput = {
      date, amount: amountNum,
      description: description || null,
      categoryId: splitsOn ? null : categoryId,
      vendorId, paymentAccountId,
      channel: channel || null,
      showId: showId || null,
      notes: notes || null,
      splits: splitsOn
        ? splits.map((s) => ({ categoryId: s.categoryId, amount: Number(s.amount), description: s.description }))
        : [],
    };
    const r = isEdit
      ? await updateExpense(expense!.id, input)
      : await addExpense(input);
    if (!r.success) {
      setSubmitError(r.error || 'Save failed');
      return;
    }
    onSaved();
    onClose();
  };

  const handleDelete = async () => {
    if (!isEdit) return;
    if (!window.confirm('Delete this expense?')) return;
    const r = await deleteExpense(expense!.id);
    if (r.success) { onSaved(); onClose(); }
  };

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Expense' : 'New Expense'}
      subtitle={isEdit && expense ? `${expense.date.slice(0,10)} · $${expense.amount.toFixed(2)}` : undefined}
      width="md"
      onPrev={onPrev}
      onNext={onNext}
      footer={
        <>
          {isEdit && (
            <button onClick={handleDelete} className="mr-auto px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-lg flex items-center gap-1">
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          )}
          <button onClick={onClose} className="px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary rounded-lg">
            Cancel
          </button>
          <button onClick={handleSave} className="px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 flex items-center gap-1">
            <Check className="w-4 h-4" /> Save
          </button>
        </>
      }
    >
      <div className="p-4 space-y-4">
        {submitError && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">{submitError}</div>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block mb-1 text-sm text-text-secondary">Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">$</span>
              <input data-autofocus type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                className="w-full pl-7 pr-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent" />
            </div>
          </div>
          <div>
            <label className="block mb-1 text-sm text-text-secondary">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent" />
          </div>
        </div>

        <div>
          <label className="block mb-1 text-sm text-text-secondary">Vendor</label>
          <VendorCombobox vendors={vendors} value={vendorId} onChange={setVendorId} onCreate={addVendor} />
        </div>

        <div>
          <label className="block mb-1 text-sm text-text-secondary">Payment account *</label>
          <AccountSelect accounts={accounts} value={paymentAccountId} onChange={setPaymentAccountId} required />
        </div>

        <div>
          <label className="block mb-1 text-sm text-text-secondary">Description</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent" />
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="splits-toggle" checked={splitsOn} onChange={(e) => {
            setSplitsOn(e.target.checked);
            if (e.target.checked && splits.length === 0) {
              setSplits([{ categoryId, amount: amountNum, description: null, sortOrder: 0 }]);
            }
          }} />
          <label htmlFor="splits-toggle" className="text-sm text-text-secondary">Split this expense across categories</label>
        </div>

        {splitsOn ? (
          <ExpenseSplitsEditor amount={amountNum} splits={splits} categories={categories} onChange={setSplits} />
        ) : (
          <div>
            <label className="block mb-1 text-sm text-text-secondary">Category</label>
            <div className="flex gap-2">
              <select value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value ? parseInt(e.target.value) : null)}
                className="flex-1 px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent">
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={async () => {
                const name = window.prompt('New category name?');
                if (!name) return;
                const r = await addCategory(name.trim());
                if (r.success && r.category) setCategoryId(r.category.id);
              }} className="px-3 py-2 text-sm bg-bg-tertiary border border-border-subtle rounded-lg hover:bg-bg-secondary">+ New</button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block mb-1 text-sm text-text-secondary">Channel</label>
            <input type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="optional"
              className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent" />
          </div>
          <div>
            <label className="block mb-1 text-sm text-text-secondary">Show</label>
            <select value={showId} onChange={(e) => setShowId(e.target.value)}
              className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent">
              <option value="">No show</option>
              {shows.map((s) => <option key={s.show_id || s.id} value={s.show_id || s.id}>{s.show_title || 'Untitled'}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block mb-1 text-sm text-text-secondary">Receipts</label>
          <ReceiptUploader expenseId={isEdit ? expense!.id : null} receipts={receipts} onChange={setReceipts} />
        </div>

        <div>
          <label className="block mb-1 text-sm text-text-secondary">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent resize-y" />
        </div>
      </div>
    </SlideOverDrawer>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/ExpenseDrawer.tsx
git commit -m "feat(ui): ExpenseDrawer composing form + splits + receipts"
```

---

### Task 10.6: `ExpenseFilterBar`, `ExpenseSummaryTiles`, `ExpenseBulkActions`

**Files:**
- Create: `desktop/src/components/expenses/ExpenseFilterBar.tsx`
- Create: `desktop/src/components/expenses/ExpenseSummaryTiles.tsx`
- Create: `desktop/src/components/expenses/ExpenseBulkActions.tsx`

- [ ] **Step 1: Implement `ExpenseFilterBar`**

```tsx
import { Vendor } from '../../hooks/useVendors';
import { PaymentAccount } from '../../hooks/usePaymentAccounts';
import { ExpenseCategory, ExpenseFilters } from '../../hooks/useExpenses';

interface Props {
  filters: ExpenseFilters;
  onChange: (filters: ExpenseFilters) => void;
  onApply: () => void;
  onClear: () => void;
  categories: ExpenseCategory[];
  vendors: Vendor[];
  accounts: PaymentAccount[];
}

export function ExpenseFilterBar({ filters, onChange, onApply, onClear, categories, vendors, accounts }: Props) {
  const set = (k: keyof ExpenseFilters, v: string | number | undefined) =>
    onChange({ ...filters, [k]: v === '' || v === undefined ? undefined : v });

  return (
    <div className="flex flex-wrap items-end gap-3 p-3 bg-bg-secondary border border-border-subtle rounded-lg">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">From</label>
        <input type="date" value={filters.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)}
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">To</label>
        <input type="date" value={filters.endDate ?? ''} onChange={(e) => set('endDate', e.target.value)}
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Category</label>
        <select value={filters.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? parseInt(e.target.value) : undefined)}
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary">
          <option value="">All</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Vendor</label>
        <select value={filters.vendorId ?? ''} onChange={(e) => set('vendorId', e.target.value ? parseInt(e.target.value) : undefined)}
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary">
          <option value="">All</option>
          {vendors.filter((v) => !v.archivedAt).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">Account</label>
        <select value={filters.paymentAccountId ?? ''} onChange={(e) => set('paymentAccountId', e.target.value ? parseInt(e.target.value) : undefined)}
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary">
          <option value="">All</option>
          {accounts.filter((a) => !a.archivedAt).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
        <label className="text-xs text-text-secondary">Search</label>
        <input type="text" value={filters.search ?? ''} onChange={(e) => set('search', e.target.value)}
          placeholder="Description, notes, vendor…"
          className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
      </div>
      <div className="flex gap-2">
        <button onClick={onClear} className="px-3 py-1 text-sm text-text-secondary hover:bg-bg-tertiary rounded">Clear</button>
        <button onClick={onApply} className="px-3 py-1 text-sm bg-accent text-white rounded hover:bg-accent/90">Apply</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `ExpenseSummaryTiles`**

```tsx
import { ExpenseSummary } from '../../hooks/useExpenses';
import { formatCurrency } from '../../utils/format';

export function ExpenseSummaryTiles({ summary }: { summary: ExpenseSummary | null }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="p-3 bg-bg-secondary border border-border-subtle rounded-lg">
        <div className="text-xs text-text-secondary mb-1">Total expenses</div>
        <div className="text-xl font-semibold text-red-400">{formatCurrency(summary?.total || 0)}</div>
      </div>
      <div className="p-3 bg-bg-secondary border border-border-subtle rounded-lg">
        <div className="text-xs text-text-secondary mb-1">Top vendor</div>
        <div className="text-sm text-text-primary">{summary?.topVendor?.name ?? '—'}</div>
        <div className="text-sm text-text-tertiary">{summary?.topVendor ? formatCurrency(summary.topVendor.total) : ''}</div>
      </div>
      <div className="p-3 bg-bg-secondary border border-border-subtle rounded-lg">
        <div className="text-xs text-text-secondary mb-1">Top category</div>
        <div className="text-sm text-text-primary">{summary?.topCategory?.name ?? '—'}</div>
        <div className="text-sm text-text-tertiary">{summary?.topCategory ? formatCurrency(summary.topCategory.total) : ''}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement `ExpenseBulkActions`**

```tsx
import { Trash2 } from 'lucide-react';

interface Props {
  selectedIds: number[];
  onClear: () => void;
  onDelete: () => void;
  onRecategorize: () => void;
  onReassignVendor: () => void;
}

export function ExpenseBulkActions({ selectedIds, onClear, onDelete, onRecategorize, onReassignVendor }: Props) {
  if (selectedIds.length === 0) return null;
  return (
    <div className="flex items-center gap-2 p-2 bg-accent/10 border border-accent/20 rounded-lg">
      <span className="text-sm text-text-primary"><strong>{selectedIds.length}</strong> selected</span>
      <button onClick={onRecategorize} className="px-3 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded hover:bg-bg-secondary">Recategorize…</button>
      <button onClick={onReassignVendor} className="px-3 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded hover:bg-bg-secondary">Reassign vendor…</button>
      <button onClick={onDelete} className="flex items-center gap-1 px-3 py-1 text-sm text-red-400 hover:bg-red-500/10 rounded">
        <Trash2 className="w-4 h-4" /> Delete
      </button>
      <button onClick={onClear} className="ml-auto px-3 py-1 text-sm text-text-secondary hover:bg-bg-tertiary rounded">Clear</button>
    </div>
  );
}
```

> "Recategorize…" and "Reassign vendor…" open small inline pickers using `window.prompt` for v1, OR a follow-up `BulkPickerDrawer` if there's bandwidth. For v1, the simplest implementation is a confirm-style picker built into the parent screen using a tiny `<select>` rendered conditionally — no additional component needed.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/components/expenses/ExpenseFilterBar.tsx desktop/src/components/expenses/ExpenseSummaryTiles.tsx desktop/src/components/expenses/ExpenseBulkActions.tsx
git commit -m "feat(ui): expense filter bar, summary tiles, bulk actions"
```

---

### Task 10.7: `ManageCategoriesDrawer`

**Files:**
- Create: `desktop/src/components/expenses/ManageCategoriesDrawer.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useState } from 'react';
import { SlideOverDrawer } from '../SlideOverDrawer';
import { Plus, Trash2 } from 'lucide-react';
import { ExpenseCategory, useExpenses } from '../../hooks/useExpenses';

interface Props {
  open: boolean;
  onClose: () => void;
  categories: ExpenseCategory[];
  addCategory: ReturnType<typeof useExpenses>['addCategory'];
  deleteCategory: ReturnType<typeof useExpenses>['deleteCategory'];
}

export function ManageCategoriesDrawer({ open, onClose, categories, addCategory, deleteCategory }: Props) {
  const [name, setName] = useState('');

  const onAdd = async () => {
    if (!name.trim()) return;
    const r = await addCategory(name.trim());
    if (r.success) setName('');
  };

  return (
    <SlideOverDrawer open={open} onClose={onClose} title="Manage Categories" width="sm">
      <div className="p-4 space-y-3">
        <div className="flex gap-2">
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
            placeholder="New category name…"
            className="flex-1 px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary"
          />
          <button onClick={onAdd} className="flex items-center gap-1 px-3 py-2 bg-accent text-white rounded hover:bg-accent/90">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <div className="bg-bg-tertiary rounded divide-y divide-border-subtle">
          {categories.length === 0 ? (
            <div className="p-4 text-center text-text-tertiary text-sm">No categories</div>
          ) : (
            categories.map((c) => (
              <div key={c.id} className="flex items-center justify-between px-3 py-2">
                <span className="text-sm text-text-primary">{c.name}</span>
                <button onClick={() => deleteCategory(c.id)} className="p-1 text-text-tertiary hover:text-red-400 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </SlideOverDrawer>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/expenses/ManageCategoriesDrawer.tsx
git commit -m "feat(ui): ManageCategoriesDrawer"
```

---

## Phase 11 — Desktop: Vendors and Accounts components

### Task 11.1: `VendorsList` + `VendorDrawer`

**Files:**
- Create: `desktop/src/components/vendors/VendorsList.tsx`
- Create: `desktop/src/components/vendors/VendorDrawer.tsx`

- [ ] **Step 1: Implement `VendorDrawer`**

```tsx
import { useEffect, useState } from 'react';
import { SlideOverDrawer } from '../SlideOverDrawer';
import { Vendor, useVendors, VendorDetail } from '../../hooks/useVendors';
import { ExpenseCategory } from '../../hooks/useExpenses';
import { Trash2, Check, Archive } from 'lucide-react';
import { formatCurrency, formatDate } from '../../utils/format';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  vendor: Vendor | null;
  categories: ExpenseCategory[];
}

export function VendorDrawer({ open, onClose, onSaved, vendor, categories }: Props) {
  const isEdit = vendor !== null;
  const { addVendor, updateVendor, deleteVendor, loadVendorDetail } = useVendors();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [defaultCategoryId, setDefaultCategoryId] = useState<number | null>(null);
  const [recent, setRecent] = useState<VendorDetail['recentExpenses']>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (vendor) {
      setName(vendor.name);
      setNotes(vendor.notes ?? '');
      setDefaultCategoryId(vendor.defaultCategoryId);
      loadVendorDetail(vendor.id).then((r) => setRecent(r.data?.recentExpenses || [])).catch(() => setRecent([]));
    } else {
      setName('');
      setNotes('');
      setDefaultCategoryId(null);
      setRecent([]);
    }
  }, [open, vendor, loadVendorDetail]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    const r = isEdit
      ? await updateVendor(vendor!.id, { name: name.trim(), notes, defaultCategoryId })
      : await addVendor({ name: name.trim(), notes, defaultCategoryId });
    if (!r.success) { setError('Save failed'); return; }
    onSaved();
    onClose();
  };

  const handleDelete = async () => {
    if (!isEdit) return;
    const r = await deleteVendor(vendor!.id);
    if (!r.success) { setError(r.error || 'Delete failed'); return; }
    onSaved();
    onClose();
  };

  const handleArchive = async () => {
    if (!isEdit) return;
    await updateVendor(vendor!.id, { archived: !vendor!.archivedAt });
    onSaved();
    onClose();
  };

  return (
    <SlideOverDrawer
      open={open} onClose={onClose}
      title={isEdit ? 'Vendor' : 'New Vendor'}
      subtitle={isEdit && vendor ? `${vendor.expenseCount} expense(s) · ${formatCurrency(vendor.totalSpent)}` : undefined}
      width="md"
      footer={
        <>
          {isEdit && (
            <>
              <button onClick={handleDelete} className="mr-auto px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded flex items-center gap-1">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <button onClick={handleArchive} className="px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary rounded flex items-center gap-1">
                <Archive className="w-4 h-4" /> {vendor?.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
            </>
          )}
          <button onClick={onClose} className="px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary rounded">Cancel</button>
          <button onClick={handleSave} className="px-3 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 flex items-center gap-1">
            <Check className="w-4 h-4" /> Save
          </button>
        </>
      }
    >
      <div className="p-4 space-y-3">
        {error && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">{error}</div>}
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Name</label>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
        </div>
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Default category</label>
          <select value={defaultCategoryId ?? ''} onChange={(e) => setDefaultCategoryId(e.target.value ? parseInt(e.target.value) : null)}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary">
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary resize-y" />
        </div>
        {isEdit && (
          <div>
            <div className="text-sm text-text-secondary mb-1">Recent expenses</div>
            <div className="bg-bg-tertiary rounded divide-y divide-border-subtle">
              {recent.length === 0 ? (
                <div className="p-3 text-center text-text-tertiary text-sm">No recent expenses</div>
              ) : recent.map((e) => (
                <div key={e.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-text-tertiary">{formatDate(e.date, 'short')}</span>
                  <span className="text-text-primary truncate flex-1 mx-3">{e.description ?? e.categoryName ?? '—'}</span>
                  <span className="text-red-400">{formatCurrency(e.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </SlideOverDrawer>
  );
}
```

- [ ] **Step 2: Implement `VendorsList`**

```tsx
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Vendor } from '../../hooks/useVendors';
import { ExpenseCategory } from '../../hooks/useExpenses';
import { useVendors } from '../../hooks/useVendors';
import { VendorDrawer } from './VendorDrawer';
import { formatCurrency } from '../../utils/format';

export function VendorsList({ categories }: { categories: ExpenseCategory[] }) {
  const { vendors, loadVendors } = useVendors();
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);

  const filtered = vendors.filter((v) =>
    !search || v.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendors…"
          className="px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary text-sm w-64" />
        <button onClick={() => { setEditing(null); setDrawerOpen(true); }}
          className="flex items-center gap-1 px-3 py-2 bg-accent text-white rounded text-sm hover:bg-accent/90">
          <Plus className="w-4 h-4" /> New Vendor
        </button>
      </div>
      <div className="bg-bg-secondary border border-border-subtle rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-tertiary text-xs text-text-secondary uppercase">
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Default Category</th>
              <th className="text-right px-3 py-2"># Expenses</th>
              <th className="text-right px-3 py-2">Total Spent</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-12 text-center text-text-tertiary">No vendors</td></tr>
            ) : filtered.map((v) => (
              <tr key={v.id} onClick={() => { setEditing(v); setDrawerOpen(true); }}
                className="border-t border-border-subtle hover:bg-bg-tertiary cursor-pointer">
                <td className="px-3 py-2 text-text-primary">{v.name}{v.archivedAt && <span className="ml-2 text-xs text-text-tertiary">(archived)</span>}</td>
                <td className="px-3 py-2 text-text-secondary">{v.defaultCategoryName ?? '—'}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{v.expenseCount}</td>
                <td className="px-3 py-2 text-right text-red-400">{formatCurrency(v.totalSpent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <VendorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => loadVendors()}
        vendor={editing}
        categories={categories}
      />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/vendors/
git commit -m "feat(ui): VendorsList and VendorDrawer"
```

---

### Task 11.2: `AccountsList` + `AccountDrawer`

**Files:**
- Create: `desktop/src/components/accounts/AccountsList.tsx`
- Create: `desktop/src/components/accounts/AccountDrawer.tsx`

- [ ] **Step 1: Implement `AccountDrawer`**

Create `desktop/src/components/accounts/AccountDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Trash2, Check, Archive } from 'lucide-react';
import { SlideOverDrawer } from '../SlideOverDrawer';
import { PaymentAccount, AccountType, usePaymentAccounts } from '../../hooks/usePaymentAccounts';
import { formatCurrency } from '../../utils/format';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  account: PaymentAccount | null;
}

const TYPES: { value: AccountType; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'credit', label: 'Credit' },
  { value: 'bank', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

export function AccountDrawer({ open, onClose, onSaved, account }: Props) {
  const isEdit = account !== null;
  const { addAccount, updateAccount, deleteAccount } = usePaymentAccounts();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('cash');
  const [openingBalance, setOpeningBalance] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (account) {
      setName(account.name);
      setType(account.type);
      setOpeningBalance(account.openingBalance != null ? String(account.openingBalance) : '');
      setNotes(account.notes ?? '');
    } else {
      setName('');
      setType('cash');
      setOpeningBalance('');
      setNotes('');
    }
  }, [open, account]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    const payload = {
      name: name.trim(),
      type,
      openingBalance: openingBalance.trim() ? parseFloat(openingBalance) : null,
      notes,
    };
    const r = isEdit
      ? await updateAccount(account!.id, payload)
      : await addAccount(payload);
    if (!r.success) { setError('Save failed'); return; }
    onSaved();
    onClose();
  };

  const handleDelete = async () => {
    if (!isEdit) return;
    const r = await deleteAccount(account!.id);
    if (!r.success) { setError(r.error || 'Cannot delete — try Archive instead.'); return; }
    onSaved();
    onClose();
  };

  const handleArchive = async () => {
    if (!isEdit) return;
    await updateAccount(account!.id, { archived: !account!.archivedAt });
    onSaved();
    onClose();
  };

  return (
    <SlideOverDrawer
      open={open} onClose={onClose}
      title={isEdit ? 'Account' : 'New Account'}
      subtitle={isEdit && account ? `${account.type} · spent ${formatCurrency(account.spent)}` : undefined}
      width="md"
      footer={
        <>
          {isEdit && (
            <>
              <button onClick={handleDelete} className="mr-auto px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded flex items-center gap-1">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <button onClick={handleArchive} className="px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary rounded flex items-center gap-1">
                <Archive className="w-4 h-4" /> {account?.archivedAt ? 'Unarchive' : 'Archive'}
              </button>
            </>
          )}
          <button onClick={onClose} className="px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary rounded">Cancel</button>
          <button onClick={handleSave} className="px-3 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 flex items-center gap-1">
            <Check className="w-4 h-4" /> Save
          </button>
        </>
      }
    >
      <div className="p-4 space-y-3">
        {error && <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">{error}</div>}
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Name</label>
          <input data-autofocus value={name} onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
        </div>
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary">
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Opening balance (optional, informational)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">$</span>
            <input type="number" step="0.01" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)}
              className="w-full pl-7 pr-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
          </div>
        </div>
        <div>
          <label className="block mb-1 text-sm text-text-secondary">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
            className="w-full px-3 py-2 bg-bg-tertiary border border-border-subtle rounded text-text-primary resize-y" />
        </div>
      </div>
    </SlideOverDrawer>
  );
}
```

- [ ] **Step 2: Implement `AccountsList`**

Create `desktop/src/components/accounts/AccountsList.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PaymentAccount, usePaymentAccounts } from '../../hooks/usePaymentAccounts';
import { AccountDrawer } from './AccountDrawer';
import { formatCurrency, formatDate } from '../../utils/format';

export function AccountsList() {
  const { accounts, loadAccounts } = usePaymentAccounts();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentAccount | null>(null);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    loadAccounts({ startDate, endDate });
  }, [loadAccounts, startDate, endDate]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-secondary">Period:</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
            className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
          <span className="text-text-tertiary">to</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
            className="px-2 py-1 text-sm bg-bg-tertiary border border-border-subtle rounded text-text-primary" />
        </div>
        <button onClick={() => { setEditing(null); setDrawerOpen(true); }}
          className="flex items-center gap-1 px-3 py-2 bg-accent text-white rounded text-sm hover:bg-accent/90">
          <Plus className="w-4 h-4" /> New Account
        </button>
      </div>
      <div className="bg-bg-secondary border border-border-subtle rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-tertiary text-xs text-text-secondary uppercase">
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-right px-3 py-2">Spent (period)</th>
              <th className="text-right px-3 py-2">Last used</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-12 text-center text-text-tertiary">No accounts</td></tr>
            ) : accounts.map((a) => (
              <tr key={a.id} onClick={() => { setEditing(a); setDrawerOpen(true); }}
                className="border-t border-border-subtle hover:bg-bg-tertiary cursor-pointer">
                <td className="px-3 py-2 text-text-primary">{a.name}{a.archivedAt && <span className="ml-2 text-xs text-text-tertiary">(archived)</span>}</td>
                <td className="px-3 py-2 text-text-secondary capitalize">{a.type}</td>
                <td className="px-3 py-2 text-right text-red-400">{formatCurrency(a.spent)}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{a.lastUsed ? formatDate(a.lastUsed, 'short') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AccountDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => loadAccounts({ startDate, endDate })}
        account={editing}
      />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src/components/accounts/
git commit -m "feat(ui): AccountsList and AccountDrawer"
```

---

## Phase 12 — Desktop: Rewrite the Expenses page

### Task 12.1: Replace `Expenses.tsx` with sub-tabs structure

**Files:**
- Modify: `desktop/src/pages/Expenses.tsx`

- [ ] **Step 1: Replace the file with the new shell**

```tsx
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Plus, Tag, MoreVertical } from 'lucide-react';
import { DataTable, Column } from '../components/DataTable';
import { formatCurrency, formatDate } from '../utils/format';
import { useExpenses, Expense, ExpenseFilters } from '../hooks/useExpenses';
import { useVendors } from '../hooks/useVendors';
import { usePaymentAccounts } from '../hooks/usePaymentAccounts';
import { ExpenseDrawer } from '../components/expenses/ExpenseDrawer';
import { ExpenseFilterBar } from '../components/expenses/ExpenseFilterBar';
import { ExpenseSummaryTiles } from '../components/expenses/ExpenseSummaryTiles';
import { ExpenseBulkActions } from '../components/expenses/ExpenseBulkActions';
import { ManageCategoriesDrawer } from '../components/expenses/ManageCategoriesDrawer';
import { VendorsList } from '../components/vendors/VendorsList';
import { AccountsList } from '../components/accounts/AccountsList';

type SubTab = 'expenses' | 'vendors' | 'accounts';

export default function Expenses() {
  const [tab, setTab] = useState<SubTab>('expenses');
  const {
    expenses, categories, summary, loading, error,
    loadExpenses, loadCategories, loadSummary,
    addExpense: _add, updateExpense: _upd, deleteExpense: _del,
    addCategory, deleteCategory,
  } = useExpenses();
  const { vendors, loadVendors, addVendor } = useVendors();
  const { accounts, loadAccounts } = usePaymentAccounts();

  const [filters, setFilters] = useState<ExpenseFilters>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [categoriesDrawerOpen, setCategoriesDrawerOpen] = useState(false);

  useEffect(() => {
    loadCategories();
    loadVendors();
    loadAccounts();
    loadExpenses();
    loadSummary();
  }, [loadCategories, loadVendors, loadAccounts, loadExpenses, loadSummary]);

  // Keyboard shortcut: 'n' opens new-expense drawer when not in an input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== 'expenses') return;
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      setEditing(null);
      setDrawerOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  const apply = useCallback(async () => {
    await Promise.all([loadExpenses(filters), loadSummary(filters)]);
  }, [loadExpenses, loadSummary, filters]);

  const onClearFilters = () => { setFilters({}); loadExpenses(); loadSummary(); };

  const indexOf = (id: number) => expenses.findIndex((e) => e.id === id);
  const onPrev = editing
    ? () => { const i = indexOf(editing.id); if (i > 0) setEditing(expenses[i - 1]); }
    : undefined;
  const onNext = editing
    ? () => { const i = indexOf(editing.id); if (i >= 0 && i < expenses.length - 1) setEditing(expenses[i + 1]); }
    : undefined;

  const columns: Column<Expense>[] = useMemo(() => [
    {
      key: '_select',
      header: '',
      width: '32px',
      render: (row) => (
        <input
          type="checkbox"
          checked={selected.includes(row.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setSelected((s) => e.target.checked ? [...s, row.id] : s.filter((x) => x !== row.id))}
        />
      ),
    },
    { key: 'date', header: 'Date', width: '110px', sortable: true, render: (r) => formatDate(r.date, 'short') },
    {
      key: 'vendor_description', header: 'Vendor / Description', sortable: true,
      render: (r) => (
        <div>
          <div className="text-text-primary">{r.vendorName ?? <span className="italic text-text-tertiary">No vendor</span>}</div>
          {r.description && <div className="text-xs text-text-secondary truncate">{r.description}</div>}
        </div>
      ),
    },
    { key: 'category_name', header: 'Category', width: '140px',
      render: (r) => r.hasSplits
        ? <span className="text-text-tertiary italic">Split</span>
        : <span className={r.categoryName ? 'text-text-secondary' : 'text-text-tertiary italic'}>{r.categoryName ?? 'Uncategorized'}</span> },
    { key: 'paymentAccountName', header: 'Account', width: '140px',
      render: (r) => <span className="text-text-secondary">{r.paymentAccountName ?? '—'}</span> },
    { key: 'receiptCount', header: '📎', width: '40px', align: 'center',
      render: (r) => r.receiptCount > 0 ? <span title={`${r.receiptCount} receipt(s)`}>📎 {r.receiptCount}</span> : null },
    { key: 'amount', header: 'Amount', width: '100px', align: 'right', sortable: true,
      render: (r) => <span className="font-medium text-red-400">{formatCurrency(r.amount)}</span> },
  ], [selected]);

  const handleBulkDelete = async () => {
    if (!window.confirm(`Delete ${selected.length} expense(s)?`)) return;
    for (const id of selected) await _del(id);
    setSelected([]);
    await apply();
  };

  const handleBulkRecategorize = async () => {
    const choice = window.prompt(
      'Set category id for selected expenses (leave blank for Uncategorized):\n' +
      categories.map((c) => `${c.id}: ${c.name}`).join('\n')
    );
    if (choice === null) return;
    const cid = choice.trim() ? parseInt(choice.trim()) : null;
    for (const id of selected) await _upd(id, { categoryId: cid });
    setSelected([]);
    await apply();
  };

  const handleBulkReassignVendor = async () => {
    const choice = window.prompt(
      'Set vendor id for selected expenses (leave blank for none):\n' +
      vendors.map((v) => `${v.id}: ${v.name}`).join('\n')
    );
    if (choice === null) return;
    const vid = choice.trim() ? parseInt(choice.trim()) : null;
    for (const id of selected) await _upd(id, { vendorId: vid });
    setSelected([]);
    await apply();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Expenses</h1>
        {tab === 'expenses' && (
          <div className="flex items-center gap-2">
            <button onClick={() => setCategoriesDrawerOpen(true)} className="flex items-center gap-1 px-3 py-2 text-sm bg-bg-tertiary border border-border-subtle rounded-lg hover:bg-bg-secondary">
              <Tag className="w-4 h-4" /> Categories
            </button>
            <button onClick={() => { setEditing(null); setDrawerOpen(true); }} className="flex items-center gap-1 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90">
              <Plus className="w-4 h-4" /> New Expense
            </button>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-border-subtle">
        {(['expenses', 'vendors', 'accounts'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 ${tab === t ? 'border-accent text-text-primary font-medium' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'expenses' && (
        <>
          <ExpenseFilterBar
            filters={filters} onChange={setFilters} onApply={apply} onClear={onClearFilters}
            categories={categories} vendors={vendors} accounts={accounts}
          />
          <ExpenseSummaryTiles summary={summary} />
          <ExpenseBulkActions
            selectedIds={selected}
            onClear={() => setSelected([])}
            onDelete={handleBulkDelete}
            onRecategorize={handleBulkRecategorize}
            onReassignVendor={handleBulkReassignVendor}
          />
          {error && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">{error}</div>}
          <div className="bg-bg-secondary border border-border-subtle rounded-lg overflow-hidden">
            <DataTable
              data={expenses as unknown as Record<string, unknown>[]}
              columns={columns as unknown as Column<Record<string, unknown>>[]}
              keyField="id"
              loading={loading}
              emptyTitle="No expenses found"
              emptyDescription="Press 'n' or click 'New Expense' to add one."
              pagination
              pageSize={25}
              onRowClick={(row) => { setEditing(row as unknown as Expense); setDrawerOpen(true); }}
            />
          </div>
        </>
      )}

      {tab === 'vendors'  && <VendorsList categories={categories} />}
      {tab === 'accounts' && <AccountsList />}

      <ExpenseDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={apply}
        expense={editing}
        vendors={vendors}
        accounts={accounts}
        categories={categories}
        addVendor={addVendor}
        addCategory={addCategory}
        onPrev={onPrev}
        onNext={onNext}
      />

      <ManageCategoriesDrawer
        open={categoriesDrawerOpen}
        onClose={() => setCategoriesDrawerOpen(false)}
        categories={categories}
        addCategory={addCategory}
        deleteCategory={deleteCategory}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add `onRowClick` prop to `DataTable` if it doesn't already exist**

Open `desktop/src/components/DataTable.tsx`. If `onRowClick?: (row) => void` isn't already a prop, add it and wire `onClick` on `<tr>` rows. Skip if already present.

- [ ] **Step 3: Type-check**

```bash
cd desktop
npx tsc --noEmit
```

Fix any type errors. Most likely candidates: missing `onRowClick` prop type on DataTable; mismatched `Expense` shape between hook and component.

- [ ] **Step 4: Manual smoke test**

```bash
cd desktop
npm run dev
```

Walk through:
1. Open Expenses tab — table loads
2. Click `+ New Expense` — drawer opens
3. Fill amount, pick account, save — row appears
4. Click row — drawer opens with data
5. Toggle Splits, add lines that don't sum — Save shows error
6. Adjust splits to sum — save succeeds, row shows "Split" in category
7. Switch to Vendors tab — list loads, create one
8. Switch to Accounts tab — list loads
9. Press `n` while on Expenses tab — drawer opens

- [ ] **Step 5: Commit**

```bash
git add desktop/src/pages/Expenses.tsx desktop/src/components/DataTable.tsx
git commit -m "feat(ui): rewrite Expenses page with sub-tabs and drawer"
```

---

## Phase 13 — Desktop: Reports tab

### Task 13.1: Add `Expenses` tab to `Reports.tsx`

**Files:**
- Create: `desktop/src/pages/reports/ExpensesTab.tsx`
- Modify: `desktop/src/pages/Reports.tsx`

- [ ] **Step 1: Implement `ExpensesTab.tsx`**

```tsx
import { useEffect, useMemo } from 'react';
import { useExpenseReports } from '../../hooks/useExpenseReports';
import { useDashboardFilters } from '../../contexts/DashboardFilterContext';
import { KPICard } from '../../components/reports';
import { formatCurrency } from '../../utils/format';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface SalesTotals {
  revenue: number;
}

export function ExpensesTab({ salesTotals }: { salesTotals?: SalesTotals }) {
  const { report, loading, loadReport } = useExpenseReports();
  const { filters } = useDashboardFilters();

  useEffect(() => {
    loadReport({
      startDate: filters.startDate,
      endDate: filters.endDate,
      period: filters.periodAgg,
    });
  }, [loadReport, filters.startDate, filters.endDate, filters.periodAgg]);

  const net = useMemo(() => {
    if (!salesTotals || !report) return null;
    return salesTotals.revenue - report.totals.total;
  }, [salesTotals, report]);

  if (loading || !report) return <div className="p-8 text-center text-text-tertiary">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-3">
        <KPICard label="Total expenses" value={formatCurrency(report.totals.total)} />
        <KPICard label="# Transactions" value={String(report.totals.count)} />
        <KPICard label="Avg transaction" value={formatCurrency(report.totals.average)} />
        <KPICard label="Net (revenue − exp.)" value={net != null ? formatCurrency(net) : '—'} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <BreakdownPanel title="By category" rows={report.byCategory.map((r) => ({ name: r.categoryName, total: r.total, count: r.count }))} />
        <BreakdownPanel title="By vendor"   rows={report.byVendor.map((r) => ({ name: r.vendorName, total: r.total, count: r.count }))} />
      </div>

      <BreakdownPanel title="By account" rows={report.byAccount.map((r) => ({ name: r.accountName, total: r.total, count: r.count }))} />

      <div className="bg-bg-secondary border border-border-subtle rounded-lg p-4">
        <div className="text-sm text-text-secondary mb-2">Over time</div>
        <div style={{ width: '100%', height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={report.overTime}>
              <XAxis dataKey="bucket" tick={{ fill: '#888', fontSize: 11 }} />
              <YAxis tick={{ fill: '#888', fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#f87171" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function BreakdownPanel({ title, rows }: { title: string; rows: Array<{ name: string; total: number; count: number }> }) {
  const top = rows.slice(0, 10);
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-lg p-4">
      <div className="text-sm text-text-secondary mb-2">{title}</div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={top} layout="vertical">
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={120} tick={{ fill: '#888', fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="total" fill="#6366f1" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="w-full text-sm mt-2">
        <tbody>
          {top.map((r) => (
            <tr key={r.name} className="border-t border-border-subtle">
              <td className="py-1 text-text-primary">{r.name}</td>
              <td className="py-1 text-right text-text-tertiary">{r.count}</td>
              <td className="py-1 text-right text-red-400">{formatCurrency(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Register the tab in `Reports.tsx`**

Open `desktop/src/pages/Reports.tsx`. Make these changes:

1. Add to the `TabId` type:

```typescript
type TabId = 'overview' | 'brands' | 'products' | 'shows' | 'customers' | 'pricing' | 'auctions' | 'expenses';
```

2. Import the new component:

```typescript
import { ExpensesTab } from './reports/ExpensesTab';
```

(Add it near the existing imports around line 16-23.)

3. Add a tab entry to the `tabs` array (around line 40):

```typescript
{ id: 'expenses', label: 'Expenses', icon: <DollarSign className="w-4 h-4" /> },
```

(Reuse the existing `DollarSign` import — it's already imported.)

4. Add a case in the tab body switch (search for where `OverviewTab`, `BrandsTab`, etc. are rendered conditionally and add):

```tsx
{activeTab === 'expenses' && <ExpensesTab salesTotals={overviewSalesTotals} />}
```

Where `overviewSalesTotals` is the existing summary object — look for the variable name used by `OverviewTab`'s revenue total in the file (likely something like `summary?.revenue` or `data.summary`). Wire that through, or pass `undefined` if it's not readily available; the Net tile will show `—`.

- [ ] **Step 3: Type-check**

```bash
cd desktop
npx tsc --noEmit
```

- [ ] **Step 4: Smoke test**

Open the Reports screen, click the new Expenses tab. Verify breakdown charts render and respond to date range changes from the filter context.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/pages/reports/ExpensesTab.tsx desktop/src/pages/Reports.tsx
git commit -m "feat(reports): expenses analytics tab"
```

---

## Phase 14 — Cleanup and verification

### Task 14.1: Final verification pass

- [ ] **Step 1: Run all tests**

```bash
cd web
npm test
```

Expected: every test in the new `__tests__` folders + existing tests all pass.

- [ ] **Step 2: Type-check both projects**

```bash
cd web && npx tsc --noEmit
cd ../desktop && npx tsc --noEmit
```

- [ ] **Step 3: Manual end-to-end walkthrough**

Run the full app (`web` dev server + `desktop` dev) and verify each piece:

1. **Migration:** Existing expenses still display, all rows have a payment account.
2. **Create expense:** New + Save with vendor, account, splits, receipt → row appears, drawer closes, table refreshes.
3. **Walk rows:** Open drawer for an expense, press ↓ — drawer hydrates next row.
4. **Vendors tab:** Create a vendor; it shows up in the Expense drawer's vendor combobox immediately.
5. **Accounts tab:** Try to delete an account that has expenses — get a 409 error message; archive instead works.
6. **Reports → Expenses tab:** Date range from this month shows correct totals matching the Expenses summary tile.
7. **Receipt upload:** Attach a PDF, verify it lists; click → opens. Delete it; verify gone from Vercel Blob (manually check or just trust the API delete).
8. **Permissions:** Log in as a Viewer (per existing setup), verify edit buttons are gone / save fails with 403.

- [ ] **Step 4: Update CLAUDE.md if anything new should be documented**

Check `web/CLAUDE.md` and `desktop/CLAUDE.md`. If `BLOB_READ_WRITE_TOKEN` setup belongs there, add a one-line note. Otherwise skip.

- [ ] **Step 5: Final commit and merge guidance**

```bash
git status
# verify clean
```

The branch is now ready for review. Open a PR per project conventions; the design spec at `docs/superpowers/specs/2026-04-28-expenses-quickbooks-rework-design.md` is the source-of-truth reference.

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| Vendor model + table | Task 1.1, 1.2 |
| PaymentAccount model + table | Task 1.1, 1.2 |
| ExpenseSplit model + table | Task 1.1, 1.2 |
| ExpenseReceipt model + table | Task 1.1, 1.2 |
| Expense column changes (vendor_id, payment_account_id, has_splits; drop brand_id) | Task 1.1, 1.2 |
| Migration seeds Cash/Unassigned/Whatnot Balance + backfill | Task 1.2 |
| Splits invariant (sum == amount, ≥1 line, positive amounts) | Task 2.2 (lib), 6.1, 6.2 (API) |
| Vercel Blob storage + key format + limits | Task 2.1, 5.1 |
| Receipt upload/delete API | Task 5.1, 5.2 |
| Vendors API (list/create/detail/update/archive/delete) | Task 3.1, 3.2 |
| Payment accounts API | Task 4.1, 4.2 |
| Extended Expenses GET/POST/PATCH | Task 6.1, 6.2 |
| Expenses summary returns topVendor/topCategory | Task 9.3 step 2 |
| Expense reports endpoint | Task 7.1 |
| `expenses.view`/`expenses.edit`/`expenses.delete` permissions | Every API task |
| Tenant isolation on all routes | Every API task |
| Reusable SlideOverDrawer | Task 8.1 |
| useVendors / usePaymentAccounts / useExpenseReports / extended useExpenses | Task 9.1, 9.2, 9.3, 9.4 |
| VendorCombobox / AccountSelect | Task 10.1, 10.2 |
| ExpenseSplitsEditor | Task 10.3 |
| ReceiptUploader | Task 10.4 |
| ExpenseDrawer | Task 10.5 |
| ExpenseFilterBar / SummaryTiles / BulkActions | Task 10.6 |
| ManageCategoriesDrawer | Task 10.7 |
| VendorsList + VendorDrawer | Task 11.1 |
| AccountsList + AccountDrawer | Task 11.2 |
| Sub-tab structure (Expenses · Vendors · Accounts) | Task 12.1 |
| Keyboard shortcut `n` for new expense | Task 12.1 |
| Reports → Expenses tab | Task 13.1 |
| End-to-end manual verification | Task 14.1 |
