# TikTok Live Monitor PoC

Mirrors the Whatnot Live Monitor (`desktop/src/pages/LiveMonitor.tsx`) for TikTok Shop:
a live sales feed, top/unique buyers, failed payments, a products table, the current
auction, and headline stats — all derived from the streamer dashboard's own traffic.

## Data plane — three sources, joined on `product_id`

The original plan assumed TikTok's old webcast XHR-protobuf transport; that never fired for
this account. The real data plane (found via direct capture + a HAR export of the live
manager) is:

| # | Source | Gives |
|---|--------|-------|
| 1 | **frontier WebSocket** `wss://frontier.tiktokv.us/ws/v2` (JSON in a protobuf PushFrame) | real-time aggregate stats: total `sales`, `gmv_local`, `current_viewers`, per-product-id sold counts |
| 2 | **`…/streamer_desktop/live_auction/added_auction_product/list`** (POST, polled) | product names + images, per-product `num_sold`/`num_failed`, the pinned auction's `win_username`/`max_bidding_price`/`num_of_bids`, payment-failure count |
| 3 | **`…/streamer_desktop/live_auction/auction_result/get`** (POST, polled, paginated) | the per-sale history: `user_name`/`user_display_id`/avatar, `selling_price`, `is_payment_successful`, `order_id`, `product_name`, `sku_desc`, timestamps |

The preload wraps the page's WebSocket + XHR/fetch and forwards these to main; the portable
`core/` decodes/aggregates them. (We observe the dashboard's own TikTok-signed requests — so
the **monitor window must be on the live/auction management view** for sources 2 & 3 to poll.)

## Portable core (`src/core/`, unit-tested, zero electron/DOM deps)
- `pushFrame.ts` — parse the frontier PushFrame envelope (field 8 → JSON)
- `liveFeed.ts` — route WS JSON → stats events (room/core_stats/product_stats/session)
- `roster.ts` — `added_auction_product/list` → product roster + pinned auction
- `auctionResults.ts` — `auction_result/get` → dedupe by `order_id`, derive new sales, aggregate Top/Unique buyers + failed payments
- `money.ts` — `"$82.00"` → cents

## Run
1. `npm install`
2. `npm test`            # 23 core unit tests, no Electron needed
3. `npm run dev`         # builds, opens monitor + viewer windows
4. Log into TikTok in the **monitor** window if prompted (you log in yourself).
5. Open the **live / auction management** view in the monitor so the roster + sale endpoints poll.
   Watch the **viewer** window: stats cards, Live Sales Feed, Top Buyers, Products, Current Auction.

`TT_DEBUG=1` logs connection + per-poll summaries. `TT_CAPTURE=1` dumps raw frames/responses to `capture/`.

## Verifying offline
- `scripts/replay-monitor.ts` — replays the real HAR's roster + sale responses through the core and prints the full monitor state (proves derivation on real data).
- `scripts/parse-har.mjs` / `har-endpoint.mjs` — enumerate all endpoints/sockets in a HAR and dump any endpoint's body + field inventory.
- `scripts/catalog.mjs` — inventory the frontier WS payload shapes from a `TT_CAPTURE` run.

## What ports to the real app
Everything in `src/core/` becomes the internals of `desktop/src/lib/liveSource/TikTokLiveSource.ts`.
The Electron harness (`src/electron`, `src/renderer`) is throwaway. A production version should
**push** stats from the WS and **poll** `auction_result`/`added_auction_product` on an interval,
rather than passively observing the dashboard's own requests.

## Known gaps / notes
- Sources 2 & 3 are passive — they only flow while the monitor is on the auction view. Active
  polling (with `room_id`/`session_id` + TikTok's request signing) is the production approach.
- The monitor window runs `contextIsolation:false` so the preload can wrap the page's WebSocket/XHR.
  Production should inject a main-world hook, like `desktop/electron/whatnot-monitor-preload.ts`.
- Per-bid history (every bid, not just the winner) would need source 1's sibling `webcast/im/fetch`
  protobuf stream — out of scope here.
