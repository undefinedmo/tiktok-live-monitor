# Previous Cost Suggestions — Bug Analysis

**Date:** 2026-04-26
**Status:** Diagnosed, not fixed
**Symptom:** In the Sales (Transaction) screen, double-clicking the **Cost** cell opens the inline editor; the "Previous Costs" dropdown always shows "No previous costs" (or zero values) regardless of history.

## TL;DR

Not a missing-data problem — the v2 cost-suggestions endpoint was written to a different spec than what consumers expect. The desktop's inline-edit dropdown receives `undefined` for `suggestions` and falls through to an empty list. Even if the shape were fixed, the underlying query no longer aggregates by cost, so `usageCount` and the de-duplicated cost buckets v1 produced are gone.

## Affected paths

| Layer | File |
|---|---|
| Desktop UI | `desktop/src/pages/Sales.tsx` (lines ~190, ~340–387, ~2215–2292) |
| Desktop hook | `desktop/src/hooks/useSales.ts:308–316` |
| Web API | `web/src/app/api/items/cost-suggestions/route.ts` |
| Web UI (also broken) | `web/src/components/pnl/CostEditor.tsx:42–66` |
| v1 reference (working) | `../sellerfolio-desktop/electron/ipc/database.ts:549–591` |
| v1 reference (working) | `../sellerfolio-desktop/src/hooks/useSales.ts:262–269` |

## Data flow

### v1 (sellerfolio-desktop, working)

```
Sales.tsx → useSales.getCostSuggestions(brand, itemName)
         → window.databaseAPI.getCostSuggestions({ brand, itemName })
         → IPC handler 'db-get-cost-suggestions'
         → SQL: DISTINCT ON (cost) … COUNT(*) OVER (PARTITION BY cost) AS usage_count
         → returns { success: true, suggestions: [{ cost, usageCount, lastUsed, … }] }
```

### v2 (sellerfolio-platform, broken)

```
Sales.tsx → useSales.getCostSuggestions(brand, itemName)
         → apiClient.get('/api/items/cost-suggestions', { brand, item: itemName })
         → Next.js route GET /api/items/cost-suggestions
         → prisma.item.findMany({ where: { aiBrand, aiItem: { contains } } })
         → returns { success: true, data: { historicalCosts, avgCost, aiSuggestion, creditsUsed } }
```

## Root causes

### 1. Response shape mismatch (immediate cause)

**Desktop reads** (`useSales.ts:308–316`):

```ts
const result = await apiClient.get<{ suggestions: CostSuggestion[] } | CostSuggestion[]>(
  '/api/items/cost-suggestions', { brand, item: itemName }
);
if (Array.isArray(result)) return result;
return result.suggestions ?? [];   // ← top-level "suggestions"
```

**API returns** (`route.ts:94–102`):

```ts
return NextResponse.json({
  success: true,
  data: { historicalCosts, avgCost, aiSuggestion, creditsUsed },
});
```

`result.suggestions` is `undefined` → fallback `[]` → dropdown shows "No previous costs" every time.

The web's own `CostEditor.tsx:56` reads `result.data.suggestions`, which also doesn't exist in the response — so the web UI is silently broken in the same way.

### 2. Query no longer aggregates by cost

v1 SQL aggregates so each row in the result is a distinct cost with its `usage_count`:

```sql
SELECT DISTINCT ON (cost)
  ai_brand, ai_item, ai_color, ai_size, cost,
  COUNT(*) OVER (PARTITION BY cost) AS usage_count,
  MAX(order_date) OVER (PARTITION BY cost) AS last_used
FROM items
WHERE cost IS NOT NULL AND cost > 0
  AND LOWER(TRIM(ai_brand)) = LOWER(TRIM($1))
  AND LOWER(TRIM(ai_item))  = LOWER(TRIM($2))
ORDER BY cost, last_used DESC
LIMIT 5
```

v2 returns up to 20 **raw** item rows, with no `usageCount` and no de-duplication by cost. The UI renders `s.cost` (`Sales.tsx:2265`) and `×{s.usageCount}` (`:2266`) — both would be undefined/NaN even if the shape were corrected.

### 3. Item-name matching changed from exact to substring

- v1: `LOWER(TRIM(ai_item)) = LOWER(TRIM($2))` — exact, normalized equality.
- v2: `aiItem: { contains: item, mode: "insensitive" }` — substring. Pulls in unrelated items whose name contains the typed item as a substring.

### 4. Ordering changed

- v1: `ORDER BY cost, last_used DESC` — distinct cost buckets, most-recent first within each.
- v2: `orderBy: { orderDate: "desc" }` — flat list of recent items.

## Fix outline (minimum change to restore parity)

Edit `web/src/app/api/items/cost-suggestions/route.ts`:

1. Replace the `prisma.item.findMany` block with a `groupBy { cost }` query (or raw SQL mirroring v1) that:
   - Filters by `tenantId`, `cost IS NOT NULL AND cost > 0`.
   - Matches `aiBrand` and `aiItem` with case/whitespace-insensitive **exact** equality (use `equals` + `mode: "insensitive"`, and trim incoming params; or fall back to `$queryRaw` to also strip whitespace like v1).
   - Returns up to 5 distinct cost buckets, each with `cost`, `usageCount` (count of items at that cost), `lastUsed` (max `orderDate`).
2. Return `{ success: true, suggestions: [{ cost, usageCount, lastUsed, brand, itemName, color, size }] }` at the **top level** — match what `useSales.ts` already reads.
3. Decide whether to also keep the AI panel fields (`historicalCosts`, `avgCost`, `aiSuggestion`, `creditsUsed`) for `web/src/components/sales/CostSuggestionPanel.tsx`. Either:
   - Return both shapes: `{ success, suggestions, data: { historicalCosts, avgCost, aiSuggestion, creditsUsed } }`, OR
   - Split into two endpoints: `/api/items/cost-suggestions` (history list) and `/api/items/cost-suggestions/ai` (AI panel).
4. Update `web/src/components/pnl/CostEditor.tsx:56` to read from the new `suggestions` field too.
5. Keep `getTenantContext`/`requirePermission('sales.view')` and the `tenantId` filter — no change needed.

## Verification plan

After the fix:

1. In the desktop dev environment, double-click a Cost cell on an item that has a `ai_brand` + `ai_item` matching prior items with non-null `cost`.
2. Confirm the dropdown shows up to 5 distinct costs with `×N` usage counts, ordered by cost ascending.
3. Confirm exact-name match: an item named "Bag" should not pull suggestions from "Tote Bag".
4. Confirm tenant isolation: items in another tenant's data must not appear (test via a second tenant if available).
5. Confirm the web Sales page's inline `CostEditor` also shows suggestions after step 4.
