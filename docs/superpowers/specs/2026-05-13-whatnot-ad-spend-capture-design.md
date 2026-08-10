# Whatnot Ad Spend Capture & P&L Integration

**Date:** 2026-05-13
**Status:** Design
**Scope:** Sync (`desktop/electron/lib/whatnot-sync.ts` + middleware ingest), DB schema (`web/prisma/schema.prisma`), P&L calculation, Consignment/Partner deal rules
**Related:** `2026-05-13-whatnot-api-regression-findings.md` (sales-feed regression — same sync pass should pick up both fixes)

## Goal

For every Whatnot show we sync, also capture the **ad spend** the seller paid during/for that show (combined Promotions + Boosts), store it on the show, surface it as a cost line in P&L, and give Consignment/Partner deals the option to include or exclude it from the cost basis used to compute partner payouts.

## Background (verified live against whatnot.com on 2026-05-13)

Whatnot's seller hub exposes per-show ad spend through the operation `GetAdsInsightSummary` (URL `/dashboard/marketing/promote-tools/lives/<liveId>`). The relevant root field is `getAdsPostShowRoi(livestreamId: ID!)`.

### Sample response (real values for show `65188d03-c053-441e-a6de-be657185e952`)

```json
{
  "data": {
    "getAdsPostShowRoi": {
      "result": {
        "__typename": "AdsPostShowRoi",
        "livestreamTitle": "NEW SHIPMENT ✨ NWT COMFRT INCLUDING BLANKETS!🧸",
        "livestreamStartDateTimestampMillis": 1778629794674,
        "estimatedAdImpressions": 1721,
        "nextAdsEligibleLivestreamId": "c06fca89-…",
        "totalSpend":           { "amount": 9427,  "currency": "USD", "amountSafe": 9427 },
        "promotionsSummary": {
          "spent":              { "amount": 9427,  "currency": "USD", "amountSafe": 9427 },
          "totalBudget":        { "amount": 18000, "currency": "USD", "amountSafe": 18000 },
          "estimatedImpressions": 1721,
          "estimatedTaps": 708
        },
        "boostsSummary": null,
        "communityBoostsSummary": { "count": 0, "contributionsTotal": { "amount": 0, "currency": "USD" } }
      },
      "error": null
    }
  }
}
```

`Money.amount` is in **cents** (`9427` = `$94.27`).

### Field meanings

| Field | Meaning | Use |
|---|---|---|
| `totalSpend` | Combined paid Promotions + Boosts spend by the seller | **Bottom-line cost line for P&L** |
| `promotionsSummary.spent` | Spend on the "Promotions" ad tool only | Informational breakdown |
| `promotionsSummary.totalBudget` | What the seller pre-funded for promotions | Informational |
| `boostsSummary.spent` | Spend on the "Boosts" ad tool only (null if none) | Informational breakdown |
| `communityBoostsSummary.contributionsTotal` | Money the **community** contributed (viewers tipping into the boost jar) | ❌ Not a seller cost; ignore for P&L |

### Aggregate variant (not used here, noted for completeness)

`getAdsRoiMetrics(queryParameters: { timePeriod: { startEpochMillis, endEpochMillis } })` returns date-range totals. Useful for the Marketing overview page but not per-show. We rely on `getAdsPostShowRoi` instead.

## The query we'll add

```graphql
query GetAdSpendForShow($livestreamId: ID!) {
  getAdsPostShowRoi(livestreamId: $livestreamId) {
    result {
      totalSpend { amount currency amountSafe }
      promotionsSummary {
        spent { amount currency amountSafe }
        totalBudget { amount currency amountSafe }
        estimatedImpressions
        estimatedTaps
      }
      boostsSummary {
        spent { amount currency amountSafe }
        estimatedImpressions
        estimatedTaps
      }
      estimatedAdImpressions
    }
    error { message }
  }
}
```

## DB schema additions

### `Show` — three new columns

```prisma
model Show {
  // …existing fields…

  // Whatnot ad spend (cents, USD-normalized — Whatnot returns Money in cents)
  adSpendTotalCents       Int?      @map("ad_spend_total_cents")
  adSpendPromotionsCents  Int?      @map("ad_spend_promotions_cents")
  adSpendBoostsCents      Int?      @map("ad_spend_boosts_cents")
  adSpendSyncedAt         DateTime? @map("ad_spend_synced_at") @db.Timestamptz
}
```

Rationale for "cents on Show" rather than auto-creating an Expense row:
- `Expense.paymentAccountId` is non-nullable; auto-create would force inventing a phantom payment account.
- Ad spend is debited from the seller's Whatnot payout balance, not from any of the user's tracked payment accounts.
- Keeping the values on `Show` lets P&L read them with the same query that already loads the show — zero extra joins.
- Editing is direct (one row, three numbers) rather than juggling Expense + ExpenseCategory + PaymentAccount.

We can still surface ad spend as a virtual "Whatnot Ad Spend" line in any P&L view by reading these columns — no Expense row needed.

### `Consignment` — one new column

```prisma
model Consignment {
  // …existing fields…

  // When TRUE, ad spend from the show is added to the cost basis used to
  // compute the partner's share — i.e. the partner shoulders a portion of
  // the boost. When FALSE (default), the seller absorbs ad spend entirely
  // and the partner is paid as if ad spend never happened.
  includeAdSpendInCost  Boolean  @default(false) @map("include_ad_spend_in_cost")
}
```

Default `false` preserves existing partner-payout math (no surprise reductions to historical payouts).

## Sync flow

### `desktop/electron/lib/whatnot-sync.ts`

Add alongside `fetchOrders` / `fetchShows`:

```ts
export async function fetchAdSpendForShow(livestreamId: string): Promise<{
  record: AdSpendRecord | null;
  errors: string[];
}> {
  const result = await graphql<{ getAdsPostShowRoi: AdsPostShowRoiResponse }>(
    GET_AD_SPEND_FOR_SHOW_QUERY,
    { livestreamId },
    'GetAdSpendForShow'
  );
  if (result.errors?.length) {
    return { record: null, errors: result.errors.map(e => e.message) };
  }
  const r = result.data?.getAdsPostShowRoi?.result;
  if (!r) return { record: null, errors: [] };
  return {
    record: {
      showId: livestreamId,
      totalCents:       r.totalSpend?.amount ?? 0,
      promotionsCents:  r.promotionsSummary?.spent?.amount ?? 0,
      boostsCents:      r.boostsSummary?.spent?.amount ?? 0,
      currency:         r.totalSpend?.currency ?? 'USD',
      estimatedImpressions: r.estimatedAdImpressions ?? null,
    },
    errors: [],
  };
}
```

### `desktop/electron/ipc/sync.ts`

When the `shows` sync runs (or when a sales/orders sync targets specific `showIds`), after the existing show metadata is fetched, also call `fetchAdSpendForShow` for each show and POST the records to a new middleware ingest endpoint.

Suggested integration point: in the `shows` sync, after `fetchShows` produces its records, loop with `Promise.allSettled(records.map(s => fetchAdSpendForShow(s.id)))` (gentle concurrency; see "Rate limiting" below). Skip shows whose `adSpendSyncedAt` is recent unless the user requested a force-refresh.

### Middleware ingest

New endpoint `POST /api/sync/whatnot/ad-spend` (or extend the existing `shows` ingest to accept `adSpend` per record). Body shape:

```ts
[
  {
    showId: '65188d03-…',
    totalCents: 9427,
    promotionsCents: 9427,
    boostsCents: 0,
    currency: 'USD',
    estimatedImpressions: 1721,
  },
  // …
]
```

Handler does `prisma.show.update({ where: { id, tenantId }, data: { adSpendTotalCents, adSpendPromotionsCents, adSpendBoostsCents, adSpendSyncedAt: new Date() } })` per row, scoped by `tenantId` (standard pattern).

### Rate limiting

`getAdsPostShowRoi` is one call per show. A 30-day sync window is ~10–30 shows for typical sellers. Run with concurrency 3 and a 200ms jitter between batches — well under Whatnot's seller-hub-implied limits, and an order of magnitude less traffic than the existing orders pagination.

## P&L integration

### Per-show P&L (existing view, augmented)

Today P&L aggregates `Show.totalGross`, `Show.totalNet`, and `Item.cost` for items in the show. Add ad spend as a new line:

```
Gross sales         $X
Whatnot fees        $Y
COGS                $Z
Whatnot ad spend    $A     ← new (from show.adSpendTotalCents / 100)
─────────────────────────
Net profit          $X - $Y - $Z - $A
```

Implementation: in the P&L query / aggregator (web app), include the three `adSpend*Cents` columns in the show select, then format to dollars in the response shape consumed by the P&L UI.

For backwards compatibility: rows with `adSpendTotalCents IS NULL` are unsynced (show predates this feature or sync hasn't run) and should display "—" rather than `$0.00` to distinguish "no data" from "no spend".

### Multi-show P&L roll-up

Sum `adSpendTotalCents` across selected shows. No date alignment needed since spend is attributed to the show itself, and shows already have `startTime`/`endTime`.

## Consignment / Partner deal — include/exclude toggle

### The math

Ad spend is a **show-level** cost; a Consignment can include items spanning multiple shows (or just one). To distribute a show's ad spend across the consignment's items in that show, allocate **proportionally by item gross revenue**:

```
allocated_ad_spend(item) =
  show.adSpendTotalCents
  * (item.grossAmount / show.totalGross)
```

Where `item.show = show`. Items not in a synced/promoted show contribute zero.

Rationale: revenue-weighted is fair because high-revenue items benefited more from the boost. Equal-share (`adSpend / itemCount`) is also defensible but penalizes low-value items disproportionately.

### Applying the toggle

In the partner-payout computation for each item (in the existing logic that already uses `splitPercent`, `splitBase`, and `sellerCostShare`):

```ts
const allocatedAdSpend = consignment.includeAdSpendInCost
  ? computeAllocatedAdSpend(item, show)
  : 0;

const effectiveCostForSplit =
  (item.actualCost ?? 0) * (consignment.sellerCostShare / 100)
  + allocatedAdSpend;

// downstream split math uses effectiveCostForSplit as before
```

When `includeAdSpendInCost = false` (default), behavior is unchanged from today.
When `true`, the partner's payout is reduced by their share of the ad spend.

### UI surface

On the Consignment edit form (existing UI), add a single checkbox under the split-config section:

```
☐ Include Whatnot ad spend in cost basis
   When enabled, this partner's share of any Whatnot promotion or boost
   spend during the show is deducted from their payout.
```

Tooltip should reference the revenue-weighted allocation formula.

## Verification approach

Following the same "schema + data + semantic" pattern used for the API regression fix:

1. **Schema check:** `GetAdSpendForShow` returns `errors === null`.
2. **Data check:** `getAdsPostShowRoi.result` is non-null for any show the user actually promoted.
3. **Sanity check:** `result.totalSpend.amount === (promotionsSummary?.spent?.amount ?? 0) + (boostsSummary?.spent?.amount ?? 0)` for at least one fixture show.

Add these to the same Live Monitor smoke-test pass that catches the sales-feed regression (`2026-05-13-whatnot-api-regression-findings.md`).

## Edge cases

- **Show with no ad spend** — `result.totalSpend.amount === 0`; we still write `0` cents (distinct from `NULL` meaning "not synced").
- **Show too old / not yet eligible** — server may return `error.message` or `result === null`. Treat as "skip, don't overwrite existing value".
- **Currency mismatch** — Whatnot returns currency on the Money object. Today all examples are USD; we store currency on the row to detect drift, but P&L assumes USD until proven otherwise. If we see non-USD, surface a warning rather than silently converting.
- **Item in a show but no `grossAmount`** — exclude from the revenue-weighted allocation (denominator and numerator both skip), so allocation only spreads across items with known revenue.
- **`show.totalGross` is 0 or null but ad spend > 0** — fall back to equal-share allocation (`adSpendTotalCents / itemCount`) to avoid divide-by-zero. Should be rare.
- **Consignment toggle changed retroactively** — partner payouts that were already settled (`ConsignorPayout` rows exist) are immutable; the toggle only affects future payouts. Document this in the toggle's UI copy.

## Files to change

| Layer | File | Change |
|---|---|---|
| Schema | `web/prisma/schema.prisma` | Add 4 cols on `Show`, 1 col on `Consignment` |
| Migration | `web/prisma/migrations/<ts>_show_ad_spend/` | Generated migration |
| Sync (desktop) | `desktop/electron/lib/whatnot-sync.ts` | Add `GET_AD_SPEND_FOR_SHOW_QUERY` + `fetchAdSpendForShow` |
| Sync (desktop) | `desktop/electron/ipc/sync.ts` | Call `fetchAdSpendForShow` per show during `shows` sync; POST to new middleware endpoint |
| Ingest (web) | `web/src/app/api/sync/whatnot/ad-spend/route.ts` (new) | Accept batch, upsert `Show.adSpend*` columns scoped by tenant |
| P&L (web) | wherever the P&L aggregator lives — add ad spend line | Include the 3 cols in select; format to dollars in response |
| Partner payout (web) | wherever consignment payout is computed | Apply `includeAdSpendInCost` toggle with revenue-weighted allocation |
| UI (web) | Consignment edit form | Add checkbox + tooltip |
| UI (web) | P&L view | Add "Whatnot Ad Spend" line |

## Open questions

1. **Should ad spend allocate across all items in the show, or only across items in this consignment within the show?** Recommendation: across all items in the show, then sum the partner's items' allocations. This is the revenue-weighted interpretation. The alternative (only across consignment items) would over-allocate to the partner.
2. **Should `includeAdSpendInCost` be the only option, or do we also want a per-tenant default?** A tenant-level default ("new consignments include ad spend by default") may help users who always run partner deals with shared ad spend. Out of scope for V1.
3. **Equal-share vs revenue-weighted allocation as a per-consignment setting?** V1: revenue-weighted only. If users push back, add `adSpendAllocation: "REVENUE" | "EQUAL"` later.

## Out of scope for this design

- Historical backfill: spec covers go-forward sync only. A separate backfill script can iterate past shows once the schema is migrated.
- Surfacing the breakdown (Promotions vs Boosts) in the UI — we capture both columns but V1 P&L only shows the total. Easy to add later.
- Community Boosts (`communityBoostsSummary.contributionsTotal`) — viewer-contributed funds, not seller spend. Could be tracked as income in a future spec; ignored here.
