# Tags Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tags tab to the Reports page that shows P&L per tag and prints a PDF with summary + per-tag item detail.

**Architecture:** A new GET endpoint (`/api/reports/tags/items`) returns one row per (tag, item) for the active filters. The new `TagsTab.tsx` mirrors `BrandsTab.tsx` minus treemap and compare-mode. PDF generation reuses the existing `generateTabPdf` primitive — the renderer builds a `tables` array containing one summary table plus one table per tag with non-empty sales.

**Tech Stack:** Next.js 16 App Router · Prisma 7 raw SQL · React 19 · pdfkit · Vitest

**Design spec:** `docs/superpowers/specs/2026-05-12-tags-report-design.md`

---

## File Structure

**New files:**
- `web/src/app/api/reports/tags/items/route.ts` — GET endpoint, per-item rows grouped by tag
- `web/tests/api/reports/tags-items.test.ts` — integration tests for the endpoint
- `desktop/src/pages/reports/TagsTab.tsx` — table + bar chart + export button

**Modified files:**
- `desktop/src/contexts/DashboardFilterContext.tsx` — add `toggleTag(name)` if it doesn't already exist (verify in Task 4)
- `desktop/src/pages/Reports.tsx` — register tab, load data, render branch, PDF handler
- `desktop/src/pages/reports/index.ts` — re-export `TagsTab`
- `desktop/electron/ipc/export.ts` — register `tags` in generators + titleMap

---

## Task 1: API endpoint `/api/reports/tags/items` — failing test

**Files:**
- Test: `web/tests/api/reports/tags-items.test.ts`

The test uses the same `vi.mock('@/lib/tenant', …)` shape as `web/tests/api/inventory/inventory.test.ts`. Data is seeded directly via Prisma — there's no existing item factory, so we'll inline what we need.

- [ ] **Step 1: Create the test file**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const ctxHolder: { tenantId: string } = { tenantId: '' };

vi.mock('@/lib/tenant', () => {
  class AuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'AuthError';
      this.status = status;
    }
  }
  return {
    AuthError,
    getTenantContext: vi.fn(async () => ({
      tenantId: ctxHolder.tenantId,
      userId: 1,
      role: 'owner' as const,
      overrides: [],
    })),
    requirePermission: vi.fn(() => undefined),
    handleAuthError: (error: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NextResponse } = require('next/server');
      if (error instanceof AuthError) {
        return NextResponse.json({ success: false, error: error.message }, { status: error.status });
      }
      console.error('Unexpected error:', error);
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    },
  };
});

import { GET } from '@/app/api/reports/tags/items/route';
import { prisma } from '@/lib/prisma';
import { NextRequest } from 'next/server';

type SeededItem = {
  id: string;
  brand: string;
  gross: number;
  net: number;
  cost: number;
  orderDate: Date;
  tags: number[];
  showId?: string;
  earningsStatus?: string;
  isGiveaway?: boolean;
};

async function seedItem(tenantId: string, args: SeededItem) {
  await prisma.item.create({
    data: {
      id: args.id,
      tenantId,
      itemTitle: `Item ${args.id}`,
      aiBrand: args.brand,
      grossAmount: args.gross,
      netEarnings: args.net,
      cost: args.cost,
      quantity: 1,
      orderDate: args.orderDate,
      showId: args.showId ?? null,
      earningsStatus: args.earningsStatus ?? null,
      isGiveaway: args.isGiveaway ?? false,
    },
  });
  for (const tagId of args.tags) {
    await prisma.itemTag.create({ data: { itemId: args.id, tagId } });
  }
}

function req(qs = ''): NextRequest {
  return new NextRequest(`http://localhost/api/reports/tags/items${qs}`, {
    headers: { 'X-Tenant-Id': ctxHolder.tenantId },
  });
}

describe('GET /api/reports/tags/items', () => {
  let tenantId: string;
  let tagA: number;
  let tagB: number;

  beforeEach(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `Test ${randomUUID()}`, slug: `t${Date.now()}${Math.random().toString(36).slice(2)}` },
    });
    tenantId = tenant.id;
    ctxHolder.tenantId = tenantId;
    const a = await prisma.tag.create({ data: { tenantId, name: 'alpha' } });
    const b = await prisma.tag.create({ data: { tenantId, name: 'beta' } });
    tagA = a.id;
    tagB = b.id;
  });

  afterEach(async () => {
    await prisma.itemTag.deleteMany({ where: { tag: { tenantId } } });
    await prisma.item.deleteMany({ where: { tenantId } });
    await prisma.tag.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it('returns one row per (tag, item) pair within the date range', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-04-15T12:00:00Z'), tags: [tagA, tagB],
    });
    await seedItem(tenantId, {
      id: 'item-2', brand: 'Y', gross: 50, net: 45, cost: 20,
      orderDate: new Date('2026-04-20T12:00:00Z'), tags: [tagA],
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30'));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    const alphaRows = body.data.filter((r: { tag: string }) => r.tag === 'alpha');
    expect(alphaRows).toHaveLength(2);
    expect(alphaRows[0].profit).toBeGreaterThan(alphaRows[1].profit);
  });

  it('excludes items outside the date range', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-03-15T12:00:00Z'), tags: [tagA],
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30'));
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('excludes refunded items', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-04-15T12:00:00Z'), tags: [tagA],
      earningsStatus: 'Refunded',
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30'));
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('excludes giveaway items', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-04-15T12:00:00Z'), tags: [tagA],
      isGiveaway: true,
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30'));
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it('honors showIds filter', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-04-15T12:00:00Z'), tags: [tagA],
      showId: 'show-1',
    });
    await seedItem(tenantId, {
      id: 'item-2', brand: 'X', gross: 50, net: 45, cost: 20,
      orderDate: new Date('2026-04-16T12:00:00Z'), tags: [tagA],
      showId: 'show-2',
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30&showIds=show-1'));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].item_id).toBe('item-1');
  });

  it('honors brandNames filter', async () => {
    await seedItem(tenantId, {
      id: 'item-1', brand: 'X', gross: 100, net: 90, cost: 30,
      orderDate: new Date('2026-04-15T12:00:00Z'), tags: [tagA],
    });
    await seedItem(tenantId, {
      id: 'item-2', brand: 'Y', gross: 50, net: 45, cost: 20,
      orderDate: new Date('2026-04-16T12:00:00Z'), tags: [tagA],
    });
    const res = await GET(req('?startDate=2026-04-01&endDate=2026-04-30&brandNames=X'));
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].brand).toBe('X');
  });
});
```

- [ ] **Step 2: Run the test, confirm all six fail because the route doesn't exist**

Run: `npm --prefix web test -- tags-items`
Expected: `Failed to resolve import "@/app/api/reports/tags/items/route"` (or all six tests fail to load).

---

## Task 2: API endpoint `/api/reports/tags/items` — implement

**Files:**
- Create: `web/src/app/api/reports/tags/items/route.ts`

- [ ] **Step 1: Create the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTenantContext, requirePermission, handleAuthError } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { parseReportFilters, NOT_REFUNDED_SQL, NOT_GIVEAWAY_SQL } from "@/lib/reports/filters";

interface Row {
  tag: string;
  item_id: string;
  title: string | null;
  brand: string | null;
  gross: string;
  net: string;
  cost: string;
  profit: string;
  order_date: Date;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getTenantContext(req);
    requirePermission(ctx, "reports.view");

    const { startDate, endDate, showIds, brandNames } = parseReportFilters(req);
    const tenantId = ctx.tenantId;

    const showFilter = showIds.length ? Prisma.sql`AND i.show_id = ANY(${showIds})` : Prisma.empty;
    const brandFilter = brandNames.length ? Prisma.sql`AND i.ai_brand = ANY(${brandNames})` : Prisma.empty;

    const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        t.name AS tag,
        i.id AS item_id,
        i.item_title AS title,
        i.ai_brand AS brand,
        COALESCE(i.gross_amount, 0)::text AS gross,
        COALESCE(i.net_earnings, 0)::text AS net,
        COALESCE(i.cost, 0)::text AS cost,
        (COALESCE(i.net_earnings, 0) - COALESCE(i.cost, 0) * COALESCE(i.quantity, 1))::text AS profit,
        i.order_date AS order_date
      FROM items i
      JOIN item_tags it ON it.item_id = i.id
      JOIN tags t ON t.id = it.tag_id
      WHERE i.tenant_id = ${tenantId}::uuid
        AND i.order_date::date BETWEEN ${startDate}::date AND ${endDate}::date
        AND ${NOT_REFUNDED_SQL}
        AND ${NOT_GIVEAWAY_SQL}
        ${showFilter}
        ${brandFilter}
      ORDER BY t.name ASC, (COALESCE(i.net_earnings, 0) - COALESCE(i.cost, 0) * COALESCE(i.quantity, 1)) DESC
    `);

    const data = rows.map((r) => ({
      tag: r.tag,
      item_id: r.item_id,
      title: r.title ?? '',
      brand: r.brand,
      gross: parseFloat(r.gross),
      net: parseFloat(r.net),
      cost: parseFloat(r.cost),
      profit: parseFloat(r.profit),
      order_date: r.order_date instanceof Date ? r.order_date.toISOString() : String(r.order_date),
    }));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return handleAuthError(error) ?? NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Run the tests, confirm all six pass**

Run: `npm --prefix web test -- tags-items`
Expected: 6 passed.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/reports/tags/items/route.ts web/tests/api/reports/tags-items.test.ts
git commit -m "feat(api): add /api/reports/tags/items endpoint for per-tag item detail"
```

---

## Task 3: Extend `useReports` with `loadTagItems`

**Files:**
- Modify: `desktop/src/hooks/useReports.ts`

This loader is called on-demand from the PDF export handler, not as part of the tab data effect, so it doesn't go into the returned state — it's returned as a function that resolves the rows.

- [ ] **Step 1: Add `TagItemRow` type next to `TagReport` (after line 206)**

```ts
export interface TagItemRow {
  tag: string;
  item_id: string;
  title: string;
  brand: string | null;
  gross: number;
  net: number;
  cost: number;
  profit: number;
  order_date: string;
}
```

- [ ] **Step 2: Add the loader inside the hook body next to `loadTags` (after line 414)**

```ts
const fetchTagItems = useCallback(async (params?: ReportParams): Promise<TagItemRow[]> => {
  try {
    const result = await apiClient.get<{ success: boolean; data?: TagItemRow[] }>(
      '/api/reports/tags/items',
      reportParamsToQuery(params),
    );
    if (result.success && result.data) return result.data;
    return [];
  } catch (err) {
    console.error('Failed to load tag items:', err);
    return [];
  }
}, []);
```

- [ ] **Step 3: Add `fetchTagItems` to the hook's return object alongside `loadTags`**

Look for the return statement (around line 600); add `fetchTagItems,` to the returned object.

- [ ] **Step 4: Run type-check**

Run: `npm --prefix desktop run build`
Expected: build succeeds (or fails only on lines this task didn't touch — note any pre-existing errors).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/hooks/useReports.ts
git commit -m "feat(useReports): add fetchTagItems loader for /api/reports/tags/items"
```

---

## Task 4: Verify `DashboardFilterContext.toggleTag` exists

**Files:**
- Read: `desktop/src/contexts/DashboardFilterContext.tsx`

- [ ] **Step 1: Check whether `toggleTag` is already exported**

Run: `grep -n "toggleTag\|addTagFilter\|removeTagFilter" desktop/src/contexts/DashboardFilterContext.tsx`

Expected: at least one of `addTagFilter` / `removeTagFilter` already exists (the brainstorming research showed `filters.tags` is read at lines 127, 134, 214, 215, 269).

- [ ] **Step 2: If `toggleTag` exists, skip the rest of this task and continue to Task 5.**

- [ ] **Step 3: If only `addTagFilter` / `removeTagFilter` exist, add a convenience `toggleTag` that wraps them**

Add inside the provider next to the existing tag helpers:

```ts
const toggleTag = useCallback((name: string) => {
  setFilters(prev => ({
    ...prev,
    tags: prev.tags.includes(name)
      ? prev.tags.filter(t => t !== name)
      : [...prev.tags, name],
  }));
}, []);
```

Export it on the context value object next to `addTagFilter`. Add `toggleTag: (name: string) => void;` to the `DashboardFilters` (or context value) TypeScript type.

- [ ] **Step 4: Commit (only if you made a change)**

```bash
git add desktop/src/contexts/DashboardFilterContext.tsx
git commit -m "feat(filters): add toggleTag convenience helper"
```

---

## Task 5: Create `TagsTab.tsx`

**Files:**
- Create: `desktop/src/pages/reports/TagsTab.tsx`

Mirrors `BrandsTab.tsx` (treemap and compare-mode branches removed). Includes the PDF-export button in the tab so the user can trigger it without leaving the tab.

- [ ] **Step 1: Create the file**

```tsx
import { useMemo, useCallback, MouseEvent, useState } from 'react';
import { DataTable, Column } from '../../components/DataTable';
import { formatCurrency, formatPercent, cn } from '@sellerfolio/shared/utils';
import { useDashboardFilters } from '../../contexts/DashboardFilterContext';
import { InteractiveBarChart } from '../../components/reports/charts';
import { ContextMenu } from '../../components/ContextMenu';
import { useChartContextMenu, getContextMenuItems, ChartMenuActions } from '../../components/reports/context-menus';
import { FileDown, Loader2 } from 'lucide-react';
import type { TagReport } from '../../hooks/useReports';

interface TagsTabProps {
  tags: TagReport[];
  loading: boolean;
  activeDateLabel: string;
  onExportPdf: () => Promise<void>;
}

export default function TagsTab({ tags, loading, activeDateLabel, onExportPdf }: TagsTabProps) {
  const { filters, toggleTag } = useDashboardFilters();
  const [exporting, setExporting] = useState(false);

  const { menuState, openContextMenu, closeContextMenu } = useChartContextMenu();

  const contextMenuActions: ChartMenuActions = useMemo(() => ({
    onFilterByBrand: () => {},
    onFilterByShow: () => {},
    onFilterByProduct: () => {},
    onFilterByDayHour: () => {},
    onNavigateToTab: () => {},
    onOpenShowModal: () => {},
    onOpenProductModal: () => {},
    onOpenCustomerModal: () => {},
    onCopyValue: (value: string) => { navigator.clipboard.writeText(value); },
  }), []);

  const handleTagContextMenu = useCallback((e: MouseEvent, row: TagReport) => {
    openContextMenu(e, { type: 'brand', value: row, label: row.tag });
  }, [openContextMenu]);

  const currentContextMenuItems = useMemo(() => {
    if (!menuState.context) return [];
    return getContextMenuItems(menuState.context, contextMenuActions, null, null);
  }, [menuState.context, contextMenuActions]);

  const chartData = useMemo(() =>
    tags.slice(0, 15).map(t => ({ name: t.tag, value: t.revenue, profit: t.profit })),
  [tags]);

  const isSelected = useCallback((name: string) => filters.tags.includes(name), [filters.tags]);

  const columns: Column<TagReport>[] = useMemo(() => [
    { key: 'tag', header: 'Tag', sortable: true, render: (row) => (
      <button
        onClick={() => toggleTag(row.tag)}
        className={cn(
          'font-medium hover:text-accent transition-colors',
          isSelected(row.tag) && 'text-accent'
        )}
      >
        {row.tag}
      </button>
    )},
    { key: 'items_sold', header: 'Items', width: '80px', sortable: true, render: (row) => row.items_sold.toLocaleString() },
    { key: 'revenue', header: 'Revenue', width: '110px', sortable: true, render: (row) => <span className='font-mono'>{formatCurrency(row.revenue)}</span> },
    { key: 'avg_price', header: 'Avg Price', width: '100px', sortable: true, render: (row) => <span className='font-mono'>{formatCurrency(row.avg_price)}</span> },
    { key: 'profit', header: 'Profit', width: '110px', sortable: true, render: (row) => (
      <span className={cn('font-mono', row.profit >= 0 ? 'text-success' : 'text-danger')}>{formatCurrency(row.profit)}</span>
    )},
    { key: 'margin_pct', header: 'Margin', width: '80px', sortable: true, render: (row) => (
      <span className={cn('font-mono', row.margin_pct >= 0 ? 'text-success' : 'text-danger')}>{formatPercent(row.margin_pct)}</span>
    )},
  ], [isSelected, toggleTag]);

  const handleExport = async () => {
    setExporting(true);
    try { await onExportPdf(); } finally { setExporting(false); }
  };

  return (
    <div className='space-y-4'>
      <div className='flex items-center justify-between'>
        <h3 className='text-base font-semibold'>Tags · P&L</h3>
        <button
          onClick={handleExport}
          disabled={exporting || tags.length === 0}
          className='flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/90 disabled:opacity-50'
        >
          {exporting ? <Loader2 className='w-3 h-3 animate-spin' /> : <FileDown className='w-3 h-3' />}
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </div>

      <div className='bg-bg-secondary border border-border-subtle rounded-lg p-4'>
        <h4 className='text-sm font-medium mb-1'>Top Tags by Revenue</h4>
        <p className='text-xs text-text-tertiary mb-3'>
          {filters.tags.length > 0 ? `Filtered: ${filters.tags.join(', ')}` : `All tags · ${activeDateLabel.toLowerCase()}`}
        </p>
        <div className='h-64'>
          {tags.length > 0 ? (
            <InteractiveBarChart
              data={chartData}
              dataKey='value'
              nameKey='name'
              layout='vertical'
              fill='#10b981'
              selectedValue={filters.tags[0] ?? null}
              highlightedValue={null}
              onBarClick={(entry) => toggleTag(entry.name as string)}
              onBarHover={() => {}}
              onBarContextMenu={(e, entry) => {
                const row = tags.find(t => t.tag === entry.name);
                if (row) handleTagContextMenu(e, row);
              }}
              height={256}
              valueFormatter={formatCurrency}
            />
          ) : (
            <div className='h-full flex items-center justify-center text-text-tertiary text-sm'>
              {loading ? 'Loading…' : 'No tag data available'}
            </div>
          )}
        </div>
      </div>

      <DataTable
        data={tags}
        columns={columns}
        loading={loading}
        emptyMessage='No tag data available'
        onRowContextMenu={handleTagContextMenu}
      />

      <ContextMenu
        items={currentContextMenuItems}
        position={menuState.position}
        onClose={closeContextMenu}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify the `DataTable` `onRowContextMenu` prop name**

Run: `grep -n "onRowContextMenu\|onContextMenu" desktop/src/components/DataTable.tsx | head -5`

Expected: a prop with one of those names. If neither exists, drop the `onRowContextMenu` prop from the JSX above. The context menu still works via the bar chart's `onBarContextMenu`.

- [ ] **Step 3: Re-export from `desktop/src/pages/reports/index.ts`**

Look at the existing exports and add:

```ts
export { default as TagsTab } from './TagsTab';
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/pages/reports/TagsTab.tsx desktop/src/pages/reports/index.ts
git commit -m "feat(reports): add TagsTab component"
```

---

## Task 6: Register `tags` in the PDF IPC

**Files:**
- Modify: `desktop/electron/ipc/export.ts`

The existing `generateTabPdf` already accepts `tables: TabPdfTable[]`. We just need to wire `tags` into the `generators` map, the dialog `titleMap`, and the internal `titleMap` inside `generateTabPdf`.

- [ ] **Step 1: Add `tags` to the generator map**

In the `generators` object (around line 188), add a new line below `auctions`:

```ts
tags: (data) => generateTabPdf(data as unknown as TabPdfData),
```

- [ ] **Step 2: Add `tags` to the dialog `titleMap`**

In the same `ipcMain.handle('export-report-pdf', …)` handler (around line 207), update `titleMap`:

```ts
const titleMap: Record<string, string> = {
  summary: 'Report Summary', brands: 'Brands Report', products: 'Products Report',
  shows: 'Shows Report', customers: 'Customers Report', pricing: 'Pricing Report',
  auctions: 'Auctions Report', tags: 'Tags Report', compare: 'Show Comparison',
};
```

- [ ] **Step 3: Add `tags` to the internal `titleMap` inside `generateTabPdf`**

Around line 1133:

```ts
const titleMap: Record<string, string> = {
  brands: 'Brands Report',
  products: 'Products Report',
  shows: 'Shows Report',
  customers: 'Customers Report',
  pricing: 'Pricing Report',
  auctions: 'Auctions Report',
  tags: 'Tags Report',
};
```

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/ipc/export.ts
git commit -m "feat(export): register tags report PDF generator"
```

---

## Task 7: Wire `TagsTab` into Reports.tsx

**Files:**
- Modify: `desktop/src/pages/Reports.tsx`

- [ ] **Step 1: Import `TagsTab`, `TagItemRow`, and the `Tag` icon**

Add `Tag` to the existing `lucide-react` import (the one that imports `BarChart3`, `Users`, etc. near line 6).

Add `TagsTab` to the existing barrel import:

```ts
import {
  OverviewTab, BrandsTab, ProductsTab, ShowsTab, CustomersTab, PricingTab, AuctionsTab, TagsTab,
} from './reports/index';
```

Add `TagItemRow` to the `useReports` type import (near line 9–10):

```ts
import { useReports, ReportSummary, BrandReport, ShowReport, ProductReport,
  CustomerTop, PriceDistribution, TagItemRow } from '../hooks/useReports';
```

- [ ] **Step 2: Add `'tags'` to the `TabId` union and `tabs` array**

```ts
type TabId = 'overview' | 'brands' | 'products' | 'shows' | 'customers' | 'pricing' | 'auctions' | 'expenses' | 'tags';
```

In the `tabs` array (around line 41–50), insert after `pricing`:

```ts
{ id: 'tags', label: 'Tags', icon: <Tag className="w-4 h-4" /> },
```

- [ ] **Step 3: Destructure `fetchTagItems` from `useReports()`**

Add `fetchTagItems` to the destructured object returned by `useReports()` (around line 84–94).

- [ ] **Step 4: Add `loadTags(params)` to the tab-specific effect**

Around line 264 there's a `useEffect` that switches on `activeTab`. Add a new branch after `auctions`:

```ts
} else if (activeTab === 'tags') {
  loadTags(params);
}
```

Also add the same call to `refreshData` (around line 291):

```ts
} else if (activeTab === 'tags') {
  loadTags(params);
}
```

- [ ] **Step 5: Add the PDF export handler**

Insert near the other handlers (e.g., next to `handleBrandClick` around line 324):

```ts
const handleTagsPdfExport = useCallback(async () => {
  const params = getFilterParams();
  const items = await fetchTagItems(params as Parameters<typeof fetchTagItems>[0]);

  const filterParts: string[] = [];
  if (filters.brandNames?.length) filterParts.push(`Brands: ${filters.brandNames.join(', ')}`);
  if (filters.showIds?.length) filterParts.push(`Shows: ${filters.showIds.length}`);
  if (filters.tags?.length) filterParts.push(`Tags: ${filters.tags.join(', ')}`);
  const filterLabel = filterParts.length ? filterParts.join(' · ') : undefined;

  const summaryTable = {
    title: 'Tag Summary',
    columns: [
      { label: 'Tag', width: 140 },
      { label: 'Items', width: 60, align: 'right' as const },
      { label: 'Revenue', width: 90, align: 'right' as const },
      { label: 'Avg Price', width: 80, align: 'right' as const },
      { label: 'Profit', width: 90, align: 'right' as const },
      { label: 'Margin', width: 70, align: 'right' as const },
    ],
    rows: tags.map(t => [
      t.tag,
      t.items_sold.toLocaleString(),
      `$${t.revenue.toFixed(2)}`,
      `$${t.avg_price.toFixed(2)}`,
      `$${t.profit.toFixed(2)}`,
      `${t.margin_pct.toFixed(1)}%`,
    ]),
  };

  const itemsByTag = new Map<string, TagItemRow[]>();
  for (const it of items) {
    const list = itemsByTag.get(it.tag) ?? [];
    list.push(it);
    itemsByTag.set(it.tag, list);
  }

  const detailTables = tags
    .filter(t => (itemsByTag.get(t.tag)?.length ?? 0) > 0)
    .map(t => ({
      title: `${t.tag} (${t.items_sold} items, ${`$${t.profit.toFixed(2)}`} profit)`,
      columns: [
        { label: 'Date', width: 80 },
        { label: 'Item', width: 200 },
        { label: 'Brand', width: 90 },
        { label: 'Gross', width: 60, align: 'right' as const },
        { label: 'Net', width: 60, align: 'right' as const },
        { label: 'Profit', width: 60, align: 'right' as const },
      ],
      rows: (itemsByTag.get(t.tag) ?? []).map(it => [
        it.order_date ? it.order_date.slice(0, 10) : '',
        it.title || '(no title)',
        it.brand ?? '',
        `$${it.gross.toFixed(2)}`,
        `$${it.net.toFixed(2)}`,
        `$${it.profit.toFixed(2)}`,
      ]),
    }));

  const result = await window.exportAPI.reportToPdf('tags', {
    reportType: 'tags',
    dateLabel: activeDateLabel,
    filterLabel,
    tables: [summaryTable, ...detailTables],
  });

  if (result && !result.success && !result.canceled) {
    console.error('Tags PDF export failed:', result.error);
  }
}, [tags, activeDateLabel, filters.brandNames, filters.showIds, filters.tags, fetchTagItems]);
```

If `useCallback` isn't already imported from `react`, add it to the import.

- [ ] **Step 6: Render the tab**

Find where the existing tabs render (e.g., `{activeTab === 'brands' && <BrandsTab … />}` patterns around the JSX) and add:

```tsx
{activeTab === 'tags' && (
  <TagsTab
    tags={tags}
    loading={loading}
    activeDateLabel={activeDateLabel}
    onExportPdf={handleTagsPdfExport}
  />
)}
```

- [ ] **Step 7: Type-check**

Run: `npm --prefix desktop run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add desktop/src/pages/Reports.tsx
git commit -m "feat(reports): add Tags tab to Reports page"
```

---

## Task 8: Manual smoke test

- [ ] **Step 1: Start the desktop dev environment**

Run: `npm --prefix desktop run electron:dev`
(Web app must already be running on its dev port — start `npm --prefix web run dev` in another shell first if it isn't.)

- [ ] **Step 2: Open Reports → Tags tab**

Verify:
- The summary table renders with Tag / Items / Revenue / Avg Price / Profit / Margin columns.
- The bar chart shows the top 15 tags by revenue.
- The "Export PDF" button is visible.

- [ ] **Step 3: Cross-filter test**

Click a tag in the table. Verify:
- The tag appears as a breadcrumb chip at the top.
- The Brands tab (when switched to) shows only items with that tag.
- Clicking the same tag again clears the filter across tabs.

- [ ] **Step 4: PDF export test**

Click "Export PDF". In the save dialog, save somewhere reachable. Open the PDF and verify:
- Title is "Tags Report" with the date range shown.
- The first table matches the on-screen summary (same tags, same totals).
- One section per tag with sales, each listing per-item rows (date, item, brand, gross, net, profit).
- Page breaks occur cleanly between sections (no row cut in half).

- [ ] **Step 5: Empty-state test**

Set a date range that has no tagged sales. Verify:
- The bar chart shows "No tag data available."
- The Export PDF button is disabled.

- [ ] **Step 6: Run the existing test suite to catch regressions**

Run: `npm --prefix web test`
Expected: all tests pass, including the new 6 in `tags-items.test.ts`.

---

## Notes for the engineer

- **Untagged items are intentionally excluded** from the report — the SQL only returns items with at least one `ItemTag` row. This is per the v1 spec.
- **Tag name casing:** Tags created via the API are stored with the user's casing; the report groups by stored name. Don't add `LOWER()` normalization here — that's a separate decision.
- **PDF item-list size:** No `limit` is applied. If a tag has thousands of items, the PDF will be large. The user accepted this trade-off in brainstorming.
- **DataTable `onRowContextMenu` prop:** If the existing `DataTable` component doesn't accept this prop (Task 5 Step 2), drop it from the JSX. The bar chart still supports right-click via `onBarContextMenu`.
