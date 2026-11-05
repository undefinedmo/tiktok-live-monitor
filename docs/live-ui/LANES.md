# Live UI lanes — who owns what (scaffold commit)

Read `BUILD.md` first (hard rules + owner decisions). All paths below are under
`sellerfolio-live-monitor/`. All six lanes run **at the same time in one working tree**, so:

- **Edit only files you OWN.** For the three shared files (`renderer.ts`, `index.html`, `journal*.ts`
  where noted) edit **only inside your fenced region**, always with `Edit` (exact replace), never `Write`
  of the whole file, and re-read the region right before editing — another lane may have just changed
  a different region of the same file.
- **Never** `git add -A`, `git stash`, `git reset`, `git checkout -- <file>`. Commit your own paths only.
- Verify with `npx tsc --noEmit` and `npx vitest run <your test files>` (not the whole suite — other
  lanes' half-done work may be red). Pure logic goes in `src/core/` with a vitest test.
- **Printing first**: nothing you add runs before the print in the `sales` handler, awaits on the print
  path, or does I/O on the renderer/main thread. Every hook below is already called *after* the print and
  wrapped in try/catch; keep it that way.

## Shared-file rules

| File | Who may touch it |
|---|---|
| `src/renderer/renderer.ts` | Lanes B, C, E, F: **only inside their `// ┌── lane X … // └── end lane X` fences** (move/delete that code into your module). Nobody edits the imports block, the `Window` typings, `showScreen`, the init loop, `printLabel`, `printSale`, `autoPrintSale`, `onAuctionClosed`, the print dedup, the event loop, or the SellerFolio/Connect section. If you truly need a new call site, ask the coordinator. |
| `src/renderer/index.html` | Each lane fills **only its own empty region(s)** (ids below) and its own `/* lane X */` CSS block at the end of `<style>`. Do not edit shared CSS above the lane blocks; add overrides in your block. Keep `#connectScreen`, `#revokedBar`, the SellerFolio card, `#showModal` intact. Ids other code reads must survive (renderer.ts looks them up). |
| `src/electron/main.ts` | **Nobody.** The scaffold wired a "live-ui lanes" block; put your main-process code in your own module. |
| `src/electron/preload-viewer.ts` | **Nobody.** Bridges are final; channel handlers live in your module. |
| `src/core/types.ts` | **Nobody** (shared types). Put new types in your own core module. |

## Bridges and IPC (fixed names)

| Bridge (renderer) | Channel | Handler (owner) |
|---|---|---|
| `controlAPI.getZoom()` → number | invoke `ctl:zoom-get` | `electron/controlIpc.ts` (A) |
| `controlAPI.setZoom(f)` → number | invoke `ctl:zoom-set` | `electron/controlIpc.ts` (A) |
| `controlAPI.onKey(cb)` | event `ctl:key` ('F14') main→viewer | `controlIpc.attachControlToViewer` (A) |
| `storeAPI.searchSales(text, limit?)` → `StoreResult` | invoke `store:search-sales` | `electron/storeIpc.ts` → `journal.queryStore` → worker (B) |
| `storeAPI.searchChat(text, limit?)` → `StoreResult` | invoke `store:search-chat` | same (B) |
| `storeAPI.failedPayments(limit?)` → `StoreResult` | invoke `store:failed-payments` | same (B) |
| `buyerAPI.lookup(ids)` → `{ counts }` | invoke `buyer:lookup` | `electron/buyerHistory.ts` (D) |
| `buyerAPI.onCounts(cb)` | event `buyer:counts` `{ counts }` main→viewer | `electron/buyerHistory.ts` (D) |
| `labelAPI.print(...)` → `{ success, error?, spoolMs }` | invoke `print-label` | main.ts (done: `spoolMs` = queue→spooler ms) |
| `chatAPI.send(text)` → `{ ok, error? }` | invoke `tt-chat-send` | existing — posts **as Host** (C uses it) |

Worker protocol (journalWorker.ts ↔ journal.ts): `{ kind: 'store-query', id, query: StoreQuery }` →
`{ kind: 'store-result', id, result: StoreResult }`. `queryStore()` resolves empty on no worker /
timeout (1.5 s) / dead worker; never rejects.

## Lane A — shell

- **Owns:** `src/renderer/shell.ts`, `src/electron/controlIpc.ts` (+ any tests you add).
- **HTML regions:** `#navRail` (replace the contents: Show / Chat / Settings buttons with the Chat
  badge; the legacy `#navMonitor` / `#navSettings2` may be removed — renderer.ts tolerates it),
  `#topControls` (Arm switch, disabled "Run next" with title "Coming soon", Print last [F14]),
  `#textSizeSlot` (Text size card: A− / % / A+ / Reset, steps 85–130%). CSS block `/* lane A */`.
- **Wired for you:** `initShell({ showScreen, print })` (called once, after `showScreen` exists and
  before the first screen paint — you may call `deps.showScreen()` in init); `onScreen(screen, gated)`
  at the end of every `showScreen` (`screen` is `'connect'` while gated — disable the rail then);
  `setChatBadge(n)` (lane C calls it). main.ts calls `attachControlToViewer(win)` in `createViewer()`
  and `registerControlIpc({ viewer, send })`.
- **Print last:** `import { lastPrintedLabel } from './printLog'` (lane E) → `deps.print(data)`.
  No arming needed for Print last. F14 arrives via `window.controlAPI.onKey` (main's
  `before-input-event`), so it works while the window has focus.
- **Text size** is per computer: persist the factor (main side, e.g. a small userData file, or
  localStorage) and re-apply on start; `webContents.setZoomFactor` in `controlIpc.ts`.
- **Never touch:** everything not listed above.

## Lane B — store + sales view

- **Owns:** `src/core/storeIndex.ts` (+ `__tests__/storeIndex.test.ts`), `src/electron/storeIpc.ts`,
  `src/renderer/salesView.ts`; in `src/electron/journalWorker.ts` the **"lane B: the show store"**
  block and the `store-query` branch; in `src/electron/journal.ts` `queryStore()` and the
  `storeWaiters` lines (you may also add an "index the existing files for the current room on
  start" message there).
- **renderer.ts fences:** `lane B: live sales feed` (renderFeed, setupFeed, feed paging),
  `lane B: top buyers` (renderTopBuyer), `lane B: payment issues` (renderFailed). Move them into
  `salesView.ts`. **Keep** `allSales`, `provisionalSales`, `feedRows`, `provKeyOf`, `printKey` usage
  working for `onAuctionClosed` (it calls `renderFeed()` — if you move renderFeed, leave a one-line
  `renderFeed` inside your fence that delegates to salesView, or export a function and replace the
  body of the fence; do not edit `onAuctionClosed` itself).
- **HTML regions:** `#feedSearch` (search box + "Last 10 sales. Search finds the rest."); the feed shows
  the last 10, search queries `window.storeAPI.searchSales`. CSS block `/* lane B */`.
- **Wired for you:** `initSalesView({ printSale })`; `onSales(ev, freshSales)` at the END of the
  `sales` case (after prints and the existing paint). Drop the WHALE tag in your render code; leave
  the `currentTopSet = …` line in the sales handler alone (harmless). `renderFeed`, `renderFailed`
  and `renderTopBuyer` are also called from code outside your fences (sales handler, the 1 s pending
  tick, `onAuctionClosed`) — keep those three names defined inside your fences as one-line delegates.
- **Badges:** from lane D — `requestCounts(ttuids)` and `badgeFor(ttuid)` from `./buyerHistory`,
  repaint on `onCountsChanged`. Sale rows only (feed, payment issues, top buyers) — never chat.
- **Never touch:** chat code, print path, main.ts, preload.

## Lane C — chat

- **Owns:** `src/core/chatIntent.ts` (+ `__tests__/chatIntent.test.ts`), `src/renderer/chatDesk.ts`.
- **renderer.ts fence:** `lane C: live chat column` (appendChat, appendOwnChat, setupChatInput,
  chat-name colours) — move into `chatDesk.ts`; the `chat` case already calls `appendChat` then
  `onChat(items)`; if you move appendChat, keep a delegating `appendChat` in your fence.
- **HTML regions:** `#chatTools` (Search chat + All chat / Questions N toggle), `#chatNote` text
  ("Replies post as Host after approval."), `#askingPanel` (a `.panel`, `hidden` until it has wishes —
  "Buyers are asking for"), `#chatScreen` (Questions list + Wishlist with Mark fulfilled; shown by
  `showScreen('chat')`, which sets `display:flex`). CSS block `/* lane C */`.
- **Wired for you:** `initChatDesk()`, `onChat(items)` per chat event, `onChatScreenShown()` when the
  Chat screen opens; nav badge via `setChatBadge(n)` from `./shell`.
- **Rules:** wishes = `ISO ` / `LF ` prefix (after an optional @mention), case-insensitive; questions =
  `?` at end or leading question word; suggested reply from local keyword rules only; reply ≤ 100
  chars; Approve → `window.chatAPI.send(text)` (posts as Host; on failure keep the card open and say so).
- **Never touch:** sales/print code, main.ts, preload.

## Lane D — buyer history

- **Owns:** `src/core/buyerTags.ts` (+ `__tests__/buyerTags.test.ts`), `src/electron/buyerHistory.ts`,
  `src/renderer/buyerHistory.ts`. CSS block `/* lane D */` (the NEW / count tag styles).
- **Wired for you:** main.ts calls `registerBuyerHistoryIpc({ url, headers, show, send, log })` —
  `url()` is the full `…/api/desktop/buyer-history` URL or null, `headers()` is the sfm_ auth (or null
  when not connected), `show()` is the room id (cache per show; a change clears it). renderer.ts calls
  `initBuyerHistory()`. Lane B calls `requestCounts`, `badgeFor`, `pastOrdersOf`, `onCountsChanged`.
- **hq contract:** `POST { buyerIds: string[] }` (≤ 200) → `{ counts: { [ttuid]: number }, asOf }`.
  Batch, de-dupe, never refetch a known id this show, back off on failure, never block anything.
- **Never touch:** renderer.ts, index.html regions of other lanes, main.ts, preload.

## Lane E — print log

- **Owns:** `src/renderer/printLog.ts`.
- **renderer.ts fence:** `lane E: the legacy print queue` (printQueue, renderQueue). Remove it; the
  other call sites of `renderQueue()` (in `printLabel` and `setupPrinting`) — replace them by keeping a
  no-op/delegating `renderQueue` inside your fence rather than editing those functions. The
  `#labelSettingsFooter` badge text ("N PRINTING" / "SET PRINTER") lived in renderQueue — keep that
  behaviour in your fence.
- **HTML regions:** `#printLog` (lines, newest first: `HH:MM:SS #80 tag sent in 50 ms`, failures red),
  the head of `#printLogPanel`, and you remove the legacy `#printQueue` div once renderQueue is gone.
  CSS block `/* lane E */`.
- **Wired for you:** `initPrintLog()`; `onPrintResult({ data, ok, error, spoolMs, at })` after EVERY
  print attempt (main's reply now carries `spoolMs`). Export `lastPrintedLabel()` (lane A's Print last).
- **Never touch:** `printLabel` / print dedup / main.ts.

## Lane F — label designer

- **Owns:** `src/core/labelLayout.ts` (+ `__tests__/labelLayout.test.ts`), `src/renderer/designer.ts`,
  and `src/electron/label.ts` + `src/electron/zplLabel.ts` (+ their tests) — route a template that
  carries a `layout` through `layoutHtml` / `layoutZpl` / `layoutNeedsHtml` there, so main's print path
  needs no change. Existing fixed-template labels must print byte-identically.
- **renderer.ts fences:** `lane F: label template types`, `lane F: the saved label template`,
  `lane F: label settings` (preview, sample, sizes, presets, setupSettings). Move into `designer.ts`;
  `printLabel` reads `labelTemplate` — keep it reachable (e.g. leave a `let labelTemplate` / getter in
  your fence).
- **HTML regions:** `#settingsTabs` (Label designer / Printer & app), `#designerTab` (hidden until you
  show it), `#appTab` (toggle it; its cards stay), `#titleDrawer` + `#titleDrawerScrim` (move the
  Label layout card's regex tools in; keep their ids). You may edit the Printer card's raw-ZPL row and
  the Label layout card inside `#appTab`. CSS block `/* lane F */`.
- **Wired for you:** `initDesigner()` runs after the existing `setupSettings()`.
- **Never touch:** the Printer / SellerFolio / About cards' behaviour, main.ts, preload.

## What the scaffold already did

- Removed the VIDEO light panel and `renderStreamState()`.
- `showScreen` takes `'monitor' | 'chat' | 'settings'`; Connect gate unchanged; `#chat` deep link works.
- Main `print-label` reply carries `spoolMs`.
- All stubs are inert: the app runs and prints exactly as before.
