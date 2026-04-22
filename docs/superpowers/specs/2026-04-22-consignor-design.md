# Consignor Feature — Design

**Status:** Approved
**Date:** 2026-04-22
**Scope:** Multi-tenant consignor tracking with full payout management, integrated with the existing Items model and Rules engine.

---

## 1. Overview

Sellers consign inventory to the platform from outside parties ("consignors"). Each consignor may have multiple distinct deals (e.g., Jeff brings Edikted at 50/50 and Alo at 60/40). When consigned items sell, the consignor is owed a share of the proceeds; the platform tracks running balances and supports payout settlement with generated statements.

The feature integrates with three existing systems:
- **Items** — gain a link to a consignment plus a computed payout amount.
- **Rules engine** — gains a `set_consignment` action so consignments auto-assign on sync (e.g., "any item with brand = Edikted → Jeff/Edikted 50/50").
- **Profit math** — payout amount becomes a third subtractor alongside `cost`.

---

## 2. Concept

Two-level model:

```
Consignor (Jeff)
└─ Consignments (the deals)
   ├─ Jeff / Edikted 50/50
   ├─ Jeff / Alo 60/40
   └─ Jeff / Default 50/50  (catch-all, is_default = true)
```

- **Consignor** = the person/entity. Owns contact info, payout method preferences, running balance.
- **Consignment** = a specific deal. Owns the split percent and split base. Belongs to one consignor.
- **Item** = links to one Consignment (which knows its Consignor and split).
- **Payout** = a settlement event. Belongs to one Consignor; covers one or more items.

Manual override on an item always wins over rule-driven assignment.

---

## 3. Data Model

All tables include `tenant_id` (uuid) per the multi-tenant pattern. Standard `created_at` / `updated_at` columns assumed.

### 3.1 `consignors`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid | indexed |
| `name` | varchar(255) | required |
| `email` | varchar(255) | optional |
| `phone` | varchar(50) | optional |
| `notes` | text | optional |
| `is_active` | bool | default true |

**Computed (not stored):** `current_balance_cents` = sum of `consignor_payout_cents` across the consignor's items where `consignor_paid_at IS NULL`.

### 3.2 `consignments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid | indexed |
| `consignor_id` | uuid FK → consignors | indexed, ON DELETE RESTRICT |
| `name` | varchar(255) | e.g., "Edikted 50/50" |
| `split_percent` | decimal(5,2) | 0–100; the consignor's share |
| `split_base` | enum | `NET` \| `GROSS` \| `NET_MINUS_COSTS`; default `NET` |
| `is_active` | bool | default true |
| `is_default` | bool | default false; one default per consignor (partial unique index) |
| `notes` | text | optional |

**Constraint:** at most one `is_default = true` per `(consignor_id)`.

### 3.3 `items` — additions

| Column | Type | Notes |
|---|---|---|
| `consignment_id` | uuid FK → consignments | nullable, indexed, ON DELETE SET NULL |
| `split_override_percent` | decimal(5,2) | nullable; overrides consignment's split for this item |
| `consignor_payout_cents` | integer | nullable; computed at sale and on financial changes |
| `consignor_paid_at` | timestamptz | nullable; null = unpaid, non-null = settled |
| `consignor_payout_id` | uuid FK → consignor_payouts | nullable; which payout settled this item |

### 3.4 `consignor_payouts`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid | indexed |
| `consignor_id` | uuid FK → consignors | indexed |
| `amount_cents` | integer | sum of items at time of payout |
| `payment_method` | enum | `venmo` \| `paypal` \| `zelle` \| `cash` \| `check` \| `bank_transfer` \| `other` |
| `method_notes` | text | optional, free-form (e.g., last-4 of check, transaction ref) |
| `paid_at` | timestamptz | required |
| `created_by_user_id` | int FK → users | who recorded the payout |
| `notes` | text | optional |
| `pdf_url` | text | nullable; generated statement |
| `csv_url` | text | nullable; generated statement |

### 3.5 `consignor_payout_items` (join)

| Column | Type | Notes |
|---|---|---|
| `payout_id` | uuid FK → consignor_payouts | ON DELETE CASCADE |
| `item_id` | varchar(255) FK → items | ON DELETE RESTRICT |
| `payout_cents_at_time` | integer | frozen snapshot at payout time |

Primary key: `(payout_id, item_id)`.

---

## 4. Split Math

For each item with a `consignment_id`:

```
split_pct = item.split_override_percent ?? consignment.split_percent

base_cents = switch consignment.split_base:
  NET              → item.net_earnings   (already excludes Whatnot fees)
  GROSS            → item.gross_amount
  NET_MINUS_COSTS  → max(0, item.net_earnings - item.cost - item.shipping_cost)

if item.is_giveaway:
  consignor_payout_cents = 0
else:
  consignor_payout_cents = round(base_cents * split_pct / 100)
```

All amounts stored as cents (integer); decimals are converted at the boundary.

### 4.1 Profit Calculation Change

Existing item profit becomes:

```
profit = net_earnings - cost - consignor_payout_cents
```

For pure consignment items (where the platform paid nothing upfront) `cost = 0`, so `profit` equals the platform's share. This is a deliberate split between two semantically different concepts: `cost` is what was paid for inventory; `consignor_payout_cents` is what is owed to a third party from the sale.

### 4.2 Returns / Refunds

When an item's financials zero out (refund), recomputation produces `consignor_payout_cents = 0`. If the item was already paid (`consignor_paid_at IS NOT NULL`), the consignor's running balance goes negative, surfaced in the UI as "Jeff was overpaid by $X — apply credit to next payout." No automatic clawback; the operator handles it on the next payout.

### 4.3 Giveaways

Items with `is_giveaway = true` produce `consignor_payout_cents = 0`. (If a future operator workflow requires "consignor approves the giveaway and waives payout," it can be a UI confirmation; no model change needed.)

---

## 5. Rules Engine Integration

### 5.1 New Action Type
- `action_type = 'set_consignment'`
- `target_id = <consignment_id>` (uuid as string)
- UI: rule action picker gains "Set Consignment" → reveals consignment dropdown (searchable).

### 5.2 New Condition Fields
Conditions can match on:
- `consignment_id` (uuid equals)
- `consignor_id` (uuid equals)

This enables rules like "if `consignor_id = Jeff` AND `aiBrand = Alo` → set flag = review."

### 5.3 Conflict Resolution
Existing `priority` and `stopProcessing` flags handle multi-consignor conflicts (e.g., Jeff and Sarah both bring Edikted). Lowest priority number wins; first matching rule with `stopProcessing = true` ends evaluation.

### 5.4 Trigger Points
The rules engine runs against an item at:
- **Initial sync** from Whatnot — auto-assigns consignment.
- **Manual rule re-run** from the rules page (existing capability).

Rules do **not** run after a manual `consignment_id` change on an item; manual edits are sticky.

---

## 6. Recompute Triggers

`consignor_payout_cents` is recomputed when:

1. Item is created or synced (after rules fire).
2. Item financial fields change (`gross_amount`, `net_earnings`, `cost`, `shipping_cost`, `is_giveaway`).
3. `consignment_id` or `split_override_percent` on the item changes.
4. Parent consignment's `split_percent` or `split_base` changes — recompute all **unpaid** items on that consignment. Paid items are frozen via `consignor_payout_items.payout_cents_at_time`.

A debug endpoint `POST /api/items/:id/recompute-consignor-payout` allows operator-initiated recompute.

---

## 7. UI

### 7.1 New Top-Level Nav: "Consignors"

**Index page** (`/consignors`)
- Table: name, active deal count, current balance, last payout date, status.
- Sort + filter (active/inactive, balance > 0).
- Row click → consignor detail.
- "New consignor" button.

**Consignor detail page** (`/consignors/:id`)
- Header: name, contact info, current balance (large), "Pay full balance" CTA.
- Tabs:
  - **Consignments** — list of deals, edit/disable/add.
  - **Items** — paginated, default filter "unpaid"; columns include consignment, sale date, gross, net, payout owed, paid status. Bulk select for partial payout.
  - **Payouts** — history with date, amount, method, notes, links to PDF/CSV.

**Consignment detail page** (`/consignments/:id`)
- Edit form: name, split %, split base, active, default flag, notes.
- Items table linked to this consignment.
- Total paid/unpaid summary.

**"New payout" modal**
- Default: pre-checks all unpaid items for the consignor (workflow A).
- Override: uncheck items to defer them (workflow B available within the same UI).
- Form: payment method dropdown, method notes textarea, paid-at (defaults now), free-form notes.
- On submit: creates payout, marks items paid, generates PDF + CSV, returns URLs.

### 7.2 Sales / Items Table Additions
- New "Consignor" column (sortable, filterable). Shows consignor name (or "—").
- New filter chip: "Consignment" (multi-select).
- Bulk action: "Assign to consignment" — pick a consignment, applies to selected items as a manual override.

### 7.3 Item Edit Drawer
- Consignment dropdown (searchable, shows "Consignor / Deal Name").
- Optional "Split % override" numeric input (only shown when a consignment is selected).
- Inline display of computed `consignor_payout_cents` for the current item.

### 7.4 Rules UI
- Action picker: adds "Set Consignment" option.
- Condition picker: adds `consignment_id` and `consignor_id` fields.

---

## 8. API (tenant-scoped)

Standard CRUD endpoints under the existing `/api/...` Next.js route convention. All include `getTenantContext` + `requirePermission` per the existing pattern.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/consignors` | list / create |
| GET / PATCH / DELETE | `/api/consignors/:id` | detail / update / soft-delete (sets `is_active = false`) |
| GET | `/api/consignors/:id/balance` | current unpaid balance |
| GET / POST | `/api/consignments` | list / create |
| GET / PATCH / DELETE | `/api/consignments/:id` | detail / update / disable |
| GET / POST | `/api/consignor-payouts` | list / create payout |
| GET | `/api/consignor-payouts/:id` | detail with PDF/CSV URLs |
| POST | `/api/items/:id/recompute-consignor-payout` | operator/debug recompute |

`POST /api/consignor-payouts` body:
```json
{
  "consignorId": "uuid",
  "itemIds": ["item-id-1", "item-id-2"],   // optional; if omitted = all unpaid for consignor
  "paymentMethod": "venmo",
  "methodNotes": "@jeff-handle",
  "paidAt": "2026-04-22T10:00:00Z",         // optional; defaults to now
  "notes": "March consignment"
}
```

Response includes the generated payout record plus `pdfUrl` and `csvUrl`.

---

## 9. Permissions

**No new permission keys.** Consignor management uses existing role tiers — Owner / Admin / Manager get full access; Viewer gets read-only via the existing `*.view` patterns. (Reconsider only if a tenant later asks to delegate payout creation separately from management.)

---

## 10. Statement Generation

Each payout generates two artifacts at creation time and stores their URLs:

- **PDF** — for the consignor: header (consignor name + date), table of items (sale date, item title, gross, net, split %, payout), total, payment method, notes.
- **CSV** — for operator bookkeeping: same columns in flat form, importable to spreadsheets.

Both are tenant-scoped by storage path.

---

## 11. Sync & Migration

- Existing items will have `consignment_id = NULL` and `consignor_payout_cents = NULL`. No backfill required; only newly assigned items have payouts.
- Operator can bulk-assign consignment to historical items via the Sales table bulk action; the recompute trigger then populates `consignor_payout_cents`.
- The v1 → v2 sync script needs no changes for this feature (consignor data is v2-native).

---

## 12. Out of Scope (YAGNI)

Explicitly deferred — easy to add later if requested:

- Tiered splits (different % above a price threshold).
- Per-item flat handling fees.
- Date-versioning of consignment terms (workaround: create a new consignment, mark old inactive, migrate items).
- Multiple consignors per item (co-owned inventory).
- Scheduled auto-payouts (cron-driven).
- Consignor self-service portal.
- Tax form (1099) generation.

---

## 13. Open Questions (for plan / implementation phase)

- Statement PDF storage location — reuse existing label/PDF storage path or new bucket? (Implementation detail.)
- Should the Sales table consignor filter live in the existing filter dropdown or as a separate sidebar facet? (UI detail.)
- Migration ordering: ship the model + manual assignment first, then rules integration in a second phase? (Plan-phase decision.)
