# TikTok Live Monitor PoC

Proves the TikTok Shop live data plane (see `../docs/superpowers/specs/2026-06-08-tiktok-live-monitor-poc-design.md`).

## Run
1. `npm install`
2. `npm test`        # core unit tests (21 tests, no Electron needed)
3. `npm run dev`     # builds, then opens the monitor + viewer windows
4. In the **monitor** window, log into TikTok if prompted (you log in yourself — the app never enters credentials or solves captchas).
5. Start/observe a live auction. Watch the **viewer** window.

> If `npm install` hangs on Electron's binary download, set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to install for tests only (you still need the binary for `npm run dev`).

## Success criteria
- Capture stays connected across a full show without re-auth.
- Decoder logs no unhandled crashes (new event variants are captured, not fatal).
- The viewer's **Derived sold** equals **Roster sold** throughout ("match" stays green).

## What ports to the real app
Everything in `src/core/` (zero Electron/DOM deps, unit-tested) becomes the internals of
`desktop/src/lib/liveSource/TikTokLiveSource.ts`. The Electron harness (`src/electron`,
`src/renderer`) is throwaway.

## Notes / deviations from the plan
- The monitor window runs with `contextIsolation:false` so the preload can observe the
  page's own (TikTok-signed) `XMLHttpRequest`. The production desktop version should instead
  inject a main-world hook script, as `desktop/electron/whatnot-monitor-preload.ts` does.
- `esbuild.mjs` copies `index.html` into `dist/` and the renderer loads it from there.
