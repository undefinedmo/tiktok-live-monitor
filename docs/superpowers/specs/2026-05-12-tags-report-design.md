# Tags Report — Design Spec

**Date:** 2026-05-12
**Author:** Mo Raad
**Status:** Approved (pending implementation plan)

## Goal

Add a Tags tab to the Reports page that shows P&L per tag with a printable PDF that includes summary totals and per-tag item detail.

## Non-goals

- No standalone "Tags" route in the sidebar. The feature lives inside Reports.
- No compare-mode (vs. previous period) for the Tags tab in v1.
- No treemap visualization for the Tags tab in v1 — table + bar chart only.
- No synthetic "Untagged" pseudo-tag in v1; totals will not reconcile with Overview for items that have no tags. Acceptable trade-off for minimal scope.

## Existing infrastructure reused

- `GET /api/reports/tags` — already returns one row per tag with `items_sold`, `revenue`, `avg_price`, `profit`, `margin_pct`. Filters by date/show/brand via `parseReportFilters`. (`web/src/app/api/reports/tags/route.ts`)
- `useReports` hook — already exposes `tags`, `loadTags`, and the `TagReport` type. (`desktop/src/hooks/useReports.ts:199`, `:407`)
- `DashboardFilterContext.filters.tags` — already supports an array of selected tag names and propagates them to all loaders. (`desktop/src/contexts/DashboardFilterContext.tsx:127`)
- `export-report-pdf` IPC handler — already dispatches per-tab generators through a `generators` record. (`desktop/electron/ipc/export.ts:182`)
- Reports page already imports `tags` and `loadTags` from `useReports` but never renders a tab; this spec closes that gap.

## Architecture

```
Reports tab (Tags)
  ├── /api/reports/tags                  → table + bar chart
  └── tag click → DashboardFilterContext.toggleTag(name)
                  → re-fires all loaders with tags=[name]

PDF export
  Renderer fetches /api/reports/tags AND /api/reports/tags/items (new)
    → ipcRenderer.invoke('export-report-pdf', 'tags', { summary, items, filters })
    → generateTagsPdf(data) writes via pdfkit
    → save dialog
```

The Tags tab participates in the same dashboard filter context as the other tabs, so clicking a tag scopes Brands/Products/Shows/Customers/Pricing/Auctions/Expenses to that tag in addition to the active date range and show/brand selections.

## New API endpoint

### `GET /api/reports/tags/items`

Per-item rows for tag-detail rendering. Same auth, permission, and filter contract as `/api/reports/tags`.

**Path:** `web/src/app/api/reports/tags/items/route.ts`
**Permission:** `reports.view`
**Query params:** Same as `/api/reports/tags` — date range, `showIds`, `brandNames` — via `parseReportFilters`.

**Response:**

```ts
{
  success: true,
  data: Array<{
    tag: string;
    item_id: string;
    title: string;
    brand: string | null;
    gross: number;
    net: number;
    cost: number;
    profit: number;
    order_date: string;  // ISO date
  }>
}
```

**SQL:** Mirror the existing `/api/reports/tags` `tag_items` CTE — same joins, same `NOT_REFUNDED_SQL` and `NOT_GIVEAWAY_SQL` predicates, same `showFilter`/`brandFilter` — but select per-item columns instead of `GROUP BY tag`. Order by `tag ASC, profit DESC`.

**Rationale:** Reusing the existing CTE shape guarantees the per-item rows in the PDF reconcile against the summary table (same item set, same filters, same exclusions).

## Tags tab component

**Path:** `desktop/src/pages/reports/TagsTab.tsx`
**Pattern:** Mirror `BrandsTab.tsx` with treemap and compare-mode branches stripped out.

**Props:**

```ts
interface TagsTabProps {
  tags: TagReport[];
  loading: boolean;
  activeDateLabel: string;
  onExportPdf: () => void;
}
```

**Layout:**

1. `DataTable` with columns: Tag, Items Sold, Revenue, Avg Price, Profit, Margin %. Default sort by Revenue desc.
2. `InteractiveBarChart` showing top 15 tags by revenue.
3. Export PDF button in the tab header (wired to `onExportPdf`).

**Interaction:**

- Clicking a row or bar calls `toggleTag(tag.tag)` on `DashboardFilterContext`.
- Highlighted row state when `filters.tags.includes(tag.tag)`.
- Context menu (right-click) reuses the existing `useChartContextMenu` machinery but only exposes "Copy value" — no per-tag drill modal in v1.

Add re-export to `desktop/src/pages/reports/index.ts`.

## Reports page integration

`desktop/src/pages/Reports.tsx`:

1. Add `'tags'` to the `TabId` union.
2. Add `{ id: 'tags', label: 'Tags', icon: <Tag className="w-4 h-4" /> }` to the `tabs` array. Import `Tag` from `lucide-react`.
3. In the tab-effect that already exists for loading data per active tab, add a `case 'tags':` that calls `loadTags(reportParams)`.
4. Render `<TagsTab tags={tags} loading={loading} activeDateLabel={activeDateLabel} onExportPdf={handleTagsPdfExport} />` when `activeTab === 'tags'`.
5. Add `handleTagsPdfExport` (see PDF section below).

## PDF generation

**Renderer side** (`Reports.tsx` or a small helper in `desktop/src/pages/reports/`):

```ts
async function handleTagsPdfExport() {
  const summary = tags; // already loaded
  const itemsResp = await apiClient.get<{ success: boolean; data: TagItemRow[] }>(
    '/api/reports/tags/items',
    reportParamsToQuery(currentParams),
  );
  if (!itemsResp.success) {
    showToast('Failed to load tag items for PDF', 'error');
    return;
  }
  await window.exportAPI.reportToPdf('tags', {
    summary,
    items: itemsResp.data,
    filters: { startDate, endDate, showIds, brandNames, tags: filters.tags },
  });
}
```

**Main process** — new file `desktop/electron/services/pdf-generators/tags.ts`:

```ts
export interface TagsPdfData {
  summary: Array<{
    tag: string;
    items_sold: number;
    revenue: number;
    avg_price: number;
    profit: number;
    margin_pct: number;
  }>;
  items: Array<{
    tag: string;
    item_id: string;
    title: string;
    brand: string | null;
    gross: number;
    net: number;
    cost: number;
    profit: number;
    order_date: string;
  }>;
  filters: {
    startDate?: string;
    endDate?: string;
    showIds?: string[];
    brandNames?: string[];
    tags?: string[];
  };
}

export async function generateTagsPdf(data: TagsPdfData): Promise<string>;
```

**PDF layout:**

1. Title block: "Tags Report" + date range + any active show/brand/tag filters.
2. Summary table — same six columns as the on-screen table, plus a totals row.
3. For each tag (ordered by profit desc), a level-2 heading and a per-item table with columns: Order Date, Item, Brand, Gross, Net, Cost, Profit. Page break before each tag heading when remaining space is < ~150pt.
4. Footer: generated timestamp + page numbers.

**IPC wiring** (`desktop/electron/ipc/export.ts`):

- Import `generateTagsPdf` from the new file.
- Add `tags: (data) => generateTagsPdf(data as unknown as TagsPdfData)` to the `generators` map.
- Add `tags: 'Tags Report'` (or similar) to the `titleMap`.

## Testing

**API test:** `web/tests/api/reports/tags-items.test.ts` (new directory). Covers:

- Returns rows for items with tags inside the date range.
- Excludes refunded items.
- Excludes giveaway items.
- Honors `showIds` filter (item outside the show is omitted).
- Honors `brandNames` filter.
- Returns empty array when no items match.

Follow the existing receipts/inbox test setup pattern (`web/tests/api/receipts/inbox/list.test.ts` is the closest analogue for a `GET` route with filters).

**Manual smoke test (Tags tab):**

1. Open Reports → Tags. Confirm summary table + bar chart render and totals match the figures shown on the Overview tab for the same date range, modulo untagged items.
2. Click a tag. Confirm the breadcrumb chip appears and Brands/Products/Shows tabs filter to that tag.
3. Click the same tag again. Confirm the filter clears across tabs.
4. Click "Export PDF". Confirm the save dialog opens, save, open the PDF. Check:
   - Date range and active filters appear in the header.
   - Summary table matches the on-screen table.
   - At least one tag has a non-empty item list under it.
   - Totals row sums match summary.

## Risks and open questions

- **Pagination:** Per-tag item lists could be large if a tag is applied to thousands of items. v1 returns all rows. If reports get slow we can add a server-side `limit` per tag or a "top N per tag" mode later.
- **Tag name casing:** Existing CSV-era tags were lowercased; new `Tag.name` rows preserve user input. The summary endpoint groups by `t.name` as-stored, so two tags differing only in case will appear as separate rows. Out of scope here, but worth a follow-up if the user wants case-insensitive grouping.

## Files changed (summary)

**New:**
- `web/src/app/api/reports/tags/items/route.ts`
- `web/tests/api/reports/tags-items.test.ts`
- `desktop/src/pages/reports/TagsTab.tsx`
- `desktop/electron/services/pdf-generators/tags.ts`

**Modified:**
- `desktop/src/pages/Reports.tsx` — tab registration, tab-effect, render branch, export handler
- `desktop/src/pages/reports/index.ts` — re-export `TagsTab`
- `desktop/electron/ipc/export.ts` — register `tags` generator and title
