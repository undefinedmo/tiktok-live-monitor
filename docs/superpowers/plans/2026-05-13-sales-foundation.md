# Sales Page Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three real bugs in the Sales screen filtering, add user-visible filter clarity features (clear-all + active chips), and shrink `Sales.tsx` (currently 3,365 lines) by extracting the three biggest modals into their own components.

**Architecture:** Pure desktop-side changes in `desktop/src/`. No API changes, no schema changes. Modals are extracted as pure presentational components that accept props from the parent page — no state migration into context. Active-filter chips are a new small component in `components/sales/`. Bug fixes are one-line or few-line patches to existing files.

**Tech Stack:** React 19 + TypeScript + Tailwind, lucide-react icons, existing `@sellerfolio/shared/utils` helpers. No new dependencies.

**Verification:** This repo has no automated test framework in `desktop/` (no vitest/jest/playwright). All verification is manual via `npm run dev` in `desktop/`. Each task lists explicit click-through steps.

**Backup already saved at:** `desktop/src/pages/Sales.tsx.bak-2026-05-13`

---

## Phase A — Bug Fixes

### Task 1: Fix `activeFilterCount` Paid exception

The badge undercounts: if the user picks `Paid` as a status filter, `activeFilterCount` doesn't increment. There's no reason `Paid` should be special — it's just one of four values in the dropdown, and the dropdown's "no filter" state is `''` (empty string).

**Files:**
- Modify: `desktop/src/pages/Sales.tsx:689-699`

- [ ] **Step 1: Locate the bug**

Open `desktop/src/pages/Sales.tsx` and find lines 689-699. Current code:

```typescript
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (isBrandFilterActive) count += 1;
    if (msrpMin || msrpMax) count += 1;
    if (excludeGiveaways) count += 1;
    if (buyItNowFilter !== 'all') count += 1;
    if (earningsStatusFilter && earningsStatusFilter !== 'Paid') count += 1;
    if (tagFilter) count += 1;
    if (consignmentFilter) count += 1;
    return count;
  }, [isBrandFilterActive, msrpMin, msrpMax, excludeGiveaways, buyItNowFilter, earningsStatusFilter, tagFilter, consignmentFilter]);
```

- [ ] **Step 2: Apply the fix**

Replace the `earningsStatusFilter` line. New version:

```typescript
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (isBrandFilterActive) count += 1;
    if (msrpMin || msrpMax) count += 1;
    if (excludeGiveaways) count += 1;
    if (buyItNowFilter !== 'all') count += 1;
    if (earningsStatusFilter) count += 1;
    if (tagFilter) count += 1;
    if (consignmentFilter) count += 1;
    return count;
  }, [isBrandFilterActive, msrpMin, msrpMax, excludeGiveaways, buyItNowFilter, earningsStatusFilter, tagFilter, consignmentFilter]);
```

- [ ] **Step 3: Verify**

Run `cd desktop && npm run dev`. Navigate to Sales. Open the filter panel (Filter button in toolbar). Select Status = "Paid". Confirm the badge on the Filter button shows `1`. Select "All" again — badge clears.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/pages/Sales.tsx
git commit -m "fix(sales): count Paid as an active status filter

Previously activeFilterCount excluded earningsStatusFilter === 'Paid'
from the badge total, leaving users with no indication that the filter
was applied."
```

---

### Task 2: Fix status filter mismatch with server values

The status `<select>` offers `Paid / Pending / Refunded / Canceled`, but server values include `Earnings Completed`, `Earnings Cancelled`, `Cancelled` (see normalization at Sales.tsx:2178-2188). The filter compares raw equality, so selecting "Canceled" misses rows whose `earnings_status` is `"Earnings Cancelled"` or `"Cancelled"`. Fix by applying the same normalization on the filter side.

**Files:**
- Modify: `desktop/src/pages/Sales.tsx:733-736`

- [ ] **Step 1: Locate the filter**

Find lines 733-736:

```typescript
    // Earnings status filter
    if (earningsStatusFilter) {
      result = result.filter(item => item.earnings_status === earningsStatusFilter);
    }
```

- [ ] **Step 2: Apply the fix**

Replace with normalized comparison matching the renderer at Sales.tsx:2178-2182:

```typescript
    // Earnings status filter — normalize server values the same way the renderer does
    // (server returns "Earnings Completed" / "Earnings Cancelled" / "Cancelled" etc.)
    if (earningsStatusFilter) {
      result = result.filter(item => {
        const raw = item.earnings_status ?? '';
        const normalized = raw
          .replace(/^Earnings\s+/i, '')
          .replace(/^Completed$/i, 'Paid')
          .replace(/^Processing$/i, 'Pending')
          .replace(/^Cancelled$/i, 'Canceled');
        return normalized === earningsStatusFilter;
      });
    }
```

- [ ] **Step 3: Verify**

Run `npm run dev`. Pick a show with a known refunded or cancelled item (you can identify one in the table by the red "Refunded"/"Canceled" status pill). Open filters, select Status = "Canceled". Confirm the cancelled row appears in the filtered view. Repeat for "Refunded" and "Paid".

- [ ] **Step 4: Commit**

```bash
git add desktop/src/pages/Sales.tsx
git commit -m "fix(sales): normalize earnings_status when filtering

Server stores values like 'Earnings Completed' / 'Earnings Cancelled' /
'Cancelled', but the filter dropdown emits short labels. Match what the
status-pill renderer already does so the filter actually catches rows."
```

---

### Task 3: Fix `isBrandFilterActive` going stale on show change

`isBrandFilterActive = brandFilter.length > 0 && brandFilter.length < brands.length` treats "all brands selected" as no filter. But `brands` is derived from the currently-selected shows, so picking N brands and then switching shows can flip the same selection between "active" and "inactive". Simpler and correct: any non-empty selection is active. "Select All" then clearing is one click away in the picker.

**Files:**
- Modify: `desktop/src/pages/Sales.tsx:688`

- [ ] **Step 1: Locate the line**

Sales.tsx:688:

```typescript
  const isBrandFilterActive = brandFilter.length > 0 && brandFilter.length < brands.length;
```

- [ ] **Step 2: Apply the fix**

```typescript
  const isBrandFilterActive = brandFilter.length > 0;
```

- [ ] **Step 3: Verify**

Run `npm run dev`. In the brand picker, click "Select All". Confirm the filter badge increments by 1 and the filtered-items count reflects only items with a brand. Click "Clear" in the picker — badge decrements, count returns. Switch shows in the sidebar — filter state remains consistent (badge accurately reflects whether anything is selected).

- [ ] **Step 4: Commit**

```bash
git add desktop/src/pages/Sales.tsx
git commit -m "fix(sales): treat any brand selection as an active filter

The 'all selected = inactive' shortcut went stale across show changes
because the brand list is per-show. Any non-empty selection now counts;
users can use Clear in the picker to deactivate."
```

---

## Phase B — Visible Filter UX

### Task 4: Add "Clear all filters" button to the filter bar

`SalesFilterBar` currently has no way to wipe everything in one click. Add an `onClearAll` prop and render a small text button at the right edge of the bar that's only visible when at least one filter is active.

**Files:**
- Modify: `desktop/src/components/sales/SalesFilterBar.tsx`
- Modify: `desktop/src/pages/Sales.tsx` (pass the callback)

- [ ] **Step 1: Extend `SalesFilterBarProps`**

In `SalesFilterBar.tsx` lines 20-27, replace the props interface with:

```typescript
export interface SalesFilterBarProps {
  values: SalesFilterValues;
  onChange: (next: Partial<SalesFilterValues>) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  brandOptions: BrandInfo[];
  tagOptions: string[];
  consignments: Consignment[];
  onOpenDropdown?: () => void;
}
```

- [ ] **Step 2: Destructure the new props**

In `SalesFilterBar.tsx` lines 29-36 (the function signature):

```typescript
export function SalesFilterBar({
  values,
  onChange,
  onClearAll,
  hasActiveFilters,
  brandOptions,
  tagOptions,
  consignments,
  onOpenDropdown,
}: SalesFilterBarProps) {
```

- [ ] **Step 3: Render the button**

In `SalesFilterBar.tsx`, find the closing `</div>` of the wrapper around line 252. Just before it (after the Buy-It-Now block ending on line 251), insert:

```tsx
      {hasActiveFilters && (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-auto text-xs text-text-tertiary hover:text-danger underline-offset-2 hover:underline transition-colors"
        >
          Clear all
        </button>
      )}
```

The `ml-auto` pushes it to the right end of the wrapping row.

- [ ] **Step 4: Add the parent handler in `Sales.tsx`**

In `Sales.tsx`, just above the JSX `return` (around line 2354 — find the spot right after `applyMassEditFromModal` finishes, before `// Table columns`), add:

```typescript
  const clearAllFilters = useCallback(() => {
    setBrandFilter([]);
    setEarningsStatusFilter('');
    setTagFilter('');
    setConsignmentFilter('');
    setMsrpMin('');
    setMsrpMax('');
    setExcludeGiveaways(false);
    setBuyItNowFilter('all');
  }, []);
```

- [ ] **Step 5: Wire the props through**

In `Sales.tsx` around lines 2555-2581, find the `<SalesFilterBar ... />` usage. Add the two new props:

```tsx
      {showFilters && (
        <SalesFilterBar
          values={{
            brands: brandFilter,
            earningsStatus: earningsStatusFilter,
            tag: tagFilter,
            consignment: consignmentFilter,
            msrpMin,
            msrpMax,
            excludeGiveaways,
            buyItNow: buyItNowFilter,
          }}
          onChange={(next) => {
            if (next.brands !== undefined) setBrandFilter(next.brands);
            if (next.earningsStatus !== undefined) setEarningsStatusFilter(next.earningsStatus);
            if (next.tag !== undefined) setTagFilter(next.tag);
            if (next.consignment !== undefined) setConsignmentFilter(next.consignment);
            if (next.msrpMin !== undefined) setMsrpMin(next.msrpMin);
            if (next.msrpMax !== undefined) setMsrpMax(next.msrpMax);
            if (next.excludeGiveaways !== undefined) setExcludeGiveaways(next.excludeGiveaways);
            if (next.buyItNow !== undefined) setBuyItNowFilter(next.buyItNow);
          }}
          onClearAll={clearAllFilters}
          hasActiveFilters={activeFilterCount > 0}
          brandOptions={brands}
          tagOptions={tags}
          consignments={consignments}
          onOpenDropdown={() => setShowCostTemplates(false)}
        />
      )}
```

- [ ] **Step 6: Verify**

Run `npm run dev`. Open the filter panel. Confirm no "Clear all" link appears when no filters active. Set a Status filter, a tag, an MSRP min — "Clear all" appears at the right of the bar. Click it — all three reset, badge goes to 0, link disappears.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/components/sales/SalesFilterBar.tsx desktop/src/pages/Sales.tsx
git commit -m "feat(sales): add 'Clear all' button to filter bar

Visible only when filters are active. Resets all eight filter dimensions
in one click — previously users had to clear each filter individually."
```

---

### Task 5: Active-filter chips row

Even when the filter panel is collapsed, users should see *what* is filtered. Add a horizontal row of chips between the toolbar and the table. Each chip names the filter and has a ✕ that clears just that dimension. Only renders when `activeFilterCount > 0`.

**Files:**
- Create: `desktop/src/components/sales/SalesActiveFilters.tsx`
- Modify: `desktop/src/pages/Sales.tsx`

- [ ] **Step 1: Create the component**

Create `desktop/src/components/sales/SalesActiveFilters.tsx` with this exact content:

```tsx
import { X } from 'lucide-react';
import type { SalesFilterValues } from './SalesFilterBar';
import type { Consignment } from '../../hooks/useConsignments';

export interface SalesActiveFiltersProps {
  values: SalesFilterValues;
  onChange: (next: Partial<SalesFilterValues>) => void;
  onClearAll: () => void;
  consignments: Consignment[];
}

interface Chip {
  key: string;
  label: string;
  onRemove: () => void;
}

export function SalesActiveFilters({ values, onChange, onClearAll, consignments }: SalesActiveFiltersProps) {
  const chips: Chip[] = [];

  if (values.brands.length > 0) {
    const label =
      values.brands.length === 1
        ? `Brand: ${values.brands[0]}`
        : `Brands: ${values.brands.length}`;
    chips.push({ key: 'brands', label, onRemove: () => onChange({ brands: [] }) });
  }

  if (values.earningsStatus) {
    chips.push({
      key: 'status',
      label: `Status: ${values.earningsStatus}`,
      onRemove: () => onChange({ earningsStatus: '' }),
    });
  }

  if (values.tag) {
    chips.push({ key: 'tag', label: `Tag: ${values.tag}`, onRemove: () => onChange({ tag: '' }) });
  }

  if (values.consignment) {
    const name =
      values.consignment === '__none__'
        ? 'Personal (no deal)'
        : consignments.find((c) => c.id === values.consignment)?.name ?? values.consignment;
    chips.push({
      key: 'consignment',
      label: `Deal: ${name}`,
      onRemove: () => onChange({ consignment: '' }),
    });
  }

  if (values.msrpMin || values.msrpMax) {
    const range = `${values.msrpMin || '0'}–${values.msrpMax || '∞'}`;
    chips.push({
      key: 'msrp',
      label: `MSRP: $${range}`,
      onRemove: () => onChange({ msrpMin: '', msrpMax: '' }),
    });
  }

  if (values.excludeGiveaways) {
    chips.push({
      key: 'no-giveaways',
      label: 'Excl. giveaways',
      onRemove: () => onChange({ excludeGiveaways: false }),
    });
  }

  if (values.buyItNow !== 'all') {
    chips.push({
      key: 'bin',
      label: values.buyItNow === 'only' ? 'Buy It Now only' : 'Excl. Buy It Now',
      onRemove: () => onChange({ buyItNow: 'all' }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs uppercase tracking-wider text-text-tertiary mr-1">Filters:</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 rounded-full bg-accent/15 text-accent text-xs"
        >
          <span>{chip.label}</span>
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove ${chip.label} filter`}
            className="p-0.5 hover:bg-accent/30 rounded-full transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs text-text-tertiary hover:text-danger underline-offset-2 hover:underline transition-colors ml-1"
      >
        Clear all
      </button>
    </div>
  );
}
```

> Note: `healthFilter` is intentionally NOT a chip in this component — it's already represented by the always-visible health pills in the toolbar with their own ✕.

- [ ] **Step 2: Render it in `Sales.tsx`**

In `Sales.tsx` find the JSX block right after `<SalesSummaryTiles stats={stats} />` (around line 2364). The toolbar row starts at line 2367. Insert the chip row between summary tiles and the toolbar so chips sit above the toolbar (most prominent), OR between Toolbar Row 2 and the filter panel. Choose **between Toolbar Row 2 and the filter panel** for less visual disruption — find line 2552 (`<div className="flex-1" />` followed by the closing `</div>` of Toolbar Row 2). Right after the closing `</div>` of Toolbar Row 2 (around line 2553), insert:

```tsx
      <SalesActiveFilters
        values={{
          brands: brandFilter,
          earningsStatus: earningsStatusFilter,
          tag: tagFilter,
          consignment: consignmentFilter,
          msrpMin,
          msrpMax,
          excludeGiveaways,
          buyItNow: buyItNowFilter,
        }}
        onChange={(next) => {
          if (next.brands !== undefined) setBrandFilter(next.brands);
          if (next.earningsStatus !== undefined) setEarningsStatusFilter(next.earningsStatus);
          if (next.tag !== undefined) setTagFilter(next.tag);
          if (next.consignment !== undefined) setConsignmentFilter(next.consignment);
          if (next.msrpMin !== undefined) setMsrpMin(next.msrpMin);
          if (next.msrpMax !== undefined) setMsrpMax(next.msrpMax);
          if (next.excludeGiveaways !== undefined) setExcludeGiveaways(next.excludeGiveaways);
          if (next.buyItNow !== undefined) setBuyItNowFilter(next.buyItNow);
        }}
        onClearAll={clearAllFilters}
        consignments={consignments}
      />
```

- [ ] **Step 3: Add the import**

At the top of `Sales.tsx`, near the existing `import { SalesFilterBar } from '../components/sales/SalesFilterBar';` (line 33), add:

```typescript
import { SalesActiveFilters } from '../components/sales/SalesActiveFilters';
```

- [ ] **Step 4: Verify**

Run `npm run dev`. With filter panel collapsed, set a brand, a status, an MSRP range — three chips appear above the filter panel slot. Click the × on the status chip — chip disappears, table updates, Filter badge decrements. Click "Clear all" on the chip row — all chips gone.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/components/sales/SalesActiveFilters.tsx desktop/src/pages/Sales.tsx
git commit -m "feat(sales): show active filters as removable chips

Chips render above the (collapsed) filter panel so users see what's
filtering the table without expanding the panel. Each chip has a per-
filter remove plus a 'Clear all' shortcut."
```

---

## Phase C — File Split (three modal extractions)

Goal: reduce `Sales.tsx` from ~3,365 lines to under ~2,700 by moving three large self-contained modals into their own files. These do NOT change behavior — they're pure refactors.

**Approach for all three modals:** convert each modal's local `useState`s + handler into a child component that accepts open-state and an onApply callback as props. The parent owns the trigger (the toolbar button or context-menu action) and the apply callback; the child owns its draft state.

### Task 6: Extract `MassEditModal`

The largest of the three. Lives at `Sales.tsx:2907-3066` (JSX) plus its `applyMassEditFromModal` handler around line 1893+ and 12 local state hooks at lines 139-156. We'll move state and JSX into the child; the parent keeps the apply logic and passes it as a callback.

**Files:**
- Create: `desktop/src/components/sales/MassEditModal.tsx`
- Modify: `desktop/src/pages/Sales.tsx`

- [ ] **Step 1: Identify what `applyMassEditFromModal` currently reads**

Read `Sales.tsx` lines 1890-1976 carefully. Note that the function reads:

- `massEditBrandEnabled`, `massEditBrandValue`
- `massEditMsrpEnabled`, `massEditMsrpValue`
- `massEditCostEnabled`, `massEditCostValue`, `massEditCostMode`
- `massEditTagEnabled`, `massEditTagValue`
- `massEditConsignmentEnabled`, `massEditConsignmentValue`
- `selectedItems`, `items`, `bulkPatchItems`, `apiClient`, `loadTags`, `selectedShowIds`, `showToast`

Write down on paper or in a scratch buffer that the new component will pass a single `MassEditPayload` object up to a parent callback, and the parent's `applyMassEditFromModal` will read the payload instead of state.

- [ ] **Step 2: Define the payload shape**

Add this near the top of `Sales.tsx`, just under the existing interfaces around line 65 (right after `CreateRuleModalState`):

```typescript
export interface MassEditPayload {
  brand: string | null;        // null = don't change
  msrp: number | null;
  cost: { mode: 'fixed' | 'percent'; value: number } | null;
  tag: string | null;
  consignmentId: string | null | undefined;  // undefined = don't change; null = clear; string = set
}
```

- [ ] **Step 3: Create the modal file**

Create `desktop/src/components/sales/MassEditModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { cn } from '@sellerfolio/shared/utils';
import type { Consignment } from '../../hooks/useConsignments';
import type { MassEditPayload } from '../../pages/Sales';

export interface MassEditModalProps {
  open: boolean;
  selectedCount: number;
  consignments: Consignment[];
  allBrands: Array<{ brand: string; count: number }>;
  allTags: string[];
  loading: boolean;
  applying: boolean;
  onClose: () => void;
  onApply: (payload: MassEditPayload) => void;
}

export function MassEditModal({
  open,
  selectedCount,
  consignments,
  allBrands,
  allTags,
  loading,
  applying,
  onClose,
  onApply,
}: MassEditModalProps) {
  const [brandEnabled, setBrandEnabled] = useState(false);
  const [brandValue, setBrandValue] = useState('');
  const [msrpEnabled, setMsrpEnabled] = useState(false);
  const [msrpValue, setMsrpValue] = useState('');
  const [costEnabled, setCostEnabled] = useState(false);
  const [costValue, setCostValue] = useState('');
  const [costMode, setCostMode] = useState<'fixed' | 'percent'>('fixed');
  const [tagEnabled, setTagEnabled] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [consignmentEnabled, setConsignmentEnabled] = useState(false);
  const [consignmentValue, setConsignmentValue] = useState('');

  // Reset draft when reopened so a previous session can't leak in.
  useEffect(() => {
    if (open) {
      setBrandEnabled(false);
      setBrandValue('');
      setMsrpEnabled(false);
      setMsrpValue('');
      setCostEnabled(false);
      setCostValue('');
      setCostMode('fixed');
      setTagEnabled(false);
      setTagValue('');
      setConsignmentEnabled(false);
      setConsignmentValue('');
    }
  }, [open]);

  if (!open) return null;

  const nothingEnabled =
    !brandEnabled && !msrpEnabled && !costEnabled && !tagEnabled && !consignmentEnabled;

  const handleApply = () => {
    if (nothingEnabled) return;
    const msrpNum = parseFloat(msrpValue);
    const costNum = parseFloat(costValue);
    const payload: MassEditPayload = {
      brand: brandEnabled && brandValue.trim() ? brandValue.trim() : null,
      msrp: msrpEnabled && !Number.isNaN(msrpNum) && msrpNum >= 0 ? msrpNum : null,
      cost:
        costEnabled && !Number.isNaN(costNum) && costNum >= 0
          ? { mode: costMode, value: costNum }
          : null,
      tag: tagEnabled && tagValue.trim() ? tagValue.trim() : null,
      consignmentId: consignmentEnabled ? (consignmentValue || null) : undefined,
    };
    onApply(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border-subtle rounded-xl p-6 max-w-lg w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">Mass Edit {selectedCount} Items</h3>
        <p className="text-sm text-text-secondary mb-4">Enable the fields you want to update, then apply once.</p>

        <div className="space-y-3">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={brandEnabled} onChange={(e) => setBrandEnabled(e.target.checked)} />
              Update Brand
            </label>
            <div className="relative">
              <input
                list="mass-edit-brand-list"
                value={brandValue}
                onChange={(e) => setBrandValue(e.target.value)}
                disabled={!brandEnabled || loading}
                placeholder={loading ? 'Loading brands...' : 'Select or type brand name'}
                className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-sm disabled:opacity-50"
              />
              <datalist id="mass-edit-brand-list">
                {allBrands.map((b) => (
                  <option key={b.brand} value={b.brand}>
                    {b.brand} ({b.count})
                  </option>
                ))}
              </datalist>
            </div>
            <p className="text-xs text-text-tertiary">
              {loading ? 'Loading...' : `${allBrands.length} brands in database`}
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={msrpEnabled} onChange={(e) => setMsrpEnabled(e.target.checked)} />
              Update MSRP
            </label>
            <input
              type="number"
              value={msrpValue}
              onChange={(e) => setMsrpValue(e.target.value)}
              disabled={!msrpEnabled}
              placeholder="MSRP"
              min="0"
              step="0.01"
              className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-sm disabled:opacity-50"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={costEnabled} onChange={(e) => setCostEnabled(e.target.checked)} />
              Update Cost
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCostMode('fixed')}
                disabled={!costEnabled}
                className={cn(
                  'px-2 py-1 rounded text-xs border',
                  costMode === 'fixed' ? 'bg-accent text-white border-accent' : 'bg-bg-secondary border-border-subtle'
                )}
              >
                Fixed $
              </button>
              <button
                onClick={() => setCostMode('percent')}
                disabled={!costEnabled}
                className={cn(
                  'px-2 py-1 rounded text-xs border',
                  costMode === 'percent' ? 'bg-accent text-white border-accent' : 'bg-bg-secondary border-border-subtle'
                )}
              >
                % of MSRP
              </button>
              <input
                type="number"
                value={costValue}
                onChange={(e) => setCostValue(e.target.value)}
                disabled={!costEnabled}
                placeholder={costMode === 'percent' ? 'Percent' : 'Cost'}
                min="0"
                step="0.01"
                className="flex-1 px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-sm disabled:opacity-50"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={tagEnabled} onChange={(e) => setTagEnabled(e.target.checked)} />
              Add Tag
            </label>
            <div className="relative">
              <input
                list="mass-edit-tag-list"
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
                disabled={!tagEnabled || loading}
                placeholder={loading ? 'Loading tags...' : 'Select or type tag name'}
                className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-sm disabled:opacity-50"
              />
              <datalist id="mass-edit-tag-list">
                {allTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </div>
            <p className="text-xs text-text-tertiary">
              {loading ? 'Loading...' : `${allTags.length} tags in database`}
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={consignmentEnabled}
                onChange={(e) => setConsignmentEnabled(e.target.checked)}
              />
              Assign to Deal
            </label>
            <select
              value={consignmentValue}
              onChange={(e) => setConsignmentValue(e.target.value)}
              disabled={!consignmentEnabled || loading}
              className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded text-sm disabled:opacity-50"
            >
              <option value="">— Unassign (clear deal) —</option>
              {consignments.filter((c) => c.isActive).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.consignor?.name ? `${c.consignor.name} — ${c.name}` : c.name}
                  {' '}({c.splitPercent}% {c.splitBase})
                </option>
              ))}
            </select>
            <p className="text-xs text-text-tertiary">
              Payouts will be recomputed for each reassigned item.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={applying || nothingEnabled}
            className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50"
          >
            {applying ? 'Applying...' : 'Apply Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update the parent `applyMassEditFromModal` to read from payload**

In `Sales.tsx`, find `applyMassEditFromModal` (around line 1890). Replace the entire function with a version that takes `payload: MassEditPayload` and reads from it instead of the 12 state hooks. Locate the function (search for `applyMassEditFromModal = async`), then rewrite as:

```typescript
  const applyMassEditFromModal = async (payload: MassEditPayload) => {
    const targetItems = items.filter((item) => selectedItems.has(item.id));
    if (targetItems.length === 0) {
      showToast('No items selected', 'error');
      return;
    }
    if (
      !payload.brand &&
      payload.msrp === null &&
      !payload.cost &&
      !payload.tag &&
      payload.consignmentId === undefined
    ) {
      showToast('Enable at least one field to update', 'error');
      return;
    }

    setMassEditInProgress(true);
    try {
      let updatedCount = 0;
      let skippedCost = 0;
      const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

      for (const item of targetItems) {
        const patch: Record<string, unknown> = {};

        if (payload.brand) patch.ai_brand = payload.brand;

        if (payload.msrp !== null) patch.ai_msrp = payload.msrp;

        if (payload.cost) {
          if (payload.cost.mode === 'percent') {
            const baseMsrp = payload.msrp !== null ? payload.msrp : (item.ai_msrp || 0);
            if (baseMsrp > 0) {
              patch.cost = Math.round((baseMsrp * payload.cost.value) / 100 * 100) / 100;
            } else {
              skippedCost += 1;
            }
          } else {
            patch.cost = payload.cost.value;
          }
        }

        if (payload.consignmentId !== undefined) {
          patch.consignment_id = payload.consignmentId;
        }

        if (Object.keys(patch).length > 0) {
          updates.push({ id: item.id, patch });
        }
      }

      if (updates.length > 0) {
        await bulkPatchItems(updates);
        updatedCount = updates.length;
      }

      if (payload.tag) {
        const tagId = await apiClient.post<{ id: string }>('/api/tags', { name: payload.tag });
        if (tagId?.id) {
          await apiClient.post('/api/sales/tags', {
            itemIds: targetItems.map((it) => it.id),
            tagIds: [tagId.id],
            action: 'add',
          });
        }
        await loadTags(Array.from(selectedShowIds));
      }

      setShowMassEdit(false);
      setSelectedItems(new Set());
      const skippedText = skippedCost > 0 ? ` (${skippedCost} skipped - missing MSRP)` : '';
      showToast(`Mass edited ${updatedCount} item${updatedCount !== 1 ? 's' : ''}${skippedText}`, 'success');
    } finally {
      setMassEditInProgress(false);
    }
  };
```

> Cross-check the original at `Sales.tsx:1893-1975` against this version line by line — the only behavioral change should be reading from `payload` instead of `massEdit*` state. If the original has any extra logic this snippet misses (e.g. specific tag-id call shape), keep the original logic and only swap the input source.

- [ ] **Step 5: Delete the old state hooks**

In `Sales.tsx` lines 140-156, delete:

```typescript
  const [massEditInProgress, setMassEditInProgress] = useState(false);
  const [massEditBrandEnabled, setMassEditBrandEnabled] = useState(false);
  const [massEditMsrpEnabled, setMassEditMsrpEnabled] = useState(false);
  const [massEditCostEnabled, setMassEditCostEnabled] = useState(false);
  const [massEditTagEnabled, setMassEditTagEnabled] = useState(false);
  const [massEditBrandValue, setMassEditBrandValue] = useState('');
  const [massEditMsrpValue, setMassEditMsrpValue] = useState('');
  const [massEditCostValue, setMassEditCostValue] = useState('');
  const [massEditTagValue, setMassEditTagValue] = useState('');
  const [massEditCostMode, setMassEditCostMode] = useState<'fixed' | 'percent'>('fixed');
  const [massEditConsignmentEnabled, setMassEditConsignmentEnabled] = useState(false);
  const [massEditConsignmentValue, setMassEditConsignmentValue] = useState('');
```

KEEP `massEditInProgress` (used in the apply function) and `massEditLoading` + `allBrands` + `allTags` (still loaded by the parent). Replace with just:

```typescript
  const [massEditInProgress, setMassEditInProgress] = useState(false);
```

- [ ] **Step 6: Replace the JSX usage**

In `Sales.tsx` find `{/* Mass Edit Modal */}` (around line 2907). Replace the entire block from `{showMassEdit && (` through its matching `)}` (the original spans roughly 2908-3066) with:

```tsx
      {/* Mass Edit Modal */}
      <MassEditModal
        open={showMassEdit}
        selectedCount={selectedItems.size}
        consignments={consignments}
        allBrands={allBrands}
        allTags={allTags}
        loading={massEditLoading}
        applying={massEditInProgress}
        onClose={() => setShowMassEdit(false)}
        onApply={(payload) => void applyMassEditFromModal(payload)}
      />
```

- [ ] **Step 7: Add the import**

At the top of `Sales.tsx` near the other `components/sales/` imports (around line 33):

```typescript
import { MassEditModal } from '../components/sales/MassEditModal';
```

- [ ] **Step 8: Verify**

Run `npm run dev`. Select 3+ items. Open Mass Edit (whichever toolbar/context-menu entry currently triggers it — verify the same trigger still works). Enable Brand only, type a new brand, Apply. Confirm the toast says "Mass edited 3 items" and the rows show the new brand. Reopen the modal — the previous selections are NOT prefilled (this is intentional via the reset effect). Repeat with MSRP + cost % mode to verify the cost-percent math still uses the updated MSRP. Cancel button closes without applying. Clicking the backdrop closes.

- [ ] **Step 9: Commit**

```bash
git add desktop/src/components/sales/MassEditModal.tsx desktop/src/pages/Sales.tsx
git commit -m "refactor(sales): extract MassEditModal

Move modal JSX, draft state, and reset logic into its own component.
Sales.tsx loses 12 useState hooks and ~160 lines of JSX. Apply handler
stays in the parent and reads from a typed payload."
```

---

### Task 7: Extract `BrandCleanupModal`

Smaller and very self-contained. Lives at `Sales.tsx:3068-3136`. Reads `brandVariations`, `cleanupInProgress`, `handleMergeBrand`, `handleAutoFixBrands`. No internal draft state.

**Files:**
- Create: `desktop/src/components/sales/BrandCleanupModal.tsx`
- Modify: `desktop/src/pages/Sales.tsx`

- [ ] **Step 1: Confirm the `BrandVariation` type is exported**

Search for `BrandVariation`. It's already exported from `hooks` and imported at `Sales.tsx:31`. Confirm:

```bash
grep -n "BrandVariation" desktop/src/hooks/index.ts desktop/src/hooks/useSales.ts | head -5
```

Expected: it's exported from `useSales` and re-exported from `hooks`. If not, add `export` in front of the interface declaration.

- [ ] **Step 2: Create the modal file**

Create `desktop/src/components/sales/BrandCleanupModal.tsx`:

```tsx
import { Tag, X } from 'lucide-react';
import type { BrandVariation } from '../../hooks';

export interface BrandCleanupModalProps {
  open: boolean;
  variations: BrandVariation[];
  inProgress: boolean;
  onClose: () => void;
  onMerge: (variation: BrandVariation) => void;
  onAutoFixAll: () => void;
}

export function BrandCleanupModal({
  open,
  variations,
  inProgress,
  onClose,
  onMerge,
  onAutoFixAll,
}: BrandCleanupModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border-subtle rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Brand Cleanup</h3>
          <button onClick={onClose} className="p-1 hover:bg-bg-tertiary rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {variations.length === 0 ? (
          <div className="text-center py-8 text-text-secondary">
            <Tag className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No brand variations found. Your brands are clean!</p>
          </div>
        ) : (
          <>
            <p className="text-text-secondary text-sm mb-4">
              Found {variations.length} brand groups with inconsistent naming. Click &quot;Fix&quot; to merge variations into the suggested name.
            </p>

            <div className="flex-1 overflow-y-auto space-y-3">
              {variations.map((variation, idx) => (
                <div key={idx} className="p-3 bg-bg-secondary border border-border-subtle rounded-lg">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <div className="text-sm font-medium min-w-0 truncate">
                      <span className="text-text-secondary">
                        {variation.variations.filter((v) => v !== variation.suggested).join(', ')}
                      </span>
                      <span className="text-text-tertiary mx-2">→</span>
                      <span className="text-accent">{variation.suggested}</span>
                    </div>
                    <button
                      onClick={() => onMerge(variation)}
                      disabled={!variation.suggested}
                      className="px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent/90 shrink-0 disabled:opacity-50"
                    >
                      Fix
                    </button>
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {variation.totalCount} {variation.totalCount === 1 ? 'item' : 'items'}
                    {variation.suggested ? ` will be renamed to "${variation.suggested}"` : ''}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-border-subtle">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={onAutoFixAll}
                disabled={inProgress}
                className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50"
              >
                {inProgress ? 'Fixing...' : 'Auto-Fix All'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace the JSX in `Sales.tsx`**

Find `{/* Brand Cleanup Modal */}` (around line 3068). Replace the block from `{showBrandCleanup && (` through its matching `)}` (roughly 3069-3136) with:

```tsx
      {/* Brand Cleanup Modal */}
      <BrandCleanupModal
        open={showBrandCleanup}
        variations={brandVariations}
        inProgress={cleanupInProgress}
        onClose={() => setShowBrandCleanup(false)}
        onMerge={handleMergeBrand}
        onAutoFixAll={handleAutoFixBrands}
      />
```

- [ ] **Step 4: Add the import**

At the top of `Sales.tsx`:

```typescript
import { BrandCleanupModal } from '../components/sales/BrandCleanupModal';
```

- [ ] **Step 5: Verify**

Run `npm run dev`. Click "Clean Brands" in the toolbar. Modal opens. If variations exist, click "Fix" on one — confirm the merge happens (toast, list updates). Click "Auto-Fix All" — confirm bulk merge. Cancel/× closes. Backdrop click closes.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/components/sales/BrandCleanupModal.tsx desktop/src/pages/Sales.tsx
git commit -m "refactor(sales): extract BrandCleanupModal

Pure presentational modal. All state and handlers stay in the parent;
the modal only needs open + variations + three callbacks."
```

---

### Task 8: Extract `CreateRuleModal`

Lives at `Sales.tsx:3221-3362`. Reads `createRuleModal` state object plus `selectedItems.size` and several handlers (`togglePattern`, `closeCreateRuleModal`, `handleSaveRule`). Strategy: move the local UI state inward (the draft text fields are local), but keep the patterns and the save flow in the parent because they depend on `selectedItems`, `apiClient`, and `runOnTransactions`.

**Files:**
- Create: `desktop/src/components/sales/CreateRuleModal.tsx`
- Modify: `desktop/src/pages/Sales.tsx`

- [ ] **Step 1: Decide what's local**

The parent currently owns one big `CreateRuleModalState` object containing: `open`, `patterns`, `ruleName`, `ruleDescription`, `actionType`, `actionValue`, `applyImmediately`, `saving`.

- `open`, `patterns`, `saving` — parent (depends on selection)
- `ruleName`, `ruleDescription`, `actionType`, `actionValue`, `applyImmediately`, plus the `selected` flag inside each pattern — local to the modal

We'll pass `patterns` in and use a local copy that supports toggling. On save, the modal calls `onSave(payload)` with the local draft.

- [ ] **Step 2: Define the payload type in Sales.tsx**

Near the `MassEditPayload` interface added in Task 6, add:

```typescript
export interface CreateRulePayload {
  ruleName: string;
  ruleDescription: string;
  actionType: 'set_brand' | 'exclude' | 'map_product';
  actionValue: string;
  applyImmediately: boolean;
  selectedPatternIds: string[];
}
```

Also export the `DetectedPattern` interface (it's defined at `Sales.tsx:48-54`). Find its declaration and add `export`:

```typescript
export interface DetectedPattern {
  id: string;
  field: 'description' | 'title' | 'brand';
  value: string;
  count: number;
  selected: boolean;
}
```

- [ ] **Step 3: Create the modal file**

Create `desktop/src/components/sales/CreateRuleModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Check, RefreshCw, X, Zap } from 'lucide-react';
import type { CreateRulePayload, DetectedPattern } from '../../pages/Sales';

export interface CreateRuleModalProps {
  open: boolean;
  patterns: DetectedPattern[];      // parent supplies; modal lets user toggle locally
  selectedItemCount: number;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: CreateRulePayload) => void;
}

export function CreateRuleModal({
  open,
  patterns,
  selectedItemCount,
  saving,
  onClose,
  onSave,
}: CreateRuleModalProps) {
  const [draftPatterns, setDraftPatterns] = useState<DetectedPattern[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const [actionType, setActionType] = useState<'set_brand' | 'exclude' | 'map_product'>('set_brand');
  const [actionValue, setActionValue] = useState('');
  const [applyImmediately, setApplyImmediately] = useState(true);

  useEffect(() => {
    if (open) {
      setDraftPatterns(patterns.map((p) => ({ ...p })));
      setRuleName('');
      setRuleDescription('');
      setActionType('set_brand');
      setActionValue('');
      setApplyImmediately(true);
    }
  }, [open, patterns]);

  if (!open) return null;

  const togglePattern = (id: string) => {
    setDraftPatterns((prev) => prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)));
  };

  const selectedCount = draftPatterns.filter((p) => p.selected).length;
  const canSave = !saving && ruleName.trim().length > 0 && selectedCount > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      ruleName: ruleName.trim(),
      ruleDescription: ruleDescription.trim(),
      actionType,
      actionValue: actionValue.trim(),
      applyImmediately,
      selectedPatternIds: draftPatterns.filter((p) => p.selected).map((p) => p.id),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border-subtle rounded-xl p-6 max-w-xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            Create Rule from Selection
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-bg-tertiary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Rule Name *</label>
            <input
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="e.g., Nike Products"
              className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              Detected Patterns ({selectedCount} selected)
            </label>
            <div className="bg-bg-secondary border border-border-subtle rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto">
              {draftPatterns.length === 0 ? (
                <p className="text-sm text-text-tertiary italic">No common patterns detected in selected items.</p>
              ) : (
                draftPatterns.map((pattern) => (
                  <label key={pattern.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-bg-tertiary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pattern.selected}
                      onChange={() => togglePattern(pattern.id)}
                      className="rounded border-border-subtle"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-text-primary">
                        {pattern.field === 'brand' ? 'Brand: ' : 'Title contains: '}
                        <span className="text-accent">&quot;{pattern.value}&quot;</span>
                      </span>
                      <span className="ml-2 text-xs text-text-tertiary">({pattern.count} items)</span>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">When Matched, Action:</label>
            <div className="flex items-center gap-3">
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as 'set_brand' | 'exclude' | 'map_product')}
                className="px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm focus:outline-none focus:border-accent"
              >
                <option value="set_brand">Set Brand</option>
                <option value="map_product">Map to Product</option>
                <option value="exclude">Exclude from Reports</option>
              </select>
              {actionType !== 'exclude' && (
                <input
                  type="text"
                  value={actionValue}
                  onChange={(e) => setActionValue(e.target.value)}
                  placeholder={actionType === 'set_brand' ? 'Brand name' : 'Product name'}
                  className="flex-1 px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm focus:outline-none focus:border-accent"
                />
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={applyImmediately}
              onChange={(e) => setApplyImmediately(e.target.checked)}
              className="rounded border-border-subtle"
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Apply rule immediately</span>
              <p className="text-xs text-text-tertiary">Run this rule on the {selectedItemCount} selected items after saving</p>
            </div>
          </label>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Description (optional)</label>
            <input
              type="text"
              value={ruleDescription}
              onChange={(e) => setRuleDescription(e.target.value)}
              placeholder="Brief description of what this rule does"
              className="w-full px-3 py-2 bg-bg-secondary border border-border-subtle rounded-lg text-sm focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-border-subtle">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                Create Rule
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `handleSaveRule` in the parent to accept the payload**

Find `handleSaveRule` in `Sales.tsx` (search `handleSaveRule = async` — should be near the other Create Rule handlers around line 436+). Rewrite its signature and body to take `payload: CreateRulePayload`. The current implementation reads from `createRuleModal.ruleName`, `createRuleModal.patterns.filter(p => p.selected)`, etc. Replace each `createRuleModal.X` with `payload.X` (mapping `selectedPatterns` to `patterns.filter(p => payload.selectedPatternIds.includes(p.id))` if needed).

Pattern:

```typescript
  const handleSaveRule = async (payload: CreateRulePayload) => {
    if (!payload.ruleName) {
      showToast('Rule name is required', 'error');
      return;
    }
    const selectedPatterns = createRuleModal.patterns.filter((p) => payload.selectedPatternIds.includes(p.id));
    if (selectedPatterns.length === 0) {
      showToast('Select at least one pattern', 'error');
      return;
    }
    setCreateRuleModal((prev) => ({ ...prev, saving: true }));
    try {
      // ... existing addRule call, using payload.ruleName / payload.ruleDescription / payload.actionType / payload.actionValue / payload.applyImmediately
      // Keep the rest of the existing logic intact — only the input source changes.
    } finally {
      setCreateRuleModal((prev) => ({ ...prev, saving: false, open: false }));
    }
  };
```

> Read the original `handleSaveRule` carefully and preserve every behavior; only replace state reads with payload reads.

- [ ] **Step 5: Slim down `createRuleModal` state in the parent**

The state object now only needs `open`, `patterns`, and `saving`. Find `CreateRuleModalState` (lines 56-65) and replace with:

```typescript
interface CreateRuleModalState {
  open: boolean;
  patterns: DetectedPattern[];
  saving: boolean;
}
```

Find the `useState` initializer (around line 197) and trim to:

```typescript
  const [createRuleModal, setCreateRuleModal] = useState<CreateRuleModalState>({
    open: false,
    patterns: [],
    saving: false,
  });
```

Also remove `togglePattern` from the parent if it's no longer referenced — search for `togglePattern` usages to confirm.

- [ ] **Step 6: Replace the JSX**

Find `{/* Create Rule Modal */}` (around line 3220). Replace the block from `{createRuleModal.open && (` through its matching `)}` with:

```tsx
      {/* Create Rule Modal */}
      <CreateRuleModal
        open={createRuleModal.open}
        patterns={createRuleModal.patterns}
        selectedItemCount={selectedItems.size}
        saving={createRuleModal.saving}
        onClose={closeCreateRuleModal}
        onSave={(payload) => void handleSaveRule(payload)}
      />
```

- [ ] **Step 7: Add the import**

```typescript
import { CreateRuleModal } from '../components/sales/CreateRuleModal';
```

- [ ] **Step 8: Verify**

Run `npm run dev`. Select 5+ items that share a brand or title pattern. Trigger Create Rule (right-click → "Create Rule from Selection" or whichever existing entry point fires it — verify the same trigger still opens the modal). Type a name, select a pattern, choose "Set Brand" with a value, leave "Apply immediately" checked, click "Create Rule". Confirm: toast, modal closes, rule is created (check the Rules screen if accessible), the selected items now have the brand applied. Reopen — name and selections are reset.

- [ ] **Step 9: Commit**

```bash
git add desktop/src/components/sales/CreateRuleModal.tsx desktop/src/pages/Sales.tsx
git commit -m "refactor(sales): extract CreateRuleModal

Draft state (name, description, action, pattern toggles) moves into
the modal. Parent keeps the patterns list and save flow. Closes the
modal-extraction series for this PR."
```

---

## Phase D — Final pass

### Task 9: Type-check and lint the whole change

- [ ] **Step 1: Type-check**

```bash
cd desktop && npm run build
```

Expected: clean TypeScript build. Fix any errors before continuing — common ones will be missing imports for `MassEditPayload` / `CreateRulePayload` / `DetectedPattern` in the new files (they import from `'../../pages/Sales'` — confirm those exports exist).

- [ ] **Step 2: Lint**

If the repo has a lint script (`npm run lint`), run it and fix any new violations.

- [ ] **Step 3: Spot-check the line count delta**

```bash
wc -l desktop/src/pages/Sales.tsx desktop/src/components/sales/*.tsx
```

Expected: `Sales.tsx` is now around 2,600-2,800 lines (down from 3,365). Three new files in `components/sales/`.

- [ ] **Step 4: Final smoke test**

Run `npm run dev`. Walk the full Sales flow:
1. Select a show → table loads.
2. Filter panel opens, badge accurate, "Clear all" appears with active filters.
3. Active chips appear above the panel; remove one chip — filter clears.
4. Inline edit a brand cell → saves.
5. Select rows → Mass Edit modal works end to end.
6. Brand Cleanup modal opens, fix one variation works.
7. Create Rule from selection works.

- [ ] **Step 5: Commit any final cleanup, then push**

If lint/type-check produced small fixups:

```bash
git add -A
git commit -m "chore(sales): typecheck + lint fixups"
```

Then push the branch and open a PR.

---

## Self-Review Notes

- **Spec coverage:** Foundation scope = Tier 1 bugs (Tasks 1–3) + clear-all (Task 4) + chips (Task 5) + file split (Tasks 6–8) + final pass (Task 9). All four chosen items present.
- **Type consistency:** `MassEditPayload`, `CreateRulePayload`, `DetectedPattern` are all defined in `Sales.tsx` and imported from `'../../pages/Sales'` by the new modal components. `SalesFilterValues` re-imported in `SalesActiveFilters.tsx` from `./SalesFilterBar`. Verify these import paths during Task 6/8 setup.
- **No test infrastructure:** Manual verification only. Each task names exact clicks and expected outcomes.
- **Backup:** `Sales.tsx.bak-2026-05-13` exists. If any task goes sideways, `cp desktop/src/pages/Sales.tsx.bak-2026-05-13 desktop/src/pages/Sales.tsx` restores it. Add `.bak-*` to `.gitignore` or delete the backup before final commit if it shouldn't be tracked.

