# TikTok Order Data Foundation + Order/Transaction Accuracy — Design

**Date:** 2026-06-21
**Target system:** `tiktok-live-poc` (graduating in place — Electron main + portable `core/` + renderer)
**Status:** Approved design, pending implementation plan
**Phase:** 0 + 1 of a 4-phase enrichment program (see §11)

---

## 1. Problem & context

The TikTok Live Monitor app is past PoC. We are enriching two subsystems — the **Live Monitor** and the **Ledger / Orders / Transactions** — across a multi-phase program. This spec covers the **first deliverable**: the data foundation that everything else builds on, plus the order/transaction accuracy fixes that make the Ledger numbers trustworthy.

Two problems block durable enrichment today:

1. **No real store.** All user-owned data (cost templates, AI transcripts, the synced order book, shows, picklist) lives in the **renderer's `localStorage`** as string blobs. There are no joins, no queries, a ~10 MB ceiling, and persistence is coupled to the throwaway-era renderer. Every theme in the broader program multiplies per-order/per-package/per-transaction data and adds relationships (orders ↔ items ↔ packages ↔ shows ↔ costs ↔ AI fields). `localStorage` will not carry it.

2. **Unstable product identity + thin money model.** The Seller-Center sync path uses the **product name** as `Sale.productId` (`tiktok-orders.ts:121`, `orderToSale`). This merges distinct bins that share a name, splits a bin when its name changes, and weakens cost templates (which key off `productId`). Separately, the order model carries grand-total + subtotal/shipping/tax but **not** discounts or per-item unit/total prices, so revenue/margin is approximate.

### Decisions taken during brainstorming

| Decision | Choice |
|---|---|
| Where the enriched code lives | **Graduate `tiktok-live-poc` in place** (no port to `desktop`/V2) |
| Persistence model | **`better-sqlite3` in the main process**, relational, renderer queries via IPC |
| First spec | **Phase 0 (Data Foundation) + Phase 1 (Order/Transaction Accuracy) together** |
| Live Monitor track | **Parallel, independent** workstream (Phase 4 — separate spec) |

### Scope of this spec

**In scope (Phase 0 + 1):**
- A main-process SQLite store + IPC query layer.
- One-time migration of existing `localStorage` data into SQLite, **including re-keying cost/AI templates** when `productId` changes from name → `product_id`.
- Enriched `order/list` parsing: stable `product_id`/`sku_id`, per-item unit/total price, image, order-line IDs, and a full price breakdown (discounts).
- Switching `Sale.productId` to the real `product_id`.
- Reading `auction_module` from `order/list` when present (fewer `order/get` calls).

**Out of scope (later phases — §11):** fulfillment/pack-ship ops, SLA deadlines, packages, dashboard/search-count counters, buyer/CRM & exception flags, and all Live Monitor telemetry.

---

## 2. Goals & success criteria

1. **No data loss on migration.** Every existing cost (`tt-cost`, `tt-product-cost`), AI transcript (`tt-order-tx`, `tt-product-tx`), cached order, show, and picked order survives the move to SQLite — verified by a migration test against a representative `localStorage` blob.
2. **Stable product identity.** A synced auction order's `Sale.productId` is the TikTok `product_id`, not the product name. Two bins with the same name no longer merge; a renamed bin no longer splits. Cost templates key off `product_id`.
3. **Trustworthy money.** Each order carries a full price breakdown (subtotal, platform/seller discounts, shipping, shipping discount, tax, origin sale price) and each item carries unit/total price — all in integer cents.
4. **Renderer reads data from SQLite via IPC**, not `localStorage`, for all migrated keys. UI-pref keys remain in `localStorage`.
5. **`core/ledger.ts` and the Ledger UI are unchanged** — rows still arrive as `LedgerRow[]`; only their source changes.
6. **All tests green** (`npm test`), including new DB and parser tests.

---

## 3. Current state (verified against the code)

- **Active order fetch already exists** in main via cookie auth: `pullTiktokOrders` / `fetchOrderDetails` (`tiktok-orders.ts`), driven by `Sync orders` (`main.ts`). Cookie auth only, no request signing. Phase 1 extends the parser; no new acquisition mechanism is needed.
- **`mapTiktokOrder` already reads** `sku_module` for `product_name`/`sku_name`/`quantity` (`tiktok-orders.ts:81-86`) and already captures `subtotalCents`/`shippingCents`/`taxCents` (`:97-100`) — but **ignores** `product_id`, `sku_id`, `order_line_ids`, item image, per-item prices, and discounts.
- **`TT_ORDER_EXTRA_DATA`** already requests `risk_order_tag_v1` and `split_combine_tag_v1` (`:146-151`) but **not** `replacement_order_tag_v1`.
- **`localStorage` data keys to migrate** (renderer):
  - `tt-cost` → `Record<orderId, cents>` (order-level cost override)
  - `tt-product-cost` → `Record<productId, cents>` (product/bin cost template, **name-keyed today**)
  - `tt-order-tx` → `Record<orderId, LedgerTranscript>` (per-item AI transcript)
  - `tt-product-tx` → `Record<productId, LedgerTranscript>` (product-level AI transcript, **name-keyed today**)
  - `tt-orders` → `Sale[]` (cached synced order book)
  - `tt-shows` → `ShowStore` (`core/shows.ts`)
  - `tt-picked` → `string[]` (picked order IDs)
- **`localStorage` UI-pref keys that stay put:** `tt-label-template`, `tt-feed-size`, `tt-autoprint`.
- **`LedgerRow`** (`core/ledger.ts:18`) = `Sale & { costCents?, transcript? }`. The view-model, KPIs, filters, picklist grouping, and CSV all consume `LedgerRow[]` and need no change.
- **Only `tt-printer.json`** is persisted in main today (`main.ts:234`). SQLite is net-new infra here.

### Verification gap (must close first)

There is **no committed `order/list` fixture** — the order test (`__tests__/tiktok-orders.test.ts`) uses synthetic data with no `product_id`. The enriched field paths (`sku_module.product_id`, `sku_id`, per-item price, discount modules) are asserted from a HAR that is **not in the repo**. **Implementation must begin by capturing one sanitized `order/list` response as a fixture** and TDD the parser against it. If a field path differs from the assumption, the spec's field names yield to the fixture.

---

## 4. Architecture

```
                 Seller-Center (cookie auth)
                          │  order/list (enriched)
                          ▼
  main.ts  ──►  tiktok-orders.ts (parse)  ──►  db.ts (upsert orders/items)
     ▲                                              │
     │  IPC: tt-db:getLedger / setCost / ...        │  SQLite (userData/tiktok.db)
     ▼                                              ▼
  renderer.ts  ◄────────── LedgerRow[] (orders ⋈ costs ⋈ transcripts ⋈ picks)
     │
     └─ localStorage: UI prefs only (label template, feed size, autoprint)
```

- **`src/electron/db.ts`** (new): opens `better-sqlite3` at `app.getPath('userData')/tiktok.db`, runs versioned migrations on boot, and exposes typed functions (`upsertOrders`, `getLedgerRows`, `setCost`, `setProductCost`, `setTranscript`, `setPicked`, `getShows`, `setShows`, `importLegacy`). Pure data access — no TikTok/network logic.
- **`main.ts`**: registers `ipcMain.handle` query handlers that delegate to `db.ts`; the `Sync orders` flow upserts into the DB instead of pushing a transient `OrdersEvent`.
- **`core/`**: enrichment parsing extends `tiktok-orders.ts` (still pure, still unit-tested). `core/ledger.ts` is untouched.
- **`renderer.ts`**: the `loadJson`/`save*` calls for the seven data keys are replaced with `ipcRenderer.invoke('tt-db:*')`. Ledger rows are requested from main rather than assembled from local maps.

**Why main-process SQLite (recap):** relational joins for the order ↔ item ↔ cost ↔ transcript graph; survives renderer rewrites; ready for Phase 2 packages/SLA and Phase 3 flags as new tables/columns.

---

## 5. Data model (SQLite)

All TikTok IDs are stored as **`TEXT`** (order/product/sku/room/line IDs exceed 2^53). Money is **integer cents**. Times are **epoch ms** `INTEGER`.

### `orders` — refreshable cache of `order/list`
```
order_id TEXT PRIMARY KEY
status TEXT, status_code TEXT
buyer_handle TEXT, buyer_name TEXT
total_cents INTEGER, subtotal_cents INTEGER,
shipping_cents INTEGER, shipping_discount_cents INTEGER,
platform_discount_cents INTEGER, seller_discount_cents INTEGER,
tax_cents INTEGER, origin_sale_cents INTEGER
live_tag TEXT, room_id TEXT
is_auction INTEGER, is_reversed INTEGER
placed_at INTEGER
video_receipt_ts INTEGER          -- safe anchor; NO signed receipt URL stored
payment_status TEXT               -- 'paid' | 'failed' | 'pending' (derived)
synced_at INTEGER
```

### `order_items` — one row per `sku_module` line
```
id INTEGER PRIMARY KEY AUTOINCREMENT
order_id TEXT REFERENCES orders(order_id) ON DELETE CASCADE
line_index INTEGER
product_id TEXT, sku_id TEXT
product_name TEXT, variant TEXT
quantity INTEGER
unit_price_cents INTEGER, total_price_cents INTEGER
image_url TEXT
order_line_ids TEXT               -- JSON array
```
Index: `(order_id)`, `(product_id)`.

### `costs` — user-owned
```
scope TEXT     -- 'order' | 'product'
key TEXT       -- order_id or product_id
cents INTEGER
updated_at INTEGER
PRIMARY KEY (scope, key)
```

### `transcripts` — user-owned AI fields
```
scope TEXT, key TEXT
brand TEXT, item TEXT, color TEXT, size TEXT, retail_price TEXT, summary TEXT
updated_at INTEGER
PRIMARY KEY (scope, key)
```

### `picks`, `shows`, `product_aliases`, `meta`
```
picks:          order_id TEXT PRIMARY KEY, picked_at INTEGER
shows:          show_key TEXT PRIMARY KEY, data TEXT (JSON ShowStore entry), updated_at INTEGER
product_aliases: name TEXT PRIMARY KEY, product_id TEXT, created_at INTEGER
meta:           k TEXT PRIMARY KEY, v TEXT     -- 'schema_version', 'legacy_migrated'
```

**Ownership model:** `orders`/`order_items` are a cache — a sync upserts them (existing rows updated, never blindly wiped). `costs`/`transcripts`/`picks`/`shows` are user-owned and join on stable keys, so a re-sync never disturbs them.

---

## 6. Legacy migration & `productId` re-keying

### One-time import
On first launch of the new build, the renderer reads its seven data keys from `localStorage` and sends them to `tt-db:importLegacy`. Main writes them into the tables and sets `meta.legacy_migrated = 1`. The renderer **keeps the old keys as a backup for one release**, then clears them on the following launch (guarded by the migrated flag). Idempotent: re-running the import is a no-op once the flag is set.

### The re-keying problem
`tt-product-cost` and `tt-product-tx` are keyed by **product name** today (because `productId` == name in the current `orderToSale`). Phase 1 changes `productId` to the real `product_id`. Without remapping, those templates would orphan and the user would lose every product-level cost and AI template.

### Chosen approach — best-effort remap + alias fallback
1. Import name-keyed product costs/transcripts **as-is** initially (keyed by name).
2. After the **first enriched sync** populates `order_items` with `(product_name, product_id)`, build a name → `product_id` map.
3. For each name-keyed `costs`/`transcripts` row with scope `product`, if the name resolves to a `product_id`, **re-key** the row to that `product_id` and record `product_aliases(name → product_id)`.
4. Names with **no match** (product not in the current order window) are **left under their name key and an alias is not yet created** — the next sync that surfaces them completes the remap. Nothing is deleted.
5. `getLedgerRows` resolves a product template by `product_id` first, then falls back to a name alias, so templates keep applying throughout the transition.

**Rejected alternatives:** (a) *hard cutover* — re-key immediately and drop unmatched names → silent loss of templates for products outside the current window; (b) *permanent dual-key* — never converge on `product_id`, leaving the merge/split bug partly alive. The chosen approach converges on `product_id` while guaranteeing no loss.

---

## 7. Order enrichment (Phase 1 parsing)

Extend `MappedOrder` and `mapTiktokOrder` (`tiktok-orders.ts`):

- `MappedOrder.items[]` gains: `productId`, `skuId`, `orderLineIds: string[]`, `imageUrl`, `unitPriceCents`, `totalPriceCents` (from `sku_module`).
- `MappedOrder` gains discount/price-breakdown fields: `platformDiscountCents`, `sellerDiscountCents`, `shippingDiscountCents`, `originSaleCents` (exact `price_module` paths verified against the captured fixture during implementation; defensive `?? 0`).
- `orderToSale`: `productId` = `items[0].productId` when present, **fallback to name only when absent**; populate `Sale.productImageUrl`, `Sale.skuId`, and a `priceBreakdown` object. `Sale` already declares `productImageUrl`/`skuId`/`orderStatus`/`liveTag` (`core/types.ts:142-157`) — extend it with the optional `priceBreakdown`.
- `auction_module` from `order/list`: when an order row already carries `auction_video_receipt_url`/`live_room_id`/`video_receipt_timestamp`, read them inline; only call `fetchOrderDetails` (`order/get`) for rows missing the module. Persist `room_id` and `video_receipt_ts` (never the signed URL).
- Add `replacement_order_tag_v1` to `TT_ORDER_EXTRA_DATA`.

**Defensiveness (per the HAR risk notes):** every new field is optional with a fallback; modules vary by status/fulfillment type/region, so absence is normal, not an error.

---

## 8. IPC query surface

`main.ts` registers (all delegating to `db.ts`):

| Channel | In | Out |
|---|---|---|
| `tt-db:getLedger` | — | `LedgerRow[]` (orders ⋈ items ⋈ costs ⋈ transcripts ⋈ picks) |
| `tt-db:setCost` | `{ orderId, cents \| null }` | ok |
| `tt-db:setProductCost` | `{ productId, cents \| null }` | ok |
| `tt-db:setTranscript` | `{ scope, key, transcript }` | ok |
| `tt-db:setPicked` | `{ orderId, picked }` | ok |
| `tt-db:getShows` / `setShows` | — / `ShowStore` | `ShowStore` / ok |
| `tt-db:importLegacy` | the 7 localStorage blobs | `{ imported, migrated }` |

`getLedger` builds `LedgerRow[]` server-side so the renderer keeps consuming the same shape `ledger.ts` already expects (cost resolution = order override ?? product template; transcript = order ?? product).

---

## 9. Data flow

1. `Sync orders` → `tiktokCookieHeader()` → `pullTiktokOrders(cookie)` (enriched parse) → `db.upsertOrders(orders)`.
2. Rows missing `auction_module` → `fetchOrderDetails` → update `room_id`/`video_receipt_ts`.
3. Renderer (on Ledger open / post-sync) → `ipcRenderer.invoke('tt-db:getLedger')` → `LedgerRow[]`.
4. Cost/transcript/pick edits → `tt-db:set*` → renderer re-invokes `getLedger` (or patches locally).
5. `core/ledger.ts` computes KPIs/filters/picklist/CSV from `LedgerRow[]` exactly as today.

---

## 10. Testing strategy

- **Parser (`tiktok-orders.test.ts`)**, fixture-first: capture one sanitized `order/list` response → assert `product_id`, `sku_id`, `order_line_ids`, image, unit/total price, discount breakdown, multi-item rows, and missing-field fallback (no `product_id` → name fallback).
- **DB (`db.test.ts`)** on `:memory:` SQLite: upsert idempotency (re-sync updates, never duplicates, never wipes user tables); `getLedgerRows` join (order override beats product template; transcript order beats product); IDs preserved as TEXT.
- **Migration (`db.test.ts` or `migration.test.ts`)**: import a representative `localStorage` blob → assert all costs/transcripts/orders/shows/picks land; after a simulated enriched sync, assert name-keyed product templates re-key to `product_id` and unmatched names are preserved.
- `npm test` stays green; new tests run without Electron (pure `core/` + `better-sqlite3` against `:memory:`).

---

## 11. Out of scope — the rest of the program

| Phase | Theme | Builds on |
|---|---|---|
| **2 — Fulfillment & Pack/Ship Ops** | `package/list`, `dashboard/get`, `search_count`, `logistic_detail/list`, `shipping/options`; `packages` table; SLA deadlines + urgency buckets; tab/dashboard counters | Phase 0/1 store |
| **3 — Buyer/CRM & Exceptions** | order flags (risk/refund/replacement/insurance, notes), buyer contact links + unread flags (fetched fresh, never stored as signed URLs), exception queue | Phase 1/2 |
| **4 — Live Monitor Telemetry** (parallel) | `pin/get` classification; richer roster/auction-result fields (durations, `actual_start/end`, server-time anchors, payment-grouping completeness); engagement velocity from WS `core_stats` (preferred over decoding `webcast/im/fetch`); auction-lifecycle events | independent of the order store |

Each later phase gets its own spec → plan → implementation cycle.

---

## 12. Risks & mitigations

1. **`better-sqlite3` native ABI** must be rebuilt against Electron 33 (`electron-rebuild` / `@electron/rebuild`). Known gotcha from prior V2 work. Mitigation: add the rebuild to the build/postinstall step and verify `npm run dev` loads the native module before building features on top.
2. **`productId` re-keying** could lose templates if done naively — mitigated by the best-effort-remap + alias-fallback design (§6); covered by a migration test.
3. **Schema drift** — TikTok modules vary by status/region. Mitigation: every new field optional + defensive; fixture-first TDD; the spec's field names yield to the captured fixture.
4. **Signed-URL / PII leakage** — never persist receipt m3u8 URLs, contact links, addresses, or phone numbers. Store only safe anchors (`room_id`, `video_receipt_ts`). Sanitize the committed `order/list` fixture.
5. **One-shot migration correctness** — guard with `meta.legacy_migrated`; keep `localStorage` backup for one release before clearing.

---

## 13. Near-term checklist

- [ ] Capture & sanitize one `order/list` fixture; commit it.
- [ ] Add `better-sqlite3` + Electron ABI rebuild step; verify it loads.
- [ ] `db.ts`: schema + versioned migration + typed accessors.
- [ ] Enrich `mapTiktokOrder`/`MappedOrder`/`orderToSale` (product_id, sku_id, line IDs, image, per-item + breakdown prices); add `replacement_order_tag_v1`.
- [ ] Read `auction_module` from `order/list`; fall back to `order/get` only when missing.
- [ ] IPC query handlers in `main.ts`; wire `Sync orders` → upsert.
- [ ] Renderer: replace the 7 data-key `localStorage` calls with IPC; keep UI-pref keys.
- [ ] `importLegacy` + re-keying; keep backup one release.
- [ ] Tests: parser (enriched fixture), DB join/idempotency, migration + re-key.
