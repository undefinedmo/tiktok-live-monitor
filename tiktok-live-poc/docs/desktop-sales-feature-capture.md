# Desktop "Sales" (Transactions) Screen — Full Feature Capture

Reference inventory of the desktop app's Sales screen, captured 2026-06-23 for porting/parity work.
Source: `sellerfolio-platform/desktop` (its own git repo).

**Files**
- `src/pages/Sales.tsx` (~3074 lines) — the screen
- `src/hooks/useSales.ts` (~523 lines) — data + mutations
- `src/components/sales/SalesFilterBar.tsx` (~268) — filter toolbar
- `src/components/sales/MassEditModal.tsx` (~248) — bulk field editor
- `src/components/sales/CreateRuleModal.tsx` (~202) — automation-rule builder
- `src/components/sales/SalesActiveFilters.tsx` (~108) — active-filter chips
- `src/components/sales/BrandCleanupModal.tsx` (~94) — brand normalization
- `src/components/sales/SalesSummaryTiles.tsx` (~30) — KPI tiles

Architecture: all data is fetched client-side (single request, `limit: 5000`) and filtered/sorted/aggregated in memory. Mutations go through `useSales` (optimistic local update + REST). Native features (transcription, video clip, export, login) go through Electron IPC (`window.whatnotAPI`, `window.exportAPI`, `window.settingsAPI`).

---

## 1. Data model — `SalesItem` (`useSales.ts:6–43`)
`id`, `order_id`, `show_id`, `show_title`, `item_title`, `listing_number`, `order_date`, `earnings_status` (raw), `quantity`, `gross_amount`, `net_earnings`, `buyer`, `video_url`, `video_seek_seconds`, `video_seek_formatted`, `seek_time_source` (`'order'`=approximate), `stream_id`, `transcript`, `ai_brand`, `ai_item`, `ai_color`, `ai_size`, `ai_msrp`, `ai_msrp_source`, `ai_status` (`pending|done|error|video_expired`), `ai_raw`, `cost`, `profit` (server-computed), `flag` (`research|review|restock|note|needs_review`), `tags[] {id,name}`, `is_giveaway` (legacy), `is_buy_it_now`, `sale_type`, `classification` (`sale|giveaway|sample|adjustment|excluded` — supersedes `is_giveaway`), `rule_id`, `consignment_id`, `split_override_percent`, `consignor_payout`.
- Postgres returns strings → all numerics coerced `Number(x)||0` in `parseItem` (`useSales.ts:200–213`).

## 2. Table columns (`Sales.tsx:2004–2360`)
1. **Select** — tri-state header checkbox (all/none/indeterminate); per-row checkbox (`stopPropagation`).
2. **Title** (sortable, 360px) — listing title + "show • buyer" subtitle. Inline prefix badges: `[G]` giveaway (amber), `[BIN]` Buy-It-Now (green), `#NNN` auction number (accent, regex-stripped from tail). Shows spinner + "Transcribing…" while that item transcribes; warning ring for 1800ms when jumped-to via quick search.
3. **Seek** (sortable, 80px) — `M:SS`/`H:MM:SS`. Accurate=accent; approximate (`seek_time_source==='order'`)=amber with `~` + tooltip.
4. **Brand** (sortable, 120px) — **inline-editable** (dbl-click; Enter/blur commit, Esc cancel). "Pending" when blank.
5. **AI Product Info** (sortable) — `ai_item` + `color • size` subtitle. Read-only.
6. **Status** (sortable, 80px) — badge via `deriveEarningsLabel()`: strips "Earnings " prefix, maps Completed→Paid / Processing→Pending / Cancelled→Canceled; infers Paid when status null but net>0. Colors: Paid=green, Pending=amber, Refunded/Canceled=red, Giveaway=accent, else neutral.
7. **MSRP** (sortable, 90px, mono) — **inline-editable**; strips `$,` before parseFloat.
8. **Gross** (sortable, 80px, mono) — `formatCurrency`. Read-only.
9. **Net** (sortable, 80px, mono, green) — read-only.
10. **Cost** (sortable, 90px, mono) — **inline-editable**; amber dash when missing. While editing shows a **"Previous Costs"** popover of historical costs for the same brand+product (`getCostSuggestions`), each with usage count; click fills+commits.

**Row styling** (`Sales.tsx:2674–2710`): selected (indigo L-border), highlighted-duplicate (amber), flag tints (research=red, review=yellow, restock=green, note=blue), giveaway=`opacity-70`, cancelled/refunded=`opacity-50 line-through`, transcribing=`animate-pulse`.

Column show/hide/reorder/resize + sort direction are delegated to the shared `DataTable` component (single-column sort; not in Sales.tsx).

## 3. Filtering & search
- **Quick search** (`Ctrl/Cmd+K`) — client filter over title/brand/ai_item/buyer/order_id/listing_number. Dropdown shows up to 8 matches; click adds to selection + smooth-scrolls + 1800ms highlight. Enter commits, Esc clears. (`Sales.tsx:665–733, 685–696`)
- **Health pills** (toolbar) — "Cost / Brand / MSRP" missing-data quick filters, single-active, with live counts (AlertTriangle vs CheckCircle). (`Sales.tsx:2458–2493`)
- **Filter bar** (`SalesFilterBar`) — Brand multi-select (searchable, per-brand counts, Select-All/Clear), Earnings Status, Tag, Deal/Consignment (grouped by consignor, active only, `__none__`=personal), MSRP min/max (inclusive; null msrp→0), Exclude Giveaways toggle, Buy-It-Now segmented (`all/exclude/only`). Active-filter count badge on the filter button.
- **Active filter chips** (`SalesActiveFilters`) — one dismissible chip per active filter + Clear All; renders `null` when none.
- All filters AND together, applied in sequence (`Sales.tsx:718–807`). **No saved/preset filters; all filter state is ephemeral React state (resets on navigation).**

## 4. Summary tiles (`SalesSummaryTiles`, computed `Sales.tsx:826–844` over ALL loaded items)
Orders (non-excluded count), Giveaways (excluded count), Gross (Σ gross), Net (Σ net, green), Fees % (`(gross-net)/gross`, amber). The page also computes Missing Cost / Missing Brand / Missing MSRP / Flagged counts (used by health pills + stats).

## 5. Selection
Single (row click) + multi (checkboxes); header selects all *filtered*; `selectedItems` Set keyed by id persists across virtual pages (all ≤5000 loaded). Context-menu helpers replace selection: All-from-Buyer / All-Same-Brand / All-from-Show / Highlight-Duplicates. Floating selection bar shows count; "M of N selected" by search.

## 6. Bulk / mass actions (floating selection bar, `Sales.tsx:2715–2893`)
- **Actions ▾**: Mark as Giveaway, Add Tag (prompt; find-or-create → `/api/items/bulk-tag` add), Remove Tag, Clear All Tags, Clear Cost.
- **Flag ▾**: Research/Review/Restock/Note/Clear → `updateItem` per id (`Promise.all`).
- **Assign to deal ▾**: active consignments + "— Unassign —" (`__unassign__`→null).
- **Edit** → Mass Edit Modal (pre-fills shared consignment).
- **Rule** → Create Rule Modal (needs ≥2 selected; auto-detects brand/title-word patterns).
- **Cost ▾** → apply/manage Cost Templates (popover) via `bulkPatchItems`; percent/minus skip no-MSRP items (counted).
- **Delete** → confirm modal → `/api/items/bulk`, optimistic removal.

## 7. Inline editing (`Sales.tsx:419–461`)
Brand / MSRP / Cost via dbl-click. Enter/blur commit, Esc cancel. MSRP/Cost strip `$,`; non-finite→null. Cost edit triggers the Previous-Costs suggestion popover. Optimistic update + toast.

## 8. AI / automation
- **Transcription (Gemini via IPC)** — "Process" button + scope (`All`/`Selected`); batches of 10 concurrent; writes transcript + ai_brand/item/color/size/msrp/ai_status per item; brand hints = all known brands. Progress bar with Pause (stops new batches). Error buckets: expired URL / past-recording-end / other. (`Sales.tsx:1334–1456`)
- **Single / Re-transcribe / Reset AI Data** — context menu (retranscribe clears AI fields first; reset clears AI fields but keeps transcript). (`Sales.tsx:1459–1644`)
- **Rules engine** — `CreateRuleModal`: name, action (`set_brand`/`map_product`/`exclude`), action value, choose detected conditions (brand= / title-contains, `operator:'contains'`, `logicType:'AND'`), "Apply Immediately" (runs `runOnTransactions` on selection). Items store `rule_id`/`classification`. (`Sales.tsx:464–581`)
- **Brand cleanup** (`BrandCleanupModal`) — `/api/brands/variations` finds case/spacing variants; per-group "Fix" (`mergeBrands`) or "Auto-Fix All" (`/api/brands/auto-fix`); local items patched to canonical, then reload. (`Sales.tsx:1100–1128`)
- **Cost suggestions / memory** — `/api/items/cost-suggestions` by brand+item with usage counts, surfaced in the cost-edit popover.
- **Seek enrichment** — Recalc Seek (`/api/items/recalculate-seek`, selection or all shows), per-item Recalc (context menu), and a TEMP "Enrich Seeks" (`/api/shows/:id/enrich-seeks` from `live_auctions`, marked "remove once v2 has its own live monitor").

## 9. Modals
- **Mass Edit** — enable-checkbox-gated fields: Brand (datalist), MSRP, Cost (Fixed-$ / %-of-MSRP toggle; % uses new-or-existing MSRP, skips no-MSRP), Add Tag (datalist, find-or-create), Assign Deal (`undefined`=untouched vs `null`=unassign sentinel). Apply disabled when nothing enabled. (`MassEditModal.tsx`)
- **Create Rule** — see Rules engine. canSave = name + ≥1 pattern. (`CreateRuleModal.tsx`)
- **Brand Cleanup** — variation groups → canonical; empty state "brands are clean"; Auto-Fix All. (`BrandCleanupModal.tsx`)
- **Transcript** — full transcript, Copy to clipboard. (`Sales.tsx:3001–3059`)
- **Cache** — on Fetch when DB already has items: Load from Cache / Refresh from Whatnot / Cancel (promise-gated). (`Sales.tsx:1130–1148, 2896–2926`)
- **Delete confirm** — "Delete N Items?" irreversibility warning.

## 10. Export (`Sales.tsx:1796–1840`)
"Excel" button → `window.exportAPI.dataToExcel` of the **filtered** rows. Columns: id, order_id, show_id, show_title, item_title, buyer, earnings_status, gross, net, ai_brand, ai_item, ai_color, ai_size, ai_msrp, cost, tags(joined), flag. Filename `sales-export-YYYY-MM-DD.xlsx`. No import. Clipboard copy of title/buyer/transcript via context menu.

## 11. Fetch / sync / video (`Sales.tsx:1194–1332`)
Fetch: cache check → Whatnot connection (`openLogin` + cookie register if needed) → `/api/sync/trigger` (orders) polled every 2s≤60s → refresh presigned video URLs per show (`refreshVideoUrls`, parallel, skips ai_status reset for done+transcribed) → reload. Specific toasts for `VIDEO_EXPIRED` / `FFMPEG_NOT_FOUND` / `AUTH_REQUIRED`. Preview Video → `getVideoClip` opens in system player (auto-refreshes URL once on expiry).

## 12. Flags (`useSales.ts:342–350`)
`research/review/restock/note`. `cycleFlag` cycles none→research→review→restock→note→none (hook fn). Context menu sets specific/clear; bulk via Flag ▾; row tint per flag; "Flagged" KPI.

## 13. Persistence
- **Persists** (Electron `electron-store`): Cost Templates (defaults "50% of MSRP", "40% of MSRP", "Flat $5"). (`Sales.tsx:265–292`)
- **Ephemeral** (resets on nav): all filters, search, health filter, selection, duplicate highlight, modal/edit state.
- **Per-show load**: requires ≥1 show selected (`useShows`); reloads on show-selection change; empty state otherwise.

## 14. Keyboard / context menu / links / states
- Keyboard: `Ctrl/Cmd+K` search; Enter/Esc in search & inline edits.
- Right-click row → context menu: View Transcript, Preview Video, Transcribe ▸ (Transcribe/Retranscribe), Reset AI Data, Refresh Video Links (Show), Recalc Seek, Copy ▸ (Title/Buyer/Transcript), Select ▸ (Buyer/Brand/Show/Highlight Dupes), Flag ▸, Open on Whatnot (`whatnot.com/orders/{id}`), Delete. Many disabled when no video / `video_expired` / no transcript / no brand. (`Sales.tsx:1601–1728`)
- States: No-Shows-Selected (full-page TV icon), loading (DataTable skeleton + pulsing Fetch icon), error banner (danger), empty table ("No sales data found…"), processing card (progress + Pause).

## 15. Formatting
`formatCurrency` (`@sellerfolio/shared/utils`) for money; seek `H:MM:SS`/`M:SS`; export date `YYYY-MM-DD`; cost/MSRP parse strips `$,`.

---

### Gaps / notes for parity
- Sorting/column-management lives in shared `DataTable` (not Sales-specific).
- No saved filter presets; no import; no in-row expansion (details via modals).
- "Enrich Seeks" is explicitly temporary pending a v2 live monitor — relevant to the TikTok PoC's own live capture.
