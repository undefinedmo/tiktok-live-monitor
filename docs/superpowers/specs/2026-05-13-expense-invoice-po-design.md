# Invoice Number and PO Number on Expenses

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan
**Scope:** Cross-service. Touches `web/` (DB schema, APIs, UI) AND `middleware/` (Gemini extractor + BullMQ worker + duplicated Prisma schema).

## Service topology context

The receipt-extraction pipeline is split across two services that share one Postgres database:

- **`web/`** — Next.js app. Owns Prisma migrations (see `web/prisma/migrations/`). Holds the Add Expense modal, expense APIs, receipt-inbox APIs, and the receipt drawer UI.
- **`middleware/`** — Node service running BullMQ workers. Has its own `prisma/schema.prisma` mirroring web's schema for the tables it touches, its own generated Prisma client, and the actual Gemini call (`middleware/src/lib/gemini/receiptExtractor.ts`, consumed by `middleware/src/jobs/workers/receiptExtractionWorker.ts`).

Because both services target the same DB, a column added to one schema must be declared in both for both Prisma clients to compile. The migration is authored once in `web/prisma/migrations/` and applied to the shared DB; middleware then regenerates its client.

The file `web/src/lib/receipts/extraction-prompt.ts` is **dead code** in v2 — no consumer imports `buildReceiptExtractionPrompt`; the middleware has its own embedded prompt. This spec does not modify the dead file (removing it is out of scope) and treats the middleware extractor as the only source of truth for prompt and schema.

## Goal

Add two optional free-text fields to every expense — `invoiceNumber` and `poNumber` — and propagate them across every capture and audit path that already exists for expenses:

- Manual entry through the Add Expense modal.
- AI receipt extraction (Gemini), with extracted-vs-reviewed mirroring.
- Receipt approval (carry-through from inbox row into created expense).
- Update / delete activity logging.
- Global expense search.

Both fields are **always optional**. Empty / whitespace strings persist as `NULL`.

## Background

Today the `Expense` model captures vendor, payment account, category, date, amount, description, notes, channel, show, and split lines. There is no invoice or PO number. The receipt-inbox pipeline already mirrors expense-relevant fields with `extracted*` (AI output) and `reviewed*` (user-edited) columns for vendor, date, amount, tax, currency, category, and notes — the same pattern will extend to invoice/PO.

There is currently no expense edit/detail UI on the web app — the table is read-only and only an Add modal exists. The `PATCH /api/expenses/[id]` endpoint is wired but not consumed from the web today. So adding the fields to the API still pays off (it's used by the desktop app and by the receipt-approve flow) but the manual *edit* UX is out of reach until an expense edit view is built. That is explicitly out of scope here.

## Non-goals

- A new expense edit / detail page.
- A new expenses-list column for invoice / PO.
- Vendor-level defaults (e.g., "this vendor always uses POs").
- Database indexes on the new columns.
- Format constraints / validation (free text, max 128 chars).
- Backfill of existing rows (all start `NULL`).

## Data model

### `Expense` (additive)

`web/prisma/schema.prisma:710`

```prisma
invoiceNumber String? @map("invoice_number") @db.VarChar(128)
poNumber      String? @map("po_number")      @db.VarChar(128)
```

### `ReceiptInboxItem` (additive — four columns)

`web/prisma/schema.prisma:644`

Mirror the existing extracted-vs-reviewed pattern (currently used for vendor, date, amount, etc.):

```prisma
extractedInvoiceNumber String? @map("extracted_invoice_number") @db.VarChar(128)
extractedPoNumber      String? @map("extracted_po_number")      @db.VarChar(128)
reviewedInvoiceNumber  String? @map("reviewed_invoice_number")  @db.VarChar(128)
reviewedPoNumber       String? @map("reviewed_po_number")       @db.VarChar(128)
```

### Migration

One Prisma migration authored under `web/prisma/migrations/` named `add_invoice_po_numbers` adding all six columns nullable, no defaults, no indexes. After it lands, the same column declarations are mirrored into `middleware/prisma/schema.prisma` (no separate middleware migration — middleware regenerates its Prisma client against the shared DB).

## Normalization rule

At every API boundary that accepts these fields, treat them uniformly:

```ts
function normalize(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, 128);
}
```

This applies to: `POST /api/expenses`, `PATCH /api/expenses/[id]`, the receipt drawer's `updateReviewed` PATCH, and the receipt-approve overrides. The Gemini extractor also runs its result through this normalizer before writing to `extracted*` columns.

## API changes

### `POST /api/expenses` (`src/app/api/expenses/route.ts`)

- Destructure `invoiceNumber` and `poNumber` from the body.
- Pass through `normalize()`.
- Set on the created `Expense.data`.
- Include in the activity-log `newValues` map (only when non-null, to keep the log compact).

### `PATCH /api/expenses/[id]` (`src/app/api/expenses/[id]/route.ts`)

- If `body.invoiceNumber !== undefined`, set `update.invoiceNumber = normalize(body.invoiceNumber)`. Same for `poNumber`.
- Extend the activity-log `fields` array to include both new column names. The diff machinery already handles `string | null` correctly.

### `GET /api/expenses` (`src/app/api/expenses/route.ts`)

- Return both fields on every row.
- Extend the existing `where.OR` `search` clause:

  ```ts
  { invoiceNumber: { contains: search, mode: 'insensitive' } },
  { poNumber:      { contains: search, mode: 'insensitive' } },
  ```

  Added to the existing description / notes / vendor.name clauses.

### `DELETE /api/expenses/[id]` (`src/app/api/expenses/[id]/route.ts`)

- Add `invoiceNumber` and `poNumber` to the `select` block and to `oldValues` so the audit captures them on delete.

### `POST /api/receipts/inbox/[id]/approve` (`src/app/api/receipts/inbox/[id]/approve/route.ts`)

- Extend the `OverridesNew` type with `invoiceNumber?: string | null` and `poNumber?: string | null`.
- Inside `approveAsNew`, resolve each value with the same `overrides ?? reviewed ?? extracted ?? null` precedence already used for date / amount / category:

  ```ts
  const invoiceNumber =
    overrides?.invoiceNumber !== undefined
      ? overrides.invoiceNumber
      : (row.reviewedInvoiceNumber ?? row.extractedInvoiceNumber ?? null);
  ```

  Same for `poNumber`. Both go into `expense.create.data`.

### Receipt update PATCH (`web/src/app/api/receipts/inbox/[id]/route.ts`, `PATCH` handler)

The drawer's `useReceiptInboxItem` hook calls this route to save edited fields. Extend the body-allowlist block (currently handling `reviewedVendorId`, `reviewedAccountId`, `reviewedCategoryId`, `reviewedDate`, `reviewedAmount`, `reviewedTax`, `reviewedNotes`, `duplicateExpenseId`) with `reviewedInvoiceNumber` and `reviewedPoNumber` via `normalize()`.

### Receipt serializer

`src/lib/receipts/serialize.ts` returns the row to the frontend. Add both extracted and reviewed values to the serialized output (and any TypeScript types that mirror it).

## Receipt extraction (Gemini) — lives in `middleware/`

### Extractor (`middleware/src/lib/gemini/receiptExtractor.ts`)

Extend the `ExtractedReceipt` interface:

```ts
export interface ExtractedReceipt {
  vendor: string | null;
  date: string | null;
  amount: number | null;
  tax: number | null;
  currency: string | null;
  invoiceNumber: string | null;   // NEW
  poNumber: string | null;        // NEW
  suggestedCategoryId: number | null;
  confidence: number;
  rawNotes?: string | null;
}
```

Add two bullets to the `PROMPT_HEADER` template:

```
  - invoiceNumber: string or null. The invoice / receipt number printed on the document (e.g. "INV-2024-0012", "#48391"). Null if not visible.
  - poNumber: string or null. The purchase order number if printed (e.g. "PO-12345"). Null if not visible.
```

Extend the parse block at the bottom of `extractReceipt` to surface the two new values defensively:

```ts
invoiceNumber: typeof parsed.invoiceNumber === 'string' ? parsed.invoiceNumber : null,
poNumber:      typeof parsed.poNumber === 'string'      ? parsed.poNumber      : null,
```

### Worker (`middleware/src/jobs/workers/receiptExtractionWorker.ts`)

In the `prisma.receiptInboxItem.update` call at line ~117, add:

```ts
extractedInvoiceNumber: normalize(extracted.invoiceNumber),
extractedPoNumber:      normalize(extracted.poNumber),
```

A small `normalize` helper local to the worker (or imported from a shared module under `middleware/src/lib/`) handles trim / max-128 / empty-to-null. Symmetric with the web-side normalizer.

### Web-side dead code (`web/src/lib/receipts/extraction-prompt.ts`)

Not modified. The file is currently unused — no consumer imports `buildReceiptExtractionPrompt`. Removing it is out of scope here.

## UI

### Add Expense modal (`web/src/app/(dashboard)/expenses/page.tsx`)

Form order becomes:

```
Date → Amount → Vendor → Payment Account → Category
→ Invoice Number (optional, text input)
→ PO Number      (optional, text input)
→ Notes
```

State changes:

```ts
const [newExpense, setNewExpense] = useState<{
  // ... existing fields ...
  invoiceNumber: string;
  poNumber: string;
}>({
  // ... existing initializers ...
  invoiceNumber: "",
  poNumber: "",
});
```

Inputs are plain `<input type="text" maxLength={128}>` with `placeholder="Optional"`, styled to match the other modal fields. Both included in the `POST /api/expenses` body. Reset clears both on success.

### Receipt drawer (`web/src/components/receipts/ReceiptDrawer.tsx`)

Two new text inputs in the reviewable-fields section, alongside vendor / date / amount / category / notes. Pre-fill from `reviewedInvoiceNumber ?? extractedInvoiceNumber` (and same for PO). Edits flow through the existing `updateReviewed` mechanism.

### Expense list display

No new column. Both fields are returned by the API and matched by the search input. That's it.

## Activity logging

- `POST` creation log — include both fields in `newValues` if non-null.
- `PATCH` update log — both fields added to the `fields:` array so changes show up in diffs.
- `DELETE` — both fields included in `oldValues` on the delete log.

## Tests

| File | Cases to add |
|---|---|
| `src/app/api/expenses/__tests__/post.test.ts` | Round-trip both values; empty string and whitespace become NULL; values over 128 chars are truncated. |
| `src/app/api/expenses/[id]/__tests__/patch.test.ts` | Update both fields; setting to `""` clears to NULL; diff is logged. |
| `src/app/api/reports/expenses/__tests__/shape.test.ts` *(or wherever GET is tested)* | `?search=INV-12` returns expenses whose `invoiceNumber` contains `inv-12`. |
| Receipt extraction prompt test (if one exists) | Schema mention; otherwise skip. |
| Approve handler test (if one exists) | Carry-through of `reviewed*` into created expense; override precedence. |

## Files affected (summary)

### `web/`

| Path | Change |
|---|---|
| `web/prisma/schema.prisma` | Add 6 columns (2 on `Expense`, 4 on `ReceiptInboxItem`). |
| `web/prisma/migrations/<ts>_add_invoice_po_numbers/migration.sql` | Generated migration (owns the DB change). |
| `web/src/lib/receipts/serialize.ts` | Surface both extracted + reviewed values. |
| `web/src/app/api/expenses/route.ts` | POST: accept + persist + log. GET: return + search. |
| `web/src/app/api/expenses/[id]/route.ts` | PATCH: accept + persist + diff-log. DELETE: include in oldValues. |
| `web/src/app/api/receipts/inbox/[id]/route.ts` | PATCH: accept `reviewedInvoiceNumber` and `reviewedPoNumber`. |
| `web/src/app/api/receipts/inbox/[id]/approve/route.ts` | Carry-through precedence + Override type. |
| `web/src/app/(dashboard)/expenses/page.tsx` | Two new inputs in the Add Expense modal; state + POST body + reset. |
| `web/src/components/receipts/ReceiptDrawer.tsx` | Two new inputs in reviewable section. |
| Web test files | `post.test.ts`, `patch.test.ts`, expense GET search tests. |

### `middleware/`

| Path | Change |
|---|---|
| `middleware/prisma/schema.prisma` | Mirror the 4 new `ReceiptInboxItem` columns so the middleware Prisma client compiles. No migration here — DB owned by web. |
| `middleware/src/lib/gemini/receiptExtractor.ts` | Extend `ExtractedReceipt` type, prompt text, and the defensive parse block. |
| `middleware/src/jobs/workers/receiptExtractionWorker.ts` | Add normalized invoice/PO values to the `prisma.receiptInboxItem.update` call. |
| `middleware/tests/jobs/receiptExtractionWorker.test.ts` | Add a case asserting invoice/PO round-trip from Gemini output → inbox row. |

### Deploy order

1. Land web migration → apply to shared DB.
2. Update web schema/code + middleware schema/code in the same release.
3. `prisma generate` in each service.
4. Restart middleware worker so it picks up the new client.

Workers will tolerate the new columns being NULL on old rows (all optional). No backfill needed.

### Unchanged

- `web/src/lib/receipts/extraction-prompt.ts` (dead code, not modified).
- Permission surface, endpoint surface, indexes — all unchanged.
- Existing extraction confidence / category / tax / currency logic — unchanged.
