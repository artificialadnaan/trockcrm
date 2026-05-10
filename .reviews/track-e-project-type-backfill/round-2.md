## Findings

Clean: I found no P1 or P2 issues in round 2.

No P3 polish items to flag.

## Review Notes

P1 is fixed correctly. `resolveProjectTypeDecision()` now computes active and inactive text matches separately, uses the active text match before any inactive fallback, and only allows the inactive match when `--include-legacy` is set. The regression test `prefers active text labels over inactive duplicate labels` puts an inactive duplicate `Service` row before the active row and still expects the active `type-service` id, which covers the original ordering failure.

P2 rejection is technically sound for this scoped backfill. The discovery note records that production has 0 Dallas rows where `project_type_id IS NULL` and `deals.project_type` is populated, and 0 Atlanta null-canonical rows. Given that, adding `deals.project_type` would not change this production run. The user requirement also scopes fallback to preserved HubSpot fields, and the script intentionally reads `hubspot_extra_properties.project_types` and `hubspot_extra_properties.project_type` only.

I did not find new NULL-update or execute-gating risk. The plan only puts rows with resolved ids into `updates`, `executePlan()` refuses a falsy `resolvedTypeId`, and the SQL updates only `WHERE project_type_id IS NULL`. Execution still requires `--execute` plus the interactive confirmation prompt; dry-run remains the default.

The audit CSV and console summary are adequate for this run. The CSV includes tenant, deal id, HubSpot id, source field/value, numeric/text raw values, conflict, resolved type id/code/label, action, and reason. The summary reports examined, eligible, skipped, skip buckets, conflict count, and samples for manual triage buckets.

The CLI path still supports:

- `npm run script -- backfill-project-types --tenant=office_dallas --dry-run`
- `npm run script -- backfill-project-types --tenant=office_dallas --execute`
- equivalent `--tenant=office_atlanta` and `--tenant=all` forms

## Verification

Ran:

- `npx vitest run scripts/backfill-project-types.test.ts` - passed, 8 tests.
- `node --import tsx -e "...parseBackfillArgs(['backfill-project-types','--tenant=office_dallas','--dry-run'])..."` - confirmed dry-run parse.
- `node --import tsx -e "...parseBackfillArgs(['backfill-project-types','--tenant=office_dallas','--execute'])..."` - confirmed execute parse.
- `npm run typecheck` - passed.
