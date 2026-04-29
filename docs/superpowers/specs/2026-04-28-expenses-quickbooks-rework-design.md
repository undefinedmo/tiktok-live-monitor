# Expenses Screen — QuickBooks-style Rework

**Date:** 2026-04-28
**Status:** Design — pending implementation plan

## Goal

Rework the Expenses screen in the desktop app to provide QuickBooks-grade structure and reporting. The current screen is a flat list with category, free-text channel, and a single "Total" tile. Users have no first-class concept of who they paid (vendor) or which account the money came from, can't attach receipts, can't split a single expense across categories, and have no breakdown reports.

The rework introduces vendors, payment accounts, splits, and receipt attachments, surfaces in-context summaries on the Expenses screen, and adds an Expenses tab to the existing Reports screen.

## Non-goals

Out of scope for this rework:

- Tax flags / Schedule C mapping
- Recurring expenses
- Bulk-import / CSV
- Bank feed integration
- Auto-categorization rules
- Account reconciliation / running balance UI
- Bills (separate from paid expenses)
- Receipt OCR / auto-fill

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Desktop (React)                                                      │
│                                                                      │
│  /expenses (page)                                                    │
│   ├── Sub-tabs: Expenses · Vendors · Accounts                        │
│   ├── ExpensesList (filter bar, summary tiles, table, bulk actions)  │
│   ├── VendorsList                                                    │
│   └── AccountsList                                                   │
│                                                                      │
│  /reports (existing page) ── new tab "Expenses" → ExpensesReportTab  │
│                                                                      │
│  Components:                                                         │
│   ├── SlideOverDrawer (NEW, reusable across app)                     │
│   ├── ExpenseDrawer, VendorDrawer, AccountDrawer (consumers)         │
│   └── DataTable (existing, reused)                                   │
│                                                                      │
│  Hooks:                                                              │
│   ├── useExpenses (extended)                                         │
│   ├── useVendors (NEW)                                               │
│   ├── usePaymentAccounts (NEW)                                       │
│   └── useExpenseReports (NEW)                                        │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ apiClient (HTTP + JWT + tenant)
┌──────────────────────────▼──────────────────────────────────────────┐
│ Web (Next.js)                                                        │
│                                                                      │
│  /api/expenses                  (extended: vendor, account, splits)  │
│  /api/expenses/:id/receipts     (NEW: upload, list, delete)          │
│  /api/vendors                   (NEW)                                │
│  /api/payment-accounts          (NEW)                                │
│  /api/reports/expenses          (NEW)                                │
│                                                                      │
│  Receipt files → Vercel Blob (public access tier, UUID keys)         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ Prisma
┌──────────────────────────▼──────────────────────────────────────────┐
│ Postgres                                                             │
│  Tables: expenses, expense_splits, expense_receipts, vendors,        │
│          payment_accounts, expense_categories                        │
└─────────────────────────────────────────────────────────────────────┘
```

All API routes follow the existing pattern: `getTenantContext(req)` → `requirePermission(ctx, 'expenses.view'|'expenses.manage')` → tenant-scoped Prisma queries. Vendors and Accounts share the existing `expenses.*` permission keys (they are sub-resources of expenses).

## Data model

### New tables

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
  id              Int       @id @default(autoincrement())
  tenantId        String    @map("tenant_id") @db.Uuid
  name            String    @db.VarChar(255)
  type            String    @db.VarChar(20)  // 'cash' | 'credit' | 'bank' | 'other'
  openingBalance  Decimal?  @map("opening_balance") @db.Decimal
  currency        String    @default("USD") @db.VarChar(3)
  notes           String?   @db.Text
  archivedAt      DateTime? @map("archived_at") @db.Timestamptz
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz

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
  id          Int      @id @default(autoincrement())
  expenseId   Int      @map("expense_id")
  blobUrl     String   @map("blob_url") @db.Text
  blobKey     String   @map("blob_key") @db.Text
  filename    String   @db.VarChar(255)
  mimeType    String   @map("mime_type") @db.VarChar(100)
  sizeBytes   Int      @map("size_bytes")
  uploadedAt  DateTime @default(now()) @map("uploaded_at") @db.Timestamptz

  expense Expense @relation(fields: [expenseId], references: [id], onDelete: Cascade)

  @@index([expenseId])
  @@map("expense_receipts")
}
```

### Modified `expenses` table

Add columns:

```
+ vendor_id              int      nullable      FK vendors(id)
+ payment_account_id     int      NOT NULL      FK payment_accounts(id)
+ has_splits             boolean  NOT NULL DEFAULT false
```

Drop columns:

```
- brand_id               (currently unused in UI)
```

Keep columns: `channel` (free-text, retained per user decision), `category_id`, `show_id`, `description`, `notes`, `date`, `amount`, `user_id`, `tenant_id`, timestamps.

### Migration strategy

1. **Add nullable columns** for `vendor_id` and `payment_account_id`; create the four new tables.
2. **Seed per tenant**: insert `Cash` and `Unassigned` payment accounts. If any existing expenses for the tenant have `channel='whatnot'`, also insert `Whatnot Balance`.
3. **Backfill** `payment_account_id`:
   - rows with `channel='whatnot'` → `Whatnot Balance` account
   - all other rows → `Unassigned` account
4. **Alter** `payment_account_id` to `NOT NULL`.
5. **Drop** `brand_id` and any related FK / index.

Migrations run via `npx prisma migrate dev` in `web/`. The seeding step is a one-time data migration script in `web/prisma/migrations/<timestamp>_expenses_rework_seed.ts` (or inline SQL alongside the schema migration).

### Splits invariant

For any expense where `has_splits=true`, `sum(expense_splits.amount) == expenses.amount` must hold. Enforced at the API layer inside a transaction on every create/update. No DB-level constraint (Postgres can't easily express this without triggers, which we don't want).

When `has_splits=true`, the header-level `category_id` is ignored (kept for backward compatibility but not used in reports — splits drive category aggregation instead).

## Reusable `SlideOverDrawer` component

**Location:** `desktop/src/components/SlideOverDrawer.tsx`

**Purpose:** A right-aligned (or left-aligned) sliding drawer that complements the existing modal pattern. Used for detail/edit views where the user benefits from keeping the underlying list visible (e.g., walking row-to-row).

**API:**

```tsx
interface SlideOverDrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: 'sm' | 'md' | 'lg';   // 400 / 520 / 720 px, default 'md'
  side?: 'right' | 'left';      // default 'right'
  footer?: ReactNode;           // sticky footer slot
  onPrev?: () => void;          // optional — enables ↑/← keys
  onNext?: () => void;          // optional — enables ↓/→ keys
  children: ReactNode;
}
```

**Behavior:**

- Portaled to `document.body` (escapes layout overflow, same pattern as today's expense modal).
- Backdrop dim, click-outside dismisses, Esc dismisses.
- Slide-in animation ~200ms (transform + opacity).
- Body scroll locked while open.
- Focus trap; on close, focus returns to the element that opened it. `aria-modal`, `role="dialog"`.
- Sticky header (title + close button) and sticky footer.
- When `onPrev`/`onNext` are provided, ↑/↓ (and ←/→) navigate.

**Reuse points called out for v1:**

- `Expenses` tab — expense detail/edit
- `Vendors` tab — vendor detail/edit
- `Accounts` tab — payment account detail/edit

**Future reuse** (not implemented now): Items, Customers, Shows detail panes.

The component is purely presentational — it owns no data or form state. Each consumer passes its own form, save handler, and footer buttons.

## Expenses screen layout

**Route:** `/expenses` (unchanged).

**Top-level sub-tabs:** `Expenses` · `Vendors` · `Accounts`. Each sub-tab has its own filter / sort state — they do not share a global filter (vendors and accounts naturally want all-time defaults).

### `Expenses` sub-tab

Top-to-bottom layout:

1. **Header** — title + `+ New Expense` button (opens drawer in create mode). Keyboard shortcut `n` opens it too.
2. **Filter bar** — Date range, Category, Vendor, Payment Account, Channel, Search. `[Clear]` and `[Apply]`.
3. **Summary tiles** (3 across, computed from current filter):
   - Total expenses (sum)
   - Top vendor (name + amount)
   - Top category (name + amount)
4. **Bulk action bar** — visible only when ≥1 row checked. Actions: Recategorize, Reassign vendor, Delete.
5. **Table** — columns: checkbox, Date, Vendor / Description (combined), Category, Account, Receipt indicator (📎 if `receipts.count > 0`), Amount. Pagination 25/page (existing `DataTable`).

### Row interaction

- Click anywhere on the row (except checkbox) → opens the drawer with that expense.
- Drawer wires `onPrev`/`onNext` to walk to the previous / next visible row in the table without re-opening.
- Edit and Delete are no longer per-row buttons — they live in the drawer footer.

### Expense drawer body

- **Header section**: Date picker, Amount input, Vendor combobox (free-type to filter; "Create new vendor: …" option at bottom), Account dropdown (required).
- **Description**, **Category** (single-select; hidden when "Split this expense" is on), **Channel** (free-text combobox), **Show** (optional dropdown, existing).
- **Splits section** — toggle "Split this expense". When on, replaces the Category field with a line-item editor: rows of (Category, Amount, optional Description). `+ Add line` button. Validation indicator shows running sum vs header amount; Save disabled until they match.
- **Receipts section** — drag-and-drop zone + thumbnail list. Each thumbnail: image preview (or PDF icon), filename, size, delete button. Click thumbnail opens the file in a new tab.
- **Notes** textarea.
- **Footer**: `[Delete]` (left, destructive) — `[Cancel]` `[Save]` (right).

### `Vendors` sub-tab

Table columns: Name, Default category, # Expenses, Total spent. Search input above the table. `+ New Vendor` button. Click row → drawer with vendor detail (name, notes, default category, archive toggle, recent expenses list of last 10).

Delete is blocked if the vendor has expenses; "Archive" is offered instead. Archived vendors are hidden from the vendor picker on the Expenses tab but kept for historical rows.

### `Accounts` sub-tab

Table columns: Name, Type, Spent (period), Last used. Type displayed as a chip. `+ New Account` button. Click row → drawer with account detail (name, type, opening balance, notes, archive toggle, recent expenses).

The `Spent (period)` column has its own date filter (default: this month). No real-time balance / reconciliation UI — explicitly out of scope.

## Receipts (Vercel Blob)

**Provider:** Vercel Blob via `@vercel/blob` (added to `web/package.json`).

**Upload flow:**

1. Client posts `multipart/form-data` to `POST /api/expenses/:id/receipts`.
2. Server validates: auth context, tenant ownership of the expense, MIME type whitelist, file size, per-expense count limit.
3. Server calls `put(key, body, { access: 'public' })` with key:
   ```
   expenses/{tenant_id}/{expense_id}/{uuid}-{filename}
   ```
4. Server inserts an `expense_receipts` row and returns `{ id, blob_url, filename, mime_type, size_bytes }`.

**Limits:**

- Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`, `application/pdf`
- Max 10 MB per file
- Max 10 receipts per expense
- Validated server-side; client pre-validates for UX.

**Delete:** `DELETE /api/expenses/:id/receipts/:receiptId` removes the blob (via `del(key)`) and the row.

**Access control:** Receipts are stored with Vercel Blob's `public` access tier. The URL contains a tenant-scoped UUID key and is unguessable, but a leaked URL is readable by anyone holding it. This is acceptable for v1; if stricter access is needed later, the alternative is `access: 'private'` plus a `/api/expenses/:id/receipts/:receiptId/url` endpoint that returns a signed URL on demand.

**Required env config:** `BLOB_READ_WRITE_TOKEN` in `web/.env.local` and the Vercel project. The implementation plan must call this out as a setup step.

## Reports — new "Expenses" tab in Reports screen

**Location:** `desktop/src/pages/reports/ExpensesTab.tsx`. Registered alongside Overview / Brands / Products / Shows / Customers / Pricing / Live Auctions in `desktop/src/pages/Reports.tsx`.

Reuses the existing `DashboardFilterContext`, `KPICard`, `FilterBreadcrumbs`, period aggregation (`day`/`week`/`month`), and compare mode.

Sections:

1. **KPI strip** — Total expenses, vs prior period (when compare on), # transactions, average transaction.
2. **By category** — bar chart + table; click row adds a category breadcrumb filter.
3. **By vendor** — same pattern.
4. **By account** — same pattern.
5. **Over time** — line chart; respects period aggregation.
6. **Net P&L** — single tile: revenue − expenses for the filter range. Reuses the sales totals already loaded by the Reports page.

Data export from this tab is out of scope for v1.

## API surface

All routes follow the existing tenant + permission pattern.

```
# Vendors
GET    /api/vendors                       list (with counts: # expenses, total spent)
POST   /api/vendors                       create
GET    /api/vendors/:id                   detail + last 10 expenses
PATCH  /api/vendors/:id                   update
DELETE /api/vendors/:id                   archive (or hard-delete if no expenses)

# Payment accounts
GET    /api/payment-accounts              list (with period totals)
POST   /api/payment-accounts              create
GET    /api/payment-accounts/:id          detail + last 10 expenses
PATCH  /api/payment-accounts/:id          update
DELETE /api/payment-accounts/:id          archive

# Receipts
POST   /api/expenses/:id/receipts         multipart upload
DELETE /api/expenses/:id/receipts/:rid    delete blob + row

# Expenses (extended)
GET    /api/expenses                      filters add: vendorId, paymentAccountId
                                          response includes: vendor, paymentAccount,
                                          receipts[], splits[]
POST   /api/expenses                      accepts splits[], validates sum
PATCH  /api/expenses/:id                  same

# Expense reports
GET    /api/reports/expenses              by-category, by-vendor, by-account,
                                          over-time aggregates with date range filter
```

Permissions: `expenses.view` for GETs, `expenses.manage` for POST/PATCH/DELETE on expenses, vendors, accounts, and receipts.

## Hooks

- `useExpenses` (existing, extended): `expenses[]` shape gains `vendor`, `paymentAccount`, `receipts`, `splits`. CRUD methods accept these fields.
- `useVendors` (new): `vendors[]`, `loadVendors(filters?)`, `addVendor`, `updateVendor`, `archiveVendor`.
- `usePaymentAccounts` (new): mirrors `useVendors`.
- `useExpenseReports` (new): one method `loadExpenseReport(filters)` returning the breakdown payload.

## Testing

- **API integration tests** against a real Postgres test DB (no mocked DB — per project convention). One happy + one error path per route. Particular focus:
  - Splits-sum invariant on create/update (POST and PATCH variants)
  - Tenant isolation across all new tables (cross-tenant read/write must fail)
  - Receipt upload size and MIME validation
  - Vendor archive vs delete logic
- **Drawer component**: light unit tests for open/close, focus trap, prev/next callbacks, esc/click-outside.
- **No e2e** for v1 — surface area is large; integration + manual UI walkthrough is the right balance.

## Open questions

None at design time. Implementation plan will sequence the work into phases.

## File-by-file impact summary

**New files**

```
web/prisma/migrations/<ts>_expenses_quickbooks_rework/migration.sql
web/prisma/schema.prisma                                          (edits)
web/src/app/api/vendors/route.ts
web/src/app/api/vendors/[id]/route.ts
web/src/app/api/payment-accounts/route.ts
web/src/app/api/payment-accounts/[id]/route.ts
web/src/app/api/expenses/[id]/receipts/route.ts
web/src/app/api/expenses/[id]/receipts/[rid]/route.ts
web/src/app/api/reports/expenses/route.ts
web/src/lib/blob.ts                                               (Vercel Blob helpers)

desktop/src/components/SlideOverDrawer.tsx
desktop/src/components/expenses/ExpenseDrawer.tsx
desktop/src/components/expenses/ExpenseSplitsEditor.tsx
desktop/src/components/expenses/ReceiptUploader.tsx
desktop/src/components/expenses/VendorCombobox.tsx
desktop/src/components/expenses/AccountSelect.tsx
desktop/src/components/vendors/VendorsList.tsx
desktop/src/components/vendors/VendorDrawer.tsx
desktop/src/components/accounts/AccountsList.tsx
desktop/src/components/accounts/AccountDrawer.tsx
desktop/src/hooks/useVendors.ts
desktop/src/hooks/usePaymentAccounts.ts
desktop/src/hooks/useExpenseReports.ts
desktop/src/pages/reports/ExpensesTab.tsx
```

**Modified files**

```
web/src/app/api/expenses/route.ts                  — vendor/account/splits in payload
web/src/app/api/expenses/[id]/route.ts             — same
web/package.json                                   — add @vercel/blob

desktop/src/pages/Expenses.tsx                     — sub-tabs + use drawer
desktop/src/hooks/useExpenses.ts                   — extended types + methods
desktop/src/pages/Reports.tsx                      — register Expenses tab
```

**Removed**

- Inline edit/delete buttons from the expenses table row (moved into drawer footer).
- The current Add/Edit Expense modal (replaced by drawer).
- The standalone Manage Categories modal — replaced by a "Create new category…" option at the bottom of the category combobox in the expense drawer (inline create), plus a small Manage Categories drawer reachable from a `⋯` overflow button in the Expenses sub-tab header for bulk rename/delete.
- `brand_id` column on `expenses` and any references in TypeScript types.
