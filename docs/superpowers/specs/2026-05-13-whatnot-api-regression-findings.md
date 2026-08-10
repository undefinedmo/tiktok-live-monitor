# Whatnot API Regression — Live Monitor Sale Feed

**Date:** 2026-05-13
**Status:** Investigation complete; fix pending
**Scope:** Desktop electron — `desktop/electron/ipc/live-stats.ts` Live Monitor sales feed
**Investigated by:** Direct browser probing of whatnot.com production GraphQL endpoint while logged in as `luxesenseedit`

## TL;DR

Whatnot changed their GraphQL schema. Our `LiveShopSold` query in `desktop/electron/ipc/live-stats.ts:213-247` still *parses* without errors, but returns **0 sold items for every show** — including ENDED shows with confirmed sales. The Live Monitor sales feed has been silently broken in production.

The new authoritative path is `liveStream(id: ID!).shop(tab: SOLD, ...)` returning a `ListingNode` connection. SKU has moved from `product.key` (now always `null`) to a direct `sku` field on `ListingNode`.

## Investigation method

1. Loaded https://www.whatnot.com/dashboard/home in an MCP-controlled Chrome tab while authenticated.
2. Installed a `window.fetch` interceptor to capture all outgoing GraphQL operation names, query strings, and variables.
3. Navigated through dashboard, past lives, individual show pages, inventory, and inventory edit pages to trigger Whatnot's own queries.
4. Compared captured queries to the queries in `desktop/electron/ipc/live-stats.ts`.
5. Read Apollo cache (`window.__APOLLO_CLIENT__.cache.extract()`) for canonical field shapes and real values.
6. Probed schema validity by sending candidate queries and checking for `Cannot query field 'X' on type 'Y'` errors.

Introspection was disabled on Whatnot's GraphQL endpoint, so all schema discovery was done via error responses and cache inspection.

## What broke

### The old query

`desktop/electron/ipc/live-stats.ts:214-235`:

```graphql
query LiveShopSold($liveId: ID!, $first: Int) {
  liveShop(liveId: $liveId) {
    soldItems(first: $first) {
      edges { node {
        id
        listing { id title images { url } }
        buyer { id username }
        price { amount currency }
        createdAt
      } }
    }
  }
}
```

### Evidence it's broken

Tested against show `65188d03-c053-441e-a6de-be657185e952` (ENDED, owned by the user, 77 confirmed sold items in Whatnot's own cache):

- Response: `{ data: { liveShop: { soldItems: { edges: [] } } } }`
- No GraphQL errors — the schema still accepts the query.
- Tested 8 separate ENDED shows from the user's past lives — all returned `edges: []`.

The `liveShop` field now returns a typename of `Shop` with an empty `soldItems` connection regardless of input. This appears to be a buyer-side view that was hollowed out when Whatnot migrated to seller-hub-native APIs.

## What works now

### The new path

```graphql
query LiveStreamSold($id: ID!, $first: Int) {
  liveStream(id: $id) {
    id
    shop(tab: SOLD, transactionTypes: null, query: "", first: $first) {
      totalCount
      edges { node {
        id
        uuid
        title
        sku
        barcode
        publicStatus
        transactionType
        quantity
        price { amount currency }
        costPerItem { amount currency }
        images { id url }
        order {
          id
          createdAt
          buyer { id username }
        }
        updatedAt
      } }
    }
  }
}
```

### Schema details

| Type | Field | Notes |
|---|---|---|
| `Query` | `liveStream(id: ID!): LiveStream` | replaces `liveShop(liveId)` |
| `LiveStream` | `shop(tab: ShopTab!, transactionTypes, query, first, after, ...): ListingNodeConnection` | replaces `Shop.soldItems` |
| `ShopTab` enum | `SOLD`, `ACTIVE` | (others likely) |
| `ListingNode` | `id, uuid, title, sku, barcode, publicStatus, transactionType, quantity, price, costPerItem, images, order, orders, updatedAt, auctionInfo, livestreams, videos, isMyListing, isEditable, ...` | flat shape replaces nested `SoldItem { listing { ... } }` |
| `ListingNode.order` | `OrderNode` (not `PublicOrderNode`) | singular per-listing order |
| `OrderNode` | `id, createdAt, buyer { id username }` | confirmed populated in cache |

### Confirmed real values

Pulled from Apollo cache on inventory edit page `/dashboard/inventory/TGlzdGluZ05vZGU6MTgxMjAwMDM2OA==`:

```json
{
  "id": "TGlzdGluZ05vZGU6MTgxMjAwMDM2OA==",
  "title": "6.COMFRT DREAMER BLANKET STRAWBERRY SWIRL XL MSRP $179",
  "sku": "601527386853",
  "publicStatus": "SOLD_OUT",
  "transactionType": "AUCTION",
  "quantity": 0,
  "price": { "amount": 100, "currency": "USD" },
  "costPerItem": { "amount": 11900, "currency": "USD" },
  "barcode": null,
  "updatedAt": "Wed, 13 May 2026 00:55:50 GMT"
}
```

A second sold listing in the same show confirmed `order.buyer.username` is populated with real usernames (e.g. `kris_again`, `nsote17`).

## SKU specifically

The user's original question: does Whatnot expose SKU when an item sells?

**Answer:** Yes — but on `ListingNode.sku`, not on `product.key`.

| Field | Schema status | Returns SKU value? |
|---|---|---|
| `Product.key` (old) | still exists | always `null` |
| `ProductNode.key` (new typename) | still exists | always `null` |
| `ProductNode.sku` | exists | always `null` |
| **`ListingNode.sku`** | exists | ✅ confirmed `"601527386853"` |

The SKU input field on Whatnot's listing-create form (`<input name="sku">`, label "SKU", help text "Buyers will see this on packing slips") writes to `ListingNode.sku`. Whatnot's `SellerHubInventory` query reads it back. Our query needs to do the same.

## Field comparison

| Field | Old query | New query |
|---|---|---|
| Returns data for tested show 65188d03 (77 sales) | 0 edges | 77 edges |
| Item title | ✅ `listing.title` | ✅ `title` (flat) |
| Item ID | ✅ `listing.id` | ✅ `id` + `uuid` |
| Images | ✅ `listing.images` | ✅ `images` |
| Sale price | ✅ `price` | ✅ `price` |
| **SKU** | ❌ (was on dead `product.key`) | ✅ `sku` |
| Buyer username | ✅ `buyer.username` | ✅ `order.buyer.username` (one level deeper) |
| Sale timestamp | ✅ `createdAt` | ✅ `order.createdAt` (one level deeper) |
| publicStatus | ❌ | ✅ |
| transactionType | ❌ | ✅ |
| totalCount | ❌ | ✅ |
| auctionInfo | ❌ | ✅ |
| costPerItem | ❌ | ✅ |
| barcode | ❌ | ✅ |

The new query is a strict superset. All old data is still reachable; buyer/createdAt move one level deeper into `order`.

### Field semantics

- **`publicStatus`** — listing state: `ACTIVE`, `INACTIVE`, `SOLD_OUT`, etc. Lets us distinguish genuinely sold items from pending or cancelled ones.
- **`transactionType`** — sale format: `AUCTION`, `BUY_NOW`, `GIVEAWAY`, `BREAK`. Useful for differentiating sale handling.
- **`totalCount`** — total sold-item count on the connection. No need to paginate just to count.
- **`auctionInfo`** — `{ endTime, currentPrice { amount currency }, bidCount }`. Final sale price (vs starting price), bidding competitiveness, exact end time.
- **`costPerItem`** — seller's cost basis. Useful for profit margin calculations.
- **`barcode`** — separate from SKU.
- **`updatedAt`** — listing last update timestamp.

## Why the regression wasn't caught

The old `LiveShopSold` query still parses successfully against Whatnot's schema — it returns `errors: null`. The only signal that anything is wrong is empty `edges`. Whatnot kept the field as a shell rather than removing it.

Our existing checks only assert "no errors." That's what allowed the silent break.

## Recommended verification approach

Add a startup smoke test that asserts three things against a fixture historical show with known sales (e.g. `65188d03-c053-441e-a6de-be657185e952`, 77 sales):

1. **Schema check:** `errors === null` — catches type renames and field removals.
2. **Data check:** `edges.length > 0` — catches the silent-break case we just hit.
3. **SKU pipeline check:** at least one `node.sku` is non-null — catches future SKU field migrations.

The triple-assertion is what would have caught this regression. Schema-only checks pass even when data is silently dropped.

## Caveats

- When the new query was sent directly via `fetch()` from the console, `me: null` and empty `edges` were returned even with the exact captured query verbatim. This suggests Whatnot uses persisted-query hashing or a directive (`@attribution(owner: "marketplace" feature: "inventory")` was observed on `SellerHubInventory`) for some authenticated paths. The desktop app's existing `executeGraphQLViaWindow` path (`live-stats.ts:17-115`) runs the query through the hidden Apollo client window — same authenticated context as the seller hub UI — and should work.
- All findings above are from Apollo cache reads, which canonically reflect what Whatnot's own UI receives.
- The schema-validity probes (no `Cannot query field` errors) are decisive proof that the fields exist on the current schema, independent of whether direct `fetch()` returns data.

## Files to update

- `desktop/electron/ipc/live-stats.ts:214-235` — `live-monitor-sales` IPC handler query body.
- Renderer-side hook that consumes the `live-stats-update` payload — response shape changes (buyer/createdAt move under `order`).

## Bonus discoveries

- Whatnot now uses a generic `listingAttributeValues` system for inventory metadata. Observed attribute intents in cache: `CONDITION`, `BRAND`. Labels seen: `Condition`, `Brand`, `Gender`, `MSRP`. SKU does NOT live here — it remains a direct field on `ListingNode`.
- Whatnot's GraphQL has introspection disabled in production.
- The `me.inventory(sellerIdV2, statuses, query, ...)` field is the seller-side inventory entrypoint, behind an `@attribution` directive.
- `ListingNode` has both `id` (Relay base64) and `uuid` (separate UUID string) — the `uuid` is more useful for cross-system referencing.
