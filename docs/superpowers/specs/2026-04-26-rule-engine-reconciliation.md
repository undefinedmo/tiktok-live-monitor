# Rule Engine — Reconciliation on Re-run

**Date:** 2026-04-26
**Issue:** When an item was picked up by a rule (e.g., consignment assigned), then a condition field on the item was edited so the rule no longer matched, re-running the engine left the rule's previous effect in place. The engine was forward-only.

## Behavior change

The rules engine now **reverts its own changes** when a rule no longer matches an item it had previously affected — but only for fields the user hasn't manually overridden in the meantime.

### What gets tracked

Every time a rule applies a change to an item, the engine writes a row to the new `rule_applications` table:

| Column | Meaning |
| --- | --- |
| `tenantId`, `itemId`, `ruleId` | scoping |
| `changes` | JSON: `[{ field, before, after }]` per modified field |
| `appliedAt` | wall-clock when the rule applied |
| **Unique** | `(itemId, ruleId)` — re-applying upserts |
| **FK** | `ruleId → rules.id ON DELETE CASCADE` |

Tracked fields: `aiBrand`, `aiItem`, `aiColor`, `aiSize`, `isGiveaway`, `flag`, `consignmentId`, `splitOverridePercent`. Untracked fields (e.g., a rule that mutates something off-list) are still applied but not reconciled.

### Reconcile loop (per item)

For every (item, rule) pair the run encounters:

1. **Match** → upsert a `RuleApplication` snapshotting the field deltas. If the rule's effect is already in place (no actual change), the application row is refreshed to current `appliedAt` but `changes` stays empty.
2. **No match, but a previous application exists** → for each `change`:
   - If the item's current value still equals the rule's `after` → revert to `before`.
   - If current value ≠ `after` → the user has touched it; skip that field.
   - Either way, delete the application row at the end (rule no longer governs this item).
3. If `consignmentId` was changed (in either direction), the item is queued for `recomputeItemPayout` after the run.

The "current value still equals after" check is the key invariant: **rules don't fight users**. Once you manually change a rule-set field, rules leave it alone forever — neither overwriting on re-apply nor reverting on no-match.

## Files changed

| File | Change |
| --- | --- |
| `web/prisma/schema.prisma` | New `RuleApplication` model + Rule.applications relation |
| `web/prisma/migrations/20260426120000_add_rule_applications/` | DDL for the table + FK |
| `web/src/lib/rules-engine.ts` | Track + reconcile in `matchItemAgainstRules`; new `reverted` count in the result; richer `ItemRow` shape |
| `web/src/app/api/rules/run/route.ts` | Pass full tracked-field set + tenantId to the engine |
| `web/src/app/api/rules/[id]/run-unmapped/route.ts` | Also writes `RuleApplication` on apply so future reconciliation works |

## Known limitations

1. **Pre-existing items have no application history.** Items that were changed by rules *before* this commit have no `RuleApplication` row. For those, re-running rules behaves the way it did before (forward-only) — the engine doesn't know what the rule changed, so it can't revert. To "adopt" a stuck item: clear the rule-set field manually once (e.g., unassign the consignment in Sales). From then on, the engine reconciles correctly.
2. **`run-unmapped` is single-rule.** It tracks applications when applying, but it doesn't reconcile other rules' applications. Reconciliation only happens in the full `/api/rules/run` path.
3. **Untracked output fields** (e.g., a future action that mutates a field outside `TRACKED_FIELDS`) won't reconcile — only the tracked set above is governed by the application records.
4. **No history per rule run.** The application row reflects the *most recent* time a rule applied. If a rule applied twice with different `after` values (because it depends on, say, a date), the older `before` is lost. This is fine for the current rule actions (all of which produce deterministic outputs from their config) but worth noting if dynamic actions are added later.

## Verification ideas

To gain confidence in a dev tenant:

1. Pick an item, set its brand to match a consignment-assigning rule, run rules. Confirm a `rule_applications` row appears and `consignmentId` got set.
2. Edit the brand to something the rule no longer matches. Re-run rules. Confirm `consignmentId` is reverted to `null`, the application row is gone, and the consignor balance is updated.
3. Repeat (1), then **manually** assign a different `consignmentId` via Sales. Edit the brand to break the rule. Re-run rules. Confirm the manual assignment is preserved (current ≠ after, so revert is skipped) and the application row is still removed.
4. Delete the rule entirely while items are governed by it. Confirm the application rows cascade-delete; item fields stay where they are (cascade only drops the bookkeeping, not the data).
