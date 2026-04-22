# HubSpot Ownership Seeding And Cleanup Design

## Summary

This design makes initial CRM adoption practical by auto-populating each rep's book of business from HubSpot ownership and separating personal data enrichment from leadership reassignment work.

The system should assign active leads and deals to CRM users based on the current HubSpot deal owner whenever a user match exists. Reps should log in and immediately see their active assigned work. Records that cannot be assigned from HubSpot should not be hidden behind office placeholder accounts. Instead, they should land in an explicit ownership resolution queue for directors and admins.

This design also introduces cleanup queues that turn missing or stale deal data into actionable work by role:

- reps enrich the records they own
- directors resolve unassigned ownership within their office
- admins resolve global mapping failures and cross-office issues

## Goals

- Auto-populate each user's active pipeline from HubSpot owner assignments.
- Remove the need for manual first-day assignment before reps can use the CRM.
- Create a clear cleanup workflow for missing deal and lead data.
- Separate `my records need enrichment` from `this record has no valid owner`.
- Allow directors to reassign orphaned records within their office.
- Preserve visibility into true ownership gaps instead of masking them with office holding accounts.

## Non-Goals

- Replacing the full HubSpot migration pipeline.
- Rebuilding deal ownership around Procore or Microsoft identity data.
- Automatically inferring new CRM roles from HubSpot.
- Automatically assigning orphaned records to a fake office user.
- Solving every migration data quality issue in one pass.

## Current Context

The platform already has the core pieces needed for this layer:

- CRM users imported from HubSpot and Procore identity sources
- deal assignment via `assigned_rep_id`
- migration and validation surfaces under admin migration
- pipeline hygiene and sales review views
- reporting grouped by assigned rep

What is missing is the operational glue:

- a reliable HubSpot owner to CRM user assignment pass
- rep-scoped cleanup queues
- explicit unassigned ownership queues for directors and admins
- role-specific landing summaries that tell users what they need to fix

## Problem Statement

If the CRM is seeded without honoring HubSpot ownership, users will log in and see incomplete or empty books. That creates immediate distrust and forces leadership to manually reconstruct assignment before the CRM can be used.

If unmatched or ownerless records are silently assigned to office placeholders, the system loses the signal that those records have real ownership problems. Reporting becomes misleading and cleanup accountability gets weaker.

The platform needs a first-run operating model that answers three questions clearly:

1. Which active records belong to this rep?
2. Which records are missing required data and need enrichment?
3. Which records have no valid owner and need reassignment?

## Recommended Approach

Use ownership-first seeding with two main cleanup lanes and one admin escalation lane.

### Lane 1: My Cleanup

For reps.

Assigned active leads and deals should show up automatically based on HubSpot owner mapping. Reps should see a personal cleanup queue containing only the records they own that are incomplete, stale, or missing required follow-up data.

Typical cleanup reasons:

- missing decision maker
- missing budget status
- missing next step
- missing next step due date
- missing forecast window or confidence
- stale stage with no recent activity
- missing required property/company linkage where relevant

### Lane 2: Office Ownership Queue

For directors and admins.

This queue should contain records in that office that are active but unassigned because:

- the HubSpot owner is missing
- the HubSpot owner email does not map to a CRM user
- the mapped user is inactive or invalid
- the record needs explicit reassignment

Directors should be able to claim or reassign these records within their office.

### Lane 3: Global Ownership Exceptions

For admins.

This queue should hold higher-order exceptions that should not be handled as ordinary office reassignment:

- duplicate user mappings
- cross-office ownership conflicts
- broken HubSpot owner identity records
- repeated assignment sync failures

## Ownership Model

### Source Of Truth

For initial seeding and migration-era refreshes, HubSpot owner should be the source of truth for active record ownership.

### Matching Strategy

Owner mapping should use the following order:

1. stored external identity mapping for HubSpot owner ID
2. normalized email match against CRM users
3. explicit failure into unassigned queue

The system should not attempt fuzzy name-based matching.

### Assignment Rules

- Active deal or lead with valid mapped owner: assign to that CRM user.
- Active deal or lead with missing or unmatched owner: mark unassigned and place in ownership queue.
- Terminal or closed records: keep historical owner if present, but do not create cleanup pressure unless specifically flagged for migration repair.

### Office Placeholder Rule

Unassigned records should not be assigned to an office account by default.

If the business later wants an office placeholder for reporting, that can exist as a display grouping or optional fallback bucket, but not as the acting owner used for cleanup accountability.

## User Experience

### Rep Experience

On login, a rep should see:

- active assigned leads and deals
- a count of cleanup items
- the highest-priority missing-data tasks

The rep should not see global unassigned records by default.

Primary rep action:

- enrich assigned records until they clear the cleanup rules

### Director Experience

On login, a director should see:

- office-level counts of cleanup items
- office-level unassigned ownership queue
- reassignment tools for active unassigned records in that office

Primary director actions:

- reassign ownerless records
- help reps clear office cleanup bottlenecks

### Admin Experience

On login, an admin should see:

- all office-level ownership queues
- global mapping exceptions
- bulk repair or reassignment tools

Primary admin actions:

- resolve mapping failures
- handle cross-office exceptions
- monitor overall cleanup completion

## Cleanup Rules

Cleanup work should be rule-driven rather than manually curated.

Each rule should evaluate whether an active lead or deal needs action and emit a machine-readable reason code. The UI should group and filter by these reason codes.

Initial recommended rule set:

- `missing_decision_maker`
- `missing_budget_status`
- `missing_next_step`
- `missing_next_step_due_at`
- `missing_forecast_window`
- `missing_forecast_confidence`
- `missing_stage_context`
- `stale_no_recent_activity`
- `missing_company_or_property_link`
- `unassigned_owner`
- `owner_mapping_failure`

Rules should auto-resolve when the underlying data is fixed. Users should not manually close cleanup tasks.

## Surfaces

### Rep-Facing

- dashboard summary card or section for `My Cleanup`
- dedicated cleanup list filtered to assigned user
- quick links into lead and deal detail pages

### Director/Admin-Facing

- office ownership queue
- bulk reassignment tools
- filters by office, reason code, stale age, pipeline stage

### Admin Migration/Data Scrub

The current migration and data scrub surfaces should remain the home for ownership exceptions and broader cleanup workflows. This work should extend those surfaces rather than create another unrelated admin tool.

The key distinction is:

- rep cleanup is operational day-to-day work
- ownership exceptions are migration/data scrub work

## Data Model Changes

The design should add structured ownership and cleanup metadata rather than burying these states in free-form notes.

Recommended additions:

### Record-Level

On leads and deals:

- ownership source metadata
  - `hubspot_owner_id`
  - `hubspot_owner_email`
  - `ownership_synced_at`
  - `ownership_sync_status`
- explicit assignment state
  - assigned user or null
  - unassigned reason code when null

### Cleanup State

Either as a materialized table or generated evaluation layer:

- record type
- record id
- office id
- assigned user id
- severity
- reason code
- generated at
- last evaluated at

The preferred implementation is a generated evaluation service backed by queryable rule outputs first, with persistence only if performance or audit needs require it.

## Sync Behavior

### Initial Seed

Run a backfill pass that:

1. loads active HubSpot leads and deals
2. resolves owner mappings
3. assigns matched records
4. emits unmatched records into ownership exception flow

### Ongoing Refresh

During migration-era coexistence, ownership refresh should be rerunnable without manual repair.

Recommended behavior:

- rerunnable admin sync command
- dry-run mode before apply
- summary of:
  - assigned
  - unchanged
  - unmatched
  - inactive-user conflicts

### Safety Rules

- do not overwrite terminal records unnecessarily
- do not assign to inactive users
- do not fallback silently to office placeholders
- always preserve enough source metadata to explain why a record is unassigned

## Reporting

Leadership should be able to see:

- percentage of active records assigned from HubSpot successfully
- count of unassigned active records by office
- cleanup volume by rep
- cleanup volume by reason code
- oldest unresolved ownership exception

This reporting should make the rollout measurable and highlight whether the system is getting cleaner over time.

## Error Handling

Failures should be explicit and actionable.

- missing HubSpot owner email -> `owner_mapping_failure`
- no CRM user match -> `owner_mapping_failure`
- matched inactive CRM user -> `inactive_owner_mapping`
- conflicting cross-office mapping -> `cross_office_mapping_conflict`
- sync failure during assignment -> `ownership_sync_error`

Users should see human-readable explanations, but the backend should store stable reason codes.

## Access Control

- reps can only view and clear cleanup items for records they own
- directors can view and reassign unassigned items within their office
- admins can view and reassign across all offices and resolve mapping failures

Directors should not be able to reassign records across offices unless they already have admin access.

## Rollout Plan

Recommended rollout order:

1. HubSpot owner mapping audit
2. initial ownership seeding pass
3. rep `My Cleanup` view
4. director/admin unassigned ownership queue
5. bulk reassignment tools
6. cleanup reporting and tuning

This order gets user trust first by making records appear in the right hands before adding more advanced cleanup tooling.

## Risks

### Bad Identity Data

If HubSpot owner emails are incomplete or stale, assignment success will drop. The design mitigates this by isolating those failures into explicit queues instead of silently masking them.

### Too Much Cleanup Noise

If the initial rules are too broad, reps may feel buried. The first version should focus on a short, high-value list of missing fields and stale states.

### Role Confusion

If rep enrichment and ownership reassignment live in the same queue, users will not know what they are accountable for. The separated lane design avoids that.

## Success Criteria

- A rep logs in and sees their active HubSpot-owned leads and deals already assigned.
- Unmatched or ownerless active records are visible in a director/admin queue, not hidden in placeholder ownership.
- Reps have a focused list of missing-data work on records they own.
- Directors can reassign orphaned active records within their office.
- Admins can monitor mapping failures and cleanup progress across the system.

## Open Questions Deferred From This Spec

These are intentionally left out of this design and can be handled in implementation planning if needed:

- whether cleanup evaluation should be persisted or generated on demand
- exact stale thresholds per stage
- whether some cleanup reasons should become hard stage gates later
- whether a limited office placeholder reporting bucket should exist as a non-owning classification
