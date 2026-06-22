# Runtime Verification Checklist

Everything in Phases 0+1 and 4 is unit-test + `tsc` + build verified, but **nothing has run in Electron yet** because the `better-sqlite3` native module isn't built for Electron's ABI. This doc gets `npm run dev` working and then smoke-tests the foundation.

> Probed on this machine (2026-06-22): VS Community 2022 (no C++ toolset), VS Build Tools 2019 (MSVC v142 ✓, no ClangCL), no ClangCL anywhere, Electron 33.4.11.

---

## Part 1 — Build `better-sqlite3` for the Electron ABI

The standard node-gyp (MSVC v142) already works here; only `electron-rebuild`'s bundled `@electron/node-gyp` demands the missing **ClangCL** toolset (`MSB8020`). So bypass `electron-rebuild` and build for the Electron target with the node-gyp that works.

### Option A — Build with the working MSVC, no install (try this first)

Run from `tiktok-live-poc/` in PowerShell:

```powershell
$ng = "C:\Program Files\nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js"
Push-Location node_modules\better-sqlite3
node $ng rebuild --release --runtime=electron --target=33.4.11 --dist-url=https://electronjs.org/headers
Pop-Location
```

If it prints `gyp info ok`, the binary is now Electron-ABI. **Skip the `electron-rebuild` step** when launching (see Part 2) — `node esbuild.mjs && electron .` directly.

If it fails fetching Electron headers behind a proxy, set `$env:npm_config_dist_url` / `$env:ELECTRON_MIRROR` accordingly and retry.

### Option B — Make `electron-rebuild` itself work (only if you want `npm run dev` unchanged)

`electron-rebuild` wants ClangCL. Add it to the install that already has MSVC (VS Build Tools 2019), headless:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe" modify `
  --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools" `
  --add Microsoft.VisualStudio.Component.VC.Llvm.Clang `
  --add Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset `
  --quiet --norestart
```

Then `npm run dev` (which runs `electron-rebuild -w better-sqlite3` first) should succeed. Heavier than Option A (downloads Clang), but keeps the existing `dev` script intact.

### Option C — Full workload (most standard, heaviest)

In the **Visual Studio Installer** GUI, on **VS Community 2022**, add the **"Desktop development with C++"** workload (it includes both MSVC and the optional "C++ Clang tools for Windows"). Then `npm run dev`.

---

## Part 2 — Launch and smoke-test

If you used **Option A**, launch without `electron-rebuild`:

```powershell
node esbuild.mjs ; npx electron .
```

If you used **Option B/C**, just: `npm run dev`.

### 2a. Offline render check (no live show needed) — verifies Phase 4 parsers reach the UI

```powershell
$env:TT_REPLAY="1"; node esbuild.mjs ; npx electron .
```

`TT_REPLAY=1` feeds the bundled `fixtures/rest-samples.json` through the core into the viewer. Confirm the **Live Sales Feed, Top Buyers, Products table, and Current Auction** panels render from the fixture (roster + auction-result enrichment is exercised here). Unset `TT_REPLAY` afterward.

### 2b. Phase 0+1 — SQLite persistence (the critical, never-run path)

1. Launch normally. In the **viewer** window go to the **Ledger**, click **Sync orders**; log into Seller Center if the window opens.
2. Orders populate with **product images** and correct totals → confirms enriched `order/list` parsing + DB upsert + hydrate.
3. Edit one order's **cost** inline. **Close the app entirely**, relaunch. The cost is still there → **proves the SQLite write/hydrate round-trip** (the whole point of Phase 0).
4. Set a **product-level** cost on a bin, confirm it applies to every order of that bin.
5. (Optional) Inspect the DB directly: `C:\Users\hammo\AppData\Roaming\tiktok-live-poc\tiktok.db` — tables `orders`, `order_items`, `costs`, `transcripts`. Confirm **no `address`** appears in any `sale_json` (the PII fix).

### 2c. Phase 0+1 — legacy migration (only meaningful if this machine ran the *pre-SQLite* build)

If you had cost/AI templates from before the SQLite change, confirm they still appear after the first launch (the one-shot `localStorage`→DB import + re-keying). If this is effectively a fresh profile, the migration is a no-op — nothing to check.

### 2d. Phase 4 — live telemetry (opportunistic, needs a real show)

`pin/get` and the richer roster/auction fields only flow while the **monitor window is on the live/auction management view during an actual show**. During a live auction, confirm the Current Auction panel shows the winner/bid/countdown. (No fixture path drives `pin/get` in replay, so this one waits for a live show.)

---

## Part 3 — Return to the test suite (the ABI dance)

`npm test` (vitest) runs under **system Node**, so after building for Electron you must rebuild for Node before testing:

```powershell
npm run rebuild:node   # = npm rebuild better-sqlite3 (standard node-gyp, MSVC — works)
npm test               # expect 107/107
```

Every time you switch between `npm run dev` (Electron ABI) and `npm test` (Node ABI), rebuild for the target you're about to use. This is inherent to a single native module serving two runtimes; documented in the plan's Global Constraints.

---

## If Part 2b fails

That's the real signal — it means a wiring bug the unit tests couldn't catch (main↔renderer IPC, hydration, or the sync→upsert path). Capture the terminal output and the DevTools console (the viewer logs `[render]` lines), and that's the next debugging target. Until 2b passes, treat the SQLite foundation as unverified and don't stack Phase 2 on it.
