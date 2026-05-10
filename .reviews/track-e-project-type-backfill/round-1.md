## Findings

### P1 - Active text labels are not guaranteed to win over inactive duplicate labels

`lookupByLabel()` returns the first matching name without considering active status, and `loadProjectTypes()` orders by `display_order, name` rather than by active-first precedence. That means if `project_type_config` contains an inactive legacy row with the same display name as an active canonical row, the resolver can skip the row without `--include-legacy` or update to the inactive ID with `--include-legacy`, even though the required precedence is active numeric code, then active text label, then inactive text only with `--include-legacy`. The active text lookup needs to be separate from the inactive legacy fallback.

Refs: `scripts/backfill-project-types.ts:86`, `scripts/backfill-project-types.ts:157`, `scripts/backfill-project-types.ts:172`, `scripts/backfill-project-types.ts:299`

### P2 - Text-label fallback ignores the existing deal `project_type` column

The candidate query only loads `hubspot_extra_properties`, and the resolver only checks `hubspot_extra_properties.project_type`. This repo still has a first-class legacy text column on deals (`project_type`) next to `project_type_id`, so rows with `deals.project_type = 'service'` and missing/stale HubSpot JSON will be reported as "no preserved project type data" and skipped instead of taking the required active text-label fallback. If the backfill is intended to repair existing CRM deal rows, include the deal column as a text source and record the exact source field in the audit.

Refs: `scripts/backfill-project-types.ts:32`, `scripts/backfill-project-types.ts:136`, `scripts/backfill-project-types.ts:320`, `shared/src/schema/tenant/deals.ts:88`

## Data-Loss Risks

No direct data-loss risk found. The execute path refuses falsy `resolvedTypeId` values and the SQL only updates `project_type_id` where it is currently `NULL`; it does not clear fields, delete rows, or touch project-number fields.

Refs: `scripts/backfill-project-types.ts:457`, `scripts/backfill-project-types.ts:461`

## Clean Areas

The refreshed CSV audit now includes deal id, HubSpot id, source field/value, raw numeric/text values, conflict, resolved type id/code/label, action, and reason.

`--execute` is gated by both the explicit flag and an interactive confirmation prompt, while default/no-execute mode remains dry-run.

I did not find coupling to project-number assignment logic in the project-type backfill script.

The `applyProjectTypeChange` clear validator is not on this path; this script performs direct `NULL` to non-`NULL` `project_type_id` updates only.

## Verification

Ran:

- `npx vitest run scripts/backfill-project-types.test.ts` - passed
- `npm run typecheck` - passed

## P3-Only Suggestions

The review patch file currently only contains the tracked `package.json` change; the new script, runner, and tests are untracked in the working tree. Consider refreshing the patch artifact in a way that includes untracked files so future reviewers can review from the patch alone.
