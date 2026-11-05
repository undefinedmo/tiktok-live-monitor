# Live UI build (2026-11-05) — the brief every lane reads

Branch `feat/live-ui` (worktree `LuxeSense/tiktok-live-monitor-live-ui`), based on `feat/sellerfolio-connect`.
App: `sellerfolio-live-monitor/`. The approved look is the owner's 10-31 prototype
(`C:\Users\hammo\Downloads\sellerfolio-live-prototype-real-ui.html` = the real renderer in demo mode + an addon layer).
The addon's source is in this folder: `prototype-addon.js` / `prototype-addon.css` — match its UI and copy, but build
it for real (the prototype fakes data).

## Hard rules
- **Printing comes first, always.** The `sales` handler in `renderer.ts` prints before anything else. Nothing you add
  may run before it, await anything on the print path, or block the renderer/main thread on I/O. Heavy work goes to
  the journal worker thread (`src/electron/journalWorker.ts`) or is async and best-effort.
- **No native modules.** SQLite was removed on purpose (commit af0fad9). Storage = an in-memory index rebuilt from the
  JSONL journal, living in the worker thread (owner decision).
- Keep everything the connect branch added: Connect screen, `#revokedBar`, SellerFolio card, `#showModal`.
- Pure logic goes in `src/core/` with vitest tests. Verify with `npx tsc --noEmit` and `npx vitest run <your tests>`
  from `sellerfolio-live-monitor/`.

## Owner decisions (2026-11-05)
1. **Storage**: journal index in the worker thread (no SQLite, no sql.js).
2. **Chat replies**: Approve posts **as Host** through the existing `chatAPI.send` (preload.ts / main.ts). Suggested
   replies come from **simple local keyword rules** (shipping, authentic, sizes, …) — no AI, no hq call. Reply box max
   100 chars (TikTok's cap).
3. **Extras IN**: Chat screen (Questions list + Wishlist with Mark fulfilled), Text size (A−/A+ per computer), label
   designer **4×6** size and **logo** element.
4. **Wish syntax**: NOT "i wish"/"!wish". A chat line starting with **`ISO `** ("in search of") or **`LF `** ("looking
   for"), case-insensitive, after an optional leading @mention, is a wish: the rest of the line is the wished item.
5. **Past-order badge** (sales only — feed, payment issues, top buyers; NEVER chat): number of **non-cancelled orders
   placed before this show started**; `0` → green **NEW**; >99 → "99+" with the exact count on hover/aria-label.
   Counts come from hq (`POST /api/desktop/buyer-history`, below), keyed on the sale's buyer id (`ttuid`).
6. **Run next lot is OUT of this build** (needs TikTok's start-auction call captured live). Ship the **Arm** switch
   and **Print last [F14]**; leave a disabled "Run next" button with a tooltip "Coming soon".
7. Question detection: heuristic (`?` at the end, or a leading question word), like the prototype.
8. VIDEO light removed. WHALE tag removed (replaced by the past-order badge).

## hq endpoint (built in SellerFolio, branch off deploy/chat-connect)
`POST /api/desktop/buyer-history` — desktop-token auth (`desktopAuthOr401`, Bearer sfm_ + X-SF-Device).
Request `{ "buyerIds": string[] }` (≤ 200 ttuids). Response `{ "counts": { [ttuid]: number }, "asOf": ISO }`.
Mapping ttuid → SellerFolio buyer: the Live Monitor's own `sale` journal events (`payload.buyerId` → `payload.orderId`
→ `order.buyer_user_id`, measured 2026-11-05: 15,617/15,617 sales map to an order). Unknown ids → 0.

## Lanes (each owns only its files; the coordinator pre-commit wires the shared files first)
See the coordinator's commit for the exact regions/ids/module stubs each lane fills.
