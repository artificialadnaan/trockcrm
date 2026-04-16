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
- a lead converts by creating one successor deal record; the lead is never mutated into a deal
- each deal must store `source_lead_id` to preserve the conversion chain and reporting lineage
- a lead may convert at most once; if a post-RFP effort is abandoned and restarted later, that creates a new lead and potentially a new successor deal
- "project" is business-language aliasing for a deal, not a separate domain entity
- contacts can attach at company, property, lead, and deal levels

### Lead-to-deal conversion contract

Conversion from lead to deal is a record-creation event, not an in-place type change.

Requirements:

- conversion occurs when the opportunity crosses the RFP boundary into post-RFP workflow
- the lead remains as a historical pre-RFP record
- the new deal inherits company, property, contact links, owner context, and source metadata from the lead at conversion time
- the deal must retain a durable reference to the originating lead for reporting, audit, and timeline continuity
- pre-RFP lead activities remain stored against the lead, but become visible from the successor deal through linked timeline rollups
- ownership defaults to the converted lead owner unless reassigned during or immediately after conversion

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

Canonical Phase 1 gate categories:

- required core fields
- required scoping sections
- required attachments
- required approvals

Minimum launch gate contract:

- required core fields: company, property, assigned rep, workflow pipeline, project type, expected value or explicit “value pending”, and source lead linkage
- required scoping sections: project overview, property details, scope summary, relevant scope sections by route, site logistics, and observed site conditions
- required attachments: the selected route must satisfy every attachment category marked as required in pipeline configuration; each required category passes only when at least one verified uploaded file is linked to the intake in that category
- required approvals: route-specific approval roles defined in pipeline configuration

Pipeline-specific override rules:

- `standard` and `service` pipelines may have different required sections, attachment categories, and approval roles
- route-specific overrides may only tighten the gate, not remove the global minimum launch contract
- admin configuration must render the effective gate definition visible in-product so sales, estimating, and directors are reading the same checklist

Attachment validation contract:

- attachment categories come from the canonical CRM file taxonomy, not freeform labels
- the gate evaluates category presence, not arbitrary file counts beyond the minimum of one verified file per required category
- a file only counts after upload verification and successful link to the intake/deal record
- replacing a file preserves category satisfaction as long as one verified file remains linked in the required category

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
- one mandatory `responsible_user_id` used for attribution and reporting
- one optional `performed_by_user_id` when the actor differs from the responsible owner

Rep attribution rules:

- every activity must resolve to a responsible rep or owner at write time
- manually created activities use the selected owner or, if omitted, the current record owner
- synced emails attribute responsibility to the owning salesperson of the matched lead/deal or, for company-only fallback, the owning salesperson responsible for classification
- meetings, approvals, and notes inherit the primary record owner unless an explicit responsible user is selected
- system events and automations must still write a `responsible_user_id` based on the affected record owner so `activity by rep` reporting is complete

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
- lead conversion must not duplicate historical activities into the deal record; continuity is achieved through linked visibility, not copy-on-convert

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
3. exactly one active matched deal for the participants
4. exactly one active matched lead for the participants, but only if no active deal match exists
5. exactly one active lead or deal under a uniquely matched property for the participants
6. fallback to company-only association

Tie-breaking rules:

- active deal matches outrank active lead matches because deal is the post-RFP canonical record
- if more than one active deal matches, treat the message as ambiguous
- if no deal matches and more than one active lead matches, treat the message as ambiguous
- the property-linked tier only applies when the email can be linked to exactly one property and that property has exactly one active lead-or-deal candidate
- if more than one active lead-or-deal candidate exists under that property, treat the message as ambiguous
- ambiguity must not be resolved by “most recent” heuristics in Phase 1 unless the prior thread is already assigned

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
- exception buckets for ambiguous historical companies, properties, contacts, leads, deals, emails, and activities
- review workflow for unresolved imports
- reporting distinction between migrated historical data and new in-CRM activity when needed

Required migration exception buckets:

- unknown company match
- ambiguous property match
- ambiguous contact match
- lead-versus-deal association conflict
- ambiguous deal association
- ambiguous email/activity attribution
- missing owner assignment

Promotion rule:

- records in exception buckets may be imported into staging and surfaced for review, but they must not be silently promoted into canonical linked CRM records until resolved or explicitly accepted with a documented fallback association

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

## Implementation Notes

The Phase 1 implementation that landed on this branch follows the design above, with a few explicit product decisions worth documenting:

- lead and property detail pages are first-class URLs, but the current property surface is synthesized from deal-linked property data rather than a standalone property aggregate
- property rollups are currently client-assisted over a bounded deal fetch, so historical counts are only as complete as the underlying deal history window
- the property `Converted` metric is a stage-derived proxy for historical lead-to-deal conversion, not an audit-grade lineage metric
- unified workflow reporting uses `deal_scoping_intake.activated_at` to split lead-stage and deal-stage rep activity
- the email assignment queue is deal-only for manual association; lead and property categorization are resolved automatically and ambiguous emails fall back to company-level association plus a classification task
- migration review now includes unresolved company, property, and lead rows with paging and visible approval failure feedback
- lead conversion preserves timeline continuity by linking the successor deal back to the originating lead instead of duplicating historical activities
