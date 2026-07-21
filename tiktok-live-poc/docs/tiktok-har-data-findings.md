# TikTok HAR Data Findings

Date reviewed: 2026-06-21

This document consolidates findings from the TikTok Shop and Seller Center HAR captures and compares them with the current data used by the app.

Reviewed captures:

- `C:\Users\hammo\Downloads\shop.tiktok.com-v2.har`
- `C:\Users\hammo\Downloads\seller-us.tiktok.com-613-sold-items.har`

Important handling note: these HAR files contain sensitive data, including buyer/order PII, tracking data, addresses, cookies or session-derived request context, and signed URLs. Do not commit raw HAR files, decoded raw responses, buyer addresses, phone numbers, or signed contact/video links.

## Current App Coverage

The app currently uses a focused set of TikTok data:

- Live product and auction roster data from `added_auction_product/list`.
- Auction sale history from `auction_result/get`.
- Basic room status and stream URL from `room/status`.
- Chat comments from `webcast/im/fetch`, currently focused on `WebcastChatMessage`.
- Seller Center order list via `seller-us.tiktok.com/api/fulfillment/na/order/list`.
- Seller Center order detail via `seller-us.tiktok.com/api/fulfillment/na/order/get` for auction video receipt URL, live room ID, and video receipt timestamp.

Current order normalization is intentionally narrow. `MappedOrder` keeps:

- Main order ID.
- Simple status/status code.
- Buyer handle/name.
- Grand total.
- Live tag.
- Auction flag.
- Reverse/refund flag.
- Order created time.
- Item product name, variant, and quantity.

The normalized `Sale` then uses product name as `productId`, because the current code assumes `order/list` does not provide a stable product ID. The Seller Center HAR proves that assumption is no longer true for the captured order-list responses.

Relevant code:

- `src/electron/tiktok-orders.ts`
- `src/core/types.ts`
- `src/core/auctionResults.ts`
- `src/core/roster.ts`
- `src/electron/main.ts`

## Capture 1: `shop.tiktok.com-v2.har`

### Endpoint Inventory

High-value endpoints seen in the Shop/live capture:

| Endpoint | Observed Use | App Uses Today | Opportunity |
| --- | --- | --- | --- |
| `GET /api/v1/streamer_desktop/pin/get` | Current pinned auction/product state | No | Add lower-latency pinned auction state |
| `POST /api/v1/streamer_desktop/added_auction_product/list` | Auction/product roster | Yes | Expand modeled fields |
| `POST /api/v1/streamer_desktop/auction_result/get` | Per-auction result rows | Yes | Expand lifecycle/payment fields |
| `GET /webcast/im/fetch/` | Protobuf live message stream | Partially | Decode more message types |
| `GET /api/v1/streamer_desktop/room/status` | Room status, duration, stream URL | Partially | Use status/duration, not only stream URL |
| `POST /api/v1/streamer_desktop/live_product/list` | Live product metadata | No or minimal | Product tags, server time, card metadata |
| `POST /api/v1/streamer_desktop/autoadd_product/list` | Auto-add state | No | Detect seller auto-add setting |
| `POST /api/v1/streamer_desktop/coupon/section/get` | Coupon section/pin state | No | Capture promotional context |
| `POST /api/v1/streamer_desktop/recommended_product/search` | Recommendation state | No | Product recommendation metadata |
| `GET /api/v1/streamer_desktop/settings/get` | Shop/live settings | No | Capture UI/feature switches |

### Unused Live Message Types

The `webcast/im/fetch` payload contains more than chat comments. The app currently decodes comments but can leverage additional message types.

Observed message markers:

| Message Type | Approx. Observations | Potential Use |
| --- | ---: | --- |
| `WebcastMemberMessage` | 70 | Join/entry activity, traffic pacing |
| `WebcastOecLiveCreatorMessage` | 60 | Commerce/live creator events |
| `WebcastOecLiveManagerMessage` | 56 | TikTok Shop live management events |
| `WebcastLikeMessage` | 42 | Engagement velocity |
| `WebcastRoomUserSeqMessage` | 40 | Viewer count/rank updates |
| `WebcastChatMessage` | 34 | Existing chat feed |
| `WebcastCapsuleMessage` | 6 | Live overlay/promo capsule state |
| `WebcastOECAuctionActionMessage` | 4 | Auction action transitions |
| `WebcastPrivilegeAdvanceMessage` | 2 | Viewer privilege events |
| `WebcastSocialMessage` | 2 | Follow/share/social activity |
| `WebcastBarrageMessage` | 2 | Highlighted comments/barrage |
| `WebcastInteractionHubGoalMessage` | 2 | Interaction goal progress |
| `WebcastRoomNotifyMessage` | 1 | Room-level notifications |

Recommended model additions:

- `LiveEngagementEvent` for likes, joins, follows, shares, and viewer sequence updates.
- `AuctionActionEvent` for auction lifecycle changes from `WebcastOECAuctionActionMessage`.
- `LiveNoticeEvent` for room notifications and commerce manager/creator events.

### `pin/get`: Current Auction State

The capture includes repeated calls to:

`GET shop.tiktok.com/api/v1/streamer_desktop/pin/get`

This endpoint is not currently captured by the preload endpoint classifier. It appears to provide current pinned-card and current auction state, including:

- Current pinned product/card.
- Current auction configuration.
- Current winner/current bid.
- Bid count.
- `pin_card_config`.
- Request/response server time metadata.

Why this matters:

- It can drive a more accurate "current auction" panel.
- It may be lower latency than waiting for roster or sale-result polling.
- It provides server time anchors for countdown accuracy.

Recommended work:

- Add endpoint classification for `pin/get`.
- Create a parser that normalizes pinned product, auction config, winner, bid count, bid price, and server-time offset.
- Merge this state with `RosterSnapshot.pinned`.

### Auction Roster Fields Not Modeled

`added_auction_product/list` contains more than the app currently uses. Fields worth modeling:

- `duration`.
- `extended_auction_duration`.
- `actual_start_time`.
- `actual_end_time`.
- `auction_bid_timestamp`.
- `auction_mode`.
- `auction_card_type`.
- `auction_config_type`.
- `productStatus`.
- `sku_id`.
- `auction_product_status_error_message`.

Potential use:

- Auction duration and extension analytics.
- Detect products that failed to start, failed validation, or are in an unexpected status.
- More accurate product/SKU joins with Seller Center orders.
- Better "current auction" and "up next" views.

### Auction Result Fields Not Modeled

`auction_result/get` contains additional sale/result fields:

- `auction_end_timestamp`.
- `sku_id`.
- `total_result_count`.
- `auction_result_grouped_data`.
- Payment-success and failure grouping data.

Observed sample rollup from one response:

- 88 result rows.
- 2 grouped product buckets.
- 83 paid.
- 1 failed.
- 4 pending.

Potential use:

- Validate whether all expected result rows were loaded.
- Track payment delay from auction end to order/payment creation.
- Show product-level auction closeout summaries.
- Detect stale pending payment rows.

### Room Status Fields Not Modeled

`room/status` includes fields beyond the stream URL:

- `data.status`.
- `data.duration`.
- Live stream URL.

Potential use:

- Accurate live/offline state.
- Session duration display.
- Guard against treating stale stream URLs as active.

### Other Shop/Live Fields

Additional captured fields worth considering:

- `live_product/list`: `introduce_id`, `server_time`, `lucky_bag_info.show_entrance`, `spu_limit`, `card_type`, `extra.live_b_general_price`.
- `autoadd_product/list`: `need_auto_add`.
- `coupon/section/get`: `is_pinned`.
- `recommended_product/search`: `show_recommended`.
- `request_demo_display`: `displayRequestDemo`.
- `settings/get`: `pwa_degrade`.

These are lower priority than `pin/get`, broader protobuf decoding, and richer auction result modeling, but they can help explain seller-center UI state and promotional context.

## Capture 2: `seller-us.tiktok.com-613-sold-items.har`

### Endpoint Inventory

High-value Seller Center endpoints observed:

| Endpoint | Observed Use | App Uses Today | Opportunity |
| --- | --- | --- | --- |
| `POST /api/fulfillment/na/order/list` | Main order page rows | Yes | Expand request filters and mapped fields |
| `POST /api/fulfillment/na/order/get` | Order detail rows | Partially | Use broader detail fields |
| `POST /api/fulfillment/na/package/list` | Package grouping and label data | No | Add pack/ship package model |
| `GET /api/v2/trade/orders/get` | Single order detail/timeline | No | Add order timeline/audit view |
| `POST /api/v1/fulfillment/na/shipping/options` | Shipping/label configuration | No | Configure batch labels, print sizes, split/combine |
| `GET /api/v1/fulfillment/na/logistic_detail/list` | Tracking and logistics timeline | No | Track shipment progress |
| `GET /chat/api/seller/mGetContactBuyerLinkByOrder` | Buyer contact links and unread flags | No | Quick contact and unread indicators |
| `POST /api/fulfillment/na/dashboard/get` | Operational order counters | No | Overdue/cancel/logistics/refund widgets |
| `POST /api/fulfillment/na/order/search_count` | Tab counts | No | Accurate tab counters |
| `POST /api/fulfillment/na/order/search_layout/get` | Search/filter layout metadata | No | Reproduce TikTok order filters |
| `GET /api/v1/fulfillment/na/orders/warehouse/list` | Warehouse options | No | Warehouse filters and labels |
| `POST /api/v1/seller/logistics_service/get_subscribable_service` | Logistics services | No | Shipping provider/service awareness |

### Important Request-Shape Mismatch

The captured Seller Center order page was not using the same request shape as the app.

Captured `order/list` request:

- `sort_info: "1"`.
- `search_condition.condition_list.order_status.value: ["2"]`.
- `search_condition.condition_list.search_tab.value: ["101"]`.
- `count: 20`.
- `pagination_type: 0`.
- `offset: 0`.
- `extra_data_list` included `replacement_order_tag_v1` in addition to other tags.

Current app request:

- `sort_info: "6"`.
- Empty `condition_list`.
- `count: 50`.
- No `replacement_order_tag_v1`.

Why this matters:

- The HAR represents the Seller Center `To Ship` sold-items view.
- The largest captured response returned 20 rows out of 200 total.
- Every row in the sampled page was status `101` in the normalized status module.
- The app may be syncing a different order population than the seller-center page the user expects.

Recommended work:

- Add explicit order sync modes for `All`, `Pending`, `To Ship`, `Shipped`, `Completed`, and `Canceled`.
- Use `search_layout/get` to derive TikTok's default sort key per tab.
- Include `replacement_order_tag_v1` in `extra_data_list`.
- Default Seller Center sold-items sync to `search_tab=101` when the user is in the sold/to-ship workflow.

### Product/SKU Data We Are Not Using

The Seller Center `order/list` response includes stable product and SKU fields in `sku_module`.

Observed fields:

- `product_id`.
- `sku_id`.
- `order_line_ids`.
- `product_name`.
- `sku_name`.
- `seller_sku_name`.
- `quantity`.
- `product_image.url_list`.
- `sku_total_price`.
- `sku_unit_price`.
- Creator/source info fields.

Current issue:

- The app uses product name as `Sale.productId`.
- This can merge different products with the same name, split the same product if names change, and weaken cost templates.

Recommended work:

- Extend `MappedOrder.items` with `productId`, `skuId`, `orderLineIds`, `imageUrl`, `unitPriceCents`, and `totalPriceCents`.
- Use `product_id` as `Sale.productId` when available.
- Use `sku_id` as an additional key for variant-level grouping.
- Populate `Sale.productImageUrl` from the Seller Center order list.

### Shipping and Fulfillment Data

The Seller Center HAR contains rich fulfillment and shipping data that is not currently modeled.

Observed modules and fields:

- `fulfill_unit_id_mapper`.
- `fulfillment_module`.
- `delivery_module`.
- `print_label_module`.
- `processing_time_info_module`.
- `package/list`.
- `logistic_detail/list`.

Useful fields:

- `fulfill_unit_id`.
- `package_id`.
- `order_line_id`.
- `tracking_no`.
- Logistics provider and service IDs/names.
- Shipping service min/max delivery days.
- Warehouse ID/name/region.
- Package dimensions and weight.
- Label status.
- Picking list status.
- Packing list status.
- Purchase time.
- Ready-to-ship time.
- Create/update fulfillment times.

Potential use:

- Pack/ship dashboard.
- Shipping label workflow.
- Package grouping.
- Thermal pick labels per item/package.
- Shipment timeline.
- Tracking status.
- Late dispatch risk.
- Warehouse filtering.

Recommended model additions:

```ts
interface FulfillmentInfo {
  fulfillUnitId?: string
  packageId?: string
  orderLineIds: string[]
  trackingNo?: string
  warehouseId?: string
  warehouseName?: string
  logisticsProviderName?: string
  shippingServiceName?: string
  packageStatus?: number
  labelStatus?: number
  pickingListStatus?: number
  packingListStatus?: number
  weight?: string
  dimensions?: string
}
```

### SLA and Operational Deadline Data

The HAR contains deadline fields that can drive an operational workflow:

- `trade_order_module.latest_rts_time`.
- `trade_order_module.latest_tts_time`.
- `trade_order_module.ship_cancellation_plan_time`.
- `trade_order_module.delivery_sla`.
- `processing_time_info_module.processing_time_info.processing_time`.
- `processing_time_info_module.processing_time_info.latest_processing_timestamp`.
- `processing_time_info_module.processing_time_info.extend_limit`.

Potential use:

- "Ship by" timers.
- Auto-cancel risk indicators.
- Overdue shipping alerts.
- Sorting by urgency.
- SLA breach reporting.

Recommended work:

- Add deadline fields to the normalized order model.
- Add computed urgency buckets: `ok`, `ship-soon`, `overdue`, `auto-cancel-risk`.
- Reconcile local urgency with TikTok's `dashboard/get` counters.

### Price Breakdown Data

Current app stores only grand total. Seller Center provides more detailed price modules.

Observed fields:

- Grand total.
- Origin sale price.
- Subtotal.
- SKU unit price.
- SKU total price.
- Platform discounts.
- Seller discounts.
- Shipping fee.
- Shipping origin fee.
- Shipping discounts.
- Taxes.

Potential use:

- More accurate revenue.
- Profit/margin calculations by item.
- Separate product revenue from tax/shipping.
- Discount reporting.
- Better cost template matching.

Recommended model additions:

```ts
interface PriceBreakdown {
  grandTotalCents: number
  subtotalCents?: number
  originSalePriceCents?: number
  sellerDiscountCents?: number
  platformDiscountCents?: number
  shippingFeeCents?: number
  shippingDiscountCents?: number
  taxCents?: number
}
```

### Split/Combine and Package Grouping

The sampled `order/list` response showed all 20 rows as live auction orders, and package mappings were present. The sample had:

- 20 response rows.
- 200 total rows.
- 20 auction-tagged rows.
- 20 live-source-tagged rows.
- 20 rows with SKU image data.
- 3 unique product IDs.
- 20 unique SKU IDs.
- 16 package IDs.
- 1 warehouse.

Relevant fields:

- `trade_order_module.split_combined_tag`.
- `trade_order_module.split_combine_express`.
- `trade_order_module.is_smart_combined`.
- `fulfill_unit_id_mapper`.
- `package/list` package rows.
- Package-level `sku_module`.
- Package-level `order_module`.

Potential use:

- Print one shipping label for combined orders.
- Print multiple item labels inside a combined package.
- Avoid duplicate package-level actions.
- Detect split packages and partial fulfillment.

Recommended work:

- Add a package entity keyed by `package_id` or `fulfill_unit_id`.
- Link package rows to order rows by `order_line_id`.
- Update print/pack views to group by package when fulfillment data is available.

### Auction Video Receipt Data

The current app fetches `order/get` to extract:

- `auction_video_receipt_url`.
- `live_room_id`.
- `video_receipt_timestamp`.

The Seller Center HAR shows this `auction_module` also appears in the richer `order/list` responses.

Potential use:

- Avoid extra `order/get` calls for rows where `order/list` already has these fields.
- Persist `live_room_id` for show grouping.
- Use `video_receipt_timestamp` to jump to the order moment in replay tooling.

Recommended work:

- Read `auction_module` directly from `order/list` when present.
- Fall back to `order/get` only when `auction_module` is missing or incomplete.

### Buyer Contact and Message Data

The HAR includes:

- `buyer_info_module.buyer_nickname`.
- `buyer_info_module.actual_buyer_nickname`.
- Avatar URL.
- `action_module.buyer_im_action_link`.
- `mGetContactBuyerLinkByOrder` response with per-order `hasUnRead`, `pigeonUid`, and app/PC contact links.

Potential use:

- Buyer avatar/display enrichment.
- "Unread buyer message" flag.
- Quick contact action from the ledger or pack view.

Safety recommendation:

- Do not store raw signed message URLs long-term.
- Store normalized flags and request fresh links on demand.

### Notes, Risk, Replacement, Refund, and Insurance Signals

Observed fields:

- `note_module.has_buyer_note`.
- `note_module.has_seller_note`.
- `note_module.has_seller_flag`.
- `reverse_module`.
- `extra_data_map.risk_order_tag_v1`.
- `extra_data_map.replacement_order_tag_v1`.
- `additional_service_purchased_module`.
- Shipping insurance coverage/status fields.

Potential use:

- Pack warnings.
- Exception queue.
- Buyer-note highlighting.
- Replacement/risk flags.
- Refund/reverse tracking.
- Insurance-aware handling for high-value orders.

Recommended work:

- Add normalized `orderFlags`.
- Display exceptions before printing/packing.
- Include flags in CSV export.

### Order Timeline and Logistics Timeline

`api/v2/trade/orders/get` and `logistic_detail/list` expose detailed timeline data.

Observed `trade/orders/get` fields:

- `available_actions`.
- `main_order_status`.
- `main_order_display_status`.
- `order_lines`.
- `payment_info`.
- `price_detail`.
- `processing_time_info`.
- `trans_histories`.
- SLA fields.
- Warehouse fields.
- Logistics provider/tracking fields.

Observed `logistic_detail/list` fields:

- `package_id`.
- `tracking_no`.
- `invoice_no`.
- `logistic_supplier`.
- `item_list`.
- `logistic_detail.track_list`.
- `predict_delivery_time_text`.
- `main_order_ids`.

Potential use:

- Per-order audit trail.
- Shipment status panel.
- "Where is this package?" support view.
- Delivery prediction.
- Better reconciliation between order status and package status.

### Dashboard, Search, and Layout Metadata

`dashboard/get` returned TikTok's operational widgets:

| Dashboard Column | Count in Capture | Use |
| --- | ---: | --- |
| Ship within 24 hours or less | 0 | Dispatch urgency |
| Auto-canceling within 24 hours or less | 0 | Auto-cancel prevention |
| Shipping overdue | 3 | Overdue alert |
| Cancellation requested | 0 | Cancellation queue |
| Logistics issue | 0 | Delivery exception queue |
| Return/refund requested | 0 | Return/refund queue |

`search_count` returned tab counts:

| Tab Key | Meaning | Count |
| --- | --- | ---: |
| `101` | To Ship | 200 |
| `102` | Shipped | 402 |
| `110` | Pending | 0 |
| `1100` | Additional pending-like count | 0 |
| `1200` | Additional to-ship-like count | 200 |

`search_layout/get` returned:

- Search tab definitions.
- Default selected tab: `101` / `To Ship`.
- Per-tab default sort keys.
- Filter component list per tab.
- Supported filters including buyer, product, package, payment, shipping service, logistics provider, customer message, seller note, order source, fulfillment type, warehouse, split/combine, urgency, cancellation type, and abnormal package tags.

Recommended work:

- Use `search_count` for tab counters.
- Use `dashboard/get` for top-level operational widgets.
- Use `search_layout/get` to build future filter UI or to keep API payloads aligned with TikTok defaults.

### Shipping Options and Label Workflow

`shipping/options` was the largest endpoint in the Seller Center capture.

Captured capabilities:

- `page_size_options`: `10`, `20`, `50`.
- Batch shipment enabled.
- Total batch size: `600`.
- Single batch size: `50`.
- Print batch size: `200`.
- Default provider ID.
- Combine package enabled.
- Split package enabled.
- Split package by item enabled.
- Pre-combine package page size options.
- Available pay methods.
- Logistics services, including Standard, Express, and Economy shipping options.
- Batch action availability per order tab.
- Shipping-label wait time.

Potential use:

- Configure batch label workflows.
- Respect TikTok split/combine support.
- Show print size/provider options.
- Prevent unsupported batch actions.
- Align internal pack/ship UI with TikTok's actual enabled settings.

Recommended work:

- Add a cached `ShippingConfig` model.
- Fetch shipping options on Seller Center connection.
- Use config in future label/pack workflows.

## Recommended Data Model Expansion

### Extend `Sale`

The current `Sale` shape is a good lightweight live-sale abstraction, but Seller Center orders need extra optional fields.

Recommended optional additions:

```ts
interface Sale {
  orderId: string
  buyer: Buyer
  productId: string
  productName: string
  productImageUrl?: string
  skuId?: string
  orderLineIds?: string[]
  skuDesc?: string
  quantity?: number
  price: Money
  priceBreakdown?: PriceBreakdown
  paymentStatus: 'paid' | 'failed' | 'pending'
  orderStatus?: number
  createdAt: number
  paidAt?: number
  liveTag?: string
  fulfillment?: FulfillmentInfo
  orderFlags?: OrderFlags
  deadlines?: OrderDeadlines
  auctionReceipt?: AuctionReceipt
}
```

### Add `OrderFlags`

```ts
interface OrderFlags {
  isAuction?: boolean
  isLiveSource?: boolean
  isReversed?: boolean
  isReplacement?: boolean
  isRiskOrder?: boolean
  hasBuyerNote?: boolean
  hasSellerNote?: boolean
  hasSellerFlag?: boolean
  hasUnreadBuyerMessage?: boolean
  hasInsurance?: boolean
  isSplitOrCombined?: boolean
}
```

### Add `OrderDeadlines`

```ts
interface OrderDeadlines {
  latestReadyToShipAt?: number
  latestTimeToShipAt?: number
  autoCancelAt?: number
  deliverySla?: string
  processingDueAt?: number
  urgency?: 'ok' | 'ship-soon' | 'overdue' | 'auto-cancel-risk'
}
```

### Add Package Model

```ts
interface SellerPackage {
  packageId: string
  fulfillUnitId?: string
  orderIds: string[]
  orderLineIds: string[]
  trackingNo?: string
  status?: number
  labelStatus?: number
  pickingListStatus?: number
  packingListStatus?: number
  warehouseId?: string
  warehouseName?: string
  logisticsProviderName?: string
  shippingServiceName?: string
  items: SellerPackageItem[]
}
```

## Implementation Priorities

### Priority 1: Fix Product/SKU Identity

Use `sku_module.product_id` and `sku_module.sku_id` from Seller Center order rows.

Why first:

- Directly improves ledger grouping.
- Improves cost templates.
- Avoids product-name collisions.
- Enables image thumbnails for synced orders.

Implementation scope:

- Extend `MappedOrder.items`.
- Update `mapTiktokOrder`.
- Update `orderToSale`.
- Add tests for product ID, SKU ID, image URL, and multi-SKU fallback.

### Priority 2: Match Seller Center Sold/To-Ship Request Shape

Support the captured `To Ship` request:

- `search_tab=101`.
- `order_status=2`.
- `sort_info=1`.
- Include `replacement_order_tag_v1`.

Why:

- Aligns app sync with the actual sold-items page.
- Reduces mismatch between Seller Center UI and app ledger.

Implementation scope:

- Add optional sync mode/filter parameters to `pullTiktokOrders`.
- Keep current all-order sync as an explicit mode.
- Add tests around payload construction if fetch is mockable.

### Priority 3: Add Fulfillment and SLA Fields

Normalize package, tracking, warehouse, label, and deadline fields.

Why:

- Enables operational pack/ship workflow.
- Helps prevent late dispatch and auto-cancel issues.
- Connects thermal labels to actual package grouping.

Implementation scope:

- Extend normalized order model.
- Add package/deadline fields as optional to preserve existing live-sale behavior.
- Surface key fields first: `packageId`, `trackingNo`, `warehouseName`, `latestReadyToShipAt`, `autoCancelAt`.

### Priority 4: Add Seller Center Dashboard Counts

Use:

- `dashboard/get`.
- `search_count`.

Why:

- Gives reliable top-level counts without local inference.
- Enables operational alerts: overdue, cancellation requests, logistics issues, returns/refunds.

Implementation scope:

- Add a small Seller Center status poll.
- Normalize tab counts and dashboard cards.
- Display counts in the app header or an operations panel.

### Priority 5: Add `pin/get` for Live Auction State

Use `shop.tiktok.com/api/v1/streamer_desktop/pin/get`.

Why:

- Better current-auction accuracy.
- More reliable bid/winner state.
- Server-time metadata for countdowns.

Implementation scope:

- Add endpoint classification.
- Add parser and tests.
- Merge into `RosterSnapshot.pinned`.

### Priority 6: Decode More Webcast Messages

Add parsers for high-value message types:

- `WebcastLikeMessage`.
- `WebcastMemberMessage`.
- `WebcastRoomUserSeqMessage`.
- `WebcastOECAuctionActionMessage`.
- `WebcastSocialMessage`.

Why:

- Provides engagement velocity.
- Adds auction lifecycle events.
- Improves live room telemetry.

Implementation scope:

- Extend protobuf decoding incrementally.
- Emit separate event kinds rather than overloading chat.
- Add fixture-based parser tests.

## Suggested Near-Term Checklist

- [ ] Add `product_id`, `sku_id`, image URL, and order line IDs to Seller Center order normalization.
- [ ] Replace product-name-based `Sale.productId` with stable product ID when present.
- [ ] Add order sync mode for TikTok `To Ship` sold-items request shape.
- [ ] Include `replacement_order_tag_v1` in `TT_ORDER_EXTRA_DATA`.
- [ ] Add optional fulfillment fields: package ID, fulfill unit ID, tracking number, warehouse, label status.
- [ ] Add optional deadline fields: latest RTS, latest TTS, auto-cancel timestamp, processing deadline.
- [ ] Add optional price breakdown fields.
- [ ] Add Seller Center dashboard/search-count polling.
- [ ] Add `pin/get` endpoint capture and parser.
- [ ] Add broader `webcast/im/fetch` message decoding.

## Risk Notes

- The HARs are snapshots. TikTok endpoint schemas can drift. Keep parsers defensive and optional-field based.
- Some IDs exceed JavaScript safe integer range. Preserve TikTok IDs as strings, especially `live_room_id`, order IDs, product IDs, SKU IDs, package IDs, and fulfill unit IDs.
- Avoid logging or persisting raw signed URLs, cookies, contact links, shipping addresses, or phone numbers.
- Do not assume all Seller Center order rows contain the same modules. Modules vary by status, fulfillment type, shipping provider, and region.
- Keep `Sale` backwards compatible. Existing live auction result flows should not require Seller Center fulfillment fields.
