# Sales Scoping Intake Design

**Date:** 2026-04-07
**Status:** Draft for review
**Scope:** Sales-to-estimating and sales-to-service intake workflow, gating, autosave, autopopulation, and downstream automation

## Goal

Replace the static project scoping checklist with a first-class in-app intake workspace on each deal so sales can capture information once, attach the required files directly, and move deals into the next routed workflow only when the intake is complete.

The system must optimize for:

- minimal sales data entry
- high-usability, sectioned workflow UI
- continuous autosave with resume support
- deterministic stage-gate enforcement
- downstream automation into estimating and service workflows

## Repo Compatibility Constraints

The current repo has:

- a stage-based deal progression model
- no native deal-level service route field yet
- an existing deal file subsystem with category-driven uploads and confirm flows
- a smart task engine that is event-driven and dedupe-aware

This design must extend those systems rather than fork them.

## Source Inputs

This design incorporates three new source artifacts:

- `Project Scoping Checklist.docx`
- `Estimating Workflow.pdf`
- `Service Workflow.pdf`

These inputs establish that:

- estimating cannot start without a complete scoped handoff
- service follows a related but distinct downstream workflow
- missing information, revisions, review timers, assignment, and handoff steps should be automated after intake completion

## Product Decision

The intake should be implemented as a deal-native workspace, not as:

- a PDF-first document workflow
- a generic task form
- a Procore-first control surface

The smart task engine remains the correct execution layer for follow-up and handoff automation, but the primary user experience must be a dedicated intake workspace attached to the deal.

## Core Principles

### 1. Capture once, reuse everywhere

Any information collected from the first touch onward should autopopulate into the scoping workflow and any later estimating or service workflows.

Examples:

- deal basics
- account and contact details
- property name and address
- rep ownership
- notes and discovery context
- uploaded files and photos
- project type and budget context

Sales should confirm or edit existing data, not re-enter it.

### 2. Hard gate before progression

A deal cannot move into its next routed workflow until all required intake sections are complete.

For current CRM behavior, this means:

- transitions into the existing `estimating` deal stage are blocked until intake readiness passes
- service-routed opportunities must pass intake readiness before service handoff automation can begin
- if the product later adds a dedicated service pipeline stage, the same readiness rules should gate that transition as well

If a user attempts stage movement early:

- the transition is blocked
- the API returns structured missing requirements
- the UI highlights the blocking sections and fields

### 3. Autosave by default

Every meaningful field edit is saved automatically without a manual save action.

Requirements:

- draft state persists continuously
- incomplete work can be resumed later
- the user sees clear save status
- partial progress is never lost because the form is incomplete

### 4. Direct attachment workflow

Photos, plans, and scope documents must be uploaded directly inside the intake workspace and automatically attached to the deal.

The user should also be able to reuse already-uploaded deal files instead of uploading duplicates.

## User Roles

The intake workspace can be completed and edited by:

- assigned sales rep
- director
- admin

Director and admin users act as override roles for correction and cleanup, but the workflow should still prefer normal rep ownership.

For this feature, override means edit authority, not progression bypass.

The user requirement is a hard gate. Director/admin users may fix data, upload missing files, or help complete the intake, but they may not bypass scoping incompleteness to force a deal into estimating or into a service handoff state.

## Workflow Model

The intake is one unified form with conditional sections rather than separate estimating and service forms.

The route and project type determine which sections are shown, which fields are required, and which downstream automation runs.

### Canonical route model

Because the current repo has no service route field, the implementation must add a canonical deal-level route selector.

Recommended field on `deals`:

- `workflow_route` enum: `estimating`, `service`

Rules:

- `workflow_route` is the source of truth for routing
- it is set by sales, director, or admin at scoping start
- new deals may default to `estimating`, but the user must be able to switch to `service`
- the scoping intake copies this value for snapshotting, but does not own it canonically
- readiness rules and downstream automation read the canonical deal-level `workflow_route`

Primary routes:

- estimating
- service

Primary conditional dimensions:

- project type
- interior scope present
- exterior scope present
- amenities/site scope present
- required attachments present

## UX Design

### Workspace structure

The intake should live as a dedicated workspace on the deal, not buried in a modal.

Recommended layout:

- header with deal identity, route, readiness status, and save state
- left-side section navigation or step rail
- central form workspace for the current section
- right-side or sticky summary panel for missing items, attachment status, and readiness

### Sections

Base section set derived from the scoping checklist:

1. Project Overview
2. Property Details
3. Project Scope Summary
4. Interior Unit Renovation Scope
5. Exterior Scope
6. Amenities / Site Improvements
7. Quantities
8. Site Logistics
9. Site Conditions Observed
10. Materials / Specifications
11. Attachments Provided

### Usability requirements

- section completion indicators
- sticky progress and readiness bar
- clear “missing required info” messaging
- conditional fields and sections based on prior answers
- prefilled values shown as editable data, not locked read-only text
- attachment upload inside the relevant section
- mobile-safe but desktop-optimized layout
- draft resume behavior on refresh or return

### Readiness behavior

The UI must clearly show one of:

- Not started
- In progress
- Missing required information
- Ready for Estimating
- Ready for Service

The readiness card should explain exactly what is blocking progression.

These are derived UI labels, not the persisted storage status.

## Data Model

Add a first-class scoping intake record linked to each deal.

Recommended model:

- `deal_scoping_intake`
  - `id`
  - `deal_id`
  - `office_id`
  - `workflow_route_snapshot` (`estimating` or `service`)
  - `project_type`
  - `status` (`draft`, `ready`, `activated`)
  - `section_data`
  - `completion_state`
  - `readiness_errors`
  - `last_autosaved_at`
  - `first_ready_at`
  - `activated_at`
  - `created_by`
  - `last_edited_by`
  - timestamps

Implementation note:

- `section_data` may start as structured JSON to move faster
- `completion_state` should be machine-readable by section and field
- `readiness_errors` should be deterministic and generated, not freeform
- `activated` means the intake has already been used to unlock the downstream estimating or service workflow; it is not a separate manual submit button requirement
- if a previously ready intake becomes incomplete after edits, `status` returns to `draft` and readiness is recomputed

### Lifecycle mapping

Persisted intake status:

- `draft`: intake exists but is not currently ready
- `ready`: all required fields and attachments are currently satisfied
- `activated`: the intake has already been used to start the next routed workflow

Derived UI labels:

- `Not started`: no intake record exists yet
- `In progress`: intake exists and `status = draft`, with no blocking summary requested yet
- `Missing required information`: intake exists and `status = draft`, with computed readiness errors
- `Ready for Estimating`: `status = ready` and canonical `workflow_route = estimating`
- `Ready for Service`: `status = ready` and canonical `workflow_route = service`

Timestamp rules:

- `last_autosaved_at`: latest persisted field or attachment change
- `first_ready_at`: first time the intake transitions into `ready`
- `activated_at`: time the intake unlocked estimating-stage entry or service handoff activation

Files should continue to live in the main deal file system, but with additional linkage metadata:

- intake section association
- intake-required marker
- source of upload (`deal_general` vs `scoping_intake`)

### File-system integration

The intake must use the existing deal file subsystem, not introduce a parallel storage path.

Requirements:

- intake uploads call the existing file upload flow under the hood
- every uploaded file still has a standard file row, category, and deal association
- intake-specific APIs may wrap the existing file APIs for UX convenience, but they must produce normal deal files
- existing deal files must be linkable into intake requirement slots without duplication

Initial category mapping should reuse current enums:

- photos and site images -> `photo`
- plans, drawings, finish schedules, scope packages -> `rfp`
- miscellaneous client documents -> `correspondence` or `other`

Foldering convention should remain deal-visible and deterministic, for example:

- `/Deals/<deal-number>/Scoping/<section-slug>/`

If later needed, a future migration can add more granular file categories, but rollout must work with the current file model first.

## Autopopulation Strategy

The intake workspace should materialize a merged view of existing deal knowledge.

Prefill sources may include:

- deal record
- company record
- primary contact
- assigned rep
- prior notes
- prior uploaded files
- property metadata
- stage history and discovery context

Rules:

- existing authoritative values prefill automatically
- users may edit prefilled values
- updates in scoping should update the relevant downstream canonical fields according to explicit ownership rules
- downstream workflows should consume scoping values instead of asking for re-entry

### Field ownership and writeback

To avoid divergence between intake JSON and existing canonical records, fields must be grouped by ownership.

Deal-owned canonical fields:

- property name
- property address
- city/state
- rep ownership
- bid due date
- project type
- budget and bid context
- scope summary

Rule:

- intake edits to deal-owned fields write through to canonical deal fields on autosave

Company/contact-owned canonical fields:

- client/company identity
- primary contact identity and contact details

Rule:

- these values prefill into intake from the canonical company/contact records
- intake may store a snapshot for handoff context
- intake autosave must not silently overwrite company/contact records
- if the user edits a company/contact-owned field inside intake, the implementation must either:
  - open an explicit linked-record update path, or
  - store the edit as intake-only until the user confirms promotion

Intake-owned fields:

- scoping checklist answers
- completion state
- readiness diagnostics
- section-specific notes
- attachment requirement satisfaction state

Rule:

- these live only in the intake record and feed downstream automation/context

This same principle should later extend into:

- estimating handoff
- service handoff
- proposal generation support
- task context payloads
- Procore downstream synchronization

## Validation and Gate Rules

Validation should be rule-driven, not hardcoded in ad hoc UI conditionals.

Rule inputs:

- route
- project type
- section answers
- attachment presence
- existing deal metadata

Rule outputs:

- section complete/incomplete status
- field-level missing requirements
- blocking reasons for stage transition
- readiness label

When a workflow transition targets the next routed handoff:

1. load scoping intake
2. evaluate readiness rules
3. if incomplete, reject transition
4. return structured blocking requirements
5. deep-link the user back into the incomplete sections

For the current app:

- moving a deal into `estimating` must invoke this gate directly
- service-routed handoff actions must invoke the same gate before creating the next service workflow state or automation
- this gate is not bypassable for scoping completeness, regardless of user role

## Downstream Automation

After the intake is complete and the deal moves forward, the smart task engine should create the next operational workflow items.

### Domain events and dedupe contract

To fit the current event-driven task engine, intake workflow changes must emit explicit events.

Required events:

- `scoping_intake.ready`
- `scoping_intake.activated`
- `scoping_intake.reopened`
- `scoping_intake.attachment.added`

Rules:

- only `scoping_intake.activated` should trigger downstream estimating/service workflow task creation
- `scoping_intake.ready` may update UI state and notifications, but should not create duplicate handoff tasks
- if an activated intake is edited back into an incomplete state, emit `scoping_intake.reopened`
- task dedupe should include at minimum `deal_id`, canonical `workflow_route`, rule id, and workflow phase

### Estimating workflow automation targets

Derived from the estimating workflow artifact:

- estimator assignment
- estimator site visit follow-up
- missing information detection tasks
- request-for-information tasks
- internal scope review
- estimate review timers
- revision loops
- under-review reminders
- proposal-sent follow-up timers

### Service workflow automation targets

Derived from the service workflow artifact:

- service superintendent assignment
- estimate takeoff site visit follow-up
- proposal follow-up
- revision handling
- budget and prime contract preparation tasks
- purchase order and trade partner scheduling handoff tasks
- change-order process follow-up
- closeout and survey tasks

These should be generated from the smart task engine, using the intake as structured context.

## Relationship to Current Work

### Smart task engine

The smart task engine remains the correct foundation for:

- timers
- assignment
- waiting-on states
- blocked states
- follow-up sequences
- internal handoffs

It should not be the primary UI for intake completion.

### Procore work

The current Procore admin and reconciliation work is still valid, but it is downstream of the intake workspace.

Priority should shift to:

1. scoping intake data model and UI
2. gate enforcement for estimating-stage entry and service handoff activation
3. workflow automation from completed intake
4. Procore consumption of finalized handoff data

## API Shape

Expected endpoints:

- `GET /api/deals/:dealId/scoping-intake`
- `PATCH /api/deals/:dealId/scoping-intake`
- `POST /api/deals/:dealId/scoping-intake/attachments`
- `POST /api/deals/:dealId/scoping-intake/attachments/link-existing`
- `GET /api/deals/:dealId/scoping-intake/readiness`

Stage transition and service-handoff APIs must incorporate scoping gate evaluation rather than requiring a separate manual submit flow.

## Testing Requirements

### Server

- readiness rule evaluation by route and project type
- attachment-required validation
- stage-block behavior when intake is incomplete
- autosave patching behavior
- autopopulation from existing deal data
- downstream task generation payload correctness

### Client

- autosave interactions
- conditional section rendering
- readiness bar and missing-requirement display
- blocked stage progression UX
- file upload and existing-file linking behavior
- resume draft behavior

### Integration

- complete estimating handoff flow from deal to ready intake to automated tasks
- complete service handoff flow from deal to ready intake to automated tasks

## Rollout Recommendation

Implement this in phases:

1. add canonical `workflow_route` on deals plus intake data model and autosaved workspace
2. integrate intake with the existing deal file flow, including existing-file linking and category mapping
3. enforce the hard gate for estimating-stage entry and service handoff activation
4. add autopopulation refinement and canonical field propagation
5. trigger smart task automation from `scoping_intake.activated`

This sequencing preserves momentum from the task-engine work while correcting the product surface to match the actual business workflow.
