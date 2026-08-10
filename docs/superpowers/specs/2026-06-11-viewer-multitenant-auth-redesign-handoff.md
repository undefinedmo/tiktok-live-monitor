# Handoff: Viewer → Multi-tenant, Authenticated, "Obsidian" UI redesign

**Date:** 2026-06-11
**Purpose:** Hand a fresh Claude Code session everything it needs to (a) restyle the TikTok data viewer to the new "Obsidian" design, and (b) make it a real multi-tenant app with username/password login backed by PostgreSQL.
**Status:** DESIGN/PLANNING ONLY — nothing in this doc has been implemented yet. Start with brainstorming/decisions, not code.

---

## 0. TL;DR for the new session

The user wants the **viewer app** (`tiktok-data-viewer/`, served by `serve.py` on `127.0.0.1:8770`) to become:
1. **Re-skinned** to the "Obsidian Data System" design (monochrome charcoal, in `C:\Users\hammo\Downloads\stitch_visual_clarity_enhancer\`).
2. **Multi-tenant**, backed by **PostgreSQL** ("create a new database").
3. Gated behind a **username + password login**.

⚠️ **READ §4 FIRST.** A multi-tenant Postgres DB with username/password/session auth **already exists** in this repo (`sellerfolio-live-api` → `sellerfolio_v2`). Creating a *second, parallel* database will fragment the data (the desktop app already syncs into `sellerfolio_v2`). The user said "create a new database," but they may not know the existing one already covers most of this. **Confirm the reconcile decision (§4) with the user before building anything.**

Do **not** start implementing until the user has chosen between "reuse `sellerfolio_v2`" vs "brand-new DB" and approved a plan.

---

## 1. The new design — "Obsidian Data System"

**Source files** (the user's reference, treat as the visual target):
- `C:\Users\hammo\Downloads\stitch_visual_clarity_enhancer\DESIGN.md` — full design system (colors, type, spacing, components).
- `C:\Users\hammo\Downloads\stitch_visual_clarity_enhancer\code.html` — Tailwind static mockup (357 lines).
- `C:\Users\hammo\Downloads\stitch_visual_clarity_enhancer\screen.png` — rendered screenshot.

**Aesthetic:** "Modern Corporate / Minimalism" — a calm, high-legibility "heads-up display" for data operators. **No neon, no glassmorphism, no shadows/glow.** This is a deliberate departure from the previous Lumina-dark cyan/magenta look and the viewer's current cyan accents.

**Colors (functional grayscale + tonal layering):**
- Canvas/background: `#121212` (DESIGN.md) — note `code.html` uses `#000000`; pick one, lean to `#121212` per DESIGN.md.
- Surface (cards/containers): `#1E1E1E` (Level 1). Interactive/floating (tooltips, dropdowns): `#2C2C2C` (Level 2).
- Primary text: `#E0E0E0`. Secondary/muted text: `#9E9E9E`.
- Borders: 1px solid `#2C2C2C`, only where two same-tone surfaces meet or for table row boundaries.
- Accents: **desaturated** semantic colors for status tags only (e.g. muted teal/green "To ship", muted red for refund/cancel). `error: #ffb4ab`.
- Depth via **brightness/tonal layering**, never shadows or blur.

**Typography (3 families, by intent):**
- **Hanken Grotesk** — headlines + KPIs (`kpi-xl`: 36/700, `headline-lg`: 24/600, `headline-md`: 20/600).
- **Inter** — body + interactive (`body-lg`: 16/400, `body-md`: 14/400).
- **JetBrains Mono** — technical labels, IDs, tabular/`data-mono` (13/400), and `label-caps` (12/600, uppercase, letter-spacing .05em) for all section labels.
- **Material Symbols Outlined** — icons.
- Bold weights reserved for KPIs + primary headers only.

**Layout/spacing:** 12-col fluid grid (→ 8-col tablet → 1-col mobile). 8px base grid; 16px gutter; 24px safe margin; generous vertical spacing (`lg` = 40px) between functional groups. 8px (0.5rem) radius on containers/buttons/inputs; pill (`rounded-xl` 1.5rem) for status tags.

**Components:**
- Primary button: solid `#E0E0E0` fill, `#121212` text. Secondary: 1px `#9E9E9E` outline.
- Inputs: `#1E1E1E` bg, `#2C2C2C` border; focus → border `#E0E0E0`.
- Cards: `#1E1E1E`, 24px padding, no shadow; header in `label-caps`.
- Tables: header row `#121212`, body rows `#1E1E1E`, hover `#252525`.
- KPI blocks: centered, `kpi-xl`, on `#1E1E1E`.

**Screen layout (from screen.png) — the viewer already has all of this functionally:**
- Top nav: `● LIVE LEDGER · TIKTOK SHOP` | tabs `Dashboard · Orders · Inventory · Analytics` | bell icon + **Refresh Data** button.
- KPI row: Orders `272` · Gross Revenue `$8,970.55` (incl. shipping + tax) · Units sold `272` · Avg order `$32.98` · Refunds/cancels `54`.
- Toolbar: search box · `All statuses` · `All sources` · `Transcribe filtered (159)` · `Transcribe all (212)`.
- Data table: `ORDER · DATE · BUYER · PRODUCT · QTY · TOTAL · STATUS`, with **expandable rows** showing Buyer & Shipping, Item details, Price breakdown, Fulfillment, refund banner, and `Refine Transcript` / `Transcribe with Gemini` actions.

➡️ **This is a restyle of the existing `tiktok-data-viewer/index.html`, not a new app.** The current viewer already implements KPIs, search/status/source filters, the order table, expandable rows, and Gemini transcription. The work is: port that markup/logic onto the Obsidian design system (replace the cyan Lumina styling). Decide framework: keep the single-file vanilla HTML/JS approach, or move to a component framework if the multi-tenant rebuild (§3) warrants it.

---

## 2. Current state of the viewer (what exists today)

**`tiktok-data-viewer/`** — a Python `serve.py` (`ThreadingHTTPServer`, loopback `127.0.0.1:8770`) + `index.html` single-page vanilla JS app. Key facts:

- **Data contract:** `index.html`'s `ingest(json)` consumes raw **TikTok `main_orders[]`** objects; the `order(o)` mapper reads `sku_module`, `price_module`, `order_status_module[0].main_order_status`, `buyer_info_module`, `trade_order_module.create_time`, `extra_data_map.sales_source_live_tag` (live/auction tags), `reverse_module` (refund/cancel). It currently loads from JSON files (drag-drop, file input, or auto-fetch of `tiktok-live-data.json` / `tiktok-orders-all-272.json`).
- **Live sync (JUST BUILT THIS SESSION, working):**
  - **Cookie-bridge extension** at `tiktok-data-viewer/cookie-bridge/` (`manifest.json`, `popup.html`, `popup.js`). MV3, `cookies` permission + host perms for `*.tiktok.com` and `127.0.0.1:8770`. Reads httpOnly TikTok cookies via `chrome.cookies.getAll`, POSTs them to `serve.py /cookies` with a shared token (`BRIDGE_TOKEN = 'sf-bridge-9c3f2a7e1b'`). Must be loaded unpacked in Chrome.
  - **`serve.py` endpoints added:** `POST /cookies` (token-guarded, stores cookies **in memory only**), `GET /sync` (replays the verified Seller-Center `order/list` call with the bridged cookies and returns raw `main_orders[]`), `GET /sync/status`.
  - **Viewer:** a header **"TikTok · Sync live"** button → `GET /sync` → `ingest()`.
  - **Validated:** 409 when no session, 403 on bad token, real request reaches TikTok (fake cookies → `code 98001002 "must log in"`; valid cookies → `code 0`). End-to-end live pull requires the user to load the extension + click it (their Chrome, httpOnly cookies).
- **The verified TikTok pull (reuse this — it's the hard-won part):**
  - `POST https://seller-us.tiktok.com/api/fulfillment/na/order/list?aid=4068&app_name=i18n_ecom_shop&device_platform=web`
  - **No request signing** (no X-Bogus/msToken/_signature) — cookies alone authenticate. Minimal query string above is sufficient.
  - Body: `{ sort_info:"6", search_condition:{condition_list:{}}, count:50, pagination_type:0, offset:N, extra_data_list:[...tags] }`. **Offset pagination** (increment `offset` by `count` until `!data.has_more`). Response: `data.main_orders[]`, `data.total_count`, `data.has_more`.
  - `serve.py` has this as `pull_tiktok_orders(cookie_header)` and `TT_ORDER_EXTRA_DATA`; the Electron app has the same in `live-ledger-desktop/main.js` `pullTiktokOrders()` (via `session.fetch`).
- **Gemini transcription:** `serve.py` `/transcribe` + `/clip` — ffmpeg-extracts the ~60s clip ending at the sale, uploads to Gemini Files API, `gemini-2.5-flash` w/ JSON schema → `{brand,item,color,size,price,transcript}`. Key from `GEMINI_API_KEY` env or `tiktok-data-viewer/gemini.key` (gitignored). SSRF/CSRF guards in place (loopback, TikTok-CDN-only fetch, same-origin POST). **These guards must be preserved.**
- **Known gap:** live `/sync` returns orders only — **no video receipts and no show-grouping** (those came from a separate combined-export/receipt pipeline, not the order API). Receipt links fall back to the order-detail URL; "by show" grouping is empty until a receipt source is wired.

---

## 3. What the user wants now (requirements)

1. **Re-skin** the viewer to the Obsidian design (§1).
2. **PostgreSQL-backed, multi-tenant.** User said "create a new database." Today the viewer has **no DB** (in-memory + JSON). Multi-tenant = orders/data scoped per tenant (organization), users belong to orgs.
3. **Username + password login** gating the viewer (a real auth screen + session — distinct from the desktop app's API-token auth).
4. (Implied) Persist synced orders to the DB instead of holding them in browser memory, so data survives reloads and is shared per tenant.

---

## 4. ⚠️ Critical reconcile decision (DO THIS FIRST with the user)

A multi-tenant Postgres database **already exists** and already models auth:

- **`sellerfolio-live-api/`** — Fastify + Prisma 7 (driver-adapter, `@prisma/adapter-pg`), runs on `:8788`.
- **DB:** `postgresql://postgres:****@207.244.240.42:5432/sellerfolio_v2` (creds reused from `web/.env`; never print/commit them).
- **Models already present** (`sellerfolio-live-api/prisma/schema.prisma`): `User`, `AuthAccount`, `Session`, `ApiToken`, `Organization`, `Membership` (roles OWNER/ADMIN/MANAGER/VIEWER), `PermissionOverride`, `Invitation`, `Plan`/`PlanPrice`/`Subscription`/`Invoice`/`UsageCounter`/`UsageEvent`, `PlatformConnection`, `Show`, `Customer`, `Order`, `OrderItem`, `Shipment`, `Receipt`, `PlatformAdmin`, `AuditLog`, `CostTemplate`, `Rule`/`RuleCondition`/`RuleAction`.
- So **multi-tenancy + `User`/`Session`/`AuthAccount` (password/session login) are already modeled.** The Electron desktop app already syncs TikTok/Whatnot orders **into `sellerfolio_v2`** via this API (token auth).

**Therefore the real decision is:**

- **Option A (recommended): Reuse `sellerfolio_v2` + the existing API.** Add a username/password **login flow** (the `Session`/`User`/`AuthAccount` models already support it — likely just needs password-hash field + login/logout/session-cookie endpoints), and rebuild the viewer as an **authenticated frontend of the `:8788` API** (read `Order`s scoped to the logged-in user's org). One source of truth shared with the desktop app. The viewer's live `/sync` becomes "sync into the org's orders," reusing `pull_tiktok_orders`.
  - Cost: the API stores **normalized** orders, while the current viewer renders **raw `main_orders[]`** (richer: address, tracking, auction tags, live-creator). Either extend the `Order`/`OrderItem` schema (or a raw-JSON column) to retain those fields, or accept the normalized subset.
- **Option B (the user's literal ask): brand-new database + new backend for the viewer.** Cleaner separation, but **fragments data** (two DBs, two sources of truth; desktop syncs to `sellerfolio_v2`, viewer to the new one) and **re-implements** multi-tenancy + auth that already exist. Only choose this if the viewer is meant to be a separate product from the desktop/API.

**Recommendation:** Option A. Present both to the user; confirm before building. If they still want a new DB, clarify *why* (separate product? throwaway/dev? data-isolation requirement?) so the new schema is right.

---

## 5. Auth design notes (whichever option)

- **Password hashing:** bcrypt or argon2id. Never store plaintext. The existing `User`/`AuthAccount` may already have a place for a credential; check before adding columns.
- **Sessions:** the `Session` model exists — use server-side sessions with an httpOnly, SameSite=Lax, Secure(if https) session cookie. The viewer is loopback today (`http://127.0.0.1:8770`); decide whether auth/viewer stays loopback-only (then Secure cookie is moot) or gets deployed (then needs https + the Contabo deploy path — see `project_deploy` memory).
- **Multi-tenant scoping:** every data query filters by the user's `Organization` (via `Membership`). Enforce at the API/query layer, not the client.
- **Login UI:** a dedicated login screen in the Obsidian style (primary `#E0E0E0` button, `#1E1E1E` inputs). Logout + "current org" indicator in the top nav.
- **Backend language:** the viewer backend is **Python (`serve.py`)** today; the existing auth/DB stack is **Node/Fastify/Prisma**. Decide: (a) point the Python viewer at the Node API (Option A — Python serves static + proxies, Node owns auth/DB), or (b) add Postgres + auth directly to `serve.py` (more divergence), or (c) rebuild the viewer frontend served by the Node API. This is a real fork — raise it explicitly.

---

## 6. Suggested process for the new session

1. **Invoke `brainstorming`** — resolve §4 (reuse vs new DB) and §5 (backend stack, deploy vs loopback, raw-vs-normalized order fields) with the user. Don't skip to code.
2. Once decided, **`writing-plans`** → a task-by-task implementation plan covering: schema/migration (or reuse), password+session auth + login UI, multi-tenant scoping, persisting synced orders, and the Obsidian re-skin.
3. Then implement (e.g. `subagent-driven-development`).
4. **Backups before destructive DB ops** (memory `feedback_v2_db_backup_before_destructive`): `pg_dump` first; never `--accept-data-loss` on `sellerfolio_v2` without confirmation + fresh backup. If creating a *new* DB, that's additive (lower risk), but still snapshot `sellerfolio_v2` before touching it.

---

## 7. Key file references

| Path | What |
|---|---|
| `C:\Users\hammo\Downloads\stitch_visual_clarity_enhancer\{DESIGN.md,code.html,screen.png}` | New "Obsidian" design system + mockup |
| `tiktok-data-viewer/index.html` | Current viewer SPA (KPIs, table, filters, transcription) — restyle target |
| `tiktok-data-viewer/serve.py` | Python server: static + `/sync` `/cookies` `/sync/status` `/clip` `/transcribe` |
| `tiktok-data-viewer/cookie-bridge/` | MV3 extension relaying TikTok cookies (load unpacked) |
| `sellerfolio-live-api/prisma/schema.prisma` | Existing multi-tenant schema (User/Session/Org/Order/...) |
| `sellerfolio-live-api/src/routes/v1.ts` | Existing API routes (token auth, sync, orders, etc.) |
| `sellerfolio-live-api/prisma.config.ts` | DB datasource → `sellerfolio_v2` @ 207.244.240.42 |
| `live-ledger-desktop/main.js` | Electron app: `pullTiktokOrders()` (session.fetch), Whatnot sync, cloud sync to API |

## 8. Constraints to honor (from session memory)
- Back up `sellerfolio_v2` (`pg_dump`) before any destructive op; v1 data expendable, v2 is not.
- DB creds reused from `web/.env` (`postgres@207.244.240.42`) — never print or commit them.
- Keep `serve.py` SSRF/CSRF protections (loopback bind, TikTok-CDN-only remote fetch, same-origin/token POST checks).
- `GEMINI_API_KEY` from env or gitignored `gemini.key` only.
- PII export files / any synced-data dumps stay gitignored — don't commit.
- Nested git repos: `desktop/` and `web/` are their own repos (memory `project_nested_git_repos`); the viewer lives in the platform root repo.
