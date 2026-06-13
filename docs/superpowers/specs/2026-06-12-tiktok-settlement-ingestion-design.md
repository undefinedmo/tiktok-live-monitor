# TikTok Shop Settlement Ingestion — Design

**Date:** 2026-06-12
**Target system:** `sellerfolio-live-api` (SellerFolio Live — Fastify + Prisma 7 + Postgres)
**Status:** Approved design, pending implementation plan

---

## 1. Problem & context

TikTok's order-detail payload (what we capture in the live monitor / `tiktok-data-viewer`) contains **only buyer-facing amounts** — item price, tax, shipping. It has **no seller fees**. The actual fees (referral commission, sales tax on that commission, etc.) and the net payout live exclusively in TikTok Seller Center's **settlement report**, downloadable as an XLSX. There is no live API for it.

We want to ingest these settlement reports so the platform knows real per-order fees and net payout, enabling:

1. **True per-order / per-show net profit** — combine TikTok fees with the seller's product cost to get real margin.
2. **Fee analytics / trends** — referral %, shipping economics, effective fee rate over time.

Explicitly **not** in scope: deposit/payout reconciliation (matching bank deposits to orders), adjustment-specific workflows.

### The settlement file (verified against a real export)

`Onhold-unsettled-orders-2026_06_01-2026_06_12(UTC-7).xlsx`:

- Single sheet: `Unsettled order and adjustment`.
- Rows 0–3 are banners/meta: a disclaimer, `Download time`, `Total Transactions` (306), a blank row.
- **Header is row 4** (0-indexed); data starts row 5. 99 columns, 306 data rows.
- Every row in this export is `Type = "Order"`, `unsettled reasons = "Waiting for package delivery"`, `Estimated Settle time = "Delivered + 1 days"`. The format also supports `Type = "adjustment"` rows (which carry `Adjustment amount`/`Adjustment reason` and may have no parent order).
- One row per order here (no multi-SKU splitting observed); `Order/adjustment ID` == `Related order ID` for order rows.
- **Only ~12 of the 99 columns ever carry a non-zero value** for this seller. The other 80+ (affiliate commission, GMV Max, FBT, brand campaigns, managed-service, retail delivery, etc.) are all zero — but could be non-zero in other reports, so we must not hard-drop them.

**Reconciliation (holds to the penny across all 306 rows):**

```
Total estimated settlement amount = Net sales + Fees + Shipping(net) + Adjustments
$9,556.71                         = $10,292.00 + (−$735.29) + $0        + $0
```

Where `Fees` (−$735.29) = `Referral fee` (−$692.07) + `Sales tax on referral fees` (−$43.22), and shipping nets to zero (`TikTok Shop shipping fee` −$1,241.08 + `Customer-paid shipping fee` +$1,241.08).

The promoted columns (the financial surface we care about):

| Report column | Meaning |
|---|---|
| Total estimated settlement amount | Net payout to seller |
| Net sales / Gross sales | Item revenue (after / before seller discounts) |
| Fees | Total fees (negative) |
| Referral fee | TikTok commission (negative) |
| Sales tax on referral fees | Tax on the commission (negative) |
| TikTok Shop shipping fee | Label cost charged to seller (negative) |
| Customer-paid shipping fee | Shipping the buyer paid (positive) |
| Customer payment | Gross the buyer paid |
| Sales tax payment | Tax collected & remitted by TikTok (not seller income) |
| Platform discounts | TikTok-funded discount |
| (ids/desc) | Order/adjustment ID, Related order ID, SKU ID, SKU name, Product name, Quantity, creation date, Estimated Settle time, unsettled reasons |

---

## 2. Goals & non-goals

**Goals**
- Recurring, idempotent importer for TikTok settlement XLSX files into `sellerfolio-live-api`.
- Store every row with full fidelity; promote the financial fields to typed columns; keep the full row as `raw` JSON.
- Roll fees + net payout up onto the existing `Order` so per-order and per-show profit "just work."
- Store settlement rows even when the matching order isn't captured yet; auto-link later.

**Non-goals (YAGNI / follow-on)**
- Deposit/bank reconciliation.
- A polished analytics dashboard (a minimal upload UI only for MVP).
- The `SETTLED` final-report pipeline (the model supports the status; we don't build the flow yet).
- Adjustment-specific UI.
- Plan-limit metering for imports.

---

## 3. Architecture & data flow

```
Web upload (XLSX, multipart)
        │
        ▼
POST /v1/settlements/import        ← auth hook + requirePermission('orders.manage')
        │
        ├─ 1. parse(buffer)   → { meta, rows[], errors[] }
        ├─ 2. create SettlementImport (provenance + summary), in a transaction
        ├─ 3. for each row → upsert OrderSettlement (unique org+platform+externalOrderId)
        │        ├─ find Order by (org, TIKTOK, externalOrderId)
        │        ├─ matched   → set orderId + roll up Order.netCents / Order.feesCents
        │        └─ unmatched → orderId = null (pending)
        └─ 4. return { parsed, upserted, matched, unmatched, totals, rowErrors[] }
```

**Re-link loop:** `POST /sync/orders` gains a small step — after upserting an order, look for a pending `OrderSettlement` with that `externalOrderId`; if found, set its `orderId` and roll up. This closes the gap when an order is captured *after* its settlement was imported.

**Read endpoints:**
- `GET /v1/settlements` — list/filter settlement rows (for the fee-analytics view).
- `GET /v1/settlements/imports` — batch history.
- Per-order/per-show profit needs **no new query** — it flows through the `Order.netCents`/`feesCents` rollup and the existing `profitCents` computation.

**Entry point:** the importer (parse + store) is the live-api endpoint above. live-api has no web frontend yet, so the upload page is a thin slice (drag file → POST → show summary). The endpoint is the core deliverable; the desktop app or a future web dashboard can call the same endpoint.

---

## 4. Schema changes (Prisma)

Additive only — new tables + enum, no changes to existing tables. Safe migration on the live-api DB.

```prisma
enum SettlementStatus {
  ESTIMATED   // "on-hold / unsettled" reports — amounts subject to change
  SETTLED     // reserved for the final settled-report flow (not built yet)
}

model SettlementImport {
  id                   String   @id @default(uuid()) @db.Uuid
  organizationId       String   @map("organization_id") @db.Uuid
  platform             PlatformType
  filename             String   @db.VarChar(500)
  rangeStart           DateTime? @map("range_start") @db.Timestamptz   // parsed from filename
  rangeEnd             DateTime? @map("range_end") @db.Timestamptz
  downloadedAt         DateTime? @map("downloaded_at") @db.Timestamptz  // "Download time" cell
  reportedCount        Int?     @map("reported_count")                  // "Total Transactions" cell
  rowCount             Int      @map("row_count")
  matchedCount         Int      @map("matched_count")
  unmatchedCount       Int      @map("unmatched_count")
  totalSettlementCents Int      @map("total_settlement_cents")
  totalFeesCents       Int      @map("total_fees_cents")
  uploadedById         String?  @map("uploaded_by") @db.Uuid
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz

  organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  settlements  OrderSettlement[]

  @@index([organizationId])
  @@map("settlement_imports")
}

model OrderSettlement {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  importId        String   @map("import_id") @db.Uuid
  orderId         String?  @map("order_id") @db.Uuid          // nullable — linked when the order exists
  platform        PlatformType
  type            String   @db.VarChar(20)                    // "Order" | "adjustment"
  externalOrderId String   @map("external_order_id") @db.VarChar(255)
  relatedOrderId  String?  @map("related_order_id") @db.VarChar(255)
  status          SettlementStatus @default(ESTIMATED)

  // promoted money fields — integer cents, SIGNED exactly as the report shows
  netSalesCents             Int @default(0) @map("net_sales_cents")
  grossSalesCents           Int @default(0) @map("gross_sales_cents")
  feesCents                 Int @default(0) @map("fees_cents")                  // negative
  referralFeeCents          Int @default(0) @map("referral_fee_cents")          // negative
  salesTaxOnReferralCents   Int @default(0) @map("sales_tax_on_referral_cents") // negative
  tiktokShippingFeeCents    Int @default(0) @map("tiktok_shipping_fee_cents")   // negative
  customerPaidShippingCents Int @default(0) @map("customer_paid_shipping_cents")
  customerPaymentCents      Int @default(0) @map("customer_payment_cents")
  salesTaxPaymentCents      Int @default(0) @map("sales_tax_payment_cents")     // negative
  platformDiscountCents     Int @default(0) @map("platform_discount_cents")
  estimatedSettlementCents  Int @default(0) @map("estimated_settlement_cents")  // net payout

  // descriptive
  skuId               String?   @map("sku_id") @db.VarChar(255)
  skuName             String?   @map("sku_name") @db.VarChar(255)
  productName         String?   @map("product_name") @db.VarChar(500)
  quantity            Int       @default(0)
  estimatedSettleTime String?   @map("estimated_settle_time") @db.VarChar(120)
  unsettledReason     String?   @map("unsettled_reason") @db.VarChar(255)
  creationDate        DateTime? @map("creation_date") @db.Timestamptz

  raw       Json     @db.JsonB   // FULL row keyed by column name — preserves all 99 columns + future ones
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

Relations added to `Organization` (`settlements`, `settlementImports`) and `Order` (`settlements OrderSettlement[]`).

### Rollup onto the existing `Order` (no new Order columns)

When an `OrderSettlement` is linked to an `Order`:
- `Order.netCents` = `estimatedSettlementCents` (what TikTok actually pays)
- `Order.feesCents` = `−(feesCents)` → stored as a **positive** magnitude of total fees

The existing computation `profitCents = (netCents ?? totalCents) − costCents` then yields **true margin** (TikTok payout − seller's product cost), automatically in the orders list and any per-show aggregate.

### Sign convention (explicit, to avoid ambiguity)

- `OrderSettlement.*Cents` are stored **exactly as the report shows** — fees and tax negative, settlement and payments positive. This keeps analytics faithful to the source.
- The `Order` rollup **derives** its values: `feesCents` is the positive magnitude; `netCents` is the (positive) estimated settlement.

---

## 5. Parsing module (`src/settlements/parse.ts`)

Pure function: `parseSettlementXlsx(buffer, filename) → { meta, rows[], errors[] }`. Uses **SheetJS (`xlsx`)**.

- **Sheet:** read `Unsettled order and adjustment`.
- **Header detection by signature:** locate the row whose first cell is `Type` (don't hard-code row 4) — survives TikTok adding/removing banner rows.
- **Column mapping by header name → field** (not by position) — survives column reordering. A static map covers the ~12 promoted columns + ids/descriptive fields. Every column (by header name) is also written to `raw`, so unknown/new columns are retained.
- **Money → cents:** numeric strings like `-1.17`, `21.16`; treat `/` and blank as `0`; `Math.round(value * 100)`; strip a leading `$` if present.
- **Meta:** read `Download time` and `Total Transactions` cells; parse the date range from the filename (`...2026_06_01-2026_06_12...`).
- **Per-row self-check:** assert `estimatedSettlement ≈ netSales + fees + shipping + adjustment` (±1¢). Failures go into `errors[]` (row index + reason) but do **not** abort the import.

---

## 6. Upload, idempotency & error handling

- **Upload:** add `@fastify/multipart`. Endpoint accepts a raw `.xlsx` (cap ~10 MB). Parse server-side.
- **Validation:** reject files missing the expected sheet or header signature → `400 { error, reason }`.
- **Idempotency:** `OrderSettlement` is unique on `(organizationId, platform, externalOrderId)`. Re-importing an overlapping range **upserts** (last upload wins) — no duplicates. Each import still records its own `SettlementImport` for provenance.
- **Partial failure:** the whole import runs in a transaction; a hard failure leaves no partial `SettlementImport`. Per-row parse errors are collected and returned in the response — **good rows still import**.
- **Audit:** write an `AuditLog` entry (`settlement.imported`) with counts + import id. No `UsageMetric` (not a billable sync).

**Response shape:**
```json
{
  "importId": "…",
  "parsed": 306, "upserted": 306,
  "matched": 290, "unmatched": 16,
  "totals": { "settlementCents": 955671, "feesCents": -73529 },
  "rowErrors": []
}
```

---

## 7. Testing (TDD)

1. **Parser unit tests** against a small XLSX fixture — header detection, column-by-name mapping, cents conversion, `/`-handling, meta + filename-range extraction, reconciliation check.
2. **Import endpoint integration test** — upload fixture → assert `SettlementImport` + `OrderSettlement` rows, matched/unmatched counts, and `Order.netCents/feesCents` rollup + resulting `profitCents`.
3. **Idempotency test** — re-import updates in place, no duplicates; a second `SettlementImport` is recorded.
4. **Re-link test** — import settlement for an un-captured order, then `POST /sync/orders` that order → the settlement links and rolls up.

Fixtures: a trimmed, synthetic XLSX (a handful of rows incl. one unmatched and, optionally, one `adjustment` row) committed under the test directory. No real buyer PII in fixtures.

**Test infrastructure note:** `sellerfolio-live-api` currently has **no test runner** (no `test` script, no test files). Setting one up — `node:test` or `vitest`, plus an `npm test` script and a DB strategy for the integration tests (e.g., a disposable test schema / transaction rollback) — is part of this work, not assumed to exist.

---

## 8. New / changed files (anticipated)

- `prisma/schema.prisma` — add enum + two models + relations.
- `prisma/migrations/<ts>_settlement_ingestion/` — additive migration.
- `src/settlements/parse.ts` — XLSX parser (pure).
- `src/settlements/import.ts` — import orchestration (create batch, upsert rows, link, roll up).
- `src/routes/v1.ts` — `POST /v1/settlements/import`, `GET /v1/settlements`, `GET /v1/settlements/imports`; re-link step inside `POST /sync/orders`.
- `src/server.ts` — register `@fastify/multipart`.
- `package.json` — add `xlsx`, `@fastify/multipart`.
- Tests under the project's test location.
- (Follow-on) minimal upload page.

---

## 9. Open questions / future

- **Final settled report:** when a `Settled` (not on-hold) report becomes available, flip `status → SETTLED` and finalize amounts. Model supports it; pipeline deferred.
- **Adjustments:** stored generically (`type`, `raw`, `relatedOrderId`) but no dedicated handling/UI yet.
- **Web analytics dashboard:** referral-rate trends, per-show fee breakdown — follow-on once data is flowing.
