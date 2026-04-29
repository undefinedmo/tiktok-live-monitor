# Bulk Transcription — v1 vs v2 Comparison

**Date:** 2026-04-26
**Scope:** "Process Items" path in the Sales (Transaction) screen — the loop that iterates over selected/filtered items and calls Gemini per item.

## Files compared

| Layer | v1 (`sellerfolio-desktop`) | v2 (`sellerfolio-platform`) |
|---|---|---|
| Frontend orchestrator | `src/pages/Sales.tsx` `handleProcessItems` (~L1326–1419) | `desktop/src/pages/Sales.tsx` `handleProcessItems` (~L1293–1407) |
| Single-item handler | `src/pages/Sales.tsx` `handleTranscribeSingle` (~L1421–1480) | `desktop/src/pages/Sales.tsx` `handleTranscribeSingle` (~L1409–1460) |
| IPC handler | `electron/main.ts` `transcribe-video` (~L824–1212) | `desktop/electron/main.ts` `transcribe-video` (~L1193–1606) |
| Schema | `electron/lib/database.ts` runtime `ALTER TABLE` (L267–276) | `web/prisma/schema.prisma` `Item` model (L325–331) |
| Item update API | direct SQL via IPC | `web/src/app/api/items/[id]/route.ts` PATCH (field map L60–96) |

## TL;DR

v2 adds materially better **error visibility** (categorized failures, past-end pre-check, 429-detail logging, downscaled re-encode), but loses three diagnostic features that mattered for debugging seek-mismatch issues, plus a more sophisticated retry strategy.

| Class | Net change |
|---|---|
| User-facing error reporting | **Improved** in v2 |
| FFmpeg robustness | **Improved** in v2 (probe + downscale) |
| Gemini retry | **Regressed** in v2 |
| Diagnostic stamp ("what window did Gemini actually see?") | **Removed** in v2 |
| Prompt (Gemini guidance) | **Redesigned** — different assumption about clip contents |

---

## 1. Frontend `handleProcessItems` (bulk loop)

| Aspect | v1 | v2 |
|---|---|---|
| Concurrency | 10 items per batch | 10 items per batch |
| Progress | `queueCurrent` / `queueProgress` | same |
| Per-item provenance log | `[transcribe] item=… seek=… dur=… source=…` (Sales.tsx:1358) | **removed** |
| Error categorization | binary success / error | tracks `successCount`, `expiredCount`, `pastEndCount`, `otherFailedCount` + 3-sample error log |
| Toast detail | `"Processed N items"` | `"N done · M expired (click Fetch) · K past end · L failed"` |
| Failure handling | sets `ai_status = 'error'` | sets `ai_status = 'error'`, branches by `result.errorCode` |
| Diagnostic stamp on success | persists `transcription_seek_seconds`, `transcription_duration` (Sales.tsx:1392–1393) | **not persisted** — fields no longer exist in v2 schema |

Verdict on the bulk loop: v2 is a UX improvement, but the lost provenance log + lost stamp make it harder to debug "Gemini saw the wrong moment" complaints.

## 2. Frontend `handleTranscribeSingle` (context-menu single)

Same delta as bulk: v2 keeps the categorized error taxonomy off this path (it's simpler), and likewise drops the `transcription_seek_seconds` / `transcription_duration` writes. Otherwise identical — both call `window.whatnotAPI.transcribeVideo` with the same args (`videoUrl`, `seekSeconds`, `duration`, `streamId`, `brandHints`, `orderId`).

## 3. IPC handler `transcribe-video`

### URL / FFmpeg

| Aspect | v1 | v2 |
|---|---|---|
| 410 (expired) pre-check | yes (HTTPS HEAD-ish range request) | same |
| Past-end pre-check | none | `probeVideoDuration` upfront — returns `SEEK_PAST_END` if seek is within `safeDuration/2` (or 5s) of the recording end (main.ts:1304) |
| Copy attempt | `-c copy`, 120s timeout | same, plus `logProgress: true` |
| Re-encode fallback | `libx264 / aac / ultrafast`, full resolution | `libx264 / aac / ultrafast + -vf scale=640:-2 -crf 28 -b:a 96k` — downscaled & lower-bitrate audio for speed |
| Past-end short-circuit | none | if copy error matches `/past the end of the video recording/i`, skip re-encode entirely (main.ts:1336) |
| Past-end final return | generic "Failed to download" | structured `{ errorCode: 'SEEK_PAST_END', error: '… recording is shorter than the live stream …' }` |

Verdict on FFmpeg: v2 is strictly better here.

### Gemini retry strategy

| Aspect | v1 | v2 |
|---|---|---|
| Attempts | **5** with model fallback | **3** same model only |
| Schedule | `0s, 15s, 45s, 30s, 60s` waits + ±3s jitter | `5s, 10s` exponential (2^attempt × 5000ms) |
| Model fallback | `gemini-2.5-flash` ×3 → `gemini-2.0-flash` ×2 | none (always `gemini-2.5-flash`) |
| Rationale documented in code | yes — comments call out that 429s on Tier 2 with <1% quota are usually shared-capacity and longer waits + different fleet help (main.ts:1061–1063) | not documented |
| 429 detail dump | no | `console.log('[Gemini 429 detail]', JSON.stringify(errorDetails …))` (main.ts:1490–1495) |

Verdict on retries: v2 has better diagnostics on hitting 429, but the actual retry strategy is weaker — fewer attempts, no model fallback, faster but shorter backoff. On a busy capacity day, v2 will surface 429s as failures where v1 would have completed via the 2.0-flash fallback.

### Return shape

```ts
// v1 (sellerfolio-desktop/electron/main.ts:1188–1198)
return {
  success: true,
  transcript,
  productInfo,
  clipSeekSeconds: Number(safeSeek),    // ← exact window sent to Gemini
  clipDuration: Number(safeDuration),
};
```

```ts
// v2 (sellerfolio-platform/desktop/electron/main.ts:1588–1592)
return {
  success: true,
  transcript,
  productInfo,
  // clipSeekSeconds / clipDuration NOT returned
};
```

This is the single most consequential change. v1's renderer used these to stamp `transcription_seek_seconds` / `transcription_duration` on the row so a future preview that disagrees with the transcript can be diagnosed. v2 has no such stamp — in either return shape, schema, or PATCH field map.

## 4. Gemini prompt (the "system" instruction)

The two prompts differ on a key assumption about what the clip contains.

**v1** (`electron/main.ts:1029–1059`):
> "The clip has been extracted to end exactly at the moment the auction for this item closed. **Every frame in this clip is the item that was sold** — there is no next-item tease or post-sale content."

**v2** (`desktop/electron/main.ts:1430–1466`):
> "**CRITICAL — MULTIPLE ITEMS IN VIDEO:** If multiple items are shown in the video, you MUST identify the item that was SOLD … Look for sale confirmation phrases like 'thank you for your purchase', 'congrats', 'sold!' … The SOLD item is the one shown/discussed IMMEDIATELY BEFORE these sale confirmation phrases."

Reading: v1 trusts the clip-extraction to be tightly bounded around one auction close. v2 has been redesigned around the assumption that the clip *can* span multiple items, and pushes "which item was sold" detection into the model. This implies the seek/window model changed — most likely the buffer is being applied differently — and explains why the `transcription_seek_seconds` / `transcription_duration` provenance fields were retired (the renderer no longer thinks of "the exact window" as a meaningful stamp). Worth confirming with whoever did the cutover.

The remaining prompt fields (`brand`, `item`, `color`, `size`, `retail_price_mentioned`, `retail_price_estimated`, `transcript_summary`) are unchanged.

## 5. Schema & persistence

### v1 — runtime SQLite/PG migration

`electron/lib/database.ts:267–276` adds `transcription_seek_seconds INTEGER` and `transcription_duration INTEGER` to `items` on first run. The IPC update path (`electron/ipc/database.ts:31–32`) explicitly allows them through.

### v2 — Prisma schema

`web/prisma/schema.prisma` lines 325–331:

```prisma
transcript    String? @db.Text
aiStatus      String? @map("transcription_status") @db.VarChar(50)
```

No `transcription_seek_seconds`, no `transcription_duration`. The PATCH `fieldMap` in `web/src/app/api/items/[id]/route.ts:60–96` does **not** list either field, so even if a v2 frontend tried to send them, they'd be silently ignored.

### v2 — `videoSeekBuffer` is preserved (and improved)

The setting itself is now persisted at the tenant level: `Tenant.videoSeekBuffer Int @default(30) @map("video_seek_buffer")` (schema.prisma:221), with a fallback in the desktop store (`store.get('videoSeekBuffer') ?? 30`, main.ts:1298). That part is fine.

## 6. Summary of regressions worth deciding on

These are the gaps you may want to plug if "bulk transcription" is regressed in v2 in any debuggable way:

1. **Retry/model-fallback for 429s.** Restore v1's 5-attempt schedule with `gemini-2.5-flash → gemini-2.0-flash` fallback in `desktop/electron/main.ts` (the `for (let attempt = 0; attempt < maxRetries; attempt++)` loop at L1474). v2's 3-attempt-same-model strategy will fail a noticeable share of bulk runs on busy days.
2. **Provenance stamp.** Decide whether to:
   - re-add `transcription_seek_seconds` / `transcription_duration` columns to the Prisma `Item` model + a migration + the PATCH field map, **and** make the IPC handler return `clipSeekSeconds` / `clipDuration` so the renderer can stamp them; **or**
   - explicitly accept that v2's "clip can span multiple items" model has retired this concept and document that.
3. **Per-item provenance log.** Re-add the `console.info('[transcribe] item=… seek=… dur=… source=…')` line at the top of `processItem` in v2's `handleProcessItems` (Sales.tsx:1320) and the matching one in `handleTranscribeSingle`. It cost almost nothing in v1 and was the first thing useful when chasing seek bugs.

Improvements in v2 to keep:
- `probeVideoDuration` past-end short-circuit.
- `errorCode`-based UI taxonomy (`VIDEO_EXPIRED`, `SEEK_PAST_END`).
- Downscaled re-encode (`scale=640:-2 -crf 28`) — Gemini doesn't need full resolution.
- 429 errorDetails JSON dump.
