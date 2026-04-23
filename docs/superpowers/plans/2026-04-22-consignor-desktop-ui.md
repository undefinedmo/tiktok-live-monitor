# Consignor Feature — Desktop UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the consignor management UI in the desktop app on top of the backend APIs from `2026-04-22-consignor-backend.md`. Operator can create consignors, set up consignments (deals), see balances, settle payouts (with PDF/CSV download), and assign consignments via the existing Rules UI.

**Architecture:** Three new hooks (`useConsignors`, `useConsignments`, `useConsignorPayouts`) wrapping the new web API endpoints via the existing `apiClient`. Three new pages (`Consignors`, `ConsignorDetail`, `ConsignmentDetail`) following the `Customers.tsx` page pattern. One new modal (`PayoutModal`). One small surgical edit to the existing `Rules.tsx` to add a "Set Consignment" action option. New nav item under "Operations" group in `Layout.tsx`.

**Tech Stack:** React 19, TypeScript, Vite, Electron, Tailwind, react-router-dom, lucide-react. Shared components from `@sellerfolio/shared`.

**Spec:** `docs/superpowers/specs/2026-04-22-consignor-design.md` (section 7 — UI)

**Conventions for this work (deviation from legacy desktop):**
- New consignor hooks use **camelCase** TypeScript types (matching the API response shape directly). The legacy desktop convention is snake_case (`is_enabled`, `created_at`), but transforming Prisma-camelCase to snake_case just to retransform back is wasteful. The consignor surface is self-contained, so consistency with the API wins. This deviation should be noted at the top of the new hooks files.

**Out of scope (deferred to follow-on plan):**
- Sales/Items table "Consignor" column + filter + bulk-assign action
- Item edit drawer "consignment" picker
- Cross-app web UI mirror (separate plan: `2026-04-22-consignor-web-ui.md`)

---

## File Map

### New files
```
desktop/
├── src/
│   ├── hooks/
│   │   ├── useConsignors.ts            # consignor CRUD + balance
│   │   ├── useConsignments.ts          # consignment CRUD
│   │   └── useConsignorPayouts.ts      # payouts list + create
│   ├── pages/
│   │   ├── Consignors.tsx              # index — list of consignors
│   │   ├── ConsignorDetail.tsx         # detail — consignments + items + payouts tabs
│   │   └── ConsignmentDetail.tsx       # edit form (page, navigated from detail)
│   └── components/
│       ├── PayoutModal.tsx             # "Pay Jeff" modal
│       └── ConsignmentFormModal.tsx    # "New consignment" + "Edit consignment" modal
```

### Modified files
```
desktop/
├── src/
│   ├── App.tsx                          # 3 new routes
│   ├── components/Layout.tsx            # 1 new nav item
│   ├── hooks/index.ts                   # re-export the 3 new hooks
│   └── pages/Rules.tsx                  # add "Set Consignment" action option in the action picker
```

---

## Phase 0 — Nav + route stubs (proves wiring before logic)

### Task 0.1: Add routes and nav item with empty placeholder pages

**Files:**
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src/components/Layout.tsx`
- Create stub: `desktop/src/pages/Consignors.tsx`
- Create stub: `desktop/src/pages/ConsignorDetail.tsx`
- Create stub: `desktop/src/pages/ConsignmentDetail.tsx`

- [ ] **Step 1: Create the three stub pages**

```tsx
// desktop/src/pages/Consignors.tsx
export default function Consignors() {
  return <div className="p-6 text-text-primary">Consignors (coming next phase)</div>;
}
```

```tsx
// desktop/src/pages/ConsignorDetail.tsx
import { useParams } from 'react-router-dom';
export default function ConsignorDetail() {
  const { id } = useParams<{ id: string }>();
  return <div className="p-6 text-text-primary">Consignor {id} (coming next phase)</div>;
}
```

```tsx
// desktop/src/pages/ConsignmentDetail.tsx
import { useParams } from 'react-router-dom';
export default function ConsignmentDetail() {
  const { id } = useParams<{ id: string }>();
  return <div className="p-6 text-text-primary">Consignment {id} (coming next phase)</div>;
}
```

- [ ] **Step 2: Wire routes in `desktop/src/App.tsx`**

Add three imports near the top with the other page imports:
```ts
import Consignors from './pages/Consignors';
import ConsignorDetail from './pages/ConsignorDetail';
import ConsignmentDetail from './pages/ConsignmentDetail';
```

Add three routes inside the `<Routes>` block in the "Operations" section (after the existing Operations routes — `expenses`, `pack-station`, etc.):
```tsx
        <Route path="consignors" element={<Consignors />} />
        <Route path="consignors/:id" element={<ConsignorDetail />} />
        <Route path="consignments/:id" element={<ConsignmentDetail />} />
```

- [ ] **Step 3: Add nav item in `desktop/src/components/Layout.tsx`**

Inside the `navGroups` array, find the "Operations" group. Add a new item to its `items` array:

```ts
      { name: 'Consignors', href: '/consignors', icon: HandCoins },
```

Import `HandCoins` from lucide-react alongside the other lucide imports:
```ts
import { ..., HandCoins } from 'lucide-react';
```

Also add `/consignors` and `/consignments/:id` patterns to the `noSidebarPages` array so the shows-sidebar isn't shown on consignor pages:
```ts
const noSidebarPages = [..., '/consignors'];
```

(Don't need to add `/consignors/:id` literally — the existing array uses prefix-style strings, and the nav routing matches by prefix.)

- [ ] **Step 4: Verify**

```bash
cd desktop && npm run dev
```
Open the app. Click "Consignors" in the sidebar. Confirm:
- Nav item shows with the HandCoins icon.
- Clicking navigates to `/consignors` and renders "Consignors (coming next phase)".
- Manually visit `/#/consignors/abc` → renders the stub with `id` = "abc".
- Manually visit `/#/consignments/xyz` → renders the stub with `id` = "xyz".

- [ ] **Step 5: Commit**

```bash
cd desktop && git add src/App.tsx src/components/Layout.tsx src/pages/Consignors.tsx src/pages/ConsignorDetail.tsx src/pages/ConsignmentDetail.tsx
git commit -m "feat(desktop): consignor nav + route stubs"
```

---

## Phase 1 — Hooks layer

### Task 1.1: `useConsignors` hook

**File:** Create `desktop/src/hooks/useConsignors.ts`

- [ ] **Step 1: Write the hook**

```ts
// NOTE: New code — uses camelCase types matching the API response shape directly.
// (Legacy desktop hooks use snake_case; this surface is self-contained and avoids
// pointless re-transformation of Prisma camelCase data.)
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export interface Consignor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { consignments: number };
}

export interface ConsignorBalance {
  balance: number;
  unpaidItemCount: number;
}

export interface ConsignorFormData {
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export function useConsignors() {
  const [consignors, setConsignors] = useState<Consignor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConsignors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiClient.get<{ success: boolean; data: Consignor[] }>('/api/consignors');
      setConsignors(r.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load consignors');
    } finally {
      setLoading(false);
    }
  }, []);

  const getConsignor = useCallback(async (id: string) => {
    const r = await apiClient.get<{ success: boolean; data: Consignor & { consignments: unknown[] } }>(`/api/consignors/${id}`);
    return r.data;
  }, []);

  const createConsignor = useCallback(async (data: ConsignorFormData) => {
    const r = await apiClient.post<{ success: boolean; data: Consignor; error?: string }>('/api/consignors', data);
    if (!r.success) throw new Error(r.error || 'Failed to create');
    return r.data;
  }, []);

  const updateConsignor = useCallback(async (id: string, data: Partial<ConsignorFormData & { isActive: boolean }>) => {
    const r = await apiClient.patch<{ success: boolean; data: Consignor; error?: string }>(`/api/consignors/${id}`, data);
    if (!r.success) throw new Error(r.error || 'Failed to update');
    return r.data;
  }, []);

  const deleteConsignor = useCallback(async (id: string) => {
    const r = await apiClient.delete<{ success: boolean; error?: string }>(`/api/consignors/${id}`);
    if (!r.success) throw new Error(r.error || 'Failed to delete');
  }, []);

  const getBalance = useCallback(async (id: string): Promise<ConsignorBalance> => {
    const r = await apiClient.get<{ success: boolean; data: ConsignorBalance }>(`/api/consignors/${id}/balance`);
    return r.data;
  }, []);

  return { consignors, loading, error, loadConsignors, getConsignor, createConsignor, updateConsignor, deleteConsignor, getBalance };
}
```

- [ ] **Step 2: Quick browser smoke** — open the app, open DevTools console, run:
  ```js
  // After importing the hook into a temp page or running via React DevTools
  // Easiest path: use the index-page wiring in Phase 2 to verify; skip standalone smoke here.
  ```
  (No code-runtime smoke for hooks alone — they get exercised by the index page in Phase 2.)

- [ ] **Step 3: Commit**

```bash
cd desktop && git add src/hooks/useConsignors.ts
git commit -m "feat(desktop): useConsignors hook"
```

### Task 1.2: `useConsignments` hook

**File:** Create `desktop/src/hooks/useConsignments.ts`

- [ ] **Step 1: Write**

```ts
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export type SplitBase = 'NET' | 'GROSS' | 'NET_MINUS_COSTS';

export interface Consignment {
  id: string;
  consignorId: string;
  name: string;
  splitPercent: string;   // Prisma Decimal serializes as string
  splitBase: SplitBase;
  isActive: boolean;
  isDefault: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  consignor?: { id: string; name: string };
  _count?: { items: number };
}

export interface ConsignmentFormData {
  consignorId: string;
  name: string;
  splitPercent: number;
  splitBase: SplitBase;
  isDefault?: boolean;
  notes?: string | null;
}

export function useConsignments() {
  const [consignments, setConsignments] = useState<Consignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConsignments = useCallback(async (consignorId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = consignorId ? { consignorId } : undefined;
      const r = await apiClient.get<{ success: boolean; data: Consignment[] }>('/api/consignments', params);
      setConsignments(r.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load consignments');
    } finally {
      setLoading(false);
    }
  }, []);

  const getConsignment = useCallback(async (id: string) => {
    const r = await apiClient.get<{ success: boolean; data: Consignment }>(`/api/consignments/${id}`);
    return r.data;
  }, []);

  const createConsignment = useCallback(async (data: ConsignmentFormData) => {
    const r = await apiClient.post<{ success: boolean; data: Consignment; error?: string }>('/api/consignments', data);
    if (!r.success) throw new Error(r.error || 'Failed to create');
    return r.data;
  }, []);

  const updateConsignment = useCallback(async (id: string, data: Partial<ConsignmentFormData & { isActive: boolean }>) => {
    const r = await apiClient.patch<{ success: boolean; data: Consignment; error?: string }>(`/api/consignments/${id}`, data);
    if (!r.success) throw new Error(r.error || 'Failed to update');
    return r.data;
  }, []);

  const deleteConsignment = useCallback(async (id: string) => {
    const r = await apiClient.delete<{ success: boolean; error?: string }>(`/api/consignments/${id}`);
    if (!r.success) throw new Error(r.error || 'Failed to delete');
  }, []);

  return { consignments, loading, error, loadConsignments, getConsignment, createConsignment, updateConsignment, deleteConsignment };
}
```

- [ ] **Step 2: Commit**

```bash
cd desktop && git add src/hooks/useConsignments.ts
git commit -m "feat(desktop): useConsignments hook"
```

### Task 1.3: `useConsignorPayouts` hook

**File:** Create `desktop/src/hooks/useConsignorPayouts.ts`

- [ ] **Step 1: Write**

```ts
import { useState, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';

export type PaymentMethod = 'venmo' | 'paypal' | 'zelle' | 'cash' | 'check' | 'bank_transfer' | 'other';

export interface ConsignorPayout {
  id: string;
  consignorId: string;
  amount: string;
  paymentMethod: PaymentMethod;
  methodNotes: string | null;
  paidAt: string;
  notes: string | null;
  pdfUrl: string | null;
  csvUrl: string | null;
  createdAt: string;
  consignor?: { id: string; name: string };
  items?: Array<{
    payoutAtTime: string;
    item: { id: string; itemTitle: string | null; orderDate: string | null };
  }>;
}

export interface CreatePayoutInput {
  consignorId: string;
  itemIds?: string[];
  paymentMethod: PaymentMethod;
  methodNotes?: string | null;
  paidAt?: string;
  notes?: string | null;
}

export function useConsignorPayouts() {
  const [payouts, setPayouts] = useState<ConsignorPayout[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPayouts = useCallback(async (consignorId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = consignorId ? { consignorId } : undefined;
      const r = await apiClient.get<{ success: boolean; data: ConsignorPayout[] }>('/api/consignor-payouts', params);
      setPayouts(r.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load payouts');
    } finally {
      setLoading(false);
    }
  }, []);

  const getPayout = useCallback(async (id: string) => {
    const r = await apiClient.get<{ success: boolean; data: ConsignorPayout }>(`/api/consignor-payouts/${id}`);
    return r.data;
  }, []);

  const createPayout = useCallback(async (data: CreatePayoutInput) => {
    const r = await apiClient.post<{ success: boolean; data: ConsignorPayout; error?: string }>('/api/consignor-payouts', data);
    if (!r.success) throw new Error(r.error || 'Failed to create payout');
    return r.data;
  }, []);

  return { payouts, loading, error, loadPayouts, getPayout, createPayout };
}
```

- [ ] **Step 2: Commit**

```bash
cd desktop && git add src/hooks/useConsignorPayouts.ts
git commit -m "feat(desktop): useConsignorPayouts hook"
```

### Task 1.4: Re-export from `hooks/index.ts`

**File:** Modify `desktop/src/hooks/index.ts`

- [ ] **Step 1: Append re-exports**

```ts
export { useConsignors, type Consignor, type ConsignorBalance, type ConsignorFormData } from './useConsignors';
export { useConsignments, type Consignment, type ConsignmentFormData, type SplitBase } from './useConsignments';
export { useConsignorPayouts, type ConsignorPayout, type CreatePayoutInput, type PaymentMethod } from './useConsignorPayouts';
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd desktop && npx tsc --noEmit -p .
```
No new errors.

- [ ] **Step 3: Commit**

```bash
cd desktop && git add src/hooks/index.ts
git commit -m "feat(desktop): re-export consignor hooks"
```

---

## Phase 2 — Consignors index page

### Task 2.1: Replace stub with real index page

**File:** `desktop/src/pages/Consignors.tsx` (overwrite the stub)

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConsignors, Consignor } from '../hooks';
import { Plus, Search, Users, Loader2 } from 'lucide-react';

export default function Consignors() {
  const { consignors, loading, error, loadConsignors, createConsignor } = useConsignors();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => { loadConsignors(); }, [loadConsignors]);

  const filtered = consignors.filter((c) => {
    if (!showInactive && !c.isActive) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createConsignor({ name: newName.trim(), email: newEmail.trim() || null });
      setShowCreate(false);
      setNewName('');
      setNewEmail('');
      navigate(`/consignors/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Consignors</h1>
          <p className="text-sm text-text-secondary mt-1">People who give you items to sell on consignment.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> New Consignor
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search consignors…"
            className="w-full pl-9 pr-3 py-2 bg-bg-secondary border border-border-subtle rounded-md text-sm text-text-primary"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-text-secondary py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}
      {error && <div className="bg-red-500/10 text-red-400 p-3 rounded text-sm">{error}</div>}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-text-secondary">
          <Users className="w-10 h-10 mx-auto mb-2 opacity-50" />
          <p>No consignors yet.</p>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-tertiary text-text-tertiary text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Email</th>
                <th className="text-right px-4 py-2 font-medium">Deals</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/consignors/${c.id}`)}
                  className="border-t border-border-subtle hover:bg-bg-tertiary cursor-pointer"
                >
                  <td className="px-4 py-3 text-text-primary font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{c.email ?? '—'}</td>
                  <td className="px-4 py-3 text-right text-text-secondary">{c._count?.consignments ?? 0}</td>
                  <td className="px-4 py-3">
                    {c.isActive ? (
                      <span className="text-xs text-green-500">Active</span>
                    ) : (
                      <span className="text-xs text-text-tertiary">Inactive</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-bg-secondary border border-border-medium rounded-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-text-primary mb-4">New Consignor</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">Name *</label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">Email</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
                />
              </div>
              {createError && <div className="text-red-400 text-sm">{createError}</div>}
              <div className="flex justify-end gap-2 pt-3">
                <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 text-text-secondary hover:text-text-primary">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newName.trim()}
                  className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium disabled:opacity-50"
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Browser verify**

```bash
cd desktop && npm run dev
```
- Click "Consignors" in nav.
- Click "New Consignor", fill in name, submit. Should navigate to `/consignors/<id>`.
- Go back to the index. Confirm the new consignor appears.
- Search for it. Confirm filtering works.
- Toggle "Show inactive" — no change yet (nothing inactive).

- [ ] **Step 3: Commit**

```bash
cd desktop && git add src/pages/Consignors.tsx
git commit -m "feat(desktop): consignors index page with create modal"
```

---

## Phase 3 — Consignment edit modal

### Task 3.1: `ConsignmentFormModal` component

**File:** Create `desktop/src/components/ConsignmentFormModal.tsx`

This modal handles BOTH create and edit. Used from the consignor detail page.

- [ ] **Step 1: Write**

```tsx
import { useState, useEffect } from 'react';
import { Consignment, ConsignmentFormData, SplitBase, useConsignments } from '../hooks';

interface Props {
  consignorId: string;
  initial?: Consignment | null;       // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

const SPLIT_BASES: { value: SplitBase; label: string; description: string }[] = [
  { value: 'NET', label: 'Net', description: 'Split applies to what you receive after Whatnot fees (most common)' },
  { value: 'GROSS', label: 'Gross', description: 'Split applies to what the buyer paid (you eat Whatnot fees)' },
  { value: 'NET_MINUS_COSTS', label: 'Net minus costs', description: 'You recover cost+shipping first, then split the remainder' },
];

export default function ConsignmentFormModal({ consignorId, initial, onClose, onSaved }: Props) {
  const { createConsignment, updateConsignment } = useConsignments();
  const [name, setName] = useState(initial?.name ?? '');
  const [splitPercent, setSplitPercent] = useState<number>(initial ? Number(initial.splitPercent) : 50);
  const [splitBase, setSplitBase] = useState<SplitBase>(initial?.splitBase ?? 'NET');
  const [isDefault, setIsDefault] = useState<boolean>(initial?.isDefault ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setSplitPercent(Number(initial.splitPercent));
      setSplitBase(initial.splitBase);
      setIsDefault(initial.isDefault);
      setNotes(initial.notes ?? '');
    }
  }, [initial]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data: ConsignmentFormData = {
        consignorId,
        name: name.trim(),
        splitPercent,
        splitBase,
        isDefault,
        notes: notes.trim() || null,
      };
      if (initial) {
        await updateConsignment(initial.id, data);
      } else {
        await createConsignment(data);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border-medium rounded-xl p-6 w-full max-w-lg">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {initial ? 'Edit Consignment' : 'New Consignment'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Name *</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Edikted 50/50"
              className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">Consignor's Split (%)</label>
              <input
                required
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={splitPercent}
                onChange={(e) => setSplitPercent(Number(e.target.value))}
                className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">Split Base</label>
              <select
                value={splitBase}
                onChange={(e) => setSplitBase(e.target.value as SplitBase)}
                className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
              >
                {SPLIT_BASES.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-text-tertiary">{SPLIT_BASES.find((b) => b.value === splitBase)?.description}</p>

          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Default for this consignor (catch-all when no other deal matches)
          </label>

          <div>
            <label className="block text-xs text-text-secondary mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary text-sm"
            />
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}

          <div className="flex justify-end gap-2 pt-3">
            <button type="button" onClick={onClose} className="px-3 py-2 text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd desktop && git add src/components/ConsignmentFormModal.tsx
git commit -m "feat(desktop): consignment create/edit modal"
```

---

## Phase 4 — Consignor detail page

### Task 4.1: Replace stub with full detail page (consignments tab + balance)

**File:** `desktop/src/pages/ConsignorDetail.tsx` (overwrite the stub)

- [ ] **Step 1: Write**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  useConsignors, useConsignments, useConsignorPayouts,
  Consignor, Consignment, ConsignorPayout, ConsignorBalance,
} from '../hooks';
import ConsignmentFormModal from '../components/ConsignmentFormModal';
import PayoutModal from '../components/PayoutModal';
import { ArrowLeft, Plus, Edit2, Loader2, DollarSign, ExternalLink, FileText } from 'lucide-react';
import { formatCurrency, formatRelativeTime } from '../utils/format';

type Tab = 'consignments' | 'payouts';

export default function ConsignorDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getConsignor, getBalance } = useConsignors();
  const { consignments, loadConsignments } = useConsignments();
  const { payouts, loadPayouts } = useConsignorPayouts();

  const [consignor, setConsignor] = useState<Consignor | null>(null);
  const [balance, setBalance] = useState<ConsignorBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('consignments');

  const [showConsignmentModal, setShowConsignmentModal] = useState(false);
  const [editingConsignment, setEditingConsignment] = useState<Consignment | null>(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [c, b] = await Promise.all([getConsignor(id), getBalance(id)]);
      setConsignor(c);
      setBalance(b);
      await loadConsignments(id);
      await loadPayouts(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id, getConsignor, getBalance, loadConsignments, loadPayouts]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center text-text-secondary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }
  if (error) return <div className="p-6 text-red-400">{error}</div>;
  if (!consignor) return <div className="p-6 text-text-secondary">Not found</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <button onClick={() => navigate('/consignors')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Consignors
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{consignor.name}</h1>
          <p className="text-sm text-text-secondary mt-1">
            {consignor.email ?? '—'} · {consignor.phone ?? '—'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-text-tertiary">Current Balance</div>
            <div className="text-2xl font-semibold text-text-primary">
              {formatCurrency(balance?.balance ?? 0)}
            </div>
            <div className="text-xs text-text-tertiary">{balance?.unpaidItemCount ?? 0} unpaid items</div>
          </div>
          <button
            onClick={() => setShowPayoutModal(true)}
            disabled={!balance || balance.balance <= 0}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            <DollarSign className="w-4 h-4" /> Pay Out
          </button>
        </div>
      </div>

      <div className="border-b border-border-subtle mb-4">
        <div className="flex gap-6">
          <button
            onClick={() => setTab('consignments')}
            className={`py-2 text-sm font-medium border-b-2 ${tab === 'consignments' ? 'border-accent text-text-primary' : 'border-transparent text-text-tertiary'}`}
          >
            Consignments ({consignments.length})
          </button>
          <button
            onClick={() => setTab('payouts')}
            className={`py-2 text-sm font-medium border-b-2 ${tab === 'payouts' ? 'border-accent text-text-primary' : 'border-transparent text-text-tertiary'}`}
          >
            Payouts ({payouts.length})
          </button>
        </div>
      </div>

      {tab === 'consignments' && (
        <div>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => { setEditingConsignment(null); setShowConsignmentModal(true); }}
              className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary border border-border-subtle text-text-primary rounded-md text-sm hover:bg-bg-tertiary"
            >
              <Plus className="w-4 h-4" /> New Consignment
            </button>
          </div>
          {consignments.length === 0 ? (
            <p className="text-center py-8 text-text-secondary">No consignments yet — add one to start splitting items.</p>
          ) : (
            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-bg-tertiary text-text-tertiary text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Name</th>
                    <th className="text-right px-4 py-2 font-medium">Split %</th>
                    <th className="text-left px-4 py-2 font-medium">Base</th>
                    <th className="text-left px-4 py-2 font-medium">Default?</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {consignments.map((c) => (
                    <tr key={c.id} className="border-t border-border-subtle">
                      <td className="px-4 py-3 text-text-primary">{c.name}</td>
                      <td className="px-4 py-3 text-right text-text-secondary">{Number(c.splitPercent).toFixed(0)}%</td>
                      <td className="px-4 py-3 text-text-secondary">{c.splitBase}</td>
                      <td className="px-4 py-3 text-text-secondary">{c.isDefault ? 'Yes' : '—'}</td>
                      <td className="px-4 py-3">
                        <span className={c.isActive ? 'text-xs text-green-500' : 'text-xs text-text-tertiary'}>
                          {c.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => { setEditingConsignment(c); setShowConsignmentModal(true); }}
                          className="text-text-secondary hover:text-text-primary"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'payouts' && (
        <div>
          {payouts.length === 0 ? (
            <p className="text-center py-8 text-text-secondary">No payouts yet.</p>
          ) : (
            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-bg-tertiary text-text-tertiary text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-right px-4 py-2 font-medium">Amount</th>
                    <th className="text-left px-4 py-2 font-medium">Method</th>
                    <th className="text-left px-4 py-2 font-medium">Notes</th>
                    <th className="text-right px-4 py-2 font-medium">Statement</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id} className="border-t border-border-subtle">
                      <td className="px-4 py-3 text-text-primary">{formatRelativeTime(new Date(p.paidAt))}</td>
                      <td className="px-4 py-3 text-right text-text-primary font-medium">{formatCurrency(Number(p.amount))}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {p.paymentMethod}{p.methodNotes ? ` (${p.methodNotes})` : ''}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{p.notes ?? '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-3">
                          {p.pdfUrl && <a href={p.pdfUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1"><FileText className="w-3 h-3" /> PDF</a>}
                          {p.csvUrl && <a href={p.csvUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1"><ExternalLink className="w-3 h-3" /> CSV</a>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showConsignmentModal && (
        <ConsignmentFormModal
          consignorId={consignor.id}
          initial={editingConsignment}
          onClose={() => setShowConsignmentModal(false)}
          onSaved={refresh}
        />
      )}
      {showPayoutModal && balance && (
        <PayoutModal
          consignorId={consignor.id}
          consignorName={consignor.name}
          balance={balance.balance}
          unpaidItemCount={balance.unpaidItemCount}
          onClose={() => setShowPayoutModal(false)}
          onCreated={refresh}
        />
      )}
    </div>
  );
}
```

Note: the `<a href={p.pdfUrl}>` link uses the URL returned by the API which is relative (`/statements/...`). In Electron, those need to resolve against the web app's base URL. The simplest fix at v1: prepend `localStorage.getItem('webAppUrl')` to make the href absolute. Add a small helper inline or keep it simple by hardcoding `http://localhost:3000` for now and noting in code that this should use the configured web URL.

Refine the link rendering to:
```tsx
const webBase = localStorage.getItem('webAppUrl') || 'http://localhost:3000';
// ... and below:
{p.pdfUrl && <a href={`${webBase}${p.pdfUrl}`} target="_blank" ...>}
```

- [ ] **Step 2: Apply the webBase fix as described above.**

- [ ] **Step 3: Browser verify**

- Visit a consignor (created in Phase 2). Confirm:
  - Header shows balance (will be $0 with no items yet).
  - Two tabs: Consignments (empty), Payouts (empty).
  - Click "New Consignment" → modal opens. Fill in "Edikted 50/50", split 50, NET. Save.
  - Consignments table shows the new row.
  - Click edit (pencil) → modal opens with values prefilled. Save.

(Pay Out button stays disabled until a balance exists; full payout test in Phase 5.)

- [ ] **Step 4: Commit**

```bash
cd desktop && git add src/pages/ConsignorDetail.tsx
git commit -m "feat(desktop): consignor detail page with consignments + payouts tabs"
```

---

## Phase 5 — Payout creation modal

### Task 5.1: `PayoutModal` component

**File:** Create `desktop/src/components/PayoutModal.tsx`

- [ ] **Step 1: Write**

```tsx
import { useState } from 'react';
import { useConsignorPayouts, PaymentMethod } from '../hooks';
import { formatCurrency } from '../utils/format';
import { Loader2, CheckCircle2, FileText, ExternalLink } from 'lucide-react';

interface Props {
  consignorId: string;
  consignorName: string;
  balance: number;
  unpaidItemCount: number;
  onClose: () => void;
  onCreated: () => void;
}

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'other', label: 'Other' },
];

const webBase = (): string => localStorage.getItem('webAppUrl') || 'http://localhost:3000';

export default function PayoutModal({ consignorId, consignorName, balance, unpaidItemCount, onClose, onCreated }: Props) {
  const { createPayout } = useConsignorPayouts();
  const [method, setMethod] = useState<PaymentMethod>('venmo');
  const [methodNotes, setMethodNotes] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ pdfUrl: string | null; csvUrl: string | null } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await createPayout({
        consignorId,
        paymentMethod: method,
        methodNotes: methodNotes.trim() || null,
        notes: notes.trim() || null,
      });
      setDone({ pdfUrl: r.pdfUrl, csvUrl: r.csvUrl });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payout');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border-medium rounded-xl p-6 w-full max-w-lg">
        {!done ? (
          <>
            <h2 className="text-lg font-semibold text-text-primary mb-1">Pay Out — {consignorName}</h2>
            <p className="text-sm text-text-secondary mb-4">
              Settling <strong className="text-text-primary">{formatCurrency(balance)}</strong> across {unpaidItemCount} unpaid items.
            </p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">Payment Method *</label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
                >
                  {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs text-text-secondary mb-1">Method Notes (optional)</label>
                <input
                  type="text"
                  value={methodNotes}
                  onChange={(e) => setMethodNotes(e.target.value)}
                  placeholder="e.g. @jeff-handle, check #1234"
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary"
                />
              </div>

              <div>
                <label className="block text-xs text-text-secondary mb-1">Internal Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 bg-bg-primary border border-border-subtle rounded text-text-primary text-sm"
                />
              </div>

              {error && <div className="text-red-400 text-sm">{error}</div>}

              <div className="flex justify-end gap-2 pt-3">
                <button type="button" onClick={onClose} disabled={submitting} className="px-3 py-2 text-text-secondary hover:text-text-primary">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Settling…</> : `Settle ${formatCurrency(balance)}`}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <div>
                <h2 className="text-lg font-semibold text-text-primary">Payout Recorded</h2>
                <p className="text-sm text-text-secondary">{formatCurrency(balance)} settled with {consignorName}.</p>
              </div>
            </div>
            <div className="bg-bg-tertiary rounded p-4 space-y-2">
              <p className="text-sm text-text-secondary">Statement files:</p>
              <div className="flex gap-3">
                {done.pdfUrl ? (
                  <a href={`${webBase()}${done.pdfUrl}`} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1 text-sm">
                    <FileText className="w-4 h-4" /> Open PDF
                  </a>
                ) : (
                  <span className="text-xs text-yellow-500">PDF not generated (file write failed — check server logs)</span>
                )}
                {done.csvUrl && (
                  <a href={`${webBase()}${done.csvUrl}`} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1 text-sm">
                    <ExternalLink className="w-4 h-4" /> Open CSV
                  </a>
                )}
              </div>
            </div>
            <div className="flex justify-end pt-4">
              <button onClick={onClose} className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Browser verify (requires items assigned to a consignment with payout calc'd)**

The full path: assign an item to a consignment (via DB or future bulk-update UI) → its `consignor_payout` populates → balance > 0 → "Pay Out" button enables → click → modal opens → submit → success state with PDF/CSV links.

For now (no item-assignment UI yet), test by:
1. Open Prisma Studio: `cd web && npx prisma studio`
2. Pick an existing item, set `consignmentId` to your test consignment's UUID. Save.
3. Hit `POST http://localhost:3000/api/items/<itemId>/recompute-consignor-payout` (use curl with auth headers, or write a one-off script). Confirm `consignor_payout` populates.
4. Refresh the consignor detail page. Balance should now be non-zero.
5. Click "Pay Out", submit. Confirm success state, click PDF link, confirm it opens.

- [ ] **Step 3: Commit**

```bash
cd desktop && git add src/components/PayoutModal.tsx
git commit -m "feat(desktop): payout creation modal with statement links"
```

---

## Phase 6 — Consignment edit page (route target)

### Task 6.1: Replace `ConsignmentDetail.tsx` stub with redirect-to-modal

The route `/consignments/:id` exists, but for v1 the consignment edit happens via `ConsignmentFormModal` opened from the consignor detail page. The route can redirect back to the consignor detail in the parent. Keep it simple.

**File:** `desktop/src/pages/ConsignmentDetail.tsx`

- [ ] **Step 1: Write**

```tsx
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useConsignments } from '../hooks';
import { Loader2 } from 'lucide-react';

export default function ConsignmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getConsignment } = useConsignments();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getConsignment(id)
      .then((c) => navigate(`/consignors/${c.consignorId}`, { replace: true }))
      .catch((e) => setError(e instanceof Error ? e.message : 'Not found'));
  }, [id, getConsignment, navigate]);

  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-400">{error}</p>
        <button onClick={() => navigate('/consignors')} className="mt-3 text-accent hover:underline">
          Back to consignors
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 flex items-center justify-center text-text-secondary">
      <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
    </div>
  );
}
```

This route exists primarily so deep-links work (e.g., from rule-engine output). Bouncing to the parent consignor detail keeps the UX coherent without duplicating the edit surface.

- [ ] **Step 2: Commit**

```bash
cd desktop && git add src/pages/ConsignmentDetail.tsx
git commit -m "feat(desktop): consignment route bounces to parent consignor detail"
```

---

## Phase 7 — Rules UI: Set Consignment action

### Task 7.1: Add "Set Consignment" to the action picker

**File:** Modify `desktop/src/pages/Rules.tsx`

This is a surgical edit — find the action picker UI in the existing Rules page and add a new option for `set_consignment` whose target is a consignment dropdown.

- [ ] **Step 1: Read `Rules.tsx` first** to understand where actions are configured.

```bash
grep -n "set_brand\|action_type\|actionType" "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/desktop/src/pages/Rules.tsx"
```

- [ ] **Step 2: Find the action-type select / dropdown / picker.**

It will likely be a `<select>` or a list of buttons mapping `action_type` strings to labels. Add a new option:
- value: `"set_consignment"`
- label: `"Set Consignment"`

When the user picks `set_consignment`, the picker should show a consignment dropdown (using the `useConsignments` hook with no consignor filter to list all). The user picks a consignment; its UUID becomes `target_id`.

If the existing UI is stuck on flat textual `target_value` for non-set_brand actions, the cleanest pattern is:
- Add a conditional rendering: when `actionType === 'set_consignment'`, show a `<select>` populated from `consignments` instead of a free-text input. Bind to `target_id` (NOT `target_value`).

Apply the change minimally — don't refactor the rules page beyond what's needed.

Sketch (adapt to actual file structure):

```tsx
// Near the top imports:
import { useConsignments } from '../hooks';

// Inside the component:
const { consignments, loadConsignments } = useConsignments();
useEffect(() => { loadConsignments(); }, [loadConsignments]);

// Inside the action editor render:
{action.action_type === 'set_consignment' ? (
  <select
    value={action.target_id ? String(action.target_id) : ''}
    onChange={(e) => updateAction({ target_id: e.target.value })}
    className="..."
  >
    <option value="">Select consignment…</option>
    {consignments.filter((c) => c.isActive).map((c) => (
      <option key={c.id} value={c.id}>
        {c.consignor?.name ?? '?'} — {c.name} ({Number(c.splitPercent).toFixed(0)}%)
      </option>
    ))}
  </select>
) : (
  // existing target_value input
)}
```

Important: the existing rules engine's `target_id` field is currently typed `number | null` in the desktop hook (see useRules.ts) but the consignment ID is a UUID string. The `target_id` field on the API response is `String?` — the hook needs to handle both. Two approaches:
(a) Loosen `RuleAction.target_id` to `string | number | null` in `useRules.ts`.
(b) Add a separate `target_uuid` field. Approach (a) is simpler and matches the underlying schema (target_id is varchar(255) per the Phase 1 schema review).

Pick (a). Edit `desktop/src/hooks/useRules.ts` to change:
```ts
target_id?: number | null;
```
to:
```ts
target_id?: string | number | null;
```

(If this triggers cascading type errors in places that pass `target_id` as a number, coerce to string at those call sites.)

- [ ] **Step 3: Verify in browser**

- Open Rules page.
- Create a new rule. Set condition: `brand contains Edikted`. Action: `Set Consignment` → pick "Jeff — Edikted 50/50" from dropdown. Save.
- Trigger rule run (existing button on the rules page). Verify items now have consignment assigned.
- Confirm in DB / via consignor balance endpoint that payouts populated.

- [ ] **Step 4: Commit**

```bash
cd desktop && git add src/pages/Rules.tsx src/hooks/useRules.ts
git commit -m "feat(rules-ui): set_consignment action with consignment picker"
```

---

## Phase 8 — Final smoke

### Task 8.1: End-to-end happy path

- [ ] **Step 1: Restart `npm run dev`** (clean slate).

- [ ] **Step 2: Walk through:**

1. Sidebar: click **Consignors**.
2. Click **New Consignor**, create "Jeff Test".
3. Lands on Jeff's detail page. Click **New Consignment**, create "Edikted 50/50" at 50%, NET.
4. Go to **Rules**. Create a rule: brand contains "Edikted" → Set Consignment = Jeff/Edikted. Save.
5. Click the rules' "Run" button (or whatever the existing Rules page exposes for re-run).
6. Back to **Consignors → Jeff Test**. Balance should now be non-zero, unpaid items > 0.
7. Click **Pay Out**. Pick Venmo, add a method note. Submit.
8. Success state shows. Click **Open PDF**. Statement opens in browser.
9. Refresh page. Payouts tab now shows the settled payout. Items moved from unpaid to paid.

- [ ] **Step 3: Build check**

```bash
cd desktop && npm run build
```
No errors.

- [ ] **Step 4: TypeScript check**

```bash
cd desktop && npx tsc --noEmit -p .
```
No new errors.

- [ ] **Step 5: Commit any final fixes if needed.**

If smoke surfaced bugs, fix them and commit. Otherwise this plan is complete.

---

## Plan Self-Review Notes

- **Spec coverage** (against spec section 7):
  - Top-level "Consignors" nav → Phase 0 ✓
  - Consignor index with create → Phase 2 ✓
  - Consignor detail with consignments + items + payouts tabs → Phase 4 (Items tab deferred to follow-on plan; the spec mentions "Items" sub-tab but implementing it requires the Sales-table integration which is also deferred)
  - Consignment detail/edit → Phases 3+6 (modal + route bounce) ✓
  - "New payout" modal → Phase 5 ✓
  - PDF + CSV download → Phase 5 ✓
  - Rules UI Set Consignment → Phase 7 ✓
  - Sales table consignor column → **DEFERRED** (called out in plan header)
  - Item edit drawer consignment picker → **DEFERRED** (same)
- **No placeholders** in tasks — every code step shows the code. The Rules.tsx edit (Phase 7) is the one place with sketched code rather than full code, because the surrounding file structure is unknown — that task explicitly tells the implementer to read first and adapt.
- **Type consistency** — `target_id` widening in `useRules.ts` is called out explicitly as a known cascading change.
