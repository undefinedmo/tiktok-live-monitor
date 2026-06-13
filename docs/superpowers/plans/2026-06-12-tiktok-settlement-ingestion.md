# TikTok Settlement Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest TikTok Shop settlement XLSX reports into `sellerfolio-live-api`, storing per-order fees + net payout and rolling them up onto `Order` so per-order/per-show profit becomes accurate.

**Architecture:** A pure XLSX parser (`parse.ts`) feeds an idempotent importer (`import.ts`) that upserts `OrderSettlement` rows keyed on `(org, platform, externalOrderId)`, links each to its `Order` when present, and rolls `estimatedSettlementCents`/`feesCents` onto `Order.netCents`/`Order.feesCents`. A shared rollup helper also runs from `POST /sync/orders` so settlements imported before their order auto-link later. Three Fastify routes expose import + reads.

**Tech Stack:** Fastify 5 (ESM), Prisma 7 (pg driver adapter), zod, `xlsx` (SheetJS), `@fastify/multipart`, `@fastify/static`, Vitest. Spec: `docs/superpowers/specs/2026-06-12-tiktok-settlement-ingestion-design.md`.

**Working directory:** all paths are relative to `sellerfolio-live-api/`.

---

## File structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `SettlementStatus` enum, `SettlementImport` + `OrderSettlement` models, relations on `Organization` + `Order` |
| `src/settlements/parse.ts` (create) | Pure: `Buffer → { meta, rows[], errors[] }`. Header detection, column-by-name mapping, cents conversion, reconciliation check |
| `src/settlements/import.ts` (create) | Orchestration: create batch, upsert rows, link order, rollup; shared `applySettlementRollup`; `importSettlement()` |
| `src/routes/v1.ts` (modify) | `POST /settlements/import`, `GET /settlements`, `GET /settlements/imports`; rollup call inside `POST /sync/orders` |
| `src/server.ts` (modify) | Register `@fastify/multipart` + `@fastify/static` |
| `public/settlements.html` (create) | Thin upload page (paste token → pick file → POST → show summary) |
| `src/settlements/parse.test.ts` (create) | Parser unit tests (no DB) |
| `src/settlements/import.test.ts` (create) | Importer + rollup + re-link integration tests (needs Postgres) |
| `vitest.config.ts` (create) | Test runner config |
| `package.json` (modify) | Add deps + `test` scripts |

---

## Task 1: Add dependencies and test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install runtime + dev dependencies**

Run (in `sellerfolio-live-api/`):
```bash
npm install xlsx @fastify/multipart @fastify/static
npm install -D vitest
```
Expected: packages added, no errors.

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block, add these two entries (after `"db:rls"`):
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',          // each test file in its own process — safe for the Prisma singleton
    fileParallelism: false, // integration tests share one DB; run files serially
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

- [ ] **Step 4: Verify the test runner starts (no tests yet is fine)**

Run: `npm test`
Expected: Vitest runs and reports "No test files found" (exit 0 or 1 with that message) — confirms config loads.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore(live-api): add xlsx, multipart, static, vitest for settlement ingestion"
```

---

## Task 2: Prisma schema — settlement models + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the `SettlementStatus` enum**

After the `RuleLogic` enum (near the end of the ENUMS section), add:
```prisma
enum SettlementStatus {
  ESTIMATED // on-hold / unsettled reports — amounts subject to change
  SETTLED   // reserved for the final settled-report flow (not built yet)
}
```

- [ ] **Step 2: Add the two models**

Append at the end of the schema file:
```prisma
// ============================================================================
// 7. SETTLEMENTS (TikTok Shop settlement-report ingestion)
// ============================================================================

// One row per uploaded settlement XLSX — provenance + batch summary.
model SettlementImport {
  id                   String       @id @default(uuid()) @db.Uuid
  organizationId       String       @map("organization_id") @db.Uuid
  platform             PlatformType
  filename             String       @db.VarChar(500)
  rangeStart           DateTime?    @map("range_start") @db.Timestamptz
  rangeEnd             DateTime?    @map("range_end") @db.Timestamptz
  downloadedAt         DateTime?    @map("downloaded_at") @db.Timestamptz
  reportedCount        Int?         @map("reported_count")
  rowCount             Int          @map("row_count")
  matchedCount         Int          @default(0) @map("matched_count")
  unmatchedCount       Int          @default(0) @map("unmatched_count")
  totalSettlementCents Int          @default(0) @map("total_settlement_cents")
  totalFeesCents       Int          @default(0) @map("total_fees_cents")
  uploadedById         String?      @map("uploaded_by") @db.Uuid
  createdAt            DateTime     @default(now()) @map("created_at") @db.Timestamptz

  organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  settlements  OrderSettlement[]

  @@index([organizationId])
  @@map("settlement_imports")
}

// One settlement transaction. Unique per (org, platform, externalOrderId) so re-imports upsert.
model OrderSettlement {
  id              String           @id @default(uuid()) @db.Uuid
  organizationId  String           @map("organization_id") @db.Uuid
  importId        String           @map("import_id") @db.Uuid
  orderId         String?          @map("order_id") @db.Uuid
  platform        PlatformType
  type            String           @db.VarChar(20)
  externalOrderId String           @map("external_order_id") @db.VarChar(255)
  relatedOrderId  String?          @map("related_order_id") @db.VarChar(255)
  status          SettlementStatus @default(ESTIMATED)

  // money — integer cents, SIGNED exactly as the report shows
  netSalesCents             Int @default(0) @map("net_sales_cents")
  grossSalesCents           Int @default(0) @map("gross_sales_cents")
  feesCents                 Int @default(0) @map("fees_cents")
  referralFeeCents          Int @default(0) @map("referral_fee_cents")
  salesTaxOnReferralCents   Int @default(0) @map("sales_tax_on_referral_cents")
  tiktokShippingFeeCents    Int @default(0) @map("tiktok_shipping_fee_cents")
  customerPaidShippingCents Int @default(0) @map("customer_paid_shipping_cents")
  customerPaymentCents      Int @default(0) @map("customer_payment_cents")
  salesTaxPaymentCents      Int @default(0) @map("sales_tax_payment_cents")
  platformDiscountCents     Int @default(0) @map("platform_discount_cents")
  estimatedSettlementCents  Int @default(0) @map("estimated_settlement_cents")

  // descriptive
  skuId               String?   @map("sku_id") @db.VarChar(255)
  skuName             String?   @map("sku_name") @db.VarChar(255)
  productName         String?   @map("product_name") @db.VarChar(500)
  quantity            Int       @default(0)
  estimatedSettleTime String?   @map("estimated_settle_time") @db.VarChar(120)
  unsettledReason     String?   @map("unsettled_reason") @db.VarChar(255)
  creationDate        DateTime? @map("creation_date") @db.Timestamptz

  raw       Json     @db.JsonB
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  import       SettlementImport @relation(fields: [importId], references: [id], onDelete: Cascade)
  order        Order?           @relation(fields: [orderId], references: [id], onDelete: SetNull)

  @@unique([organizationId, platform, externalOrderId])
  @@index([organizationId])
  @@index([orderId])
  @@map("order_settlements")
}
```

- [ ] **Step 3: Add the back-relations on `Organization` and `Order`**

In `model Organization { ... }`, in the relations block (after `rules                Rule[]`), add:
```prisma
  settlements         OrderSettlement[]
  settlementImports   SettlementImport[]
```

In `model Order { ... }`, in the relations block (after `receipts           Receipt[]`), add:
```prisma
  settlements        OrderSettlement[]
```

- [ ] **Step 4: Generate the migration + client**

Run: `npx prisma migrate dev --name settlement_ingestion`
Expected: a new folder `prisma/migrations/<timestamp>_settlement_ingestion/migration.sql` is created with `CREATE TABLE settlement_imports`, `CREATE TABLE order_settlements`, `CREATE TYPE "SettlementStatus"`, and the Prisma client regenerates. No errors.

- [ ] **Step 5: Sanity-check the generated client types**

Run: `npx tsc --noEmit`
Expected: passes (the new `prisma.orderSettlement` / `prisma.settlementImport` delegates now exist).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(live-api): add SettlementImport + OrderSettlement models"
```

---

## Task 3: Settlement parser (TDD)

**Files:**
- Create: `src/settlements/parse.ts`
- Test: `src/settlements/parse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/settlements/parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSettlementXlsx } from './parse';

// Columns the parser must understand (subset of the real 99 — order is intentionally
// shuffled to prove mapping is by header NAME, not position).
const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];

// Build a row matching HEADER order. `over` overrides by column name.
function row(over: Record<string, unknown>): unknown[] {
  const base: Record<string, unknown> = {
    Type: 'Order', 'Order/adjustment ID': '577431091617435979',
    'Related order ID': '577431091617435979', 'creation date': '2026/06/12',
    'Total estimated settlement amount': '13.76', 'Estimated Settle time': 'Delivered + 1 days',
    'unsettled reasons': 'Waiting for package delivery', 'SKU ID': '1732440158393635811',
    Quantity: '1', 'Product name': '$15 STARTS WOMEN PREMIUM BRANDS', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16',
    'Sales tax payment': '-1.58', 'Platform discounts': '0', 'Adjustment amount': '0',
  };
  return HEADER.map((h) => (h in over ? over[h] : base[h]));
}

function makeXlsx(rows: unknown[][]): Buffer {
  const aoa: unknown[][] = [
    ['Disclaimer: reference only.'],
    ['Download time', '2026-06-12 16:55:33'],
    ['Total Transactions', String(rows.length)],
    [],
    HEADER,
    ...rows,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const FILENAME = 'Onhold-unsettled-orders-2026_06_01-2026_06_12(UTC-7).xlsx';

describe('parseSettlementXlsx', () => {
  it('detects the header below banner rows and maps columns by name', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.externalOrderId).toBe('577431091617435979');
    expect(r.type).toBe('Order');
    expect(r.productName).toBe('$15 STARTS WOMEN PREMIUM BRANDS');
    expect(r.quantity).toBe(1);
  });

  it('converts currency strings to signed integer cents', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    const r = rows[0];
    expect(r.netSalesCents).toBe(1500);
    expect(r.feesCents).toBe(-124);
    expect(r.referralFeeCents).toBe(-117);
    expect(r.salesTaxOnReferralCents).toBe(-7);
    expect(r.estimatedSettlementCents).toBe(1376);
    expect(r.customerPaymentCents).toBe(2116);
  });

  it("treats '/' and blank cells as 0", () => {
    const { rows } = parseSettlementXlsx(
      makeXlsx([row({ 'Platform discounts': '/', 'Adjustment amount': '' })]),
      FILENAME,
    );
    expect(rows[0].platformDiscountCents).toBe(0);
  });

  it('extracts meta and the date range from the filename', () => {
    const { meta } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(meta.reportedCount).toBe(1);
    expect(meta.downloadedAt).toBe('2026-06-12 16:55:33');
    expect(meta.rangeStart).toBe('2026-06-01');
    expect(meta.rangeEnd).toBe('2026-06-12');
  });

  it('keeps the full row in raw', () => {
    const { rows } = parseSettlementXlsx(makeXlsx([row({})]), FILENAME);
    expect(rows[0].raw['Customer payment']).toBe('21.16');
    expect(rows[0].raw['SKU name']).toBe('151');
  });

  it('flags rows that fail the settlement reconciliation', () => {
    // estimatedSettlement should equal net + fees + shippingNet + adj = 13.76.
    // Force a mismatch by setting it to 99.99.
    const { errors } = parseSettlementXlsx(
      makeXlsx([row({ 'Total estimated settlement amount': '99.99' })]),
      FILENAME,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/reconcil/i);
  });

  it('rejects a workbook without the expected header', () => {
    const ws = XLSX.utils.aoa_to_sheet([['nope']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(() => parseSettlementXlsx(buf, FILENAME)).toThrow(/header/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/settlements/parse.test.ts`
Expected: FAIL — `Cannot find module './parse'`.

- [ ] **Step 3: Implement `src/settlements/parse.ts`**

```ts
// Pure parser for TikTok Shop settlement XLSX reports.
import * as XLSX from 'xlsx';

const SHEET_NAME = 'Unsettled order and adjustment';

export interface SettlementMeta {
  filename: string;
  downloadedAt: string | null;
  reportedCount: number | null;
  rangeStart: string | null; // YYYY-MM-DD
  rangeEnd: string | null;
}

export interface ParsedSettlementRow {
  type: string;
  externalOrderId: string;
  relatedOrderId: string | null;
  netSalesCents: number;
  grossSalesCents: number;
  feesCents: number;
  referralFeeCents: number;
  salesTaxOnReferralCents: number;
  tiktokShippingFeeCents: number;
  customerPaidShippingCents: number;
  customerPaymentCents: number;
  salesTaxPaymentCents: number;
  platformDiscountCents: number;
  estimatedSettlementCents: number;
  adjustmentCents: number; // used for reconciliation only; not stored as a column
  skuId: string | null;
  skuName: string | null;
  productName: string | null;
  quantity: number;
  estimatedSettleTime: string | null;
  unsettledReason: string | null;
  creationDate: string | null;
  raw: Record<string, unknown>;
}

export interface ParseError {
  row: number; // 1-based data row index
  reason: string;
}

export interface ParseResult {
  meta: SettlementMeta;
  rows: ParsedSettlementRow[];
  errors: ParseError[];
}

// header name -> typed field
const STRING_FIELDS: Record<string, keyof ParsedSettlementRow> = {
  'Type': 'type',
  'Order/adjustment ID': 'externalOrderId',
  'Related order ID': 'relatedOrderId',
  'Estimated Settle time': 'estimatedSettleTime',
  'unsettled reasons': 'unsettledReason',
  'SKU ID': 'skuId',
  'Product name': 'productName',
  'SKU name': 'skuName',
};
const MONEY_FIELDS: Record<string, keyof ParsedSettlementRow> = {
  'Net sales': 'netSalesCents',
  'Gross sales': 'grossSalesCents',
  'Fees': 'feesCents',
  'Referral fee': 'referralFeeCents',
  'Sales tax on referral fees': 'salesTaxOnReferralCents',
  'TikTok Shop shipping fee': 'tiktokShippingFeeCents',
  'Customer-paid shipping fee': 'customerPaidShippingCents',
  'Customer payment': 'customerPaymentCents',
  'Sales tax payment': 'salesTaxPaymentCents',
  'Platform discounts': 'platformDiscountCents',
  'Total estimated settlement amount': 'estimatedSettlementCents',
  'Adjustment amount': 'adjustmentCents',
};

export function toCents(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s === '' || s === '/') return 0;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function blankRow(): ParsedSettlementRow {
  return {
    type: '', externalOrderId: '', relatedOrderId: null,
    netSalesCents: 0, grossSalesCents: 0, feesCents: 0, referralFeeCents: 0,
    salesTaxOnReferralCents: 0, tiktokShippingFeeCents: 0, customerPaidShippingCents: 0,
    customerPaymentCents: 0, salesTaxPaymentCents: 0, platformDiscountCents: 0,
    estimatedSettlementCents: 0, adjustmentCents: 0,
    skuId: null, skuName: null, productName: null, quantity: 0,
    estimatedSettleTime: null, unsettledReason: null, creationDate: null, raw: {},
  };
}

export function parseSettlementXlsx(buffer: Buffer, filename: string): ParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[SHEET_NAME] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('settlement sheet not found');

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false, blankrows: true });

  // meta cells
  let downloadedAt: string | null = null;
  let reportedCount: number | null = null;
  for (const r of grid) {
    const key = r?.[0] == null ? '' : String(r[0]).trim();
    if (key === 'Download time' && r[1] != null) downloadedAt = String(r[1]);
    if (key === 'Total Transactions' && r[1] != null) reportedCount = Number(r[1]);
  }

  // filename date range: ..._YYYY_MM_DD-YYYY_MM_DD...
  const m = filename.match(/(\d{4})_(\d{2})_(\d{2})-(\d{4})_(\d{2})_(\d{2})/);
  const rangeStart = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  const rangeEnd = m ? `${m[4]}-${m[5]}-${m[6]}` : null;
  const meta: SettlementMeta = { filename, downloadedAt, reportedCount, rangeStart, rangeEnd };

  // header row = first row whose first cell is exactly "Type"
  const headerIdx = grid.findIndex((r) => r?.[0] != null && String(r[0]).trim() === 'Type');
  if (headerIdx === -1) throw new Error('settlement header row (starting with "Type") not found');
  const header = grid[headerIdx].map((c) => (c == null ? '' : String(c).trim()));

  const rows: ParsedSettlementRow[] = [];
  const errors: ParseError[] = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (!cells || cells.every((c) => c == null || String(c).trim() === '')) continue;

    const rec = blankRow();
    const raw: Record<string, unknown> = {};
    header.forEach((h, col) => {
      if (!h) return;
      const val = cells[col] ?? null;
      raw[h] = val;
      if (h in STRING_FIELDS) {
        const field = STRING_FIELDS[h];
        const s = val == null ? '' : String(val).trim();
        (rec as Record<string, unknown>)[field] =
          field === 'type' || field === 'externalOrderId' ? s : s === '' || s === '/' ? null : s;
      } else if (h in MONEY_FIELDS) {
        (rec as Record<string, unknown>)[MONEY_FIELDS[h]] = toCents(val);
      } else if (h === 'Quantity') {
        rec.quantity = val == null ? 0 : Math.round(Number(String(val).trim()) || 0);
      } else if (h === 'creation date') {
        rec.creationDate = val == null || String(val).trim() === '' ? null : String(val).trim();
      }
    });
    rec.raw = raw;

    const dataRow = rows.length + 1;
    if (!rec.externalOrderId) {
      errors.push({ row: dataRow, reason: 'missing Order/adjustment ID' });
      continue;
    }
    const expected =
      rec.netSalesCents + rec.feesCents +
      (rec.tiktokShippingFeeCents + rec.customerPaidShippingCents) + rec.adjustmentCents;
    if (Math.abs(expected - rec.estimatedSettlementCents) > 1) {
      errors.push({
        row: dataRow,
        reason: `reconciliation off: expected ${expected}¢ got ${rec.estimatedSettlementCents}¢`,
      });
    }
    rows.push(rec);
  }

  return { meta, rows, errors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/settlements/parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settlements/parse.ts src/settlements/parse.test.ts
git commit -m "feat(live-api): settlement XLSX parser with reconciliation check"
```

---

## Task 4: Importer + rollup + re-link (TDD, integration)

> These tests hit Postgres via the shared Prisma client. They require `DATABASE_URL` to point at a reachable dev database (the same one `npm run dev` uses). Each test creates its own throwaway `Organization` and deletes it (cascade) afterward.

**Files:**
- Create: `src/settlements/import.ts`
- Test: `src/settlements/import.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/settlements/import.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as XLSX from 'xlsx';
import { prisma } from '../db';
import { importSettlement, applySettlementRollup } from './import';

const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];

function row(orderId: string, over: Record<string, unknown> = {}): unknown[] {
  const base: Record<string, unknown> = {
    Type: 'Order', 'Order/adjustment ID': orderId, 'Related order ID': orderId,
    'creation date': '2026/06/12', 'Total estimated settlement amount': '13.76',
    'Estimated Settle time': 'Delivered + 1 days', 'unsettled reasons': 'Waiting for package delivery',
    'SKU ID': '1732440158393635811', Quantity: '1',
    'Product name': '$15 STARTS WOMEN PREMIUM BRANDS', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16',
    'Sales tax payment': '-1.58', 'Platform discounts': '0', 'Adjustment amount': '0',
  };
  return HEADER.map((h) => (h in over ? over[h] : base[h]));
}

function makeXlsx(rows: unknown[][]): Buffer {
  const aoa = [['Disclaimer'], ['Download time', '2026-06-12 16:55:33'],
    ['Total Transactions', String(rows.length)], [], HEADER, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const FILENAME = 'Onhold-unsettled-orders-2026_06_01-2026_06_12(UTC-7).xlsx';
let orgId: string;

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Test Settlement Org', slug: `test-settle-${Date.now()}-${Math.round(Math.random() * 1e6)}` },
  });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.organization.delete({ where: { id: orgId } }); // cascades to orders + settlements + imports
});

async function makeOrder(externalOrderId: string) {
  return prisma.order.create({
    data: { organizationId: orgId, platform: 'TIKTOK', externalOrderId, totalCents: 2100 },
  });
}

describe('importSettlement', () => {
  it('imports rows, links existing orders, and rolls up fees + net payout', async () => {
    await makeOrder('AAA-1');
    const summary = await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('AAA-1')]),
    });
    expect(summary.parsed).toBe(1);
    expect(summary.matched).toBe(1);
    expect(summary.unmatched).toBe(0);

    const order = await prisma.order.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(order.netCents).toBe(1376);  // estimated settlement
    expect(order.feesCents).toBe(124);  // positive magnitude of -1.24

    const s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(s.orderId).toBe(order.id);
    expect(s.referralFeeCents).toBe(-117);
  });

  it('stores unmatched rows with orderId null', async () => {
    const summary = await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('GHOST-1')]),
    });
    expect(summary.matched).toBe(0);
    expect(summary.unmatched).toBe(1);
    const s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'GHOST-1' } });
    expect(s.orderId).toBeNull();
  });

  it('is idempotent — re-import updates in place, no duplicates', async () => {
    await makeOrder('AAA-1');
    await importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('AAA-1')]) });
    await importSettlement({
      organizationId: orgId, platform: 'TIKTOK', filename: FILENAME,
      buffer: makeXlsx([row('AAA-1', { 'Referral fee': '-2.00', Fees: '-2.07', 'Total estimated settlement amount': '12.93' })]),
    });
    const all = await prisma.orderSettlement.findMany({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(all).toHaveLength(1);
    expect(all[0].referralFeeCents).toBe(-200);
    const order = await prisma.order.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'AAA-1' } });
    expect(order.netCents).toBe(1293);
  });
});

describe('applySettlementRollup (re-link path)', () => {
  it('links a pending settlement when its order appears later', async () => {
    // settlement imported first — order not captured yet
    await importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: FILENAME, buffer: makeXlsx([row('LATE-1')]) });
    let s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'LATE-1' } });
    expect(s.orderId).toBeNull();

    // order syncs in later → caller runs the rollup
    const order = await makeOrder('LATE-1');
    const linked = await applySettlementRollup(prisma, orgId, 'TIKTOK', 'LATE-1', order.id);
    expect(linked).toBe(true);

    s = await prisma.orderSettlement.findFirstOrThrow({ where: { organizationId: orgId, externalOrderId: 'LATE-1' } });
    expect(s.orderId).toBe(order.id);
    const refreshed = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
    expect(refreshed.netCents).toBe(1376);
    expect(refreshed.feesCents).toBe(124);
  });

  it('no-ops when there is no settlement for the order', async () => {
    const order = await makeOrder('NONE-1');
    const linked = await applySettlementRollup(prisma, orgId, 'TIKTOK', 'NONE-1', order.id);
    expect(linked).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/settlements/import.test.ts`
Expected: FAIL — `Cannot find module './import'`.

- [ ] **Step 3: Implement `src/settlements/import.ts`**

```ts
// Settlement import orchestration + shared Order rollup.
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { parseSettlementXlsx, type ParsedSettlementRow, type ParseError } from './parse';

type Platform = 'TIKTOK' | 'WHATNOT';
// Accept the base client or an interactive-transaction client.
type Db = PrismaClient | Prisma.TransactionClient;

export interface ImportSummary {
  importId: string;
  parsed: number;
  upserted: number;
  matched: number;
  unmatched: number;
  totals: { settlementCents: number; feesCents: number };
  rowErrors: ParseError[];
}

// Link a pending settlement (if any) to its order and roll fees + net payout onto the order.
// Returns true when a settlement existed and was applied. Shared by import + sync/orders.
export async function applySettlementRollup(
  db: Db,
  organizationId: string,
  platform: Platform,
  externalOrderId: string,
  orderId: string,
): Promise<boolean> {
  const s = await db.orderSettlement.findUnique({
    where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId } },
    select: { id: true, orderId: true, estimatedSettlementCents: true, feesCents: true },
  });
  if (!s) return false;
  if (s.orderId !== orderId) {
    await db.orderSettlement.update({ where: { id: s.id }, data: { orderId } });
  }
  await db.order.update({
    where: { id: orderId },
    data: { netCents: s.estimatedSettlementCents, feesCents: -s.feesCents },
  });
  return true;
}

function rowData(r: ParsedSettlementRow) {
  return {
    type: r.type,
    relatedOrderId: r.relatedOrderId,
    netSalesCents: r.netSalesCents,
    grossSalesCents: r.grossSalesCents,
    feesCents: r.feesCents,
    referralFeeCents: r.referralFeeCents,
    salesTaxOnReferralCents: r.salesTaxOnReferralCents,
    tiktokShippingFeeCents: r.tiktokShippingFeeCents,
    customerPaidShippingCents: r.customerPaidShippingCents,
    customerPaymentCents: r.customerPaymentCents,
    salesTaxPaymentCents: r.salesTaxPaymentCents,
    platformDiscountCents: r.platformDiscountCents,
    estimatedSettlementCents: r.estimatedSettlementCents,
    skuId: r.skuId,
    skuName: r.skuName,
    productName: r.productName,
    quantity: r.quantity,
    estimatedSettleTime: r.estimatedSettleTime,
    unsettledReason: r.unsettledReason,
    creationDate: r.creationDate ? new Date(r.creationDate) : null,
    raw: r.raw as never,
  };
}

export async function importSettlement(opts: {
  organizationId: string;
  platform: Platform;
  filename: string;
  buffer: Buffer;
  uploadedById?: string | null;
}): Promise<ImportSummary> {
  const { organizationId, platform, filename, buffer, uploadedById } = opts;
  const { meta, rows, errors } = parseSettlementXlsx(buffer, filename);

  const totalSettlementCents = rows.reduce((s, r) => s + r.estimatedSettlementCents, 0);
  const totalFeesCents = rows.reduce((s, r) => s + r.feesCents, 0);

  return prisma.$transaction(async (tx) => {
    const imp = await tx.settlementImport.create({
      data: {
        organizationId, platform, filename,
        rangeStart: meta.rangeStart ? new Date(meta.rangeStart) : null,
        rangeEnd: meta.rangeEnd ? new Date(meta.rangeEnd) : null,
        downloadedAt: meta.downloadedAt ? new Date(meta.downloadedAt) : null,
        reportedCount: meta.reportedCount,
        rowCount: rows.length,
        totalSettlementCents,
        totalFeesCents,
        uploadedById: uploadedById ?? null,
      },
    });

    let matched = 0;
    let unmatched = 0;
    for (const r of rows) {
      const order = await tx.order.findUnique({
        where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId: r.externalOrderId } },
        select: { id: true },
      });
      const data = rowData(r);
      await tx.orderSettlement.upsert({
        where: { organizationId_platform_externalOrderId: { organizationId, platform, externalOrderId: r.externalOrderId } },
        update: { importId: imp.id, orderId: order?.id ?? null, ...data },
        create: { organizationId, platform, externalOrderId: r.externalOrderId, importId: imp.id, orderId: order?.id ?? null, ...data },
      });
      if (order) {
        await applySettlementRollup(tx, organizationId, platform, r.externalOrderId, order.id);
        matched++;
      } else {
        unmatched++;
      }
    }

    await tx.settlementImport.update({
      where: { id: imp.id },
      data: { matchedCount: matched, unmatchedCount: unmatched },
    });

    return {
      importId: imp.id,
      parsed: rows.length,
      upserted: rows.length,
      matched,
      unmatched,
      totals: { settlementCents: totalSettlementCents, feesCents: totalFeesCents },
      rowErrors: errors,
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/settlements/import.test.ts`
Expected: PASS (5 tests). If it errors with a DB connection failure, ensure Postgres is up and `DATABASE_URL` is set (e.g. `npm run db:create` / the dev DB).

- [ ] **Step 5: Commit**

```bash
git add src/settlements/import.ts src/settlements/import.test.ts
git commit -m "feat(live-api): settlement importer with order rollup + re-link helper"
```

---

## Task 5: Wire routes + multipart + re-link on sync

**Files:**
- Modify: `src/server.ts`
- Modify: `src/routes/v1.ts`

- [ ] **Step 1: Register `@fastify/multipart` and `@fastify/static` in `src/server.ts`**

Add imports near the top (after `import Fastify from 'fastify';`):
```ts
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
```

Immediately after `const app = Fastify(...)` (before the error handler), add:
```ts
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB cap
app.register(fastifyStatic, {
  root: join(__dirnameLocal, '..', 'public'),
  prefix: '/app/',
});
```

- [ ] **Step 2: Add the rollup call inside `POST /sync/orders`**

In `src/routes/v1.ts`, add to the imports at the top:
```ts
import { importSettlement, applySettlementRollup } from '../settlements/import';
```

In the `api.post('/sync/orders', ...)` handler, find the line `upserted++;` (right after the `if (o.items) { ... }` block) and insert this line **before** it:
```ts
      await applySettlementRollup(prisma, orgId, o.platform, o.externalOrderId, order.id);
```

- [ ] **Step 3: Add the three settlement routes**

In `src/routes/v1.ts`, inside `registerRoutes`, just before the final `// ── permissions catalog` block, add:
```ts
  // ── settlements: import a TikTok settlement XLSX ──
  api.post('/settlements/import', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.manage')) return;
    const orgId = req.ctx!.organizationId;
    const file = await (req as unknown as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: 'no_file' });
    const buffer = await file.toBuffer();

    let summary;
    try {
      summary = await importSettlement({
        organizationId: orgId,
        platform: 'TIKTOK',
        filename: file.filename,
        buffer,
        uploadedById: req.ctx!.userId,
      });
    } catch (e) {
      return reply.code(400).send({ error: 'parse_failed', reason: (e as Error).message });
    }

    await prisma.auditLog.create({
      data: {
        organizationId: orgId,
        userId: req.ctx!.userId,
        action: 'settlement.imported',
        targetType: 'settlement_import',
        targetId: summary.importId,
        metadata: { matched: summary.matched, unmatched: summary.unmatched, ...summary.totals } as never,
      },
    });
    return summary;
  });

  // ── settlements: list rows ──
  api.get('/settlements', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.view')) return;
    const settlements = await prisma.orderSettlement.findMany({
      where: { organizationId: req.ctx!.organizationId },
      orderBy: [{ creationDate: 'desc' }],
      take: 2000,
    });
    return { settlements };
  });

  // ── settlements: import batch history ──
  api.get('/settlements/imports', async (req, reply) => {
    if (!requirePermission(req, reply, 'orders.view')) return;
    const imports = await prisma.settlementImport.findMany({
      where: { organizationId: req.ctx!.organizationId },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
    return { imports };
  });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Add a route integration test**

Create `src/settlements/route.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import * as XLSX from 'xlsx';
import { prisma } from '../db';
import { importSettlement } from './import';

// Minimal app exposing just the import logic over multipart, to prove file plumbing works.
function buildApp(orgId: string): FastifyInstance {
  const app = Fastify();
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  app.post('/settlements/import', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: 'no_file' });
    const buffer = await file.toBuffer();
    return importSettlement({ organizationId: orgId, platform: 'TIKTOK', filename: file.filename, buffer });
  });
  return app;
}

const HEADER = [
  'Type', 'Order/adjustment ID', 'Related order ID', 'creation date',
  'Total estimated settlement amount', 'Estimated Settle time', 'unsettled reasons',
  'SKU ID', 'Quantity', 'Product name', 'SKU name',
  'Net sales', 'Gross sales', 'Fees', 'Referral fee', 'Sales tax on referral fees',
  'TikTok Shop shipping fee', 'Customer-paid shipping fee', 'Customer payment',
  'Sales tax payment', 'Platform discounts', 'Adjustment amount',
];
function xlsxBuf(orderId: string): Buffer {
  const data = HEADER.map((h) => ({
    Type: 'Order', 'Order/adjustment ID': orderId, 'Related order ID': orderId, 'creation date': '2026/06/12',
    'Total estimated settlement amount': '13.76', 'Estimated Settle time': 'Delivered + 1 days',
    'unsettled reasons': 'x', 'SKU ID': '1', Quantity: '1', 'Product name': 'p', 'SKU name': '151',
    'Net sales': '15', 'Gross sales': '15', Fees: '-1.24', 'Referral fee': '-1.17',
    'Sales tax on referral fees': '-0.07', 'TikTok Shop shipping fee': '-4.58',
    'Customer-paid shipping fee': '4.58', 'Customer payment': '21.16', 'Sales tax payment': '-1.58',
    'Platform discounts': '0', 'Adjustment amount': '0',
  } as Record<string, string>)[h]);
  const aoa = [['Disclaimer'], ['Download time', '2026-06-12 16:55:33'], ['Total Transactions', '1'], [], HEADER, data];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Unsettled order and adjustment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

let orgId: string;
let app: FastifyInstance;
beforeEach(async () => {
  const org = await prisma.organization.create({ data: { name: 'Route Org', slug: `route-${Date.now()}-${Math.round(Math.random() * 1e6)}` } });
  orgId = org.id;
  app = buildApp(orgId);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await prisma.organization.delete({ where: { id: orgId } });
});

describe('POST /settlements/import', () => {
  it('accepts a multipart XLSX upload and returns a summary', async () => {
    const boundary = '----testboundary';
    const buf = xlsxBuf('ROUTE-1');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Onhold-unsettled-orders-2026_06_01-2026_06_12.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST', url: '/settlements/import',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.parsed).toBe(1);
    expect(json.totals.settlementCents).toBe(1376);
  });
});
```

- [ ] **Step 6: Run the route test**

Run: `npx vitest run src/settlements/route.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all settlement tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/routes/v1.ts src/settlements/route.test.ts
git commit -m "feat(live-api): settlement import/read routes + re-link on order sync"
```

---

## Task 6: Minimal upload page (thin UI slice)

**Files:**
- Create: `public/settlements.html`

- [ ] **Step 1: Create `public/settlements.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SellerFolio · Settlement import</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #111; }
    h1 { font-size: 20px; }
    label { display: block; margin: 16px 0 4px; font-weight: 600; }
    input[type=password], input[type=file] { width: 100%; padding: 8px; box-sizing: border-box; }
    button { margin-top: 20px; padding: 10px 18px; font-weight: 600; cursor: pointer; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow: auto; white-space: pre-wrap; }
    .err { color: #b00020; }
  </style>
</head>
<body>
  <h1>TikTok settlement import</h1>
  <p>Upload an <code>Onhold-unsettled-orders…xlsx</code> export from TikTok Seller Center.</p>
  <label for="token">API token</label>
  <input id="token" type="password" placeholder="Bearer token" autocomplete="off" />
  <label for="file">Settlement XLSX</label>
  <input id="file" type="file" accept=".xlsx" />
  <button id="go">Import</button>
  <h3>Result</h3>
  <pre id="out">—</pre>
  <script>
    const out = document.getElementById('out');
    document.getElementById('go').addEventListener('click', async () => {
      const token = document.getElementById('token').value.trim();
      const file = document.getElementById('file').files[0];
      if (!token || !file) { out.textContent = 'Need both a token and a file.'; out.className = 'err'; return; }
      out.className = ''; out.textContent = 'Uploading…';
      const fd = new FormData();
      fd.append('file', file, file.name);
      try {
        const res = await fetch('/v1/settlements/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
        const json = await res.json();
        out.className = res.ok ? '' : 'err';
        out.textContent = JSON.stringify(json, null, 2);
      } catch (e) { out.className = 'err'; out.textContent = String(e); }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Manual smoke test**

Run: `npm run dev`, then open `http://127.0.0.1:8788/app/settlements.html`, paste a valid API token, choose the real settlement XLSX, click Import.
Expected: a JSON summary with `parsed`, `matched`, `unmatched`, `totals`. (Same-origin page → no CORS needed.)

- [ ] **Step 3: Commit**

```bash
git add public/settlements.html
git commit -m "feat(live-api): minimal settlement upload page at /app/settlements.html"
```

---

## Self-review notes (for the implementer)

- **Sign convention:** `OrderSettlement.*Cents` are stored signed as the report shows (fees negative). The `Order` rollup writes `feesCents = -feesCents` (positive) and `netCents = estimatedSettlementCents`. The existing `profitCents = (netCents ?? totalCents) - costCents` then gives true margin — no change needed to `/orders`.
- **Idempotency** comes from the `@@unique([organizationId, platform, externalOrderId])` on `OrderSettlement` + `upsert`. Re-imports overwrite; a new `SettlementImport` row is still recorded each time (provenance).
- **Re-link** is the same `applySettlementRollup` helper, called from both the importer (when the order already exists) and `POST /sync/orders` (when the order arrives later).
- **Out of scope (do not build):** deposit reconciliation, `SETTLED` finalization flow, adjustment-specific handling beyond storing `type`/`raw`, analytics dashboards, plan-limit metering.
```
