# TikTok Label Capture + Picklist Revamp — Design

**Date:** 2026-06-24
**Target:** `tiktok-live-poc` (Electron + TypeScript, SQLite). PoC-first; no changes to the shared Postgres model or v1/v2 apps.
**Status:** Design approved, pending spec review.

---

## 1. Goal and non-goals

**Goal.** Make shipping-label fulfillment fully automatic inside the PoC. Today the seller manually exports a "To-Ship" CSV, bulk-prints labels to a merged PDF, and uploads both to the standalone `tiktok-label-restack` web app to get reordered labels + a packing sheet. This feature eliminates both uploads: the PoC already holds the order data, captures the label PDF passively, ties each label to its order record, and surfaces the result as an interactive **Picklist** screen plus the same two printable PDFs.

**Specifically:**
1. Passively capture the batch label PDF (and the request that maps pages to orders) when the seller prints in the TikTok dashboard.
2. Tie each label page to the order record we already hold.
3. Reorder labels **newest purchase first, grouped by buyer** and produce a matching packing sheet — the validated `tiktok-label-restack` logic, ported to TypeScript, in-process.
4. Present an interactive picklist console (pick/pack check-off, per-order label view) and export the two PDFs.

**Non-goals.**
- No changes to the shared Postgres schema, the desktop/web Whatnot picklist screens, or `sellerfolio-live-v2`.
- No active/automated triggering of `shipping_doc/generate` from the PoC (capture is passive; the seller still clicks Print in TikTok).
- No accounts, no cloud, no third-party network calls beyond fetching the seller's own pre-signed label PDF.
- OCR is not in scope; barcode decode (when used) is the only fallback to the generate-order tie.

---

## 2. Background: the captured flow (verified)

When the seller selects orders in the To-Ship tab and prints shipping labels, the TikTok dashboard fires (on `seller-us.tiktok.com`):

1. `POST /api/fulfillment/na/order/batch_action/verify`
2. `POST /api/fulfillment/na/order/batch_action/filter_order`
3. `GET  /api/v1/fulfillment/seller_print_setting/na/get`
4. `POST /api/v1/fulfillment/na/doc/print_status/verify` — response maps `fulfill_unit_id` → `main_order_ids[]` (the only place this explicit map appears; one unit can carry several main orders = a combined shipment)
5. **`POST /api/v1/fulfillment/na/shipping_doc/generate`** — the pivotal call.

`generate` request body (abridged):
```json
{ "op_scene": 2,
  "fulfill_unit_id_list": ["1156730386024534712", "...65 ids in print order"],
  "file_prefix": "Shipping label", "content_type_list": [1],
  "template_type": 3, "print_option": {"tmpl":0,"template_size":3,"layout":[1]},
  "print_source": 202 }
```

`generate` response:
```json
{ "code": 0, "data": {
    "doc_url": "https://seller-us.tiktok.com/wsos_v2/.../object/wsos...?expire=...&skipCookie=true&timeStamp=...&sign=...",
    "stats": [ { "order_id": "1156730386024534712", "detail_list": [ { "content_type": 1, "status": 0 } ] }, ... ] } }
```

> **Note on `stats[].order_id`:** verified against the real response, this value equals the **`fulfill_unit_id`** (the `1156…` series), in the same order as the request `fulfill_unit_id_list` — it confirms page/unit alignment but is **not** the main order id. The `fulfill_unit_id → main_order_ids[]` map comes from `print_status/verify`, or (preferred) from our own `orders.fulfill_unit_id`.

**Verified facts** (from the captured HAR, `seller-us.tiktok.com-613-shipping_labels.har`):
- `doc_url` is a **single merged PDF** for all selected units (65 units → one PDF in the sample).
- The PDF is **pre-signed and cookie-less**: a plain GET with a browser UA returned `HTTP 206`, `Content-Type: application/pdf`, `Content-Disposition: filename="06-24_08-36-22_Shipping label.pdf"`, full size ~4.7 MB, body starting `%PDF-1.7`. No session cookie required.
- TTL is **24h** (`expire − timeStamp = 86400s`). The final PDF GET does **not** appear in the dashboard's own network log because it opens as a new-tab navigation — so we must fetch `doc_url` ourselves.
- `content_type_list: [1]` = shipping label. (`2`/`3` = packing slip / picking list, per `print_status` keys; out of scope here.)

---

## 3. Architecture and data flow

```
TikTok dashboard (monitor webview)        Electron main process            Viewer window (renderer)
┌─────────────────────────────┐           ┌──────────────────────────┐     ┌─────────────────────────┐
│ Seller clicks Print → labels │  preload  │  capture req + resp:      │     │   PICKLIST SCREEN        │
│  POST shipping_doc/generate ─┼─ fetch ──▶ │   • fulfill_unit order    │     │   • orders in restack    │
│   (ordered fulfill_unit_id)  │  hook     │   • doc_url, stats[]       │     │     order (newest→old,   │
│  resp { doc_url, stats[] }   │           │                          │     │     grouped by buyer)    │
└─────────────────────────────┘           │  net.fetch(doc_url)        │     │   • per-order label view │
                                           │   → merged labels.pdf      │     │   • pick / pack check    │
   captured earlier (existing):            │                          │─IPC▶│   • Export reordered PDF │
   order/list + order/get  ───────────────▶│  RESTACK PIPELINE (TS):    │     │     + packing sheet      │
   (buyer, items/SKU, placedAt,            │   tie → sort → split →     │     │   • Clear labels (purge) │
    tracking, fulfillUnitId)               │   reordered PDF + sheet    │     └─────────────────────────┘
                                           │         ↓ SQLite           │
                                           │  label_batch / label_page  │
                                           └──────────────────────────┘
```

**End-to-end:**
1. **Capture.** The existing `preload.ts` fetch/XHR wrapper gains a matcher for `…/shipping_doc/generate`. On a hit it forwards `{ url, requestBody, responseText }` to main over a new `tt-label-batch` IPC channel (same shape/pattern as `tt-rest-data`).
2. **Download.** `main.ts` (`ipcMain.on('tt-label-batch')`) parses the request/response and immediately fetches `doc_url` with `net.fetch` (cookie-less, pre-signed). The merged PDF is written to `capture/labels/<batch_id>.pdf`.
3. **Tie.** Each PDF page → `fulfill_unit_id` (by generate-order index, cross-checked against `stats[i].order_id`) → our order records via `orders.fulfill_unit_id` (a combined shipment fans out to several orders). The captured `print_status/verify` map is stored as a secondary source for when an order has not been synced yet. Barcode decode is verification/fallback, not the hot path (see §4).
4. **Restack.** Ported `sortlogic` computes the sequence (newest-first, grouped by buyer) from order data already in SQLite.
5. **Outputs.** `pdf-lib` builds the reordered-labels PDF (pages copied in sequence) and the packing-sheet PDF.
6. **Screen.** The picklist renderer shows the sequence interactively and drives exports.

---

## 4. The tie mechanism (heart of "tie labels to the record")

| Path | How | Role |
|---|---|---|
| **Generate-order (primary)** | request `fulfill_unit_id_list[i]` ↔ PDF page `i` ↔ `stats[i].order_id` (== the unit id, confirms alignment) → `orders.fulfill_unit_id` → order record(s) | Deterministic, exact, no rasterization. Used when `page_count == unit_count`. Fans out for combined shipments. |
| **Barcode decode (fallback/verify)** | rasterize page → Code 128 → tracking digits → match `orders.tracking_no` (substring of normalized digits, per restack §9) | Confirms the index tie; **takes over** when `page_count ≠ unit_count` (multi-page labels) or when a PDF was captured without its `generate` request. |

> **Spike #1 (first task in the plan).** Against the real 4.7 MB sample PDF, confirm: `page_count == 65`, exactly one barcode per page, and page order == request `fulfill_unit_id_list` order. If true, the generate-order path is primary and barcode decode is pure verification. If false, barcode decode is primary — which is exactly what `tiktok-label-restack` does today, so we are never worse off than the current tool. The spike's outcome decides whether `label-decode.ts` is on the critical path.

Matching rule for the barcode path is reused verbatim from restack: USPS Impb barcodes decode to a longer digit string than the human-readable tracking number, so match by **substring containment of normalized digits**, and never assign one page to two orders.

---

## 5. Data model and storage

**Reused tables:** `orders` (PK `order_id` = main order id), `order_items` (SKU/bin source), `picks` (pick check-off).

**Additive migration (bump `schema_version` → 2):**
- Add columns `fulfill_unit_id TEXT` and `tracking_no TEXT` to `orders` (currently only inside `sale_json`), with an index on `fulfill_unit_id`, so the tie is a clean indexed join. Backfill from `sale_json` on migration.
- Add nullable `packed_at INTEGER` to `picks` so the console tracks pick **and** pack without a new table.
- All `ALTER TABLE`s guarded by a `PRAGMA table_info` check (the schema uses `CREATE TABLE IF NOT EXISTS`, not destructive migrations).

**New tables:**
```sql
CREATE TABLE IF NOT EXISTS label_batch (
  id            TEXT PRIMARY KEY,   -- generate request_time or uuid
  captured_at   INTEGER,
  room_id       TEXT,               -- show association (from referer / orders)
  doc_url       TEXT,               -- pre-signed source (expires ~24h)
  pdf_path      TEXT,               -- on-disk merged PDF
  page_count    INTEGER,
  unit_count    INTEGER,            -- from fulfill_unit_id_list
  request_json  TEXT,               -- ordered fulfill_unit_id_list (page-order source)
  stats_json    TEXT,               -- generate stats[] (unit-id list; confirms count/order) + print_status/verify unit->main_order_ids map if captured
  status        TEXT                -- captured | tied | exported | error
);
CREATE TABLE IF NOT EXISTS label_page (
  batch_id        TEXT,
  page_index      INTEGER,
  fulfill_unit_id TEXT,            -- authoritative tie key (joins orders.fulfill_unit_id)
  order_id        TEXT,             -- resolved primary order for the 1:1 case (FK orders.order_id), nullable
  tracking_decoded TEXT,           -- null unless barcode verify ran
  match_method    TEXT,            -- generate-order | barcode | unmatched
  PRIMARY KEY (batch_id, page_index)
);
```

**Tie resolution.** The authoritative key on each page is `fulfill_unit_id` (from `fulfill_unit_id_list[page_index]`). The order(s) for a page are resolved by joining `orders.fulfill_unit_id` — a **combined shipment** (one unit → several `main_order_ids`) naturally returns multiple orders for the one page, so the page-to-order relation is one-to-many via the join rather than a single `order_id` column. `label_page.order_id` caches the resolved order for the common 1:1 case; `match_method` records how the tie was made.

**Storage and PII.** The merged label PDF contains buyer **addresses**, which this codebase otherwise never persists (`stripForStorage` removes addresses from `sale_json`). The console needs the PDF available to view/print per-order until shipping, so pure-ephemeral handling (as in restack) does not fit. Decision:
- Store under `capture/labels/<batch_id>.pdf`.
- **Never** include label PDFs or `label_page`/`label_batch` rows in any sync/snapshot/export of order data.
- Provide a visible **"Clear labels"** purge (deletes PDFs + label rows).
- Optional auto-expire of label PDFs (default 7 days) on app start.

---

## 6. Modules

Mirrors restack's separation of pure logic from I/O.

| Module | Role | Pure |
|---|---|---|
| `src/core/restack/sortlogic.ts` | Faithful port of `sortlogic.py`, preserving its exact ordering and determinism: buyers sorted newest-first by their oldest order; within a buyer, orders oldest-first; time ties broken exactly as the current app does (single reverse sort on `(sort_key, name)` → name descending on ties). Re-specifying tie-break direction is avoided so behavior cannot diverge from the validated tool. | ✅ |
| `src/core/restack/bins.ts` | Bin derivation: `A` if product name contains "Bin A", `B` if "Bin B", else `?` | ✅ |
| `src/electron/labels.ts` | Capture handler: parse generate req/resp, `net.fetch(doc_url)`, tie pages→orders, write `label_batch`/`label_page`, emit `label-batch-ready` | I/O |
| `src/electron/label-pdf.ts` | `pdf-lib`: reorder pages → labels PDF; build packing-sheet PDF; extract one page for view | I/O |
| `src/electron/label-decode.ts` | **Optional**, gated by Spike #1: rasterize (pdfium/pdf.js) + `zxing-wasm` decode + substring match | I/O |

**Wiring:** `preload.ts` adds the `generate` matcher → `tt-label-batch`; `main.ts` adds `ipcMain.on('tt-label-batch')`. New IPC for the renderer: `label-batches:list`, `label-batch:get`, `label-page:pdf` (extract a page), `label:export` (`labels` | `sheet`), `label:clear`, plus `pick:set` / `pack:set` (extend existing pick IPC).

**Dependencies added:** `pdf-lib` (reorder + sheet). The barcode path adds a rasterizer + `zxing-wasm` **only if** Spike #1 requires it; kept behind `label-decode.ts` so the hot path stays lean.

---

## 7. The picklist screen

A new view in the viewer window, alongside the ledger — the interactive form of the restack outputs.

- **List** — orders in restack sequence, **grouped by buyer, newest-first**. Each row: buyer, purchase time, items as `SKU (Bin X)`, label status (tied / printed), **pick** + **pack** checkboxes, **View label** (extracts the tied page from the merged PDF and shows it).
- **Multi-item orders** highlighted so packers don't miss pieces (mirrors the restack sheet's colored cell).
- **Warnings panel** — unmatched pages, missing bins (`?`), page/unit count mismatch — surfaced and **non-blocking** (restack §11 behavior). Nothing is silently dropped.
- **Actions** — `Export reordered labels`, `Export packing sheet`, `Clear labels` (PII purge), and a **batch selector** when more than one print batch was captured.
- **State** — pick/pack check-off persists to `picks` (`picked_at` / `packed_at`); survives restart.
- **Look** — consistent with the existing viewer styling, leaning into the dense, aligned, operator-console feel of the restack design direction. Not a focus of this spec.

---

## 8. Packing sheet contents

One row per order in restack sequence (port of restack §11): columns `#`, `Buyer`, `Purchased` (`%-I:%M %p`), `Items (SKU / Bin)`, `Pick`. Multi-item rows visually flagged. Built with `pdf-lib`; header repeats across pages.

---

## 9. Error handling and edge cases

A bad batch never crashes capture or affects the live monitor/ledger; it lands as `label_batch.status = error` with a human-readable reason shown in the warnings panel.

| Case | Handling |
|---|---|
| `doc_url` expired (>24h) | We download immediately at capture, so normally moot. If the PDF was never saved and the URL is dead → `status=error`, panel: "labels expired — re-print in TikTok." If the PDF is already on disk, no re-fetch needed. |
| `page_count ≠ unit_count` (multi-page labels) | Generate-order index tie breaks → fall back to barcode decode. If decode also can't resolve a page → that page becomes a warning. |
| `generate` request not captured (printed before monitoring, or PDF only) | No `request_json` → barcode decode becomes primary (full restack parity). Optional **manual PDF-import** hatch covers this case only. |
| Split/combined units (1 unit → N orders) | Expected. One page tied to all N `main_order_ids`; packing sheet groups them as one package. |
| Order referenced by a label but not yet synced | Store `label_page` with `order_id = null` + flag; re-tie on the next order sync. |
| Corrupt/partial PDF | Validate `%PDF-` magic + `page_count > 0`; retry the fetch once; else `status=error`. |
| Unmatched pages / orders, missing bins (`?`) | Surfaced in the warnings panel, never dropped. |

---

## 10. Testing and acceptance

**Unit (pure):**
- `sortlogic`: buyer positioned by their **oldest** order; buyer block stays contiguous; ties resolve **deterministically** (same input → byte-identical sequence across runs).
- `bins`: A / B / `?` derivation.
- tie resolver: generate-order index → orders; split/combined fan-out; unmatched on both sides reported; (barcode path) Impb-prefixed digit string still matches the shorter tracking via substring, and no page is assigned twice.

**Integration (real fixtures):** use the captured HAR's `generate` request/response + the 4.7 MB sample PDF →
- assert each page ties to the expected order;
- reordered-labels PDF page count == number of matched orders, in restack sequence;
- packing-sheet row count matches;
- an injected count-mismatch fixture produces warnings and still returns artifacts.

**Spike #1 test:** sample PDF `page_count == 65`, one barcode per page, page order == request order.

**Acceptance checklist:**
- [ ] Spike #1 resolved; primary tie path chosen and recorded in `match_method`.
- [ ] Re-running the same captured batch yields byte-stable ordering (determinism).
- [ ] Capturing a print in the dashboard auto-produces a tied batch with no manual upload.
- [ ] Per-order "View label" shows the correct page for the order.
- [ ] Export produces a reordered labels PDF + packing sheet matching the on-screen sequence.
- [ ] "Clear labels" removes all label PDFs and label rows; label data never appears in any order-data sync/snapshot.
- [ ] A corrupt / expired / request-less capture degrades to a clear status, not a crash.

---

## 11. Build order (for the implementation plan)

1. **Spike #1** — verify the sample PDF page/unit/order alignment; decide primary tie path.
2. `sortlogic.ts` + tests; `bins.ts` + tests (pure, green first).
3. Schema migration (v2): `orders` columns + backfill, `picks.packed_at`, `label_batch`/`label_page`.
4. `labels.ts` capture handler + `preload`/`main` wiring; tie resolver + tests against fixtures.
5. `label-pdf.ts`: reorder + packing sheet; integration test against the sample PDF.
6. `label-decode.ts` only if Spike #1 requires it.
7. Picklist renderer: list, per-order view, pick/pack, exports, warnings, clear.
8. Acceptance checklist pass.

Implement the generate-order happy path end-to-end before the barcode fallback. Keep `sortlogic`/`bins` pure — correctness lives there and is testable without Electron.
