# T Rock CRM HubSpot Replacement Scope Expansion Design

**Date:** 2026-04-15
**Status:** Draft for review
**Scope:** Additional Phase 1 requirements and Phase 2 follow-ons identified from sales/workflow review meeting

## Goal

Refine the existing T Rock CRM design so Phase 1 fully replaces HubSpot with the workflow corrections discussed in the meeting, while capturing operational optimizations from the same discussion as explicit Phase 2 requirements.

This scope expansion keeps the existing CRM architecture, but tightens the business model in five areas:

- canonical record hierarchy
- pre-RFP lead workflow
- split post-RFP pipelines
- first-class activity attribution
- safe email categorization across shared company/contact relationships

## Launch Boundary

### Phase 1: Required for HubSpot replacement by May 15, 2026

- canonical `company -> property -> lead -> deal` hierarchy
- lead pipeline for pre-RFP workflow
- separate `service` and `standard` deal pipelines
- consolidated reporting across lead, service, and standard workflows
- deterministic activity tracking at company, property, lead, and deal levels
- deterministic email-to-entity categorization with ambiguity handling
- scoping and estimating handoff enforcement
- revision routing back into estimating
- migration exception handling for incomplete or ambiguous HubSpot history

### Phase 2: Operational optimizations from the meeting

- AI activity summaries and feedback tuning
- rep goals, targets, and motivational UI
- trade-show / source ROI reporting enhancements
- richer mobile and road-warrior workflow actions
- deeper CRM-originated estimate send flows
- more advanced workflow automation controls

## Canonical Data Model

### Core entities

- `company`
- `property`
- `lead`
- `deal`
- `contact`
- `activity`
- `task`
- `email_thread`
- `email_message`

### Canonical hierarchy

The CRM should treat the hierarchy as:

`company -> property -> lead -> deal`

Rules:

- a company can have many properties
- a property can have many leads over time
- a lead is the canonical pre-RFP record
- a deal is the canonical post-RFP record
- "project" is business-language aliasing for a deal, not a separate domain entity
- contacts can attach at company, property, lead, and deal levels

### Why this hierarchy is required

The meeting exposed that current workflow and reporting break down when:

- one company has many properties
- one property has multiple opportunities over time
- one contact is involved in multiple jobs
- pre-RFP activity is not carried forward into the post-RFP view

This hierarchy fixes those boundaries without introducing a generic platform abstraction.

## Workflow Architecture

### Recommended approach

Build a bounded workflow engine on top of the normalized CRM core.

The CRM core owns the records and relationships. The workflow layer owns:

- stage definitions
- entry and exit requirements
- stale thresholds
- task triggers
- ownership and reassignment rules
- routing between sales, estimating, and service
- reminder and escalation behavior

This is not an open-ended no-code workflow builder in Phase 1.

## Phase 1 Workflow Requirements

### 1. Lead pipeline

The CRM must add a first-class lead pipeline for pre-RFP work.

Requirements:

- leads exist before deals
- lead stages are configurable in an admin-safe way
- stale lead rules generate follow-up tasks automatically
- lead ownership, touchpoint recency, and source attribution are reportable
- lead activity remains visible after conversion into a deal

### 2. Split deal pipelines

The CRM must support:

- `standard` deal pipeline
- `service` deal pipeline

Requirements:

- each pipeline has its own stage configuration and stale thresholds
- reporting rolls up both cleanly into one management view
- pipeline totals and definitions use canonical CRM-owned semantics, not ad hoc spreadsheet logic

### 3. Estimating handoff gating

The CRM must enforce that:

- scoping/intake is complete before a deal can enter estimating
- the required fields, attachments, and approvals are machine-validated
- estimating-stage entry is blocked with structured missing-requirement feedback

### 4. Revision routing

The CRM must support estimate revision flow as a first-class workflow path.

Requirements:

- sales can send a deal back for revisions
- that action creates a visible task trail
- estimating regains ownership or explicit awareness of the revision request
- revision movement is reportable and audit-visible

This does not require a fully separate revision entity in Phase 1, but it does require deterministic workflow behavior rather than informal side-channel communication.

## Activity Model

Activity must become a first-class timeline system.

### Activity types

- `email`
- `call`
- `meeting`
- `note`
- `task_event`
- `stage_change`
- `approval`
- `system_event`

### Attribution rules

Each activity has:

- one canonical stored source entity
- optional linked entities for roll-up visibility

Activities must be viewable by:

- company
- property
- lead
- deal
- salesperson / owner

### Historical continuity

Lead history must not disappear after conversion.

Requirements:

- deal views surface relevant pre-RFP lead activity
- company and property timelines roll up all related history across multiple leads and deals
- rep activity reporting can distinguish lead-stage work from deal-stage work

### Call logging

Phase 1 must support manual call logging with:

- timestamp
- participants
- notes
- linked CRM entities
- owner attribution

If phone systems are not integrated, workflow reminders and stale rules must compensate for missing auto-capture rather than pretending call completeness exists.

## Email Categorization

### Problem to solve

One customer email address may be associated with:

- multiple properties
- multiple leads
- multiple active deals

The CRM cannot guess incorrectly and silently misfile history.

### Categorization order

The system should attempt assignment in this order:

1. explicit project/deal number in subject, body, or normalized extracted metadata
2. prior thread assignment
3. exactly one active linked lead or deal for the participants
4. exactly one active property-linked opportunity match
5. fallback to company-only association

### Ambiguity handling

If the system cannot confidently match a single lead or deal:

- attach the email to the company only
- create a task for the assigned salesperson to classify it
- store the ambiguity reason for audit and operational queue reporting

This rule is required for safe Microsoft Graph email ingestion at launch.

## Reporting Requirements

### Unified management reporting

Reporting must reconcile:

- lead pipeline
- standard deal pipeline
- service deal pipeline

### Required Phase 1 reporting surfaces

- company rollups across properties, leads, and deals
- activity by rep
- activity by company
- activity by property
- activity by lead
- activity by deal
- lead-to-deal conversion
- stale leads
- stale deals
- service versus standard pipeline comparison
- estimating handoff and revision visibility
- win/loss/cancel reporting with consistent status definitions

### Metric governance

Every management-facing metric must have one canonical definition in the CRM.

This is necessary to eliminate the meeting's current-state problem where sales and estimating derive different numbers from different systems and stage interpretations.

## Migration Requirements

### Guiding rule

HubSpot history should be migrated conservatively.

If historical attribution is incomplete or ambiguous, the system should:

- preserve the record
- flag the confidence level
- route the record into review or exception handling

The system should not fabricate history or silently attach data to the wrong deal.

### Required protections

- migration confidence flags
- exception buckets for ambiguous historical emails and activities
- review workflow for unresolved imports
- reporting distinction between migrated historical data and new in-CRM activity when needed

## Recommended Implementation Shape

### Data model additions or refinements

- first-class `properties` table tied to `companies`
- first-class `leads` table and lead-stage configuration
- `deals.workflow_pipeline` or equivalent canonical pipeline discriminator (`standard`, `service`)
- polymorphic or link-table-based `activities` association model
- email assignment state fields for confidence, ambiguity reason, and manual-resolution status

### Workflow configuration surfaces

- lead stage config
- standard deal stage config
- service deal stage config
- stale thresholds
- required field / document / approval lists
- revision routing rules
- inactivity task triggers

### UX additions

- company timeline
- property timeline
- lead workspace
- ambiguous email assignment queue
- consolidated cross-pipeline reporting views

## Phase 2 Requirements From Meeting

- AI-generated activity summaries with user feedback loop
- rep goals and progress indicators
- trade-show and lead-source ROI intelligence
- better mobile-first actions for sales reps in the field
- CRM-native estimate-send actions that update workflow state automatically
- deeper estimating revision workflow if basic routing is insufficient
- more advanced cross-office workflow reuse controls

## Recommendation

Implement this as a normalized CRM core plus bounded workflow engine.

Do not attempt a fully generic workflow platform before launch.

That approach:

- fixes the actual data and attribution problems raised in the meeting
- keeps launch-critical scope aligned to HubSpot replacement
- preserves a clean extension point for later workflow generalization
