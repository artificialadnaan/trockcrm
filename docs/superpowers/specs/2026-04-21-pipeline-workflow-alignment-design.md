# Pipeline Workflow Alignment Design

**Date:** 2026-04-21  
**Status:** Draft for review  
**Scope:** Lead qualification, Opportunity conversion, dynamic Service vs Deals routing, gate requirements, and departmental ownership alignment

## Goal

Align the CRM pipeline model to the real operating workflow described in:

- `CRM Workflow_v5.2a_042126_.pdf`
- `Project Scoping Checklist COMPLETED.pdf`
- T Rock email guidance on qualification questions, Pre-Bid Meeting, and gated kanban stages

The system must reflect actual execution rather than a simplified sales-only view. It must produce:

- accurate pipeline tracking
- accurate forecasting
- cleaner handoffs into estimating, client services, and operations
- visible accountability by department without removing Sales visibility

## Confirmed Decisions

- `Lead` and `Deal` remain separate lifecycle records.
- A lead converts only after passing the lead go/no-go gate.
- Every converted lead becomes a `Deal` starting in `Opportunity`.
- `Opportunity` is the universal first stage of the deals side.
- Routing from `Opportunity` is dynamic:
  - below `$50k` routes to the `Service` pipeline
  - `$50k` and above routes to the `Deals` pipeline
- Routing can change later if the threshold amount changes.
- There are two authoritative routing review points:
  - early `Opportunity` review uses the sales-entered estimated opportunity value
  - post-bid review uses the returned estimate from Procore/Bid Board
- Sales owns lead stages and Opportunity.
- Estimating owns bid production after handoff, then returns ownership to Sales for client-facing proposal follow-up.
- Client Services owns service-routed work.
- Operations owns post-win execution and closeout.
- Sales must retain stage visibility across the full lifecycle.
- Lead qualification requires:
  - full front-end qualification
  - partial scoping subset before conversion
- Full scoping completion happens inside `Opportunity` before the record progresses deeper into either downstream pipeline.

## Current-State Gaps

The current repo baseline does not yet match the agreed workflow.

### 1. Lead workflow is under-modeled

Current seed data only provides lead stages equivalent to `Contacted` and `Converted`. There is no modeled path for:

- company pre-qualification
- scoping in progress
- pre-qual value assignment
- lead go/no-go review
- qualified-for-opportunity readiness
- structured disqualification categories

### 2. Lead stage gates do not exist

Lead stage movement currently validates stage identity only. It does not enforce:

- required qualification questions
- required scoping subset
- required estimated pre-qual value
- go/no-go rationale
- disqualification reason capture

### 3. Conversion boundary is too loose

The code converts a lead directly into a deal without enforcing the newly agreed `Qualified for Opportunity -> Opportunity` contract. The repo still carries older assumptions around crossing an RFP boundary instead of using an explicit internal qualification gate.

### 4. Lead UI still reflects old stage assumptions

Parts of the lead detail and badge UI still infer lead-vs-deal state from legacy deal stage concepts such as `dd` and `estimating`, rather than from a dedicated lead workflow.

### 5. Scoping enforcement is too narrow

The current scoping readiness rules only require a small subset of fields plus basic attachments. They do not yet reflect the actual qualification inputs or the Project Scoping Checklist.

### 6. Ownership model is incomplete

The current data model supports rep ownership and limited team-member roles such as estimator, but it does not yet express:

- Client Services ownership
- department-level handoff acceptance
- explicit responsibility shifts between Sales, Estimating, Client Services, and Operations

### 7. Stage taxonomy is misaligned with the workflow artifact

The baseline seeded deal stages are still closer to:

- `dd`
- `estimating`
- `bid_sent`
- `in_production`
- `close_out`

The workflow artifact requires a richer business model centered on:

- Lead qualification
- Opportunity
- Estimating / Proposal / Contract / Production / Close Out
- Service routing below threshold
- explicit review gates and re-routing opportunities

## Canonical Workflow Model

### Lifecycle hierarchy

The CRM must use the following lifecycle:

`Lead -> Deal(Opportunity) -> Deals pipeline or Service pipeline -> Production / Close Out`

Rules:

- `Lead` is the canonical pre-opportunity qualification record.
- `Deal` is the canonical post-qualification record.
- A lead never mutates into a deal in place.
- Conversion creates one successor deal linked to the source lead.
- The successor deal always starts in `Opportunity`.

### Pipeline architecture

There are three distinct workflow families:

- `Lead pipeline`
- `Deals pipeline`
- `Service pipeline`

`Opportunity` is the first stage on the deals side and acts as the branch-control stage before the record settles into one downstream pipeline.

### Dynamic threshold routing

Routing between downstream pipelines is not fixed at conversion time.

The system must support reclassification when the amount changes at either of these checkpoints:

1. `Opportunity Routing Review`
   - source of truth: sales-entered estimated opportunity value
2. `Post-Bid Routing Review`
   - source of truth: returned Procore/Bid Board estimate

Rules:

- if amount `< $50k`, route to `Service`
- if amount `>= $50k`, route to `Deals`
- if a later authoritative amount crosses the threshold, re-route the record to the correct pipeline
- every route change must be audited with reason, previous pipeline, new pipeline, value source, and changed-by user

## Stage Design

### Lead pipeline stages

Ordered lead stages:

1. `New`
2. `Company Pre-Qualified`
3. `Scoping In Progress`
4. `Pre-Qual Value Assigned`
5. `Lead Go/No-Go`
6. `Qualified for Opportunity`
7. `Disqualified`

### Opportunity stage

All converted leads enter `Opportunity`.

`Opportunity` includes:

- pre-bid meeting with estimator for scope clarification
- optional site-visit requirement and field verification
- full scoping completion
- early threshold routing review
- later post-bid threshold routing review

`Opportunity` is not skipped for either pipeline.

### Downstream pipelines

This design standardizes the branch point and gate model now. It does not force a complete downstream rename of every existing Service and Deals stage in the same change set.

Phase 1 alignment for this workflow work should:

- standardize the lead pipeline
- standardize `Opportunity`
- standardize the threshold routing engine
- preserve separate downstream `Deals` and `Service` stage families
- keep existing downstream stage families operational until their exact stage names are finalized with the operating team

For the standard deals side, the workflow artifact already supports the following business progression:

- `Opportunity`
- `Estimating`
- `Proposal Sent`
- `Contract Review`
- `Production`
- `Close Out`
- terminal outcomes

## Gate Design

### Lead qualification form

The lead kanban needs structured required fields and question groups, not just freeform notes.

Required qualification inputs:

- project location
- property information
- number of units
- who Sales is speaking with
- contact role
- budgeted vs not budgeted
- timing quarter or budget window
- project type
- scope summary and spec status
- project checklist started

Recommended canonical fields:

- `projectLocation`
- `propertyName`
- `propertyAddress`
- `propertyCity`
- `propertyState`
- `unitCount`
- `stakeholderName`
- `stakeholderRole`
- `budgetStatus`
- `budgetQuarter`
- `projectType`
- `scopeSummary`
- `specPackageStatus`
- `checklistStarted`

### Partial scoping subset required before conversion

Before a lead can move from `Lead Go/No-Go` into `Qualified for Opportunity`, it must also complete a minimum scoping subset derived from the Project Scoping Checklist:

- project overview
- property details
- scope summary
- budget and bid context
- initial quantities known at qualification time
- decision maker and decision timeline
- initial notes on logistics or observed blockers if already known

This subset should be fast enough for Sales to complete without requiring the full downstream scoping package.

### Full scoping required inside Opportunity

Before a record can progress from `Opportunity` into deeper `Deals` or `Service` execution, the full scoping workspace must be complete.

Required sections should reflect the checklist with conditional logic:

- Project Overview
- Property Details
- Project Scope Summary
- Interior Unit Renovation Scope when applicable
- Exterior Scope when applicable
- Amenities / Site Improvements when applicable
- Quantities
- Site Logistics
- Site Conditions Observed
- Materials / Specifications
- Attachments Provided

Required attachments at minimum:

- scope documents
- site photos

The downstream team-specific checklist may add tighter requirements, but the base opportunity handoff cannot be lighter than this standard.

### Gate mapping by lead stage

`New -> Company Pre-Qualified`

- company identified
- property identified
- source captured
- initial contact identified

`Company Pre-Qualified -> Scoping In Progress`

- company pre-qual decision recorded
- existing customer vs new customer recorded
- active project within 12 months recorded where applicable
- disqualification reason required if failed

`Scoping In Progress -> Pre-Qual Value Assigned`

- base qualification fields complete
- partial scoping subset started

`Pre-Qual Value Assigned -> Lead Go/No-Go`

- estimated pre-qual value entered

`Lead Go/No-Go -> Qualified for Opportunity`

- go/no-go decision recorded
- rationale recorded
- partial scoping subset complete

`Any stage -> Disqualified`

- disqualification reason required
- disqualification notes required when reason is `other` or ambiguous

### Opportunity review gates

`Opportunity` must expose two explicit routing review events:

1. `Early Routing Review`
   - value source: sales estimated opportunity value
   - may route to Service early if `< $50k`
2. `Post-Bid Routing Review`
   - value source: Procore/Bid Board estimate
   - may re-route to Deals if estimate crosses above threshold
   - may re-route to Service if a value falls below threshold

The system should not treat routing as a one-time irreversible decision.

## Ownership And Handoffs

### Accountability by phase

- Lead pipeline: `Sales`
- Opportunity: `Sales`
- Pre-Bid Meeting: `Sales accountable`, `Estimating consulted`
- Deals pipeline bid production: `Estimating`
- Proposal follow-up after estimating completion: `Sales`
- Service pipeline after route assignment: `Client Services`
- Production and Close Out: `Operations`

### Visibility rule

Sales must retain visibility across the full lifecycle even when another department becomes accountable.

This means:

- Sales can see current stage and owner at all times
- Sales can see task, handoff, and history context
- Sales does not lose read access after handoff
- visibility does not imply edit authority

### Handoff requirements

Each cross-department handoff should create a durable handoff record or audit event containing:

- from department
- to department
- effective owner
- handoff timestamp
- triggering gate or stage
- required next action
- accepted vs pending status when applicable

Minimum handoff transitions:

- Sales -> Estimating
- Estimating -> Sales
- Opportunity -> Client Services
- Contract/Won -> Operations

## Data Model Direction

### Lead-side additions

The lead record needs structured qualification data rather than relying on freeform description only.

Recommended additions:

- lead qualification payload
- lead scoping-subset payload
- go/no-go decision and rationale
- disqualification reason and notes
- pre-qual estimated value

### Deal-side additions

Recommended deal-side additions or refinements:

- explicit `Opportunity` stage in the deals-side families
- pipeline classification state separate from general workflow route semantics
- routing review history with threshold source
- authoritative early opportunity value field if distinct from existing estimate fields
- authoritative post-bid routing source reference

### Ownership additions

The system should introduce first-class department ownership concepts or extend team roles to include at minimum:

- `client_services`
- `operations`

If role expansion is not enough, a separate handoff / departmental ownership table should become the source of truth for current accountable department.

## UX Direction

### Lead kanban

The lead page should become the operational lead board the user described:

- kanban by lead stage
- gated movement between stages
- stage-level checklist modal or side panel before advance
- visible missing requirements
- disqualification capture inline when routed out

### Lead forms

The lead form should be stage-aware and sectioned:

- Qualification
- Contact / Stakeholder
- Budget / Timing
- Scope Summary
- Partial Scoping
- Go/No-Go

### Opportunity workspace

The deal-side opportunity view should combine:

- full scoping workspace
- pre-bid meeting capture
- site-visit requirement tracking
- threshold routing controls
- audit-visible route changes

## Reporting And Forecasting Rules

To keep forecasting clean:

- leads must report separately from deals and service work
- `Opportunity` belongs to deals-side reporting, not lead reporting
- Service and Deals pipelines must roll up separately and together
- route changes must update forecast buckets without duplicating records
- reports must show current pipeline plus route-change history when needed

## Implementation Boundary For The Next Plan

The next implementation plan should focus on:

1. lead pipeline stage expansion
2. lead-stage gate engine and required lead forms
3. conversion contract update to always create a deal in `Opportunity`
4. threshold-routing engine with two review points
5. Sales visibility across downstream lifecycle
6. ownership and handoff modeling upgrades
7. scoping gate expansion from partial lead subset to full Opportunity readiness

The next implementation plan should not assume that every downstream Service stage name is finalized yet. The branch point, routing engine, and gate semantics are the priority alignment work.
