# Forecast Accuracy And Pipeline Variance Design

## Goal

Add forecast-accuracy reporting that shows how deal value changes from initial deal creation through qualification, estimating, and final award, without creating a second competing pipeline system.

## Non-Goals

- Replacing the existing weighted forecast report
- Rebuilding workflow or stage-gate logic
- Introducing opportunity-stage monetary fields on `leads`
- Recomputing historical forecast state from arbitrary audit diffs on every request

## Existing Foundations

- Current weighted forecast lives in [server/src/modules/reports/service.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/forecast-admin-reporting/server/src/modules/reports/service.ts:153) and reports current active pipeline by expected close month.
- Deal stage history exists in [shared/src/schema/tenant/deal-stage-history.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/forecast-admin-reporting/shared/src/schema/tenant/deal-stage-history.ts:1) and records when stage transitions happen.
- Audit log exists in [shared/src/schema/tenant/audit-log.ts](/Users/adnaaniqbal/Developer/trock-crm/.worktrees/forecast-admin-reporting/shared/src/schema/tenant/audit-log.ts:1) and the tenant trigger records sparse field-level updates plus full row inserts.
- The analytics cycle already added shared report filters, source performance, data mining, and regional ownership lanes.

## Problem

The client wants to measure forecast quality across the lifecycle:

- original sales-entered value
- value after qualification
- estimate-stage value
- final awarded value

The platform can report the current deal value, but it does not persist durable milestone snapshots for those checkpoints. Audit data is too sparse and too expensive to reconstruct reliably for a first-class report because updates only store changed fields, not complete state snapshots.

## Approaches Considered

### 1. Reconstruct from audit log + deal stage history

Pros:
- no new table

Cons:
- sparse updates force historical state reconstruction
- hard to make deterministic for all existing records
- expensive and brittle for reporting queries
- hard to test and explain

### 2. Add report-specific snapshot table fed by milestone events

Pros:
- deterministic
- cheap to query
- easy to explain to users
- extends existing deal and stage-history flows instead of duplicating them

Cons:
- requires one new tenant table and backfill policy

### 3. Add workflow-specific value fields directly onto deals

Pros:
- easy to read

Cons:
- duplicates mutable deal state
- creates ambiguous source of truth
- does not preserve history

## Recommendation

Use approach 2.

Add a small sibling milestone fact table keyed by deal and milestone. Populate it when a deal is created, when it reaches the first qualifying checkpoint, when it first enters estimating, and when it closes won. Keep it append-light and deterministic. Use those milestone snapshots to power forecast variance reporting while leaving the existing weighted forecast report intact.

## Design

### Data Model

Add a new tenant table:

- `deal_forecast_milestones`

Fields:

- `id`
- `deal_id`
- `milestone_key`
  - `initial`
  - `qualified`
  - `estimating`
  - `closed_won`
- `captured_at`
- `captured_by`
- `stage_id`
- `workflow_route`
- `expected_close_date`
- `dd_estimate`
- `bid_estimate`
- `awarded_amount`
- `forecast_amount`
- `source`
- `capture_source`
  - `live`
  - `audit_backfill`

Rules:

- one row per `deal_id + milestone_key`
- `forecast_amount` is derived at capture time from the best available value:
  - `awarded_amount`
  - else `bid_estimate`
  - else `dd_estimate`
  - else `0`

This avoids a second value model while still giving reports a stable numeric comparison point.

### Milestone Capture Rules

#### Initial

Capture on deal creation.

Purpose:
- establishes the earliest durable sales-entered forecast for the deal record

#### Qualified

Capture on first entry into the `dd` stage slug after deal creation.

Implementation note:
- the current seeded pipeline already treats DD as the first post-conversion qualification checkpoint
- the first cut uses that explicit `dd` slug instead of a fuzzy “DD-like” classifier
- if T Rock later formalizes a different qualification checkpoint, the mapping can change in one milestone-capture service

#### Estimating

Capture on first entry into stage slug `estimating`.

This maps directly to the client’s request for “value after qualification” and “estimate-stage value.”

#### Closed Won

Capture when a deal enters `closed_won`.

This provides the final awarded comparison point.

### Backfill Policy

Backfill only what can be inferred safely:

- `initial`: backfill only from the deal-create `audit_log` insert `full_row` when it exists
- `closed_won`: backfill for currently won deals from current deal row and `actual_close_date`, tagged as `audit_backfill`

Do not fabricate historical `qualified` or `estimating` snapshots for older records unless stage history makes that milestone unambiguous and the deal currently has a non-null forecast amount at that point. Ambiguous records remain partially populated instead of inventing fake history.

### Reporting Surface

Add a new report lane:

- `forecast_variance`

Returned overview should include:

- summary cards
  - total deals with complete milestone chain
  - average variance from initial to closed won
  - average variance from qualified to closed won
  - average variance from estimating to closed won
- by-rep rollups
  - count of comparable deals
  - average initial variance
  - average qualified variance
  - average estimating variance
  - average close-date slip days
- deal detail table
  - deal
  - rep
  - workflow route
  - initial forecast
  - qualified forecast
  - estimating forecast
  - awarded amount
  - initial variance
  - qualified variance
  - estimating variance
  - expected close drift in days

### Filtering

Use the existing shared analytics filters:

- `from`
- `to`
- `officeId`
- `regionId`
- `repId`
- `source`

Office scoping should work the same way the current source, data-mining, and regional ownership lanes do.

### UI Placement

Do not replace the existing weighted forecast report.

Add a new section to the reports page below source performance and above data mining:

- `Forecast Accuracy`

Rationale:
- it stays inside the analytics lane
- it is complementary to source performance and regional ownership
- it does not overload the locked report drawer

### Admin / Director Visibility

- directors: full access
- admins: read access
- reps: no first-cut access

This matches the decision-oriented nature of the report and avoids creating a rep-facing incentive/compensation interpretation prematurely.

### Error Handling

- If a report filter produces no comparable closed-won deals, show an empty state instead of zeros that imply accuracy.
- If a deal lacks one or more milestones, include it only in summary counts where appropriate, not in variance averages that require those milestones.

## Why This Is Not Redundant

- it extends the analytics reporting foundation rather than creating a new analytics module
- it does not replace weighted forecast; weighted forecast remains current-state forward-looking pipeline
- it does not duplicate audit log; milestone snapshots exist because audit log is not a durable analytical checkpoint model
- it does not add money fields to leads or duplicate mutable deal value fields
- it does not add another locked report path for the same analytics surface

## Testing Strategy

- service tests for milestone capture rules
- backfill tests for safe partial backfill
- report service tests for summary math and filter scoping
- route tests for role access and office scoping
- UI section tests for empty, loading, populated, and export states

## Rollout

### Phase 1

- milestone table
- initial backfill only when audit insert snapshots exist, plus closed-won backfill
- live capture hooks for initial, qualified, estimating, closed won
- report service + route
- reports page section

### Phase 2

- tighter qualified-stage detection if T Rock finalizes a more explicit workflow taxonomy
- optional trend charts by month/quarter
