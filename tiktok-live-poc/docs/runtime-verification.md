# Runtime Verification Checklist

Everything in Phases 0+1 and 4 is unit-test + `tsc` + build verified, but **the app itself hasn't run in Electron yet** because `better-sqlite3` (the only native module) needs building for Electron's ABI. This doc gets it running and smoke-tests the foundation.

## ⚠️ The one thing that matters: use the *standard* node-gyp, not the Electron one

**Verified 2026-06-22 on this machine — no Visual Studio install is needed.** The standard node-gyp (npm's bundled copy, MSVC v142) builds `better-sqlite3` for **both** ABIs, and the Electron build loads + runs inside Electron's main process:

```
ELECTRON_SQLITE_OK value=42 abi=130 electron=33.4.11
```

The trap: **both** `npm run dev` (via `electron-rebuild`) **and** `npm run rebuild:node` (via `npm rebuild`) route through **`@electron/node-gyp`**, which demands the missing **ClangCL** toolset (`MSB8020`) and fails. Ignore those two scripts; drive the builds with the explicit standard node-gyp below. It lives at:

```
C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js
```

You will **alternate** between two builds of the same file — Electron ABI to run the app, Node ABI to run tests:

| Goal | Command (run from `tiktok-live-poc/`) |
|------|----|
| **Build for Electron** (to launch the app) | `node $ng rebuild --release --runtime=electron --target=33.4.11 --dist-url=https://electronjs.org/headers` |
| **Build for Node** (to run `npm test`) | `node $ng rebuild --release` |

…where `$ng` is the standard node-gyp path above. Both are run inside `node_modules\better-sqlite3` (see commands below). This ABI swap is inherent to one native module serving two runtimes.

---

## Part 1 — Build for the Electron ABI ✓ VERIFIED

```powershell
$ng = "C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
Push-Location node_modules\better-sqlite3
node $ng rebuild --release --runtime=electron --target=33.4.11 --dist-url=https://electronjs.org/headers
Pop-Location
```

`gyp info ok` → binary is Electron-ABI (130). If Electron is upgraded later, set `--target` to match `node_modules/electron/package.json`.

---

## Part 2 — Launch and smoke-test

`npm run dev` is unusable (its `electron-rebuild` step fails). After the Part 1 build, bundle and launch the Electron binary directly (`npx electron` also misresolves here):

```powershell
node esbuild.mjs
& "node_modules\electron\dist\electron.exe" .
```

### 2a. Offline render check (no live show needed) — Phase 4 parsers → UI

```powershell
$env:TT_REPLAY = "1"
node esbuild.mjs
& "node_modules\electron\dist\electron.exe" .
Remove-Item Env:\TT_REPLAY
```

`TT_REPLAY=1` feeds `fixtures/rest-samples.json` through the core into the viewer. Confirm the **Live Sales Feed, Top Buyers, Products table, and Current Auction** panels render (roster + auction-result enrichment exercised). *(Note: `pin/get` isn't part of the replay path, so the server-time/current-auction-from-pin bits wait for 2d.)*

### 2b. Phase 0+1 — SQLite persistence (the critical, never-run path)

1. Launch normally. In the **viewer** window → **Ledger** → **Sync orders**; log into Seller Center if its window opens.
2. Orders populate with **product images** and correct totals → enriched `order/list` parse + DB upsert + hydrate.
3. Edit one order's **cost** inline. **Fully close** the app, relaunch. The cost persists → **proves the SQLite write/hydrate round-trip** (the entire point of Phase 0).
4. Set a **product-level** cost on a bin → it applies to every order of that bin.
5. (Optional) Inspect `C:\Users\hammo\AppData\Roaming\tiktok-live-poc\tiktok.db` — tables `orders`, `order_items`, `costs`, `transcripts`. Confirm **no `address`** appears in any `sale_json` (the PII fix).

### 2c. Phase 0+1 — legacy migration (only if this profile ran the *pre-SQLite* build)

If you had cost/AI templates from before the SQLite change, confirm they still appear after first launch (one-shot `localStorage`→DB import + re-keying). Fresh profile → no-op, nothing to check.

### 2d. Phase 4 — live telemetry (opportunistic, needs a real show)

`pin/get` + the richer roster/auction fields only flow while the **monitor window is on the live/auction management view during an actual show**. During a live auction, confirm the Current Auction panel shows winner/bid/countdown.

---

## Part 3 — Back to the test suite ✓ VERIFIED

After running the app you must rebuild for Node before `npm test` (vitest runs under system Node, ABI 137):

```powershell
$ng = "C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
Push-Location node_modules\better-sqlite3
node $ng rebuild --release
Pop-Location
npm test   # expect 107/107
```

Do this every time you switch from running the app back to running tests (and Part 1 every time you switch the other way).

---

## If Part 2b fails

That's the real signal — a wiring bug unit tests can't catch (main↔renderer IPC, hydration, or sync→upsert). Capture the terminal output + the viewer DevTools console (it logs `[render]` lines). Until 2b passes, treat the SQLite foundation as unverified and don't stack Phase 2 on it.

---

## Optional: make the npm scripts work natively (skip — not required)

To stop hand-driving node-gyp, add an `.npmrc` in `tiktok-live-poc/` pointing npm at the standard node-gyp, then `npm rebuild`/a small `rebuild:electron` script would work via MSVC:

```
node_gyp=C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\node-gyp\\bin\\node-gyp.js
```

(This fixes `npm rebuild` / `rebuild:node`; `electron-rebuild` bundles its own node-gyp and would still need ClangCL, so the `dev` script should drop `electron-rebuild` in favor of the Part 1 command.) Left out by default because the path is machine-specific.

## Appendix — installing ClangCL (only if you insist on `npm run dev` / `electron-rebuild`)

- Add Clang to the existing **VS Build Tools 2019** (already has MSVC), headless:
  ```powershell
  & "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
    --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools" `
    --add Microsoft.VisualStudio.Component.VC.Llvm.Clang `
    --add Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset --quiet --norestart
  ```
- Or add the **"Desktop development with C++"** workload to **VS Community 2022** (GUI; includes MSVC + optional C++ Clang tools).

Neither is necessary — Part 1 already works.
