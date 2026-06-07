# Consignment Intake → Sale → Payout — Cross-Repo Execution Plan

> **Plan type:** Coordination plan with per-milestone acceptance criteria. Each milestone below will be expanded into its own TDD task-detail plan (file path noted in each section) immediately before that milestone is executed. Steps in this file use checkbox (`- [ ]`) syntax so milestones can be tracked end-to-end.

**Goal:** Land the fiduciary-correct consignment intake → sale → payout flow described in the design spec, in two coupled repos, in dependency order, behind feature flags where listing-prep is dark until middleware Phase 2 is ready.

**Architecture:** Identity = one unique opaque `labelCode` per consignment piece (UPC+qty preserved for fungible owned stock). Reconciliation writes an append-only `ItemInventoryLink` + guarded `InventoryMovement{sold,-1}` with snapshotted attribution. Pack-station enforces a hard server-side gate (R1) until every order line is reconciled or routed to exception. All ownership/attribution changes flow through an immutable audit trail. Listing-prep capture is built behind a feature flag (`FEATURE_LISTING_PREP_SCAN`) so the data is captured for the middleware Phase 2 zero-touch match even though the UI is dark at launch.

**Tech Stack:** Web — Next.js 16, React 19, Prisma 7, PostgreSQL, NextAuth v5, Vitest. Desktop — Electron 33, React, Vitest, `qrcode-generator`, Shippo SDK.

**Source spec:** `docs/superpowers/specs/2026-05-13-whatnot-ad-spend-capture-design.md` is unrelated; the authoritative design is the per-repo plan at `docs/plans/2026-05-30-consignment-intake-qr-implementation.md` on branch `claude/consignment-intake-plan-aHd1n` in both `greenerytx/sellerfolio-desktop-v2` and `greenerytx/luxesense-web-v2`. This execution plan is the binding cross-repo coordination layer.

**Repos / local layout:**
- Web → `sellerfolio-platform/web/` (GitHub `greenerytx/luxesense-web-v2`, working branch `feature/v1-parity-port`)
- Desktop → `sellerfolio-platform/desktop/` (GitHub `greenerytx/sellerfolio-desktop-v2`, working branch `feature/sales-foundation`)
- Middleware → out of scope (Phase 2)

---

## Locked Decisions (from 2026-05-31 planning session)

| Decision | Resolution | Rationale |
|---|---|---|
| Phase 0 scan-latency diagnostic (§12) | **Skipped for now** | No scanner on hand. Opaque `labelCode` payload still ships; diagnostic deferred until hardware is back. Add follow-up if decode latency surfaces in field testing. |
| Collision policy on UPC↔consignment match | **Force explicit choice** | Reverses v1's silent owned default. Operator picks Owned / Consignment:&lt;name&gt; / Scan QR / Exception. No default, no timeout. |
| Refund/cancellation hold window before payout | **14 days post-ship** (override from 7-day recommendation) | Aligns with the buyer-protection window most likely to surface late returns; consignor payout waits 14 days post-ship. |
| Negative-inventory writes | **Hard block consignment; manager override owned** | Fiduciary safety on consignment; owned drift recoverable with audit trail + manager role. |
| Identity granularity | **Per-piece `labelCode` for consignment; UPC+qty for fungible owned** | Per-piece traceability for authenticity/damage disputes; preserves existing owned UPC+qty rows. |
| `ItemInventoryLink` bridge (bundles/multi-qty) | **Built in Phase 1** | 3/3 reviewer consensus that bundles are real. Avoids retro-migration. |
| Listing-prep capture (Phase 1.5) | **Built behind feature flag `FEATURE_LISTING_PREP_SCAN`** | Storage + scan UI in scope; dark until Whatnot middleware (Phase 2) can auto-match. Data accumulates so the flip is zero-migration. |
| Plan structure | **One unified plan here; per-milestone TDD plans on demand** | Coordination view stays single-source; execution detail decoupled per milestone. |

---

## File Structure (cross-repo inventory)

This is the complete file footprint the implementation will touch. Per-milestone plans will scope themselves to a subset.

### Web (`web/`)

**Prisma / schema:**
- Modify `prisma/schema.prisma` — add `labelCode`, `consignorId`, `consignmentId`, `sourceType`, `condition`, `intakeValue` to `Inventory`; relax `@@unique([tenantId, upc])` to non-unique index; add `@@unique([tenantId, labelCode])`. Extend `InventoryMovement.sourceType` enum-by-convention to include `received | sold | returned_from_customer | returned_to_consignor | damaged | lost | adjusted | reversal`; add `reversalMovementId`, `reason`, `createdBy`. Add `Item.reconciliationStatus` (`unreconciled | pending_sync | reconciled_owned | reconciled_consignment | reconciled_mixed | exception | legacy_skipped | reversed`). Add new model `ItemInventoryLink`. Add `consignorId`, `consignmentId` to `InventoryReceipt`.
- Create `prisma/migrations/<timestamp>_consignment_intake_v2/migration.sql` — generated migration with manual edits for the `sold ⇒ itemId IS NOT NULL` partial constraint.

**Library code:**
- Create `src/lib/inventory/label-codec.ts` — `generateLabelCode(): string`, `verifyLabelCode(s: string): boolean`. Opaque base32 code + check char. Pure functions.
- Create `src/lib/inventory/__tests__/label-codec.test.ts`.
- Create `src/lib/inventory/reconcile.ts` — `reconcileItem({ tenantId, itemId, scan: { labelCode | upc }, actorUserId, choice? })` returns `{ status, link, ambiguous?, lots? }`. Implements R2 (forced choice on UPC collision), R3 (atomic guarded depletion), R4 (frozen attribution snapshot), R5 (append-only — corrections go through `reverseReconciliation` not mutation).
- Create `src/lib/inventory/__tests__/reconcile.test.ts`.
- Create `src/lib/inventory/audit.ts` — `writeAttributionAudit({ itemId, oldConsignorId, newConsignorId, reason, actorUserId, station })` writes to a new `AttributionAudit` table.
- Create `src/lib/payout/eligibility.ts` — `isPayoutEligible(item, now)` returns false for `unreconciled`/`exception`/`reversed` or within the 14-day refund window post-`shippedAt`.
- Create `src/lib/payout/__tests__/eligibility.test.ts`.
- Modify `src/lib/payout/recompute.ts` — call `isPayoutEligible` when building batch candidates; preserve existing `consignorPaidAt` freeze.
- Modify `src/lib/feature-flags.ts` (or create if missing) — add `FEATURE_LISTING_PREP_SCAN` resolver (env-driven, tenant-scoped override).

**API routes:**
- Modify `src/app/api/inventory/scan/route.ts` — accept `{ labelCode?, upc?, ...intakeFields }`; per-piece create when `sourceType === 'consignment'`; preserve UPC+qty path for owned. Writes `received +1` movement.
- Create `src/app/api/inventory/reconcile/route.ts` — POST `{ itemId, labelCode? | upc?, choice? }` → calls `reconcileItem`. Returns `{ success, link, ambiguous?, lots? }` (lots returned on UPC collision with no choice).
- Create `src/app/api/inventory/reconcile/__tests__/reconcile.route.test.ts`.
- Create `src/app/api/inventory/reverse-reconcile/route.ts` — POST `{ linkId, reason }` → writes reversal movement, flips `Item.reconciliationStatus` to `reversed`, voids payout amount.
- Modify `src/app/api/pack-station/mark-packed/route.ts` — refuse completion (`409`) if any `ShipmentItem.itemId` in the shipment has `reconciliationStatus IN ('unreconciled','pending_sync')`. Allow `exception` to pass with reason logged.
- Modify `src/app/api/pack-station/verify/route.ts` — decode opaque `labelCode` (call `verifyLabelCode` + DB lookup). Backward-compat: still parse legacy `<showToken>|<title>` payload during grace window (see M5).
- Create `src/app/api/listing-prep/capture/route.ts` — POST `{ labelCode, showId, listingTitle, externalListingId? }` → stores link in new `ListingPrepCapture` table. Guarded by `FEATURE_LISTING_PREP_SCAN`.
- Create `src/app/api/reports/unreconciled-sales/route.ts` — GET, paginated. Sold `Item` rows where `reconciliationStatus IN ('unreconciled','pending_sync')` and `soldAt < now - 1h`. Drives the leak detector.
- Create `src/app/api/reports/consignment-liability/route.ts` — GET, grouped by consignor: in-house / sold-unreconciled / reconciled-unpaid / paid. Read-only view feed for consignors uses this.
- Create `src/app/api/consignor-portal/inventory/route.ts` — read-only consignor view (auth: signed token per consignor or master-admin impersonation).

**Background jobs / cron:**
- Create `src/lib/jobs/unreconciled-sales-alert.ts` — polls every 15 min; surfaces over-threshold counts to ops channel.
- Modify `src/lib/jobs/enqueue.ts` — wire the new job.

### Desktop (`desktop/`)

**Intake / receiving:**
- Modify `src/components/inventory/StartReceivingModal.tsx` — add consignor + consignment select (with inline-create); set on `InventoryReceipt`.
- Modify `src/components/inventory/ReceivingRow.tsx` — per-row override of consignment (defaults to receipt-level); display `sourceType` chip.
- Create `electron/lib/label-codec.ts` — mirrors web `label-codec.ts` (`generateLabelCode`, `verifyLabelCode`). Same algorithm so QR generation and verification agree.
- Create `electron/lib/label-codec.test.ts`.
- Modify `electron/lib/label-html.ts` — render QR of opaque `labelCode` (drop the legacy `<showToken>|<title>` payload). Cover the manufacturer UPC zone with the QR.
- Modify `electron/ipc/label-generator.ts` — thread `labelCode` through; remove dependence on listing title at print time.
- Modify `src/pages/LiveMonitor.tsx` — drop print-time title dependency; pass `labelCode` only.

**PackStation reconciliation:**
- Modify `src/pages/PackStation.tsx` — replace single-scan-to-load with line-item reconciliation panel. For each `ShipmentItem`:
  - Shows current `reconciliationStatus`.
  - Accepts QR (calls `/api/pack-station/verify` then `/api/inventory/reconcile`).
  - Accepts UPC; on collision (`ambiguous: true`) opens a forced-choice modal (Owned / Consignment:&lt;name&gt; / Scan QR / Exception).
  - Hard-blocks **Mark Packed** until every line is `reconciled_*` or `exception`.
- Create `src/components/packstation/ForceChoiceModal.tsx`.
- Create `src/components/packstation/ForceChoiceModal.test.tsx`.
- Create `src/components/packstation/ReconciliationLine.tsx`.
- Modify `src/electron/main/shippo.ts` (or equivalent label-purchase path) — gate `purchaseLabel` on a server-side check `/api/pack-station/can-purchase-label?shipmentId=…` that returns 409 when unreconciled lines exist. Self-fulfillment only.

**Listing-prep capture (feature-flagged):**
- Create `src/pages/ListingPrepQueue.tsx` — visible only when flag is on. Scans QR → calls `POST /api/listing-prep/capture` with currently-active show/listing context.
- Modify `src/components/live-monitor/AddListingFlow.tsx` — when flag on, require a `labelCode` scan before queuing.

**Returns:**
- Create `src/pages/Returns.tsx` — scan QR on returned piece → call new web endpoint `POST /api/inventory/return-from-customer { labelCode, orderId? }` that writes `returned_from_customer +1` and triggers payout reversal logic (auto if `consignorPaidAt` null, explicit-adjustment dialog otherwise).
- Create `src/components/returns/ReturnToConsignorPanel.tsx` — operator picks a consignment lot; web endpoint `POST /api/inventory/return-to-consignor { consignmentId }` writes `returned_to_consignor -N` and closes the lot (blocked if any sold-but-unshipped items linked).

**Reports / consignor view:**
- Create `src/pages/reports/Unreconciled.tsx` — table view of the unreconciled-sales report.
- Create `src/pages/reports/ConsignmentLiability.tsx` — grouped-by-consignor liability view.

### Shared

- `packages/shared/src/types/inventory.ts` (if monorepo shared package exists) — add `LabelCode`, `ReconciliationStatus`, `SourceType` types so web + desktop agree.

---

## Milestones

> Order: M1 → M2 → M3 → M4 → M5 → M6, with M7 buildable in parallel with M5/M6 since it's flag-gated. Each milestone's task-detail TDD plan lives at `docs/superpowers/plans/2026-05-31-consignment-intake-<milestone-slug>.md` and is written immediately before that milestone starts.

### M1 — Web: schema migration + label codec (`m1-schema-codec`)

**Why first:** Everything else depends on the schema and the codec algorithm being settled. Migration is the highest-risk operation; isolate it.

**Scope:**
- Branch sign-off for the schema changes on `feature/v1-parity-port` (this is the prereq the source plan flags).
- Prisma migration: add `labelCode`, consignment FKs, `sourceType`, `condition`, `intakeValue` to `Inventory`; relax UPC unique → non-unique index; add `@@unique([tenantId, labelCode])`. Add `ItemInventoryLink`, `Item.reconciliationStatus`, expanded movement types, `reversalMovementId`, `reason`, `createdBy`, `AttributionAudit` model. Add `ListingPrepCapture` model (flag-dark consumer, but the table lives).
- Custom SQL in the migration for the `sold ⇒ itemId IS NOT NULL` partial constraint (Prisma can't express it directly).
- Backfill: existing `Inventory` rows get `sourceType='owned'`; existing sold `Item` rows get `reconciliationStatus='legacy_skipped'` (the design's escape hatch).
- `src/lib/inventory/label-codec.ts` + tests. Opaque base32 (Crockford), 8 data chars + 1 check char = 9-char payload.

**Acceptance:**
- [ ] `npx prisma migrate dev` runs clean against a fresh DB and against a `pg_dump`-restored production snapshot (per `feedback_v2_db_backup_before_destructive`, take backup first).
- [ ] `npx prisma generate` produces a client with the new types.
- [ ] `vitest run src/lib/inventory/label-codec` passes — `generateLabelCode()` round-trips through `verifyLabelCode()`, malformed codes reject, check char catches single-character errors.
- [ ] No data loss: row counts in `inventory`, `inventory_movements`, `items` unchanged post-migration; sample 10 rows show expected backfill values.
- [ ] `web` typecheck and existing test suite still pass.

**Dependencies:** None.

**Risks / cut points:** If the UPC-uniqueness relax is contested, fall back to a tenant-scoped unique that excludes consignment rows via a partial index. Stop point before M2: confirm with branch owner that the schema is the final shape.

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m1-schema-codec.md` (to be written immediately before M1 execution).

---

### M2 — Web: reconcile engine + atomic depletion + audit (`m2-reconcile-engine`)

**Why next:** The reconcile API is the only legitimate writer of `ItemInventoryLink` + sold movements + attribution. Lock it down before any UI calls it.

**Scope:**
- `src/lib/inventory/reconcile.ts` — implements R2/R3/R4/R5. The atomic depletion is a `prisma.$queryRaw` `UPDATE inventory SET qty = qty - 1 WHERE id = $1 AND qty >= 1 AND tenant_id = $2 RETURNING *`. Zero rows → reject with `ALREADY_DEPLETED`. On UPC collision with no `choice` provided, returns `{ ambiguous: true, lots: [...] }` and does NOT mutate.
- `src/lib/inventory/audit.ts` — `AttributionAudit` write helper.
- `src/lib/payout/eligibility.ts` — gate logic; 14-day refund window from `Shipment.shippedAt`.
- `src/app/api/inventory/reconcile/route.ts` — wires the lib into the API. Updates `Item.consignmentId` only for the single-source case (so existing payout `recompute.ts` keeps working). Calls `recomputeItemPayout` post-write.
- `src/app/api/inventory/reverse-reconcile/route.ts` — append-only reversal.
- Modify `src/lib/payout/recompute.ts` — consult `isPayoutEligible` when batching; do NOT touch the `consignorPaidAt` freeze (per §8 of the spec, that already works).

**Acceptance:**
- [ ] Vitest suite for `reconcile.ts` covers: clean owned scan, clean consignment QR scan, UPC collision → `ambiguous`, UPC collision with `choice='owned'` → resolves, double-scan against same inventory row → second call returns `ALREADY_DEPLETED`, mid-pack consignor change on the lot → existing link's snapshotted attribution unchanged (R4), `reverseReconciliation` writes the negative movement and flips status to `reversed`.
- [ ] Route test for `/api/inventory/reconcile` covers permission denial, tenant isolation, and the `ambiguous` response shape.
- [ ] `eligibility.test.ts` covers: `unreconciled` excluded, `exception` excluded, within 14-day window excluded, post-14-day reconciled included, `consignorPaidAt` set → already-paid path (no double-pay).
- [ ] `payout/recompute.ts` regression test: existing single-source consignment payout math unchanged.

**Dependencies:** M1 schema + codec.

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m2-reconcile-engine.md`.

---

### M3 — Web: pack-station gate + verify decoder (`m3-pack-gate`)

**Why next:** Closes the leak in production code before any desktop UI starts calling it. R1 is the hard gate.

**Scope:**
- Modify `src/app/api/pack-station/mark-packed/route.ts` — refuse with `409 { code: 'UNRECONCILED_LINES', items: [...] }` if any line is `unreconciled` or `pending_sync`. `exception` passes with reason logged.
- Modify `src/app/api/pack-station/verify/route.ts` — decode opaque `labelCode`. Backward-compat parser: if payload contains `|`, fall back to legacy title-match for 30 days; log usage to a counter. Goal is to delete legacy parser at the end of M5 grace window.
- Create `src/app/api/pack-station/can-purchase-label/route.ts` — GET `?shipmentId=…` → `{ canPurchase: boolean, unreconciled: [...] }`. Desktop Shippo flow consults this.
- Wire `pending_sync` queue: if a pack-time scan arrives but the order hasn't synced yet, the reconcile endpoint queues the link locally (new `PendingPackScan` table) and replays on `Item` insert from the middleware.

**Acceptance:**
- [ ] Route test: `mark-packed` returns 409 on unreconciled lines, 200 when all are `reconciled_*` or `exception`.
- [ ] Route test: `verify` decodes opaque labelCode and returns `{ shipmentItem, item }`; legacy payload also resolves while flag is on.
- [ ] Route test: `can-purchase-label` returns `false` with the unreconciled list when any line is open.
- [ ] Integration: a `pending_sync` insert followed by middleware sync of the order results in the link being attached and status flipping to `reconciled_*`.

**Dependencies:** M2.

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m3-pack-gate.md`.

---

### M4 — Desktop: intake consignment + per-piece QR (`m4-intake-qr`)

**Why next:** With the web side accepting the new schema and codec, the desktop can start producing per-piece labels that the new flow will consume.

**Scope:**
- `electron/lib/label-codec.ts` — mirrors web codec. Same algorithm verified by a cross-repo test fixture (a list of `labelCode` strings + expected validity that both `label-codec.test.ts` files load).
- `StartReceivingModal` adds consignor/consignment selection (inline-create wired through existing `/api/consignors` and `/api/consignments` endpoints; if those don't exist, add them now — small enough not to be its own milestone, fold into M4).
- `ReceivingRow` per-row consignment override.
- `electron/lib/label-html.ts` renders QR of opaque `labelCode`. The QR module size + ECC level are set so the label fits over the manufacturer UPC zone and decodes reliably on the C750 at typical user distance.
- `LiveMonitor` no longer needs the listing title at print time.

**Acceptance:**
- [ ] Visual test: print a sheet of 4 labels at the production printer; each scans on the C750 in &lt;1.5s. (Field test; if no scanner available, deferred manual check — log to followups.)
- [ ] Receiving a piece into a consignment lot writes `Inventory` with `sourceType='consignment'`, `labelCode`, `consignorId`, `consignmentId` set; `received +1` movement written.
- [ ] Receiving owned stock keeps the existing UPC+qty path; no `labelCode` required.
- [ ] Cross-repo codec test fixture: identical input → identical validity decision on both web and desktop.

**Dependencies:** M1 (schema + codec on web). Codec lib in `electron/lib` is a copy of web's algorithm — keep them in sync via shared fixture, not via runtime coupling.

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m4-intake-qr.md`.

---

### M5 — Desktop: PackStation reconciliation panel + Shippo gate (`m5-pack-reconciliation`)

**Why next:** This is where the operator-facing R1 gate appears. Web is already enforcing it server-side; this UI prevents users from hitting the wall blind.

**Scope:**
- New line-item reconciliation panel in `PackStation.tsx`. Each `ShipmentItem`:
  - Status chip (`Unreconciled` / `Pending sync` / `Reconciled — Owned` / `Reconciled — <consignor>` / `Mixed` / `Exception`).
  - Scan input: routes QR vs UPC by payload shape (legacy `|` parser still recognized for grace period).
  - On UPC `ambiguous` response, opens `ForceChoiceModal`.
  - Result writes via `/api/inventory/reconcile`.
- `Mark Packed` button disabled until every line is `reconciled_*` or `exception`. Server-side check is the real gate; this is UX.
- Shippo `purchaseLabel` path consults `can-purchase-label` before opening payment; show a blocker dialog with the unreconciled lines if blocked.
- Whatnot-fulfilled labels are pre-printed upstream — there the gate is `mark-packed`, NOT print. Verify that path still works.
- Sunset note: remove legacy `|` payload parser at the end of this milestone if telemetry shows zero hits in the prior 14 days.

**Acceptance:**
- [ ] Manual run-through: scan an order with 3 mixed lines (owned + two consignors); each line resolves, mark-packed succeeds.
- [ ] Manual run-through: ambiguous UPC scan opens the modal; choosing Exception lets the shipment complete with the exception logged.
- [ ] Shippo path: try to purchase a label with an unreconciled line → blocked dialog shows the line.
- [ ] Whatnot path: pre-printed label scan loads the shipment; mark-packed enforces gate; print step is unaffected.
- [ ] Telemetry counter for legacy `|` payload reaches zero before deleting the parser.

**Dependencies:** M3 (web gate), M4 (desktop QR + intake).

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m5-pack-reconciliation.md`.

---

### M6 — Web + Desktop: safeguards, reports, consignor view (`m6-reports`)

**Why next:** Non-negotiable before go-live per the spec's §7. The unreconciled-sales report is the primary leak detector and must exist when traffic ramps.

**Scope:**
- Web endpoints `/api/reports/unreconciled-sales`, `/api/reports/consignment-liability`, `/api/consignor-portal/inventory`.
- Cron job `unreconciled-sales-alert` (15 min poll, threshold-driven Slack/email escalation).
- Desktop `Unreconciled.tsx` and `ConsignmentLiability.tsx` pages — operator-facing views.
- Consignor read-only view: web page at `/c/:consignorToken/inventory` (sign-only, no full auth; per-consignor signed URL).
- Returns flows (M6 includes these because they're a safeguard against leaks): `return-from-customer` and `return-to-consignor` endpoints + desktop UI.
- Aging report (drives RTC decisions); scan-coverage-per-packer metric; negative-inventory alert.

**Acceptance:**
- [ ] Unreconciled report shows the leak: deliberately leave one shipment line unresolved overnight, the morning report flags it.
- [ ] Consignor portal: a consignor can see their own (and only their own) in-house / sold-unreconciled / reconciled-unpaid / paid breakdown.
- [ ] Liability report total reconciles against `ConsignorPayout` aggregates for the last closed period.
- [ ] Buyer return flow: scan returned QR → `returned_from_customer +1` written, payout flagged for reversal; if `consignorPaidAt` set, explicit-adjustment dialog appears.
- [ ] RTC flow: marking a lot returned-to-consignor with an unshipped-sold item linked → blocked with the offending item listed.
- [ ] Negative-inventory alert fires on a manual injection of `qty=-1`.

**Dependencies:** M2 (reconcile is what populates the report data), M5 (operator workflow needs these views once gate friction starts).

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m6-reports.md`.

---

### M7 — Listing-prep capture (flag-dark) (`m7-listing-prep`)

**Why parallelizable:** Flag-gated. Can ship dark in any order after M1 (the `ListingPrepCapture` table lives from M1). Work can run in parallel with M5/M6 if a second engineer is available.

**Scope:**
- Web: `POST /api/listing-prep/capture` writes `{ labelCode, showId, listingTitle, externalListingId? }` to `ListingPrepCapture` keyed by `(tenantId, labelCode)`. Guarded by `FEATURE_LISTING_PREP_SCAN` per-tenant.
- Web: when middleware (Phase 2) lands, it consumes `ListingPrepCapture` to deterministically auto-match `externalListingId → labelCode → Item` at sync time. This plan does NOT build the middleware consumer; it builds the producer.
- Desktop: `ListingPrepQueue.tsx` page (hidden when flag off). Operator selects active show, scans QR, optionally types/pastes external listing id, submit.
- Desktop: `AddListingFlow.tsx` modified — when flag on, require a `labelCode` scan before queuing. When flag off, behave exactly as today.

**Acceptance:**
- [ ] Flag off: zero behavior change anywhere in the desktop or web app.
- [ ] Flag on for a test tenant: scanning a QR on the listing-prep page writes a `ListingPrepCapture` row; querying `/api/listing-prep/capture?labelCode=…` returns it.
- [ ] No `Item` mutation occurs at listing prep — sale linkage still goes through M2 reconcile until middleware Phase 2 reads the table.

**Dependencies:** M1 (table exists). Can run in parallel with M5/M6 if staffed.

**Task-detail plan:** `docs/superpowers/plans/2026-05-31-consignment-intake-m7-listing-prep.md`.

---

## Cross-cutting concerns (handled per milestone, called out once)

- **DB backups before destructive ops** — `pg_dump` of production before M1 migration (per existing `feedback_v2_db_backup_before_destructive` memory). Never `--accept-data-loss` without confirmation.
- **Tenant scoping** — every new Prisma query must include `tenantId` per `web/CLAUDE.md`. Lint or code review enforces this.
- **Permission keys** — new permissions: `inventory.reconcile`, `inventory.reverse-reconcile`, `consignor.portal.read`, `reports.consignment.read`. Wire into `src/lib/permissions.ts` defaults.
- **Audit trail** — every reconcile, reversal, attribution change writes to `AttributionAudit`. The trail is immutable (no UPDATE/DELETE in the lib).
- **Frequent commits** — one commit per logical step. Conventional Commits format (`feat:`, `fix:`, etc.). Plan-update commits use `docs:`.
- **Deploy** — per `project_deploy` memory: web is `deploy.ps1` to Contabo VPS (pm2); desktop is `npm run publish` to GitHub Releases. The pm2-lock standalone gotcha and required `prisma`/`pg` junctions still apply (per `feedback_deploy_gotchas`).

---

## Out of scope for this plan

- Middleware auto-match at sync (Phase 2 — separate repo).
- Whatnot external-id idempotency keying (flagged to middleware team).
- The scan-latency diagnostic in §12 of the source spec (skipped pending scanner availability — captured here so it isn't forgotten).
- Any change to the existing `recompute.ts` freeze behavior on `consignorPaidAt` (§8 of the source spec: don't touch).
- Owned-stock fungibility model (preserved as-is).

---

## Open items to confirm before M1 starts

- [ ] Branch-owner sign-off on the schema changes in `feature/v1-parity-port` (the `Inventory` UPC-uniqueness relax is the controversial one).
- [ ] Listing-prep flag scope: tenant-level only, or also per-user toggle? Defaulting to tenant-level unless told otherwise.
- [ ] Consignor portal auth: signed URL vs short-lived OTP. Defaulting to signed URL per-consignor (rotatable) unless told otherwise.
- [ ] When the C750 scanner is back available, schedule the §12 diagnostic before M5 ships.

---

## Self-review notes

Spec coverage:
- §3 R1 → M3 (`mark-packed` 409 gate) + M5 (UI). ✓
- §3 R2 → M2 (`reconcile.ts` ambiguous response) + M5 (`ForceChoiceModal`). ✓
- §3 R3 → M2 (`prisma.$queryRaw` guarded depletion). ✓
- §3 R4 → M2 (snapshot at reconcile, `AttributionAudit`). ✓
- §3 R5 → M2 (`reverseReconciliation`, append-only). ✓
- §4 data model → M1 schema. ✓
- §5 end-to-end flow → distributed across M2/M3/M4/M5/M6. ✓
- §5 race handling (pending_sync, double-deplete, mid-pack consignor change) → M2 + M3 pending-pack queue. ✓
- §6 cross-repo breakdown → matches M1–M5 split. ✓
- §7 safeguards & reports → M6. ✓
- §8 don't rebuild → respected (no changes to `consignorPaidAt` freeze, `ConsignorPayout(Item)` reused, `splitBase` untouched). ✓
- §9 scope boundary (middleware) → out of scope, captured. ✓
- §10 business knobs → all five resolved in Locked Decisions above. ✓
- §11 phasing → M1–M7 mapped to the spec's Phase 0/1/1.5/2 boundaries (Phase 0 explicitly skipped, Phase 1 = M1–M6, Phase 1.5 = M7 flag-dark, Phase 2 = middleware OoS). ✓
- §12 scan-latency diagnostic → explicitly skipped, tracked in out-of-scope + open items.

No `TBD`/`TODO`/`fill in details` placeholders. Types and names are consistent across milestones (`labelCode`, `reconciliationStatus`, `ItemInventoryLink`, `ForceChoiceModal`, etc.).
