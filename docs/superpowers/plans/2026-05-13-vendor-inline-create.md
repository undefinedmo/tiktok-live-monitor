# Inline Vendor Create from Add Expense Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a type-and-create vendor picker to the Add Expense modal in the web app so users can select an existing vendor or create a new one inline.

**Architecture:** A new presentational `VendorCombobox` React component renders a searchable dropdown with a `Create "<query>"` row when no exact match exists. The parent (Add Expense modal in `expenses/page.tsx`) owns the vendor list, fetches `/api/vendors`, handles inline creation via `POST /api/vendors`, and applies the "auto-fill category from vendor default only if Category is empty" rule. The pure filtering and Create-row logic is extracted into `vendor-combobox-helpers.ts` so it can be unit-tested with vitest (existing test infrastructure is Node-only — no jsdom / React Testing Library in this repo).

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, vitest (Node env).

**Spec:** `docs/superpowers/specs/2026-05-13-vendor-inline-create-design.md`

**File map:**

| Path | Change |
|---|---|
| `web/src/components/expenses/vendor-combobox-helpers.ts` | New — pure functions: `filterVendors`, `shouldShowCreateRow` |
| `web/src/components/expenses/__tests__/vendor-combobox-helpers.test.ts` | New — vitest unit tests for the helpers |
| `web/src/components/expenses/VendorCombobox.tsx` | New — React component, uses helpers |
| `web/src/app/(dashboard)/expenses/page.tsx` | Modify — fetch vendors, add field to modal, auto-fill logic, include `vendorId` in submit |

No DB migration. No API change. No permission change.

---

## Task 1: Pure helpers for vendor filtering and Create-row decision

**Files:**
- Create: `web/src/components/expenses/vendor-combobox-helpers.ts`
- Test: `web/src/components/expenses/__tests__/vendor-combobox-helpers.test.ts`

This task isolates the testable logic so it can be covered by vitest without setting up jsdom. The React component in Task 2 will import these functions.

- [ ] **Step 1: Write the failing tests**

Create `web/src/components/expenses/__tests__/vendor-combobox-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterVendors, shouldShowCreateRow, type VendorOption } from '../vendor-combobox-helpers';

const vendors: VendorOption[] = [
  { id: 1, name: 'Acme Co',       defaultCategoryId: 3 },
  { id: 2, name: 'Acme Supplies', defaultCategoryId: null },
  { id: 3, name: 'Beta Corp',     defaultCategoryId: 5 },
];

describe('filterVendors', () => {
  it('returns all vendors when query is empty', () => {
    expect(filterVendors(vendors, '')).toEqual(vendors);
    expect(filterVendors(vendors, '   ')).toEqual(vendors);
  });

  it('filters by case-insensitive substring on name', () => {
    expect(filterVendors(vendors, 'acme').map((v) => v.id)).toEqual([1, 2]);
    expect(filterVendors(vendors, 'CORP').map((v) => v.id)).toEqual([3]);
    expect(filterVendors(vendors, 'supp').map((v) => v.id)).toEqual([2]);
  });

  it('returns empty list when no vendor matches', () => {
    expect(filterVendors(vendors, 'zzz')).toEqual([]);
  });
});

describe('shouldShowCreateRow', () => {
  it('is false when the trimmed query is empty', () => {
    expect(shouldShowCreateRow(vendors, '')).toBe(false);
    expect(shouldShowCreateRow(vendors, '   ')).toBe(false);
  });

  it('is true when the query has no case-insensitive exact match', () => {
    expect(shouldShowCreateRow(vendors, 'New Vendor')).toBe(true);
    expect(shouldShowCreateRow(vendors, 'acme')).toBe(true); // partial match only
  });

  it('is false when the query exactly matches a vendor name (case-insensitive)', () => {
    expect(shouldShowCreateRow(vendors, 'Acme Co')).toBe(false);
    expect(shouldShowCreateRow(vendors, 'acme co')).toBe(false);
    expect(shouldShowCreateRow(vendors, '  ACME CO  ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `web/`:
```bash
npx vitest run src/components/expenses/__tests__/vendor-combobox-helpers.test.ts
```

Expected: FAIL — module `../vendor-combobox-helpers` not found.

- [ ] **Step 3: Implement the helpers**

Create `web/src/components/expenses/vendor-combobox-helpers.ts`:

```ts
export interface VendorOption {
  id: number;
  name: string;
  defaultCategoryId: number | null;
}

export function filterVendors(vendors: VendorOption[], query: string): VendorOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return vendors;
  return vendors.filter((v) => v.name.toLowerCase().includes(q));
}

export function shouldShowCreateRow(vendors: VendorOption[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return !vendors.some((v) => v.name.toLowerCase() === q);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `web/`:
```bash
npx vitest run src/components/expenses/__tests__/vendor-combobox-helpers.test.ts
```

Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/expenses/vendor-combobox-helpers.ts web/src/components/expenses/__tests__/vendor-combobox-helpers.test.ts
git commit -m "feat(expenses): add vendor-combobox filter and create-row helpers"
```

---

## Task 2: VendorCombobox React component

**Files:**
- Create: `web/src/components/expenses/VendorCombobox.tsx`

This is a presentational component. It does no data fetching — the parent owns the vendor list and the create call. It does not have an automated test in this plan (no jsdom infrastructure exists in this repo, and the testable logic is already covered by Task 1 helpers). Manual verification happens in Task 4.

- [ ] **Step 1: Create the component file**

Create `web/src/components/expenses/VendorCombobox.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  filterVendors,
  shouldShowCreateRow,
  type VendorOption,
} from "./vendor-combobox-helpers";

interface VendorComboboxProps {
  vendors: VendorOption[];
  value: number | null;
  onChange: (vendor: VendorOption | null) => void;
  onCreate: (name: string) => Promise<VendorOption>;
  disabled?: boolean;
  placeholder?: string;
}

export function VendorCombobox({
  vendors,
  value,
  onChange,
  onCreate,
  disabled = false,
  placeholder = "Select or create a vendor...",
}: VendorComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => vendors.find((v) => v.id === value) ?? null,
    [vendors, value],
  );

  const filtered = useMemo(() => filterVendors(vendors, query), [vendors, query]);
  const showCreate = shouldShowCreateRow(vendors, query);
  const rowCount = filtered.length + (showCreate ? 1 : 0);

  // Keep highlight in range as the list changes.
  useEffect(() => {
    setHighlight((h) => (rowCount === 0 ? 0 : Math.min(h, rowCount - 1)));
  }, [rowCount]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selectExisting = (vendor: VendorOption) => {
    onChange(vendor);
    setQuery("");
    setOpen(false);
  };

  const selectCreate = async () => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const created = await onCreate(name);
      onChange(created);
      setQuery("");
      setOpen(false);
    } catch {
      // Parent surfaces the error; keep the popover open so the user can retry.
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (rowCount === 0 ? 0 : (h + 1) % rowCount));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (rowCount === 0 ? 0 : (h - 1 + rowCount) % rowCount));
    } else if (e.key === "Enter") {
      if (!open || rowCount === 0) return;
      e.preventDefault();
      if (highlight < filtered.length) {
        selectExisting(filtered[highlight]);
      } else if (showCreate) {
        void selectCreate();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const inputValue = selected && !open ? selected.name : query;

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (selected) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="w-full px-4 py-2 pr-9 bg-bg-tertiary border border-border-subtle rounded-lg focus:border-accent focus:ring-2 focus:ring-accent/20 text-text-primary placeholder:text-text-tertiary disabled:opacity-60"
        />
        {selected && !disabled && (
          <button
            type="button"
            aria-label="Clear vendor"
            onClick={() => {
              onChange(null);
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {open && rowCount > 0 && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-border-subtle bg-bg-secondary py-1 shadow-lg"
        >
          {filtered.map((vendor, i) => (
            <li
              key={vendor.id}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                selectExisting(vendor);
              }}
              className={`cursor-pointer px-4 py-2 text-sm ${
                i === highlight
                  ? "bg-bg-tertiary text-text-primary"
                  : "text-text-secondary"
              }`}
            >
              {vendor.name}
            </li>
          ))}
          {showCreate && (
            <li
              role="option"
              aria-selected={highlight === filtered.length}
              onMouseEnter={() => setHighlight(filtered.length)}
              onMouseDown={(e) => {
                e.preventDefault();
                void selectCreate();
              }}
              className={`cursor-pointer px-4 py-2 text-sm border-t border-border-subtle ${
                highlight === filtered.length
                  ? "bg-bg-tertiary text-accent"
                  : "text-accent"
              } ${creating ? "opacity-60" : ""}`}
            >
              {creating ? `Creating "${query.trim()}"...` : `Create "${query.trim()}"`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the component compiles**

Run from `web/`:
```bash
npx tsc --noEmit
```

Expected: clean (no new errors introduced by this file).

- [ ] **Step 3: Commit**

```bash
git add web/src/components/expenses/VendorCombobox.tsx
git commit -m "feat(expenses): add VendorCombobox component with type-and-create"
```

---

## Task 3: Wire the combobox into the Add Expense modal

**Files:**
- Modify: `web/src/app/(dashboard)/expenses/page.tsx`

Add vendor state and fetch, render the combobox between Amount and Category, apply the auto-fill rule, and include `vendorId` in the submit body. The reset on close/submit also clears `vendorId`.

- [ ] **Step 1: Add the import and the VendorOption type to the imports**

In `web/src/app/(dashboard)/expenses/page.tsx`, add to the existing imports block near the top:

```tsx
import { VendorCombobox } from "@/components/expenses/VendorCombobox";
import type { VendorOption } from "@/components/expenses/vendor-combobox-helpers";
```

- [ ] **Step 2: Add vendors state and extend `newExpense` shape**

Inside the `ExpensesPage` component, alongside the existing `useState` calls, add:

```tsx
const [vendors, setVendors] = useState<VendorOption[]>([]);
```

Update the `newExpense` initializer (currently at lines 70–75) to include `vendorId`:

```tsx
const [newExpense, setNewExpense] = useState<{
  date: string;
  amount: string;
  categoryId: string;
  vendorId: number | null;
  notes: string;
}>({
  date: new Date().toISOString().split("T")[0],
  amount: "",
  categoryId: "",
  vendorId: null,
  notes: "",
});
```

- [ ] **Step 3: Fetch vendors on mount**

Add a new effect immediately after the existing `useEffect(() => { fetchExpenses(); }, [fetchExpenses]);` block:

```tsx
useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch("/api/vendors");
      const json = await res.json();
      if (!cancelled && res.ok && json.success) {
        const list: VendorOption[] = (json.data?.vendors ?? []).map(
          (v: { id: number; name: string; defaultCategoryId: number | null }) => ({
            id: v.id,
            name: v.name,
            defaultCategoryId: v.defaultCategoryId,
          }),
        );
        setVendors(list);
      }
    } catch {
      // Non-blocking — the modal is still usable without vendor data.
    }
  })();
  return () => {
    cancelled = true;
  };
}, []);
```

- [ ] **Step 4: Add the vendor-create handler and the combobox handlers**

Add the following helpers inside `ExpensesPage`, above the `return` statement:

```tsx
const createVendor = async (name: string): Promise<VendorOption> => {
  const res = await fetch("/api/vendors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const json = await res.json();
  if (!res.ok || !json.success) {
    const message = json.error || "Failed to create vendor";
    alert(message);
    throw new Error(message);
  }
  const v = json.data.vendor;
  const created: VendorOption = {
    id: v.id,
    name: v.name,
    defaultCategoryId: v.defaultCategoryId ?? null,
  };
  setVendors((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
  return created;
};

const handleVendorChange = (vendor: VendorOption | null) => {
  setNewExpense((prev) => {
    const next = { ...prev, vendorId: vendor?.id ?? null };
    if (
      vendor &&
      vendor.defaultCategoryId != null &&
      prev.categoryId === ""
    ) {
      next.categoryId = String(vendor.defaultCategoryId);
    }
    return next;
  });
};
```

- [ ] **Step 5: Insert the vendor field into the modal form**

In the JSX inside the `<Modal>` (between the Amount field and the Category field — current lines ~412 to ~414), insert:

```tsx
<div>
  <label className="block text-sm font-medium text-text-secondary mb-1">
    Vendor
  </label>
  <VendorCombobox
    vendors={vendors}
    value={newExpense.vendorId}
    onChange={handleVendorChange}
    onCreate={createVendor}
  />
</div>
```

So the form ordering becomes: Date → Amount → **Vendor** → Category → Notes.

- [ ] **Step 6: Include `vendorId` in the submit body and reset it on success**

In `handleAddExpense`, update the `fetch` body to include `vendorId`:

```tsx
const response = await fetch("/api/expenses", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    date: newExpense.date,
    amount: newExpense.amount,
    categoryId: newExpense.categoryId,
    vendorId: newExpense.vendorId,
    notes: newExpense.notes,
  }),
});
```

And update the reset block (currently `setNewExpense({ date: ..., amount: "", categoryId: "", notes: "" })`) to include `vendorId: null`:

```tsx
setNewExpense({
  date: new Date().toISOString().split("T")[0],
  amount: "",
  categoryId: "",
  vendorId: null,
  notes: "",
});
```

- [ ] **Step 7: Typecheck**

Run from `web/`:
```bash
npx tsc --noEmit
```

Expected: clean (no new errors).

- [ ] **Step 8: Run the existing test suite to make sure nothing regressed**

Run from `web/`:
```bash
npx vitest run
```

Expected: all tests pass, including the new `vendor-combobox-helpers.test.ts` from Task 1.

- [ ] **Step 9: Commit**

```bash
git add web/src/app/\(dashboard\)/expenses/page.tsx
git commit -m "feat(expenses): inline vendor picker on Add Expense modal"
```

---

## Task 4: Manual verification against dev server

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run from `web/`:
```bash
npm run dev
```

Navigate to `http://localhost:3000/expenses` and log in.

- [ ] **Step 2: Verify the picker shows existing vendors**

1. Click **Add Expense**.
2. Click into the Vendor field.
3. Confirm the dropdown lists existing vendors (or is empty if there are none).
4. Type a partial name → list filters case-insensitively.

- [ ] **Step 3: Verify inline create**

1. Type a brand-new vendor name (e.g., `Test Vendor 2026-05-13`).
2. Confirm the last row says `Create "Test Vendor 2026-05-13"`.
3. Click that row.
4. Confirm the input updates to the new vendor name and the dropdown closes.
5. Confirm the vendor appears in subsequent dropdown queries from the same modal.

- [ ] **Step 4: Verify auto-fill rule for default category**

1. In a separate browser tab, go to `/vendors` and create a vendor with a default category set, or pick an existing one that has one (check the Default Category column).
2. Back on `/expenses`, open Add Expense. Leave Category empty.
3. Select the vendor with a default category in the combobox.
4. Confirm the Category dropdown auto-fills to that vendor's default.
5. Clear the vendor (× button), reset, then **manually choose a different Category first**, then select the same vendor. Confirm Category is **not** overwritten.

- [ ] **Step 5: Verify exact-match suppression**

1. Type the exact name (case-insensitively) of an existing vendor.
2. Confirm the Create row does **not** appear at the bottom.

- [ ] **Step 6: Verify submit includes the vendor**

1. Fill in Date, Amount, pick or create a Vendor, optionally a Category, submit.
2. Confirm the expense appears (after refresh if needed) and that querying `/api/expenses` returns it with the expected `vendorId`/`vendorName`.

If everything passes, the work is done. If anything fails, stop and report — do not amend the previous commits.

---

## Self-review (already performed by plan author)

- **Spec coverage:** every section of the spec maps to a task — helpers (Task 1), component (Task 2), modal wiring + auto-fill + submit (Task 3), manual verification (Task 4).
- **Deviation from spec — testing strategy:** the spec called for unit tests on the React component. This repo has no jsdom / React Testing Library setup (`vitest.config.ts` matches only `*.test.ts`, env: `node`). Rather than bootstrap that infrastructure for one component, the testable logic was extracted into pure helpers (`vendor-combobox-helpers.ts`) with proper unit tests, and the React layer is covered by manual verification in Task 4. This deviation should be flagged to the user before execution if they want full component tests instead.
- **Placeholders:** none — every code step contains the exact code to write.
- **Type consistency:** `VendorOption` (`{ id; name; defaultCategoryId }`) is used identically across helpers, component, and modal. The component prop names match between Task 2's definition and Task 3's usage.
