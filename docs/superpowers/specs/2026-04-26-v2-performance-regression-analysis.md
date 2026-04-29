# Why v2 Feels Much Slower Than v1

**Date:** 2026-04-26
**Question:** v1 was a single-process Electron app talking directly to PostgreSQL. v2 is the same Electron renderer talking to a Next.js + Prisma + PostgreSQL backend over HTTP. Where does the time go?

## TL;DR

The slowness is structural, not algorithmic. v1 made in-process SQL calls (~1–5 ms each); v2 turns every data operation into:

```
fetch → Next.js route handler → JWT verify → tenant lookup query →
permission check → Prisma query(ies) → JSON serialize → HTTP response →
JSON parse → camelCase→snake_case map
```

That's **~50–200 ms per call instead of ~1–5 ms**, so any UI action that used to be one IPC + one SQL is now noticeably laggy, and bulk loops pay it N times.

There are also a few new sources of work *per request* (tenant-context lookup, `groupBy`, profit-recompute, dev-mode route compilation) that were never present in v1 at all.

## Cost of a single round-trip — apples-to-apples

### v1: load items

```ts
// sellerfolio-desktop/src/hooks/useSales.ts:205
const result = await window.databaseAPI.loadItems(params);

// sellerfolio-desktop/electron/ipc/database.ts:91–132
ipcMain.handle('db-load-items', async (_event, { showIds, filters }) => {
  const result = await dbPool.query(`SELECT i.* FROM items WHERE … ORDER BY order_date DESC`, params);
  return { success: true, rows: result.rows };
});
```

Steps: structured-clone IPC → in-process `pg.Pool.query` → return rows. **One PG round-trip. ~1–10 ms total** for a few thousand rows on localhost.

### v2: load items

```ts
// desktop/src/hooks/useSales.ts:202–264
const result = await apiClient.get('/api/sales', { limit: 5000, showIds, … });
const mapped = rawItems.map(s => ({ id: s.id, order_id: s.orderId, /* ~30 fields */ }));
const parsedItems = mapped.map(parseItem);
```

Steps:
1. `fetch` to `http://localhost:3000` (TCP + HTTP overhead).
2. Next.js route dispatch (`web/src/app/api/sales/route.ts`).
3. `getTenantContext(req)` →
   - `jwtVerify(token, secret)` — cryptographic check (`web/src/lib/tenant.ts:28`).
   - `prisma.tenantUser.findUnique({ include: { permissionOverrides, tenant } })` — **separate PG round-trip just for auth** (`tenant.ts:87–99`).
4. `requirePermission(ctx, 'sales.view')`.
5. `Promise.all([ prisma.item.findMany({...}), prisma.item.count({where}) ])` — two PG queries (`route.ts:86–133`).
6. `prisma.item.groupBy({ by: ['aiBrand'], where: {...}, orderBy: { _count: { aiBrand: 'desc' } } })` — **third PG round-trip on every page load**, computing the brand list even when nothing changed (`route.ts:136–147`).
7. JSON.stringify the response.
8. HTTP response back over loopback.
9. JSON.parse in renderer.
10. camelCase→snake_case mapping for ~30 fields × N rows in `loadItems` (`useSales.ts:222–256`).

**3 PG round-trips + auth crypto + serialization + remap. ~50–200 ms** even on localhost for the same payload.

That's a 10–50× per-call slowdown, before any business logic runs.

## Where this compounds

### Inline cost edit — feels laggy now

v1: hit Enter → IPC → `UPDATE items SET cost = $1, profit = net - cost WHERE id = $2` → return → setState. **~5–15 ms.**

v2: hit Enter → apiClient.patch → Next.js → auth (1 PG query) → permission check → existence check (`prisma.item.findFirst` — another PG query, route.ts:47) → `prisma.item.update` (third PG query) → **`recomputeItemPayout(prisma, id)`** (consignor payout recompute, route.ts:131–134) — fourth+ PG query, dynamic import on first call → JSON response → setState. **~80–250 ms.**

The recompute is *new behaviour*, not a regression — but it's why a single keystroke commit feels heavier than v1.

### Bulk transcription (the path you're actively using)

`desktop/src/pages/Sales.tsx:1376–1385`:

```ts
for (let i = 0; i < scopedItems.length; i += BATCH_SIZE) {
  const batch = scopedItems.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(item => processItem(item)));
}
```

`processItem` does:
1. `window.whatnotAPI.transcribeVideo(...)` — IPC, ffmpeg + Gemini upload + Gemini generateContent. Dominant cost: **5–30 s / item**.
2. `await updateItem(item.id, { transcript, ai_brand, ai_item, …, ai_status: 'done' })` — HTTP PATCH (full v2 stack from above).

For 30 items at concurrency 10:
- v1 DB writes: 30 × ~5 ms = **~150 ms total DB overhead** across the run.
- v2 DB writes: 30 × ~80 ms = **~2.4 s DB overhead** across the run (effectively ~3 batches of 10 concurrent, so ~240 ms wall time per batch; still real time the user is waiting on).

The Gemini step is the same in both versions, so the **percentage** slowdown on bulk transcription is small. But the sequential UI actions around it (load items first, save AI fields per item, reload after) all pay the new tax.

### `loadData()` is called liberally

`Sales.tsx:1403` runs `await loadData()` after every bulk run. That's:
- `/api/sales` (3 PG queries + auth)
- whatever else `loadData` chains.

In v1 the same refresh cost ~10 ms; in v2 it's ~150–400 ms before any UI updates.

## New per-request work that didn't exist in v1

| Source | Where | Per-request cost |
|---|---|---|
| `jwtVerify` of Bearer token | `web/src/lib/tenant.ts:28` | ~1–5 ms (crypto) |
| Tenant lookup query (`tenantUser.findUnique` with `include`) | `tenant.ts:87–99` | one PG round-trip per request |
| Permission resolution | `requirePermission` + role/overrides eval | ~µs, but always runs |
| `prisma.item.count` alongside `findMany` | `web/src/app/api/sales/route.ts:132` | parallel but a second PG round-trip |
| `prisma.item.groupBy` for brand filter | `route.ts:136–147` | third PG round-trip per `/api/sales` GET |
| Existence check before update | `web/src/app/api/items/[id]/route.ts:47–52` | extra PG round-trip per PATCH |
| `recomputeItemPayout` on cost change | `route.ts:131–134` | dynamic import + payout recompute query |
| Console logging in apiClient | `desktop/src/lib/apiClient.ts:67,82–84` | small, but every request DevTools-paints |
| Renderer-side camelCase→snake_case map | `useSales.ts:222–256` | O(rows × fields) on every load — ~5–30 ms for 5k rows |

None of these existed in v1. Each is small; together they explain "everything feels heavier."

## Things that are slower in dev only

- **Next.js route compilation on first hit.** Hitting a route the first time after `npm run dev` triggers webpack compilation — multiple seconds. This isn't real production cost but explains the cold-start lag during development.
- **Prisma connection warmup.** In dev, the Prisma client may reconnect across HMR boundaries; in production it's a long-lived pool.

## What's NOT slower in v2

For completeness — these paths haven't regressed:

- **Whatnot live monitor / OBS overlay** — still IPC, same code paths.
- **FFmpeg clip extraction** — actually faster in v2 due to downscale + lower CRF (`scale=640:-2 -crf 28`, see `desktop/electron/main.ts:1351`).
- **Past-end short-circuit** — v2 probes video duration up front and skips a doomed re-encode (main.ts:1304).

The slowness is concentrated in **anything that touches `apiClient`** — i.e., reads or writes against the items/sales/consignor models — which is most of the Sales page.

## Highest-leverage fixes

Roughly ordered by impact / effort:

1. **Cache tenant context per request batch.** A short-lived in-memory cache keyed by token, valid for ~5 s, would eliminate the per-request `tenantUser.findUnique` round-trip for high-frequency endpoints. Drops every API call by ~10–30 ms.
2. **Drop the `groupBy` from `/api/sales`.** Brands rarely change per request; cache them client-side or expose a separate `/api/brands` endpoint that's called once per show selection. Saves one PG round-trip per page load.
3. **Skip the existence pre-check on `PATCH /api/items/[id]`.** `prisma.item.update({ where: { id, tenantId } })` already 404s on miss; the explicit `findFirst` is redundant. Saves one round-trip per cost/AI edit.
4. **Bulk-update endpoint for the transcription writeback.** Instead of one `PATCH /api/items/:id` per item, post `[ {id, fields…}, … ]` to a `POST /api/items/bulk-update` (route exists — `web/src/app/api/items/bulk-update/`). Collapses 30 round-trips into 1.
5. **Stop the camelCase→snake_case re-mapping.** Either change the API to return snake_case (it's already a desktop-shaped endpoint) or change `parseItem` and downstream renderers to consume camelCase directly. Either way, `useSales.ts:222–256` is pure busywork.
6. **Move `recomputeItemPayout` off the request path** for cost edits — fire-and-forget into a queue, or batch it with the bulk-update endpoint above.
7. **Remove `console.log` in `apiClient.request`** in production builds (or gate it behind a debug flag). DevTools paints are surprisingly expensive when 30 requests fire concurrently.

If you want a numeric bound: implementing 1, 2, 3, and 4 should drop a 30-item bulk transcription's non-Gemini overhead from ~3 s to under 300 ms, and bring single-cost edits from ~150 ms to ~30 ms — not as fast as v1, but close enough that the UI shouldn't *feel* slow.
