# Consignor Feature — Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the desktop consignor UI in the web app. Operator can manage consignors, set up consignments, settle payouts (with PDF/CSV download), and assign consignments via the existing Rules UI — all in the browser.

**Architecture:** Next.js 16 app-folder routing under `src/app/(dashboard)/consignors/`. A small `src/lib/consignor-api.ts` module wraps the fetch calls (mirroring the role of desktop's hooks but matching web's "fetch directly from a 'use client' page" idiom). Two new pages plus reusable form/payout modal components. One small surgical edit to the existing `Rules` page.

**Tech Stack:** Next.js 16, React 19, NextAuth v5 (session cookies — no Bearer token needed for same-origin fetches), Tailwind 4, lucide-react. UI primitives from `@/components/ui/`.

**Spec:** `docs/superpowers/specs/2026-04-22-consignor-design.md` (section 7 — UI)

**Key differences from desktop plan:**
- No `apiClient` wrapper — direct `fetch('/api/consignors', ...)` calls. Same-origin so cookie auth handles itself.
- Pages must declare `"use client"` (interactive UI requires client component).
- Uses `@/components/ui/Modal` instead of hand-rolled modals (existing primitive).
- File paths under `src/app/(dashboard)/<segment>/page.tsx` per Next.js app router.

**Out of scope (deferred to follow-on plan):**
- Sales/Items table "Consignor" column + filter + bulk-assign action
- Item edit drawer "consignment" picker
- These edit very large legacy pages and aren't required for the consignor flow itself.

---

## File Map

### New files
```
web/
├── src/
│   ├── lib/
│   │   └── consignor-api.ts                    # fetch helpers + shared types
│   ├── app/(dashboard)/
│   │   ├── consignors/
│   │   │   ├── page.tsx                        # index — list of consignors
│   │   │   └── [id]/page.tsx                   # detail — consignments + payouts tabs
│   │   └── consignments/
│   │       └── [id]/page.tsx                   # bouncer to parent consignor
│   └── components/consignor/
│       ├── ConsignmentFormModal.tsx            # create/edit modal
│       └── PayoutModal.tsx                     # "Pay Out" modal with statement download
```

### Modified files
```
web/
└── src/
    ├── app/(dashboard)/layout.tsx              # 1 nav item under "Operations"
    └── app/(dashboard)/rules/page.tsx          # add "Set Consignment" action option
```

---

## Phase 0 — Nav + route stubs

### Task 0.1: Add nav item + route stubs

**Files:**
- Modify: `web/src/app/(dashboard)/layout.tsx`
- Create stub: `web/src/app/(dashboard)/consignors/page.tsx`
- Create stub: `web/src/app/(dashboard)/consignors/[id]/page.tsx`
- Create stub: `web/src/app/(dashboard)/consignments/[id]/page.tsx`

- [ ] **Step 1: Create the three stub pages**

```tsx
// web/src/app/(dashboard)/consignors/page.tsx
"use client";
export default function ConsignorsPage() {
  return <div className="p-6 text-text-primary">Consignors (coming next phase)</div>;
}
```

```tsx
// web/src/app/(dashboard)/consignors/[id]/page.tsx
"use client";
import { useParams } from "next/navigation";
export default function ConsignorDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <div className="p-6 text-text-primary">Consignor {id} (coming next phase)</div>;
}
```

```tsx
// web/src/app/(dashboard)/consignments/[id]/page.tsx
"use client";
import { useParams } from "next/navigation";
export default function ConsignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <div className="p-6 text-text-primary">Consignment {id} (coming next phase)</div>;
}
```

- [ ] **Step 2: Add nav item in `web/src/app/(dashboard)/layout.tsx`**

Read the file. Find the `navSections` array. In the "Operations" section's `items` array, add:
```ts
      { name: "Consignors", href: "/consignors", icon: HandCoins },
```

Add `HandCoins` to the lucide-react import:
```ts
import { ..., HandCoins } from "lucide-react";
```

- [ ] **Step 3: Verify**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && npx tsc --noEmit -p .
```
No new errors compared to baseline (~7 pre-existing per backend Phase 10).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/app/\(dashboard\)/layout.tsx src/app/\(dashboard\)/consignors src/app/\(dashboard\)/consignments
git commit -m "feat(web): consignor nav + route stubs"
```

---

## Phase 1 — Fetch helpers module

### Task 1.1: `consignor-api.ts`

**File:** Create `web/src/lib/consignor-api.ts`

Encapsulates the API calls so pages don't repeat boilerplate. Same-origin fetch — cookie auth handles itself.

```ts
// All fetches are same-origin; NextAuth session cookies authenticate.
// Tenant context is resolved server-side from the session.

export type SplitBase = "NET" | "GROSS" | "NET_MINUS_COSTS";
export type PaymentMethod = "venmo" | "paypal" | "zelle" | "cash" | "check" | "bank_transfer" | "other";

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

export interface Consignment {
  id: string;
  consignorId: string;
  name: string;
  splitPercent: string;
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

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || `Request failed: ${res.status}`);
  return json.data as T;
}

// Consignors
export const listConsignors = () => request<Consignor[]>("GET", "/api/consignors");
export const getConsignor = (id: string) =>
  request<Consignor & { consignments: Consignment[] }>("GET", `/api/consignors/${id}`);
export const createConsignor = (data: ConsignorFormData) =>
  request<Consignor>("POST", "/api/consignors", data);
export const updateConsignor = (id: string, data: Partial<ConsignorFormData & { isActive: boolean }>) =>
  request<Consignor>("PATCH", `/api/consignors/${id}`, data);
export const deleteConsignor = (id: string) => request<void>("DELETE", `/api/consignors/${id}`);
export const getConsignorBalance = (id: string) =>
  request<ConsignorBalance>("GET", `/api/consignors/${id}/balance`);

// Consignments
export const listConsignments = (consignorId?: string) => {
  const qs = consignorId ? `?consignorId=${encodeURIComponent(consignorId)}` : "";
  return request<Consignment[]>("GET", `/api/consignments${qs}`);
};
export const getConsignment = (id: string) =>
  request<Consignment>("GET", `/api/consignments/${id}`);
export const createConsignment = (data: ConsignmentFormData) =>
  request<Consignment>("POST", "/api/consignments", data);
export const updateConsignment = (id: string, data: Partial<ConsignmentFormData & { isActive: boolean }>) =>
  request<Consignment>("PATCH", `/api/consignments/${id}`, data);
export const deleteConsignment = (id: string) => request<void>("DELETE", `/api/consignments/${id}`);

// Payouts
export const listPayouts = (consignorId?: string) => {
  const qs = consignorId ? `?consignorId=${encodeURIComponent(consignorId)}` : "";
  return request<ConsignorPayout[]>("GET", `/api/consignor-payouts${qs}`);
};
export const getPayout = (id: string) =>
  request<ConsignorPayout>("GET", `/api/consignor-payouts/${id}`);
export const createPayout = (input: CreatePayoutInput) =>
  request<ConsignorPayout>("POST", "/api/consignor-payouts", input);
```

- [ ] **Step 2: TypeScript check**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && npx tsc --noEmit -p .
```
No new errors.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/lib/consignor-api.ts
git commit -m "feat(web): consignor API client helpers"
```

---

## Phase 2 — Consignors index page

### Task 2.1: Replace stub with full index

**File:** `web/src/app/(dashboard)/consignors/page.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, Users, Loader2 } from "lucide-react";
import { listConsignors, createConsignor, type Consignor } from "@/lib/consignor-api";

export default function ConsignorsPage() {
  const router = useRouter();
  const [consignors, setConsignors] = useState<Consignor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setConsignors(await listConsignors());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load consignors");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

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
      setNewName("");
      setNewEmail("");
      router.push(`/consignors/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
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
                  onClick={() => router.push(`/consignors/${c.id}`)}
                  className="border-t border-border-subtle hover:bg-bg-tertiary cursor-pointer"
                >
                  <td className="px-4 py-3 text-text-primary font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{c.email ?? "—"}</td>
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
                  {creating ? "Creating…" : "Create"}
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

- [ ] **Step 2: Verify TypeScript**, baseline + 0 new.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/app/\(dashboard\)/consignors/page.tsx
git commit -m "feat(web): consignors index page with create modal"
```

---

## Phase 3 — Consignment form modal

### Task 3.1: `ConsignmentFormModal`

**File:** Create `web/src/components/consignor/ConsignmentFormModal.tsx`

```tsx
"use client";

import { useState, useEffect } from "react";
import {
  type Consignment, type ConsignmentFormData, type SplitBase,
  createConsignment, updateConsignment,
} from "@/lib/consignor-api";

interface Props {
  consignorId: string;
  initial?: Consignment | null;
  onClose: () => void;
  onSaved: () => void;
}

const SPLIT_BASES: { value: SplitBase; label: string; description: string }[] = [
  { value: "NET", label: "Net", description: "Split applies to what you receive after Whatnot fees (most common)" },
  { value: "GROSS", label: "Gross", description: "Split applies to what the buyer paid (you eat Whatnot fees)" },
  { value: "NET_MINUS_COSTS", label: "Net minus costs", description: "You recover cost+shipping first, then split the remainder" },
];

export default function ConsignmentFormModal({ consignorId, initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [splitPercent, setSplitPercent] = useState<number>(initial ? Number(initial.splitPercent) : 50);
  const [splitBase, setSplitBase] = useState<SplitBase>(initial?.splitBase ?? "NET");
  const [isDefault, setIsDefault] = useState<boolean>(initial?.isDefault ?? false);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setSplitPercent(Number(initial.splitPercent));
      setSplitBase(initial.splitBase);
      setIsDefault(initial.isDefault);
      setNotes(initial.notes ?? "");
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
      if (initial) await updateConsignment(initial.id, data);
      else await createConsignment(data);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border-medium rounded-xl p-6 w-full max-w-lg">
        <h2 className="text-lg font-semibold text-text-primary mb-4">
          {initial ? "Edit Consignment" : "New Consignment"}
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
              {saving ? "Saving…" : initial ? "Save" : "Create"}
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
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/components/consignor
git commit -m "feat(web): consignment create/edit modal"
```

---

## Phase 4 — Payout modal

### Task 4.1: `PayoutModal`

**File:** Create `web/src/components/consignor/PayoutModal.tsx`

```tsx
"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, FileText, ExternalLink } from "lucide-react";
import { createPayout, type PaymentMethod } from "@/lib/consignor-api";
import { formatMoney } from "@/lib/utils";

interface Props {
  consignorId: string;
  consignorName: string;
  balance: number;
  unpaidItemCount: number;
  onClose: () => void;
  onCreated: () => void;
}

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "venmo", label: "Venmo" },
  { value: "paypal", label: "PayPal" },
  { value: "zelle", label: "Zelle" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "other", label: "Other" },
];

export default function PayoutModal({ consignorId, consignorName, balance, unpaidItemCount, onClose, onCreated }: Props) {
  const [method, setMethod] = useState<PaymentMethod>("venmo");
  const [methodNotes, setMethodNotes] = useState("");
  const [notes, setNotes] = useState("");
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
      setError(err instanceof Error ? err.message : "Failed to create payout");
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
              Settling <strong className="text-text-primary">{formatMoney(balance)}</strong> across {unpaidItemCount} unpaid items.
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
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Settling…</> : `Settle ${formatMoney(balance)}`}
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
                <p className="text-sm text-text-secondary">{formatMoney(balance)} settled with {consignorName}.</p>
              </div>
            </div>
            <div className="bg-bg-tertiary rounded p-4 space-y-2">
              <p className="text-sm text-text-secondary">Statement files:</p>
              <div className="flex gap-3">
                {done.pdfUrl ? (
                  <a href={done.pdfUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1 text-sm">
                    <FileText className="w-4 h-4" /> Open PDF
                  </a>
                ) : (
                  <span className="text-xs text-yellow-500">PDF not generated (file write failed — check server logs)</span>
                )}
                {done.csvUrl && (
                  <a href={done.csvUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline flex items-center gap-1 text-sm">
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

Note on URLs: web is same-origin with the file storage path (`/statements/...`), so `<a href={done.pdfUrl}>` works without prepending a base URL. Different from desktop where Electron is on a different origin.

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/components/consignor/PayoutModal.tsx
git commit -m "feat(web): payout creation modal"
```

---

## Phase 5 — Consignor detail page

### Task 5.1: Replace stub with full detail page

**File:** `web/src/app/(dashboard)/consignors/[id]/page.tsx`

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Plus, Edit2, Loader2, DollarSign, ExternalLink, FileText } from "lucide-react";
import {
  getConsignor, getConsignorBalance, listConsignments, listPayouts,
  type Consignor, type Consignment, type ConsignorPayout, type ConsignorBalance,
} from "@/lib/consignor-api";
import ConsignmentFormModal from "@/components/consignor/ConsignmentFormModal";
import PayoutModal from "@/components/consignor/PayoutModal";
import { formatMoney, formatShortDate } from "@/lib/utils";

type Tab = "consignments" | "payouts";

export default function ConsignorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();

  const [consignor, setConsignor] = useState<Consignor | null>(null);
  const [balance, setBalance] = useState<ConsignorBalance | null>(null);
  const [consignments, setConsignments] = useState<Consignment[]>([]);
  const [payouts, setPayouts] = useState<ConsignorPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("consignments");

  const [showConsignmentModal, setShowConsignmentModal] = useState(false);
  const [editingConsignment, setEditingConsignment] = useState<Consignment | null>(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [c, b, cs, ps] = await Promise.all([
        getConsignor(id),
        getConsignorBalance(id),
        listConsignments(id),
        listPayouts(id),
      ]);
      setConsignor(c);
      setBalance(b);
      setConsignments(cs);
      setPayouts(ps);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

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
      <button onClick={() => router.push("/consignors")} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Consignors
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{consignor.name}</h1>
          <p className="text-sm text-text-secondary mt-1">
            {consignor.email ?? "—"} · {consignor.phone ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-text-tertiary">Current Balance</div>
            <div className="text-2xl font-semibold text-text-primary">{formatMoney(balance?.balance ?? 0)}</div>
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
            onClick={() => setTab("consignments")}
            className={`py-2 text-sm font-medium border-b-2 ${tab === "consignments" ? "border-accent text-text-primary" : "border-transparent text-text-tertiary"}`}
          >
            Consignments ({consignments.length})
          </button>
          <button
            onClick={() => setTab("payouts")}
            className={`py-2 text-sm font-medium border-b-2 ${tab === "payouts" ? "border-accent text-text-primary" : "border-transparent text-text-tertiary"}`}
          >
            Payouts ({payouts.length})
          </button>
        </div>
      </div>

      {tab === "consignments" && (
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
                      <td className="px-4 py-3 text-text-secondary">{c.isDefault ? "Yes" : "—"}</td>
                      <td className="px-4 py-3">
                        <span className={c.isActive ? "text-xs text-green-500" : "text-xs text-text-tertiary"}>
                          {c.isActive ? "Active" : "Inactive"}
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

      {tab === "payouts" && (
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
                      <td className="px-4 py-3 text-text-primary">{formatShortDate(p.paidAt)}</td>
                      <td className="px-4 py-3 text-right text-text-primary font-medium">{formatMoney(Number(p.amount))}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {p.paymentMethod}{p.methodNotes ? ` (${p.methodNotes})` : ""}
                      </td>
                      <td className="px-4 py-3 text-text-secondary">{p.notes ?? "—"}</td>
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

Note: `formatShortDate` is in `@/lib/utils` (used by customers/page.tsx). Confirm by reading the import there.

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/app/\(dashboard\)/consignors/\[id\]/page.tsx
git commit -m "feat(web): consignor detail page with consignments + payouts tabs"
```

---

## Phase 6 — Consignment route bouncer

### Task 6.1: Replace stub

**File:** `web/src/app/(dashboard)/consignments/[id]/page.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getConsignment } from "@/lib/consignor-api";

export default function ConsignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getConsignment(id)
      .then((c) => router.replace(`/consignors/${c.consignorId}`))
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"));
  }, [id, router]);

  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-400">{error}</p>
        <button onClick={() => router.push("/consignors")} className="mt-3 text-accent hover:underline">
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

- [ ] **Step 2: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/app/\(dashboard\)/consignments
git commit -m "feat(web): consignment route bounces to parent consignor"
```

---

## Phase 7 — Rules UI: Set Consignment action

### Task 7.1: Add "Set Consignment" to web Rules page

**File:** `web/src/app/(dashboard)/rules/page.tsx`

This is the same surgical edit pattern as the desktop plan but on the web copy of Rules. Read the file first to learn its structure — it may differ from the desktop one even though they implement the same concept.

- [ ] **Step 1: Discover the action picker**

```bash
grep -n "set_brand\|action_type\|actionType\|target_id\|target_value" "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web/src/app/(dashboard)/rules/page.tsx"
```

Read enough to understand:
- How action types are listed (constant array vs hardcoded)
- How the action's target is rendered (single text input vs branching by type)
- Whether `target_id` is typed as string-only, number-only, or already polymorphic

- [ ] **Step 2: Add action option**

Add `{ value: "set_consignment", label: "Set Consignment" }` to the action-type list. If the type is a TS string union, add `"set_consignment"`.

- [ ] **Step 3: Add consignment dropdown rendering**

When `action_type === "set_consignment"`, render a `<select>`:

```tsx
{actionType === "set_consignment" ? (
  <select
    value={targetId ?? ""}
    onChange={(e) => updateAction({ target_id: e.target.value || null })}
    className="<existing-input-classes>"
  >
    <option value="">Select consignment…</option>
    {consignments.filter((c) => c.isActive).map((c) => (
      <option key={c.id} value={c.id}>
        {c.consignor?.name ?? "?"} — {c.name} ({Number(c.splitPercent).toFixed(0)}%)
      </option>
    ))}
  </select>
) : (
  /* existing fallback input */
)}
```

Load consignments from `listConsignments()` (no consignorId — get all):

```tsx
import { listConsignments, type Consignment } from "@/lib/consignor-api";
const [consignments, setConsignments] = useState<Consignment[]>([]);
useEffect(() => { listConsignments().then(setConsignments).catch(() => setConsignments([])); }, []);
```

- [ ] **Step 4: Verify**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && npx tsc --noEmit -p .
```
Baseline + 0 new.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && git add src/app/\(dashboard\)/rules/page.tsx
git commit -m "feat(web-rules): set_consignment action with consignment picker"
```

---

## Phase 8 — Final smoke

### Task 8.1: Type-check + walkthrough

- [ ] **Step 1: TypeScript check**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && npx tsc --noEmit -p .
```
Expected: ~7 baseline pre-existing errors. Zero new.

- [ ] **Step 2: Build (production)**

```bash
cd "C:/Users/hammo/Documents/Code Playground/LuxeSense/sellerfolio-platform/web" && npm run build
```
Should succeed. Next.js sometimes surfaces stricter type errors in build than `tsc --noEmit`. If consignor files cause new errors, fix them. Pre-existing failures elsewhere are not in scope.

- [ ] **Step 3: Manual UI walk (operator)**

Run `npm run dev` and walk through:
1. Sidebar → Consignors → New → "Web Test"
2. On detail → New Consignment → "Edikted 50/50" / 50% / NET
3. Rules → new rule: brand contains "Edikted" → Set Consignment = Web Test/Edikted → save → run
4. Back to Web Test → balance > 0 → Pay Out → Venmo → submit → PDF/CSV links open

- [ ] **Step 4: Commit any final fixes if needed.**

If smoke surfaced issues, fix and commit. Otherwise the plan is complete.

---

## Plan Self-Review Notes

- **Spec coverage** (against spec section 7):
  - Top-level Consignors nav → Phase 0 ✓
  - Index with create → Phase 2 ✓
  - Detail with consignments + payouts tabs → Phase 5 ✓
  - Consignment edit modal → Phase 3 ✓
  - Payout modal with PDF + CSV → Phase 4 ✓
  - Rules UI Set Consignment → Phase 7 ✓
  - Sales table consignor column → **DEFERRED** (called out in plan header)
  - Item edit drawer consignment picker → **DEFERRED**
- **No placeholders** — every code step has full code. Phase 7 is the one place with a sketched edit because the surrounding file structure is unknown; that task explicitly tells the implementer to read first.
- **Type consistency** — `splitPercent` is `string` per Prisma's Decimal serialization (matches the API response shape). Convert to number with `Number(c.splitPercent)` only at display/comparison sites.
- **Cross-page wiring** — Phase 5 imports both modals (Phases 3 and 4); plan ordering (3 → 4 → 5) ensures imports resolve at each commit.
