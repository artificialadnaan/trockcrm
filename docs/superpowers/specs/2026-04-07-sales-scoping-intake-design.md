# Sales Scoping Intake Design

**Date:** 2026-04-07
**Status:** Draft for review
**Scope:** Sales-to-estimating and sales-to-service intake workflow, gating, autosave, autopopulation, and downstream automation

## Goal

Replace the static project scoping checklist with a first-class in-app intake workspace on each deal so sales can capture information once, attach the required files directly, and move deals into `estimating` or `service` only when the intake is complete.

The system must optimize for:

- minimal sales data entry
- high-usability, sectioned workflow UI
- continuous autosave with resume support
- deterministic stage-gate enforcement
- downstream automation into estimating and service workflows

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

A deal cannot move into `estimating` or `service` until all required intake sections are complete.

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

Director and admin users act as override roles for correction, cleanup, and emergency progression support, but the workflow should still prefer normal rep ownership.

## Workflow Model

The intake is one unified form with conditional sections rather than separate estimating and service forms.

The route and project type determine which sections are shown, which fields are required, and which downstream automation runs.

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

## Data Model

Add a first-class scoping intake record linked to each deal.

Recommended model:

- `deal_scoping_intake`
  - `id`
  - `deal_id`
  - `office_id`
  - `route` (`estimating` or `service`)
  - `project_type`
  - `status` (`draft`, `ready`, `submitted`)
  - `section_data`
  - `completion_state`
  - `readiness_errors`
  - `last_autosaved_at`
  - `completed_at`
  - `submitted_at`
  - `created_by`
  - `last_edited_by`
  - timestamps

Implementation note:

- `section_data` may start as structured JSON to move faster
- `completion_state` should be machine-readable by section and field
- `readiness_errors` should be deterministic and generated, not freeform

Files should continue to live in the main deal file system, but with additional linkage metadata:

- intake section association
- intake-required marker
- source of upload (`deal_general` vs `scoping_intake`)

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
- updates in scoping should update the relevant downstream canonical fields where appropriate
- downstream workflows should consume scoping values instead of asking for re-entry

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

When a stage transition targets `estimating` or `service`:

1. load scoping intake
2. evaluate readiness rules
3. if incomplete, reject transition
4. return structured blocking requirements
5. deep-link the user back into the incomplete sections

## Downstream Automation

After the intake is complete and the deal moves forward, the smart task engine should create the next operational workflow items.

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
2. gate enforcement into estimating/service
3. workflow automation from completed intake
4. Procore consumption of finalized handoff data

## API Shape

Expected endpoints:

- `GET /api/deals/:dealId/scoping-intake`
- `PATCH /api/deals/:dealId/scoping-intake`
- `POST /api/deals/:dealId/scoping-intake/attachments`
- `POST /api/deals/:dealId/scoping-intake/attachments/link-existing`
- `GET /api/deals/:dealId/scoping-intake/readiness`

Stage transition APIs must incorporate scoping gate evaluation rather than requiring a separate manual submit flow.

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

1. data model and autosaved intake workspace
2. hard gate enforcement for `estimating` and `service`
3. direct file upload and existing attachment reuse
4. autopopulation refinement and canonical field propagation
5. smart task automation driven by completed intake

This sequencing preserves momentum from the task-engine work while correcting the product surface to match the actual business workflow.
