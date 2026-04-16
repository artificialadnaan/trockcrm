# T Rock CRM Admin Intervention Workspace Design

**Date:** 2026-04-16  
**Status:** Draft for review  
**Scope:** Manager-first workspace for acting on AI-generated disconnect cases and generated admin tasks

## Goal

Turn the existing admin-first AI layer from a reporting and notification system into an operating workspace for office and management staff.

The workspace should help admins and directors:

- see which sales-process disconnects require intervention right now
- understand the evidence behind each disconnect
- take direct action without bouncing across multiple pages
- apply actions in batch where appropriate
- track whether those interventions actually reduce repeated disconnects

This phase builds on the current disconnect dashboard, action queue, and deterministic admin task generation. It does not replace them. It makes them operational.

## Canonical Surface Boundary

This design introduces one canonical writable surface:

- `/admin/interventions`

The existing surfaces keep distinct roles:

- `/admin/sales-process-disconnects`
  - diagnostic and reporting surface
  - read-first
  - optimized for totals, clusters, trends, narratives, and automation status
- `/admin/interventions`
  - operational action surface
  - optimized for ownership, queue management, batch actioning, and intervention history
- `/admin/ai-actions`
  - broader AI/admin queue for non-disconnect AI items
  - not the primary operating surface for disconnect-case work

Navigation rule:

- users discover problems on `/admin/sales-process-disconnects`
- users act on those problems in `/admin/interventions`
- the disconnect dashboard should link into the intervention workspace using prefiltered views, not duplicate its controls

Boundary rule for existing dashboard controls:

- the existing dashboard may retain `Refresh`, `Queue Digest`, `Queue Escalation Scan`, and `Queue Admin Tasks`
- those controls remain office-level automation triggers, not case-level intervention controls
- individual and batch mutation of disconnect cases belongs only in `/admin/interventions`
- the disconnect dashboard should not gain assign, snooze, resolve, or escalate controls for specific cases

## Why This Is Next

The current AI/admin stack already provides:

- disconnect detection
- root-cause clustering
- trend hotspots
- intervention outcomes
- playbooks
- weekly management narrative
- digest automation
- deterministic admin task generation

The main gap is follow-through.

Today, the system can tell office staff what is broken and can generate tasks, but the user still has to move between multiple surfaces to actually manage the intervention lifecycle. That weakens accountability, slows response, and makes it harder to measure what worked.

The highest-value next step is therefore a single manager-first intervention workspace.

## Approaches Considered

### 1. Task-only admin workspace

Build a page centered only on generated admin tasks.

**Pros**

- fastest to build
- maps cleanly onto existing task concepts
- easy to batch assign or resolve

**Cons**

- hides the actual disconnect case behind the task
- does not work well when no task exists yet
- encourages admins to think in task objects rather than operational problems

### 2. Disconnect-only intervention board

Build a page centered only on disconnect rows, with click-through to existing task or CRM pages for action.

**Pros**

- keeps focus on operational problems
- aligns with management reporting
- good for visibility and prioritization

**Cons**

- weak action loop
- still requires page-hopping to do the work
- does not unify generated task state with the underlying disconnect

### 3. Combined disconnect-case workspace

Use the disconnect case as the primary object and embed generated task state, recommended action, evidence, ownership, and intervention history in the same row or detail panel.

**Pros**

- best fit for office/admin workflows
- ties evidence, task state, and outcome into one operating surface
- works whether a generated task already exists or not
- supports both manager oversight and direct execution

**Cons**

- more design work than a task-only page
- requires clear boundaries between disconnect-case state and canonical CRM state

## Recommendation

Build a combined disconnect-case workspace.

Design rules:

- primary object: `disconnect case`
- embedded action state: generated task, assignment, escalation, snooze, resolution
- optimize first for manager oversight and batch operations
- allow direct mutation of intervention state from the workspace
- do not turn this page into a freeform CRM editor

## Product Outcome

Phase 1 of the workspace should let admins and directors do five things from one page:

### 1. Work a single prioritized queue

Users should see one queue of open disconnect cases across the office, with filtering and grouping by:

- severity
- cluster
- disconnect type
- owner
- stage
- company
- age
- escalated state
- generated task state

### 2. Understand why each case exists

Each case should clearly show:

- disconnect label
- severity
- age
- affected deal and company
- related cluster
- related generated task, if one exists
- summary of why the case was surfaced
- key evidence references

### 3. Take direct action from the workspace

Supported actions in v1:

- assign
- batch assign
- snooze
- batch snooze
- resolve
- batch resolve
- escalate
- batch escalate
- open linked CRM context

### 4. Capture intervention outcome

The workspace should record:

- what action was taken
- who took it
- when it was taken
- whether the user marked the intervention useful
- optional structured resolution reason

### 5. Give managers control and oversight

The page should make it easy to answer:

- what is aging out
- which teams or reps accumulate repeated disconnects
- which interventions reduce repeat issues
- which generated tasks are sitting untouched

## Design Principles

### 1. Case-first, not task-first

The operational problem is the disconnect case. Tasks are one possible intervention attached to that case.

### 2. Direct action, narrow mutation

Admins should be able to take action directly from the page, but those actions must be narrow and reviewable:

- assign
- snooze
- resolve
- escalate

The workspace should not become a broad editor for deals, contacts, companies, stages, or estimates.

### 3. Manager-first optimization

V1 should prioritize:

- queue visibility
- batch actioning
- aging and ownership visibility
- repeated-pattern management

Single-case triage should still be good, but not at the expense of the oversight layer.

### 4. Evidence-backed intervention

Every case must preserve the chain:

- deterministic disconnect signal
- cluster or pattern context
- linked CRM records
- generated task state
- intervention history

### 5. Additive and merge-safe

This workspace should remain additive:

- new page
- new service layer
- new API routes
- new supporting tables where needed

Avoid rewiring the canonical task engine or deal lifecycle in this phase.

## Primary Domain Object

The workspace should be built around a new conceptual object:

### `disconnect case`

A disconnect case is a normalized operating record representing:

- one active operational issue
- one target entity, usually a deal
- one disconnect type
- one current ownership/intervention state

It may or may not have:

- a generated admin task
- an escalation flag
- intervention notes
- prior resolution history

This is not a replacement for `ai_risk_flags` or `ai_task_suggestions`, but it is the canonical workspace state for admin intervention lifecycle.

Authority rule:

- `ai_disconnect_cases` is the source of truth for workspace status, assignee, escalation state, snooze state, and resolution state
- generated `tasks` remain the execution artifact for admin follow-through
- `ai_risk_flags` and disconnect dashboard logic remain the detection layer
- task rows may be created, assigned, snoozed, or resolved in response to case actions, but they do not own the workspace lifecycle

This keeps ownership unambiguous:

- detection comes from existing AI/disconnect logic
- intervention state lives in `ai_disconnect_cases`
- work execution can still be represented in canonical `tasks`

Materialization rule:

- every active disconnect that qualifies for the dashboard/action system should have exactly one `ai_disconnect_cases` row for its business key
- case rows are created or upserted by the same deterministic refresh path that computes disconnect dashboard rows
- recommended entry points are the existing disconnect refresh jobs and manual refresh path, not ad hoc page loads
- the workspace never creates duplicate cases from UI reads

## Recommended Architecture

### 1. Source layer

The existing AI/admin system remains the source for:

- disconnect rows and counts
- clusters
- trend hotspots
- intervention outcomes
- generated admin tasks

### 2. Workspace projection layer

Add a new server-side aggregation layer that assembles each disconnect case from:

- canonical `ai_disconnect_cases` state
- current disconnect dashboard row
- linked generated admin task, if present
- related AI risk flag, if present
- prior triage history from `ai_feedback`
- ownership and assignee information

This projection should return one normalized queue item shape.

### 3. Action layer

Direct mutations from the workspace should map to existing systems:

- assignment updates `ai_disconnect_cases.assigned_to` and syncs generated task assignee when a task exists
- snooze updates `ai_disconnect_cases.status = 'snoozed'` and `snoozed_until`, and may also snooze the generated task when one exists
- resolve records case outcome and can close the generated task if appropriate
- escalate updates case escalation state and keeps the case visible in escalation filters

Where no generated task exists yet, the workspace may create or queue the intervention action directly using existing deterministic task-generation semantics.

Task sync rule:

- workspace actions should never create a second parallel task for the same case business key
- if a generated admin task already exists, workspace actions mutate that task
- if no generated task exists and the chosen action requires one, the workspace creates or queues exactly one deterministic admin task tied to the case business key

### 4. Outcome layer

Every mutation should write structured feedback that can later answer:

- what action was taken
- which disconnect family it applied to
- whether the case reopened
- whether the cluster repeated

Write contract:

- every workspace mutation must write one `ai_disconnect_case_history` row
- every workspace mutation must also write one standardized `ai_feedback` event

This preserves compatibility with the current AI ops metrics and action-history consumers while introducing a purpose-built intervention history table.

## UI Shape

V1 should be a new admin/director page at `/admin/interventions`.

### Layout

#### Top summary strip

Show:

- open disconnect cases
- escalated cases
- cases with no owner
- aging cases beyond threshold
- generated admin tasks still pending

#### Main queue

A grouped, filterable queue with:

- row selection for batch actions
- sort by age, severity, cluster, owner, company
- quick action buttons

#### Side detail panel

When a row is selected, show:

- disconnect summary
- linked deal/company
- cluster context
- generated task details
- evidence snippets
- recent intervention history
- recommended action

### Batch controls

Batch controls should support:

- assign selected
- snooze selected
- resolve selected
- escalate selected

Batch actions should require lightweight confirmation where the action changes visibility or ownership.

## Filters and Views

V1 should support these saved or standard views:

- all open cases
- escalated
- unassigned
- aging
- repeated issues
- generated tasks pending
- by cluster
- by rep
- by company

## Direct Actions

### Assign

Assign the case owner and, if a generated task exists, sync the task assignee.

### Snooze

Temporarily suppress visibility until a future date without marking the case solved.

Required behavior:

- snooze must set `snoozed_until`
- snoozed cases are excluded from the default open queue until that timestamp passes
- snoozed cases remain visible in a dedicated snoozed view

### Resolve

Mark the intervention complete with a required structured resolution reason.

Suggested reasons:

- task completed
- owner aligned
- follow-up completed
- false positive
- duplicate case
- issue no longer relevant

Task outcome mapping:

- `task completed`
  - generated task transitions to `completed`
  - corresponding `task_resolution_state` should be written so the task engine understands the issue was resolved through execution
- `owner aligned`
  - generated task is dismissed if no further task execution is needed
  - `task_resolution_state` should be written with a suppressing resolution marker
- `follow-up completed`
  - generated task transitions to `completed`
  - `task_resolution_state` should be written
- `false positive`
  - generated task is dismissed
  - `task_resolution_state` should be written with a suppression-oriented resolution marker
- `duplicate case`
  - generated task is dismissed unless a surviving linked case owns the task
  - `task_resolution_state` should be written
- `issue no longer relevant`
  - generated task is dismissed
  - `task_resolution_state` should be written

If no generated task exists, resolve updates only the disconnect case and case history, but still writes the standardized `ai_feedback` event.

### Escalate

Mark the case escalated and push it into escalation-oriented views and metrics.

### Reopen

Reopen is not a direct user action in v1. It is a deterministic system transition.

Rule:

- if a resolved or snoozed disconnect case is re-detected for the same business key after its resolution or snooze window, the same case record is reopened rather than creating a new case
- reopening increments a counter and appends a history row

Business key recommendation:

- `office_id + disconnect_type + scope_type + scope_id`

## Data Model Additions

This phase should prefer additive tables rather than invasive changes.

### `ai_disconnect_cases`

Purpose:

- stable working-layer record for active intervention state

Suggested fields:

- `id`
- `office_id`
- `scope_type`
- `scope_id`
- `deal_id`
- `company_id`
- `disconnect_type`
- `cluster_key`
- `business_key`
- `severity`
- `status` such as `open`, `snoozed`, `resolved`
- `assigned_to`
- `generated_task_id`
- `escalated`
- `snoozed_until`
- `reopen_count`
- `first_detected_at`
- `last_detected_at`
- `last_intervened_at`
- `resolved_at`
- `resolution_reason`
- `metadata_json`

Recommended index/uniqueness rule:

- unique index on `office_id + business_key`

Business key should be derived from:

- `office_id + disconnect_type + scope_type + scope_id`

### `ai_disconnect_case_history`

Purpose:

- append-only intervention history for each case

Suggested fields:

- `id`
- `disconnect_case_id`
- `action_type`
- `acted_by`
- `acted_at`
- `from_status`
- `to_status`
- `from_assignee`
- `to_assignee`
- `from_snoozed_until`
- `to_snoozed_until`
- `notes`
- `metadata_json`

These tables should not replace existing `ai_feedback`. They provide the canonical intervention-state layer and append-only intervention history, while `ai_feedback` remains the broad event ledger used by existing AI ops metrics and telemetry.

## API Surface

Recommended additive routes:

- `GET /api/ai/ops/interventions`
- `GET /api/ai/ops/interventions/:id`
- `POST /api/ai/ops/interventions/batch-assign`
- `POST /api/ai/ops/interventions/batch-snooze`
- `POST /api/ai/ops/interventions/batch-resolve`
- `POST /api/ai/ops/interventions/batch-escalate`
- `POST /api/ai/ops/interventions/:id/assign`
- `POST /api/ai/ops/interventions/:id/snooze`
- `POST /api/ai/ops/interventions/:id/resolve`
- `POST /api/ai/ops/interventions/:id/escalate`

### List endpoint contract

`GET /api/ai/ops/interventions` should support:

- pagination:
  - `page`
  - `limit`
- sorting:
  - `sortBy` with values such as `age`, `severity`, `cluster`, `owner`, `company`, `lastIntervenedAt`
  - `sortOrder` with values `asc` or `desc`
- filters:
  - `status`
  - `severity`
  - `clusterKey`
  - `disconnectType`
  - `assignedTo`
  - `stageId`
  - `companyId`
  - `escalated`
  - `hasGeneratedTask`
  - `repeatOnly`
  - `agingOnly`
  - `view`

Standard `view` values should include:

- `open`
- `escalated`
- `unassigned`
- `aging`
- `repeat`
- `generated-task-pending`

Response shape should include:

- `items`
- `pagination`
- `availableFilters`
- `summary`

Each queue item should include:

- case identity and business key
- scope and linked CRM entities
- severity and age
- cluster metadata
- generated task state
- assignee
- escalated state
- snoozed state
- top evidence summary
- last intervention snapshot

### Batch mutation contract

Batch action routes should accept:

- `caseIds: string[]`
- action-specific payload such as:
  - `assignedTo`
  - `snoozedUntil`
  - `resolutionReason`
  - `notes`

Batch mutation responses should include:

- `updatedCount`
- `skippedCount`
- `errors`

## Relationship to Existing AI Features

### Sales process disconnect dashboard

The existing dashboard remains the diagnostic and reporting surface.

The intervention workspace becomes the action surface.

### AI action queue

The action queue remains a broader AI/admin queue.

The intervention workspace is the opinionated queue specifically for disconnect-case operations.

### Generated admin tasks

Generated admin tasks remain useful, but they should now be shown as part of the disconnect-case workspace rather than treated as the whole intervention model.

## Metrics and Success Criteria

The workspace should improve:

- time to first intervention
- rate of unassigned disconnects
- rate of aging open cases
- repeated disconnect reopen rate
- percentage of generated tasks acted on
- intervention clearance rate by cluster and action type

## Out of Scope

Not part of this phase:

- broad editing of deal/account canonical data from the workspace
- autonomous AI stage movement
- fully autonomous escalation without rules
- freeform chatbot interaction from this page
- replacing the current disconnect dashboard

## Merge-Safe Boundaries

Recommended additive boundaries:

- `server/src/modules/ai-copilot/intervention-service.ts`
- `server/src/modules/ai-copilot/intervention-routes.ts`
- `client/src/pages/admin/admin-intervention-workspace-page.tsx`
- `client/src/components/ai/intervention-*`
- new additive schema files for intervention-case tables

Minimize edits to:

- task engine internals
- core deal lifecycle flows
- existing disconnect dashboard logic except to link into the workspace

## Recommendation Summary

Build a combined disconnect-case workspace optimized for manager oversight and batch operations.

This is the highest-value next AI/admin feature because it converts the current stack from:

- detect
- explain
- notify

into:

- detect
- explain
- act
- measure

That is the missing operational layer for office/admin users.
