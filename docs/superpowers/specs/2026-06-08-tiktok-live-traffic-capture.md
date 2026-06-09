# TikTok Shop Live — Traffic Capture & Data-Source Findings

**Date:** 2026-06-08
**Status:** Investigation / capture complete — ready to sift
**Goal:** Determine whether we can build a Live Monitor for TikTok Shop live auctions equivalent to the existing Whatnot one (`desktop/src/pages/LiveMonitor.tsx`).
**Method:** Hooked `XMLHttpRequest` on the live Streamer Desktop dashboard (`shop.tiktok.com/streamer/live/event/dashboard`, `session_id=4463472902`, `room_id=7649102219992369933`) and decoded the protobuf event stream + REST responses during a real live show with active bidding/sales. ~260s capture, 151 stream frames, 68 commerce events, 0 decode errors.

> All long IDs/URLs below are illustrative — captured values were sanitized in-flight. Human-readable values (product names, prices, usernames, event names, field keys) are verbatim.

---

## 1. Verdict

**Yes — fully feasible, and TikTok actually exposes *more* than Whatnot.** Two independent sources, both confirmed live:

| Source | Transport | Nature | Best for |
|--------|-----------|--------|----------|
| **A. Real-time event stream** | `webcast/im/fetch` — XHR long-poll, `responseType=arraybuffer`, **protobuf** | Event-driven, low-latency | Instant bid/sale/auction-lifecycle events (the Sales Feed + live auction state) |
| **B. Auction roster poll** | `streamer_desktop/live_auction/added_auction_product/list` — POST, **clean JSON**, polled every ~1–2s during auctions | Aggregate snapshot | Per-product sold/failed counts, current winner, prices, stock — drives most of the dashboard with **no protobuf decoding** |

Whatnot gives us one JSON WebSocket. TikTok gives us a rich protobuf stream **and** a clean polled JSON snapshot. Source B alone could power a v1 Live Monitor; Source A adds real-time immediacy.

---

## 2. How our Whatnot monitor works today (baseline)

Hidden Electron `BrowserWindow` loads Whatnot's own page; `desktop/electron/whatnot-monitor-preload.ts` monkey-patches `window.WebSocket` to piggyback on Whatnot's auction socket (`/services/auction/socket`), parses **JSON** frames, and forwards `sale_detected` / `new_bid` / `auction_started` over IPC to `LiveMonitor.tsx`. Riding the page's own authenticated socket means we never deal with auth/signing.

**The TikTok parallel:** same hidden-window pattern, but hook **`XMLHttpRequest`** (not `WebSocket`) and decode protobuf — *or* just read the polled JSON roster. Riding the page's session sidesteps TikTok's request signing (see §6).

---

## 3. Endpoint inventory (observed)

Real-time / webcast (`webcast.us.tiktok.com`):
- `webcast/im/fetch/` — **the live event stream** (protobuf long-poll; `room_id`, `cursor`, `internal_ext` w/ `ack_ids`, `resp_content_type=protobuf`)
- `webcast/room/continue/` — keepalive
- `webcast/im/fetch` bootstrap via `streamer_desktop/websocket_config/get` (negotiates optional WS push; `sup_ws_ds_opt=1`)

Shop / streamer desktop (`shop.tiktok.com/api/v1/...`), all signed with `msToken`+`X-Bogus`+`X-Gnarly`:
- `streamer_desktop/live_auction/added_auction_product/list` — **auction roster (polled, JSON)** ⭐
- `streamer_desktop/live_product/list`, `recommended_product/search` — product catalog
- `streamer_desktop/live_session/get`, `live_room_info/get`, `live_creator_tools/get`, `settings/get` — session/room meta
- `insights/workbench/live/detail/room/info` + `/trend/chart` + `/room/status` — GMV / viewers / trend stats
- `live_promotion/billboard/current_displaying_billboard` + `/pre_live` — leaderboard / top buyers
- `streamer_desktop/live/coupon/section/get`, `pin/get`, `check_risk_permission`, `get_violation_detail`

---

## 4. Source A — real-time protobuf stream (`im/fetch`)

Envelope = standard TikTok `WebcastResponse`: a list of messages, each `{ method: string, payload: bytes }`. Decode by `method` name. Message types observed in this session:

```
WebcastChatMessage, WebcastMemberMessage, WebcastLikeMessage, WebcastSocialMessage,
WebcastRoomUserSeqMessage, WebcastBoostedUsersMessage, WebcastCapsuleMessage,
WebcastRoomNotifyMessage, WebcastPrivilegeAdvanceMessage, WebcastEcDrawMessage,
WebcastOECAuctionActionMessage, WebcastOecLiveCreatorMessage, WebcastOecLiveManagerMessage
```

The three **commerce** types are what we care about:

### 4.1 `WebcastOecLiveCreatorMessage` — auction lifecycle (the primary feed)

This is the direct analogue of Whatnot's auction socket events. Structure (protobuf field numbers):

```
1  Common header   { 1: method, 2: msg_id, 3: room_id, 4: server_ts }
2  seq/ack timestamp entries (kv {1:code, 2:ts})
3.2.1  Auction state object:
        .1  auction_id            (e.g. 8656…2619)
        .2  bid count / status
        .3  end_time (epoch sec)
        .4  quantity
        .5  product_name          ("Sugarholic Cookies")
        .6  price (integer)       ("31")
        .7  price (formatted)     ("$31.00")   ← current/final bid
        .8  product image url
        .9  timestamp
4  Event envelope:
        .1, .2  timestamps
        .3  EVENT NAME            ← the verb
        .4  kv map { action_type, action_platform, start_time,
                     order_payment_time, trigger_scenario, server_b_* timestamps }
```

**Event names (`4.3`) / `action_type` captured — the full auction lifecycle:**

| `4.3` event name | `action_type` | Whatnot equivalent | Notes |
|------------------|---------------|--------------------|-------|
| `auction.start` | `start_auction` | `auction_started` | `trigger_scenario: live_auction_pin_card` |
| `auction.new_bid` | `bid` | `new_bid` | carries current price (`$31.00`) + bid count |
| `auction.end` | `end_auction` | `auction_ended` | final price in `3.2.1.7`; `3.2.1.6=31` |
| `auction.result_update` | `auction_result_update` | (settlement) | includes `order_payment_time` → sale settled/paid |
| `auction.payment_failure` | — | Failed Payments panel | fires when winner's payment fails |

### 4.2 `WebcastOecLiveManagerMessage` — winner + product + buyer record

Richest single message — pairs buyer, product, and bid state:

```
1   Common header
11.1  User object   { 1: user_id, 3: display_name ("Brenda"),
                      9: avatar {url, 48×48}, 38: username ("brendap2929") }
11.2  Product       { 1: title ("Women Contemporary Random Pull"),
                      2: image {url, 48×48}, 3.1: price ("$15.00"),
                      4: product_id }
11.3  Bid/qty state { 1: count ("25"), 4: order/sku id }
```

→ gives us **buyer username + display name + avatar**, **product title + image + id**, and **price** — everything the Top Buyers / Unique Buyers panels need.

### 4.3 `WebcastOECAuctionActionMessage` — lightweight auction action ping

```
1  Common header
2  action code (varint)
3  nested auction_config_id ("10263952440…")
5  kv map { action_type ("start_auction"), action_platform ("app"|"pc"),
            start_time, trigger_scenario ("live_auction_pin_card"), server_b_* }
```

Lighter signal that mirrors `auction.start`; useful as a redundant trigger.

---

## 5. Source B — auction roster poll (`added_auction_product/list`) ⭐

POST, returns clean JSON, **polled every ~1–2s while auctions are live** (it appears idle-only at first because polling starts when an auction is active). This is the cleanest, lowest-effort source.

```jsonc
{
  "code": 0, "msg": "success", "has_more": false,
  "auction_payment_failure_info": { "num_auction_payment_failed": 1 },

  "pinned_auction_config": {              // the CURRENTLY RUNNING auction
    "auction_config_id": "10263952440…",
    "product_id": "...", "sku_id": "...",
    "product_name": "#29 Women Contemporary Random Pull",
    "variant_desc": "#29",
    "starting_bid_price": 15, "formatted_starting_bid_price": "$15.00",
    "duration": 15, "extended_auction_duration": 10,
    "stock_num": 271, "productStatus": 2, "auction_mode": 1,
    "cover": { "url_list": ["…"] },
    "num_sold": 1, "num_failed": 0,
    "latest_auction_item": {
      "status": 3,
      "win_username": "Sugarholic Cookies",          // ← WINNER
      "win_user_profile_image_url": "…",
      "max_bidding_price": "$15.00",                  // ← winning bid
      "num_of_bids": 1,
      "actual_end_time": 1780947882,
      "expected_end_time_ms": 1780947880915,
      "auction_bid_timestamp": "…"
    }
  },

  "auction_config_list": [                // all auction products in the show
    {
      "auction_config_id": "10263952440…",
      "product_id": "...", "sku_id": "...",
      "product_name": "#30 Women Contemporary Random Pull",
      "variant_desc": "#30",
      "starting_bid_price": 15, "formatted_starting_bid_price": "$15.00",
      "num_sold": 26, "num_failed": 3,                // ← cumulative per product
      "stock_num": 271, "duration": 15,
      "cover": { "url_list": ["…"] }
    }
  ]
}
```

Fields that map straight to Live Monitor stats: `num_sold`, `num_failed`, `num_auction_payment_failed`, `win_username`, `max_bidding_price`, `num_of_bids`, `formatted_starting_bid_price`.

---

## 6. Request signing (the one hard dependency)

Every `shop.tiktok.com` call carries `msToken` + `X-Bogus` + `X-Gnarly`, generated by ByteDance's obfuscated `webmssdk_ex.js`. Reproducing these server-side is brittle and a maintenance treadmill. **The in-browser/Electron-session approach avoids it entirely** — we ride the page's own already-signed requests (read responses via the XHR hook, or just observe the polled roster). This is the same reason our Whatnot monitor rides the page's socket.

`webcast/im/fetch` itself is also parameter-signed but is issued by the page; the hook reads its responses without re-signing.

---

## 7. Mapping to our existing Live Monitor data model

| LiveMonitor concept | Whatnot source | TikTok source |
|---------------------|----------------|---------------|
| Sale detected | `sale_detected` (WS) | `auction.end` / `auction.result_update` (stream) **or** `latest_auction_item.win_username` + `max_bidding_price` (roster) |
| New bid | `new_bid` (WS) | `auction.new_bid` → `3.2.1.7` price |
| Auction started | `auction_started` (WS) | `auction.start` / `WebcastOECAuctionActionMessage` |
| Buyer identity (Top/Unique Buyers) | sale username | `WebcastOecLiveManagerMessage 11.1` (username/display/avatar) or `win_username` |
| Items sold / revenue | derived | `num_sold` + price per `auction_config_list[]` |
| Failed payments panel | failed events | `auction.payment_failure` + `num_auction_payment_failed` |
| Product / image | listing | `product_name`, `variant_desc`, `cover.url_list` |

---

## 8. Recommended integration

1. **New preload** `desktop/electron/tiktok-monitor-preload.ts` — clone the Whatnot hidden-window pattern, but hook **`XMLHttpRequest`** instead of `window.WebSocket`.
2. **Two listeners:**
   - **Roster (v1, easy):** capture `added_auction_product/list` responses (already JSON) → emit `tiktok-auction-state`. Drives sold/failed counts, current auction, winner, prices with zero protobuf work.
   - **Stream (v2, real-time):** decode `im/fetch` protobuf, dispatch the 3 OEC message types → emit `tiktok-sale` / `tiktok-bid` / `tiktok-auction`.
3. **Protobuf decoding:** the schemaless wire-walker used in this capture already produces clean field trees; harden later with proper `.proto` definitions (standard webcast messages exist in the open-source `TikTokLive` project; the `OEC*` shop messages are reversed in §4 above).
4. **Renderer:** a TikTok variant of `LiveMonitor.tsx` (or a platform-parameterized version) consuming the same stat/feed shapes.

---

## 9. Still to confirm / capture next

- **Order/GMV totals:** decode `insights/workbench/live/detail/room/info` + `/trend/chart` JSON for show-level revenue/viewers (not captured — fires at load; capture by hooking before navigation or via UI refresh).
- **Top buyers leaderboard:** `live_promotion/billboard/current_displaying_billboard` shape.
- **`WebcastOecLiveManagerMessage` field 11.3 semantics:** confirm whether `.1` ("22"/"25") is bid count vs. quantity vs. viewers.
- **Non-auction "Buy Now" sales:** this show was auction-only; confirm how fixed-price shop purchases surface (likely a separate `Webcast…ShoppingMessage` or `live_product` flow).
- **WebSocket push path:** `websocket_config/get` advertises an optional WS transport (`sup_ws_ds_opt=1`); confirm whether the desktop ever uses WS instead of the XHR long-poll (changes the hook point).

---

## 10. Orders & post-show data (Seller Center + Live Data Screen)

Investigated 2026-06-08 to find the Whatnot-order-sync analogue. Two surfaces, both `fetch`-based JSON (note: Seller Center uses `fetch`, the streamer dashboard uses XHR):

### 10.1 Order list — `seller-us.tiktok.com/api/fulfillment/na/order/list` (POST, cursor-paginated)

The order-data source. `data.main_orders[]`, cursor via `next_cursor_token` / `has_more`. Each order ≈ **217 fields** grouped into modules. Seller identity `seller_id=7494618711066314723`, `app_name=i18n_ecom_shop`.

Modules that matter for us:
- `buyer_info_module` — `buyer_nickname` (TikTok username, e.g. `nugget9277`), `actual_buyer_nickname` ("Megs"), avatar, full `shipping_address` (name, phone, region/district).
- `sku_module[]` — `product_id`, `sku_id`, `product_name`, `sku_name`, `quantity`, `sku_unit_price`/`sku_total_price` (currency, val, formatted).
- `price_module` — `grand_total`, `sub_total`, `shipping_fee`, `taxes`, seller/platform discounts, `main_order_origin_sale_price`.
- `trade_order_module` — `create_time`, `payment_time`, `pay_method` (e.g. "Venmo"), `delivery_sla`, `fulfillment_type`.
- `delivery_module[]` — `tracking_no`, carrier (`shipment_provider_info` USPS), shipping service, warehouse, package weight/dims, tracking URL.
- `order_status_module[]` — `main_order_status`, `sku_display_status`.
- `reverse_module[]` — refunds/cancellations (`reverse_reason`, `refund_time`, `reverse_order_id`).
- `print_label_module[]` — `label_status`, `batch_id` (ties into our QR-label/print feature).
- **`extra_data_map.sales_source_live_tag`** ⭐ — *"Order contains one or more items from LIVE streams by the following creators: `luxesenseedit`"*; also `order_label_module[].label_express_map.sales_source_live_tag` = `"LIVE: luxesenseedit"`. **This is how orders link back to the LIVE show** (by creator handle; no room_id on the order itself).
- **`extra_data_map.auction_tag`** ⭐ — `"Auction"`, marks auction-sourced orders.

Supporting: `order/search_layout/get` (filter/column config), `order/export_record/get` (built-in CSV export feature).

### 10.2 Post-show live recap — `shop.tiktok.com/api/v1/insights/workbench/live/detail/*` (POST, keyed by `room_id` + `btm_show_id`)

The **Live Data Screen** (`/workbench/live/overview?room_id=…&btm_show_id=…`) is a full per-show recap. Endpoints (all POST, `app_name=i18n_ecom_shop`, `vertical=3`):
- `room/info` — room metadata **(almost certainly carries the replay playback URL — see 10.3; to confirm)** ⭐
- `room/status`
- `core/stats` (+ `core/stats/selection/get`) — show-level GMV / viewers / core stats.
- `trend/chart` (+ `trend/chart/selection/get`) — time-series trend.
- `product/list` (+ `product/list/selection/get`) — products sold in the show.
- `auction/list` — per-auction results for the show (post-hoc; complements the live `added_auction_product/list`). ⭐
- `rank_list/get` — top-buyer / leaderboard ranking (feeds a Top Buyers panel). ⭐
- `user/portrait` — buyer demographics.
- `event/timeline` — chronological show event timeline (auctions, milestones). ⭐
- `recap/comment` — chat/comment recap.
- `fe/config`, `common/info` — page config.

### 10.3 Video — replay IS available as HLS (on the Live Data Screen)

The per-show Live Data Screen embeds the **live replay video**, confirmed by capture:
- The `<video>` element plays a `blob:` URL via **MediaSource Extensions** (hls.js-style).
- Underlying source is a standard **HLS manifest** on TikTok/ByteDance's video CDN:
  `…/dash/hls-<id>/tos-useast5-v-150710-tx/<asset>.m3u8` → `.ts` segments.
- The path is **signed + expiring** (hash prefix + expiry token segment), so the manifest URL is time-limited.

**Implication:** the show video can be captured/archived with standard HLS tooling (e.g. `ffmpeg -i <m3u8>`) **while the signed URL is valid**, and associated with the show by `room_id`/`btm_show_id`. The issuing API is most likely `live/detail/room/info` (to confirm by capturing its body).

Note: the *other* "replay" endpoints on Seller Center (`session_replay`, `bytereplay.tiktokw.us`) are **rrweb DOM session-replay for support tooling**, NOT the live video — don't confuse them.

### 10.5 Identity reference (this account)

- `room_id` (a show): `7649102219992369933`; per-show recap also keyed by `btm_show_id` (e.g. `54248e12-…`).
- `seller_id` / `oec_seller_id`: `7494618711066314723`.
- Creator handle on live-sourced orders: `luxesenseedit`.

### 10.3.1 Per-order **Video receipt** (the key one) — HLS clip of the sale

Each live-sourced order detail (`/order/detail?order_no=…`) has a **"Video receipt"** — the clip of the moment the item sold/was won on the LIVE. Confirmed by capture on order `577424858038964867`:

- The order-line block shows `SKU ID`, product name, the `LIVE: luxesenseedit` tag, price (`$13.84 x 1`), and a **"Video receipt"** control (tracking attr `data-log_click_for="video_receipt_open"`).
- Opening it mounts a `<video>` fed by a `blob:` URL (MSE), backed by an **HLS manifest** on TikTok's LIVE CDN:
  `pull-hls-f16-thunder-tt01.fcdn.us.tiktokcdn-us.com/stage/stream-<streamId>/index.m3u8` → segments.
- `streamId` (e.g. `3578281742571406256`) identifies the live stream the clip is from.

**Implications:**
- The receipt is **HLS** → capturable/archivable with `ffmpeg`/hls tooling (URL is signed/expiring; "thunder" is live-streaming infra, so re-fetch promptly).
- It's loaded **on demand** when the receipt is opened, not present in `order/list`, `order/get`, or `trade/orders/get` bodies — so pulling it programmatically means triggering the same `video_receipt_open` path (or finding the dedicated play-URL endpoint it calls) per order line.
- This is the strongest order↔live linkage available: order line → `streamId` + creator handle.

### 10.3.2 Order-detail data endpoints (seller-us)

The detail page (`/order/detail`) pulls from: `api/fulfillment/na/order/get` (POST — full order detail), `api/v1/fulfillment/na/orders/buyer` (POST — buyer), `api/v3/trade/orders/get?main_order_id=…` (GET — trade record, 168 fields, **no video**), `api/v1/fulfillment/na/order/history` (POST — status history), and **`api/v1/pay/statement/order/list?reference_id=…&page_type=12`** (GET — **settlement/earnings statement**, the earnings-reconciliation source).

### 10.4 Order/earnings linkage summary

Orders → LIVE show is by **creator handle + time window**, not a direct room_id on the order. To attach orders to a specific show/auction we'd join on creator + timestamp (and cross-reference the live `auction_config_id`/product ids captured in §4–5). Confirm whether a stronger order↔room key exists in `order/detail` (not yet captured).

## 11. LIVE Center — creator-side LIVE analytics (`livecenter.tiktok.com`)

`livecenter.tiktok.com/analytics/live_video` is the **creator/anchor** analytics surface (distinct from the shop surfaces; app `aid=304449`). Its data comes from the webcast anchor API:

- **`webcast.us.tiktok.com/webcast/anchor/live_fragment/list/`** (POST) — the anchor's list of past LIVE sessions ("fragments") with per-LIVE metrics. Signed with `msToken`/`X-Bogus`/`X-Gnarly`.

Pullable via the creator's authenticated session (same browser-session approach as everything else). This is the per-LIVE history/analytics index; a per-fragment detail endpoint likely exists too (not yet captured). Useful as the authoritative list of shows (join key to `room_id`/replay video) for reporting. Confirms a third data source beyond Seller Center orders and the shop Live Data Screen.

## Appendix — capture harness

The reusable in-page collector (`window.__sfCap`) hooks `XMLHttpRequest.open`, decodes every `im/fetch` protobuf frame via a schemaless wire-walker, isolates the real outer message (method name is always immediately followed by tag `0x12`), extracts the OEC key/value maps, and buffers commerce events + commerce REST responses. Run it from the dashboard tab to reproduce/extend this capture during any live show.
