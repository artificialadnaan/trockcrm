## Summary

This PR ships Phase 1 of the comprehensive audit-log upgrade:

- `audit_log` schema augmentation for richer activity entries
- idempotent SQL migration plus idempotent startup bootstrap for the new columns/indexes
- shared `logActivity(...)` helper
- field formatter and privacy redaction layer
- `ActivityFeedEntry` frontend renderer
- admin `All Activity` feed with filters
- lead and deal write-surface coverage for the approved Phase 1 paths

## Strategy

This follows the approved Option 2 strategy:

- `audit_log` becomes the canonical event index for new activity entries
- legacy tables such as `activities`, `lead_stage_history`, `deal_stage_history`, `deal_history`, and `photo_audit_log` remain in place
- Phase 1 does not remove or backfill legacy history systems

## Phase 1 Coverage

Shared infrastructure:

- `actor_name`, `actor_role`, `actor_system_process`
- `entity_type`, `entity_name_snapshot`, `entity_secondary_id_snapshot`
- `impersonator_id`
- `field_changes_jsonb`
- `visibility_scope`

Lead and deal paths covered in this PR:

- lead create
- lead update
- lead stage transition
- lead conversion to deal
- lead soft delete
- direct deal create
- deal field update
- deal stage transition
- proposal draft start
- contract signed date updates
- deal soft delete

## Known Phase 1 Gaps

These are documented intentionally and deferred rather than expanded tonight:

1. `server/src/modules/leads/due-diligence-service.ts` background lead transitions still bypass the named system-process audit context. That should be addressed in Phase 1.5 or Phase 2.
2. No active in-repo HubSpot Sync mutation surface for leads/deals was found during the inventory in this checkout. Either that mutation surface exists elsewhere and is not yet wired, or HubSpot sync is not currently mutating these entities in this codebase. That follow-up investigation is deferred.

## Explicitly Out Of Scope

Per the approved phased plan, this PR does **not** touch:

- properties
- companies
- contacts
- tasks
- files
- photos
- email
- recordings
- Procore
- Bid Board
- CompanyCam
- admin permission flows
- merge tooling

Those remain deferred to Phase 2.

## Reference

- `.reviews/comprehensive-audit-logs/phase-2-plan.md`
