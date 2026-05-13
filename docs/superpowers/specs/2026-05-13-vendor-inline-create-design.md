# Inline Vendor Create from Add Expense Modal

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan
**Scope:** Web app only (`web/`)

## Goal

Add a vendor picker to the existing Add Expense modal (`web/src/app/(dashboard)/expenses/page.tsx`) that lets users either select an existing vendor or create a new one inline by typing a name. Eliminates the context switch to `/vendors` just to register a payee while logging an expense.

## Background

- The Add Expense modal today has only Date, Amount, Category, Notes. It does **not** expose vendor at all.
- The backend already supports vendors on expenses:
  - `POST /api/expenses` accepts an optional `vendorId` and validates it against `tenantId`.
  - `GET /api/vendors` returns active vendors with `defaultCategoryId`.
  - `POST /api/vendors` creates a vendor from `{ name, notes?, defaultCategoryId? }`.
- Both vendor endpoints require permission `expenses.edit` — the same permission that already gates the Add Expense submit. No permission surface change.
- A larger desktop "QuickBooks-style expenses rework" exists in `docs/superpowers/plans/2026-04-28-expenses-quickbooks-rework.md`. This spec is intentionally **independent** of that work — it's a minimal addition to the existing web modal and does not pre-empt that plan.

## Non-goals

- Inline editing of vendor default category, notes, or any other field beyond `name`.
- A vendor filter on the expense list/table.
- Splits, payment accounts, receipt attachments, or any other field from the larger rework.
- Changes to the standalone `/vendors` page.
- Edit/archive controls on existing vendors from within the combobox.

## UX

### Vendor field placement
Between **Amount** and **Category** in the Add Expense modal. The field is **optional** (matches the API contract — `vendorId` is nullable).

### Type-and-create combobox
Text input + popover dropdown.

- Dropdown is populated from a vendor list the parent fetches once when the modal opens.
- Filtering: case-insensitive substring match on `name`.
- **Create row:** if the trimmed query is non-empty and no existing vendor has an exact (case-insensitive) name match, the last row in the dropdown reads `Create "<query>"`. Selecting it creates the vendor and selects it.
- Selected vendor: input shows the vendor's name. An `×` button on the right clears the selection.
- Keyboard: ↑ / ↓ move highlight, Enter selects the highlighted row (including the Create row), Escape closes the dropdown.
- Styling matches the modal's other inputs: `bg-bg-tertiary`, `border-border-subtle`, accent-coloured focus ring.

### Default category auto-fill
When a vendor is selected and that vendor has `defaultCategoryId !== null`:

- If the form's Category field is currently empty (`categoryId === ""`), prefill it with `String(vendor.defaultCategoryId)`.
- If the user has already chosen a category, **do not overwrite**.

This matches QuickBooks behavior and avoids surprising the user after they've made an explicit category choice.

## Architecture

### New component
`web/src/components/expenses/VendorCombobox.tsx`

Props:
```ts
interface VendorOption {
  id: number;
  name: string;
  defaultCategoryId: number | null;
}

interface VendorComboboxProps {
  vendors: VendorOption[];
  value: number | null;
  onChange: (vendor: VendorOption | null) => void;
  onCreate: (name: string) => Promise<VendorOption>;
  disabled?: boolean;
}
```

Internal state: search query string, open/closed, highlighted index.

The combobox is purely presentational — it does no fetching of its own. The parent owns the vendor list and the create call, so the component is reusable elsewhere later (e.g., on the receipts inbox drawer) without coupling it to any specific endpoint.

### Modal wiring
`web/src/app/(dashboard)/expenses/page.tsx`

Changes:

1. Fetch `/api/vendors` in parallel with the existing data fetch (or lazily on first modal open — implementation plan will pick one; both are fine). Store as `vendors: VendorOption[]`.
2. When `POST /api/vendors` creates a new vendor, append the returned vendor to local `vendors` state.
3. Extend `newExpense` state shape:
   ```ts
   {
     date: string;
     amount: string;
     categoryId: string;
     vendorId: number | null;   // NEW
     notes: string;
   }
   ```
4. Insert `<VendorCombobox>` between Amount and Category.
5. `onChange(vendor)` handler:
   - Set `vendorId = vendor?.id ?? null`.
   - If `vendor?.defaultCategoryId` is set **and** `newExpense.categoryId === ""`, set `categoryId = String(vendor.defaultCategoryId)`.
6. `onCreate(name)` handler:
   - `POST /api/vendors` with `{ name }` (no notes, no default category in the inline flow).
   - On success, append the returned vendor to local `vendors`, return it.
   - On error, surface via `alert(...)` (consistent with existing error handling in this file).
7. Include `vendorId` in the `POST /api/expenses` body.
8. Reset `vendorId: null` when the modal closes or submit succeeds (alongside the existing reset of other fields).

### API
No changes. The existing `GET /api/vendors` and `POST /api/vendors` cover both the read and the create. Both already enforce `tenantId` scoping and `expenses.edit` permission.

## Data flow

```
User opens modal
  └─ parent fetches /api/vendors → vendors state

User types "Acm" in vendor field
  └─ combobox filters list locally; "Acme Co" matches

User picks "Acme Co"
  └─ onChange({id: 5, name: "Acme Co", defaultCategoryId: 3})
      ├─ vendorId = 5
      └─ if categoryId === "" → categoryId = "3"

— OR —

User types "New Vendor X" (no match)
  └─ combobox shows: Create "New Vendor X"
  └─ User selects it → onCreate("New Vendor X")
      └─ POST /api/vendors {name}
      └─ returned vendor appended to local list
      └─ onChange(newVendor)
          └─ vendorId = newVendor.id
          └─ defaultCategoryId is null on a freshly-created vendor → no category fill

User submits
  └─ POST /api/expenses { ..., vendorId }
```

## Error handling

- **Create vendor fails** (network, duplicate name, validation): show `alert(err.message)`. The combobox stays open with the query intact so the user can adjust and retry. Selection is unchanged.
- **Duplicate name (case-sensitive at the DB level via `vendors_name_tenant_id_key`):** The API currently returns the Prisma error verbatim. Out of scope to refine here; if it becomes a usability issue we can polish later. The inline Create row already suppresses on **case-insensitive** exact match, which prevents the common case.
- **Empty/whitespace-only query:** the Create row does not appear (we require non-empty trimmed query).

## Testing

### Unit (`VendorCombobox`)
- Filters list by case-insensitive substring.
- Create row appears when query is non-empty and has no exact (case-insensitive) match.
- Create row is suppressed when query exactly matches an existing vendor (case-insensitive).
- Create row is suppressed when query is empty or whitespace-only.
- Keyboard nav: ↑/↓ moves highlight, Enter triggers select on highlighted row, Escape closes.
- Clear button calls `onChange(null)`.
- `onCreate` is awaited and the returned vendor is passed to `onChange`.

### Integration (modal)
- Selecting a vendor with `defaultCategoryId` while Category is empty auto-fills Category.
- Selecting a vendor with `defaultCategoryId` while Category is already chosen leaves Category alone.
- Inline create round-trip: type → Create → vendor appears in subsequent dropdown queries → expense submit includes the new `vendorId`.

### Manual
- Full modal flow end-to-end against the dev server, including: existing vendor, new vendor, clear, auto-fill happens, auto-fill does not overwrite, submit succeeds.

## Files

| Path | Change |
|---|---|
| `web/src/components/expenses/VendorCombobox.tsx` | New |
| `web/src/components/expenses/__tests__/VendorCombobox.test.tsx` | New |
| `web/src/app/(dashboard)/expenses/page.tsx` | Modify — fetch vendors, add field, auto-fill logic, include `vendorId` in submit |

No DB migration. No API change. No permission change.
