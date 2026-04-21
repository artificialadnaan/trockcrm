# HubSpot Ownership Cleanup Phase 1 Design

## Summary

Phase 1 makes CRM adoption operationally viable by ensuring that active leads and deals inherit ownership from HubSpot where a valid CRM user match exists, while exposing unresolved ownership and missing-data issues as explicit cleanup work instead of hiding them behind placeholder owners.

This phase is intentionally narrow. It does not try to solve every migration defect or every create-form UX issue. It focuses on the first critical operating loop:

- reps log in and see the records they own
- reps see which of their records need enrichment
- directors and admins see which active records have no valid owner
- directors and admins can bulk reassign those records
- reassignment clears the ownership queue and triggers visible handoff work for the new owner

## Goals

- Seed active leads and deals from HubSpot owner identity whenever a clean CRM match exists.
- Preserve unresolved ownership as an explicit state instead of assigning records to office placeholder users.
- Expose rep-scoped cleanup work as a rule-driven queue grouped by reason code.
- Expose office-scoped unassigned ownership queues for directors and admins.
- Allow directors and admins to bulk reassign ownerless leads and deals.
- Keep this work inside existing dashboard and migration/data scrub surfaces.

## Non-Goals

- Replacing the full HubSpot migration pipeline.
- Solving every data migration defect in the same release.
- Building a new top-level sidebar section for ownership cleanup.
- Creating manual cleanup tasks for every missing field.
- Reworking create-form search performance or post-conversion enrichment in this phase.

## Current Context

The platform already has the core primitives needed for this work:

- `assignedRepId` exists on leads and deals.
- directors and admins can already change ownership on individual records.
- reassignment already creates handoff tasks for leads and deals.
- migration/admin surfaces already exist for validation, staged review, and data hygiene.
- rep and director dashboards already exist and can carry cleanup summaries.
- `/api/tasks/assignees` already exposes the office user list for assignment actions.

What is missing is the operational glue between HubSpot ownership, CRM assignment, and actionable cleanup.

## Problem Statement

Without ownership-first seeding, reps log in and do not see the correct book of business. That forces leadership to manually reconstruct assignment before the CRM can be trusted.

Without explicit ownership queues, unmatched or missing HubSpot owners disappear into ambiguous states. Reporting becomes misleading, cleanup accountability weakens, and there is no clear distinction between:

1. records a rep owns but still needs to enrich
2. records with no valid owner at all

Phase 1 must solve that distinction cleanly.

## Recommended Approach

Use an ownership-first operating model with three lanes:

### Lane 1: My Cleanup

For reps.

Reps should see only the active records they currently own that are incomplete, stale, or missing required follow-up context. These items are not manual tasks. They are query-driven cleanup records that disappear automatically when the underlying record is fixed.

### Lane 2: Office Ownership Queue

For directors and admins.

This queue should contain active leads and deals in the office that do not have a valid owner because the HubSpot owner is missing, unmatched, inactive, or otherwise invalid.

These records should be bulk-reassignable from the queue.

### Lane 3: Global Ownership Exceptions

For admins.

This queue should contain higher-order mapping problems that should not be treated as normal office reassignment, such as duplicate mappings, cross-office conflicts, or repeat sync failures.

Phase 1 should expose the metadata needed for this lane, but the first implementation focus is the office ownership queue rather than a full exception-management console.

## Ownership Model

### Source Of Truth

For migration-era seeding and refreshes, HubSpot owner identity is the source of truth for initial CRM assignment of active leads and deals.

### Matching Strategy

Owner resolution should follow this order:

1. explicit HubSpot owner mapping by owner ID
2. normalized email match against active CRM users
3. explicit failure into the unassigned ownership queue

The system should not use fuzzy name matching.

The owner-ID mapping is global to the HubSpot owner, not office-scoped. `hubspot_owner_mappings.hubspot_owner_id` should be unique across the whole system. Each HubSpot owner ID may resolve to at most one CRM user at a time.

If one HubSpot owner appears to map to multiple candidate CRM users, multiple offices, or any other conflicting identity state, the mapping row must remain unresolved:

- `user_id = null`
- `mapping_status = conflict`
- `failure_reason_code = duplicate_user_match` or `cross_office_conflict`

Those conflicts belong in the admin exception lane, not the normal office ownership queue.

### Assignment Rules

- Active lead/deal with valid mapped owner: set `assignedRepId` to that CRM user.
- Active lead/deal with missing or unmatched owner: leave ownership unresolved and set structured ownership failure metadata.
- Terminal or closed records: retain historical ownership metadata when available, but do not generate cleanup pressure in Phase 1.

### Placeholder Rule

Unassigned records must not be auto-assigned to office holding accounts.

If the business later wants placeholder reporting buckets, that should be a reporting concern, not the acting owner used for accountability.

## Data Model

Phase 1 should add explicit ownership-sync metadata to `leads` and `deals`:

- `hubspotOwnerId`
- `hubspotOwnerEmail`
- `ownershipSyncedAt`
- `ownershipSyncStatus`
- `unassignedReasonCode`

Phase 1 should also add a public mapping table:

- `hubspot_owner_mappings`

That table should store:

- HubSpot owner id
- HubSpot owner email
- resolved CRM user id, when known
- office id, when known
- mapping status
- failure reason code
- timestamps for last seen and last updated

The table should enforce a unique key on `hubspot_owner_id`. It should not allow one HubSpot owner ID to point at multiple CRM users through office-scoped duplicates.

## Cleanup Evaluation Model

Cleanup should be rule-driven, not manually curated.

The preferred implementation is a server-side evaluation service that returns queue items computed from live record data. Phase 1 should not persist cleanup items as task rows unless performance later demands it.

Each cleanup queue row should expose:

- record type
- record id
- office id
- assigned user id or null
- severity
- reason code
- generated at / evaluated at timestamps

Initial reason codes for Phase 1:

- `missing_decision_maker`
- `missing_budget_status`
- `missing_next_step`
- `missing_next_step_due_at`
- `missing_forecast_window`
- `missing_forecast_confidence`
- `stale_no_recent_activity`
- `missing_company_or_property_link`
- `unassigned_owner`
- `owner_mapping_failure`
- `inactive_owner_match`

These reason codes must be filterable in the UI and must auto-resolve when the underlying record is corrected.

## Surfaces

### Rep-Facing

Rep dashboard should gain a `My Cleanup` summary card that shows:

- total cleanup count
- grouped counts by highest-priority reasons
- a drill-in link to a dedicated cleanup list

The list should show only records assigned to the current rep.

### Director/Admin-Facing

The existing migration/data scrub area should gain:

- ownership sync summary
- office ownership queue
- filters for office, record type, stage, reason code, and stale age
- bulk reassignment actions

This work should extend existing migration/data hygiene pages instead of creating a new sidebar destination.

## Bulk Reassignment Behavior

Bulk reassignment is for records in the ownership queue, not for arbitrary record editing.

Allowed actors:

- directors: records within their accessible office scope
- admins: records across all offices

Expected behavior:

1. user selects one or more queue rows
2. user selects a valid assignee from the office user list
3. the system updates `assignedRepId`
4. the system clears `unassignedReasonCode`
5. the system updates ownership sync metadata to reflect manual resolution
6. the record drops out of the unassigned queue on next evaluation
7. existing lead/deal reassignment tasking fires so the new owner gets visible work

Reps must not have access to bulk reassignment.

Assignee eligibility must be tied to the queue row's office:

- the selected assignee must be an active CRM user with access to that record's office
- a director may only reassign rows from offices they can access
- a director with access to multiple offices may still only choose assignees valid for the selected row's office
- admins may reassign across offices, but the chosen assignee must still have access to the target row's office

The UI should therefore use an office-filtered assignee list for bulk reassignment rather than a global office-agnostic picker.

## Sync Behavior

Phase 1 needs two admin operations:

- dry run
- apply

### Dry Run

Returns counts and examples without mutating records:

- matched assignments
- unchanged assignments
- unmatched owners
- inactive-user conflicts
- records that would move into unassigned status

### Apply

Runs the same evaluation and writes ownership metadata and assignments to active leads and deals.

The sync should be rerunnable and idempotent. Re-running it should not create duplicate reassignment side effects when ownership did not actually change.

Manual reassignment must take precedence over later HubSpot refreshes in Phase 1.

When a director or admin resolves an ownership queue row manually:

- `assignedRepId` is updated to the chosen CRM user
- `ownershipSyncStatus` becomes `manual_override`
- the latest HubSpot owner metadata may still be refreshed on rerun
- but rerun sync must not overwrite `assignedRepId` while the record remains in `manual_override`

If leadership wants to restore HubSpot-driven ownership later, that should require an explicit admin action in a later slice rather than an automatic rerun side effect.

## Access Control

- reps can view only their own cleanup queue
- directors can view office cleanup and office ownership queues for offices they can access
- admins can view all queues and all ownership sync results
- only directors and admins can bulk reassign queue rows
- only admins can run global ownership sync

## Success Criteria

Phase 1 is successful when:

- active records with valid HubSpot owner matches automatically populate under the correct CRM rep
- unmatched owner records remain explicitly visible in ownership queues
- reps can see and work their own missing-data cleanup backlog
- directors/admins can bulk reassign ownerless records from the migration/data scrub surface
- reassigned records generate visible handoff tasks for the new owner
- queue items disappear automatically once their underlying data is fixed

## Out Of Scope For The Next Slice

These are intentionally deferred until after Phase 1:

- create-form company/property search speed improvements
- select-component testing ergonomics and hidden-input snapshot noise
- post-conversion deal enrichment nudges for project type, region, expected close, and next step

Those should be handled as the next polish track after ownership and cleanup are operational.
