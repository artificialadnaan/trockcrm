# T Rock CRM Sales Operating Rhythm Design

**Date:** 2026-04-20  
**Status:** Draft for review  
**Scope:** Sales forecast discipline, structured activity expansion, weekly sales review workspace, and data hygiene workflow built on the existing CRM platform

## Goal

Turn the current CRM foundations into a usable sales operating system for weekly management, rep accountability, and pipeline hygiene without creating a second tracker outside the platform.

This design addresses the gaps surfaced in the sales meeting:

- inconsistent rep updates
- unclear `30/60/90` forecast discipline
- incomplete and non-standardized activity logging
- poor data hygiene and stale stages
- weak visibility into next steps, support needs, and rep cadence

The solution should reuse the current `company -> property -> lead -> deal` model, dashboards, reports, and stage-gate architecture wherever possible, then add the missing operating layer on top.

## Non-Goals

- replacing the existing hierarchy or workflow engine
- building a no-code CRM builder
- rebuilding reports that already exist and are directionally correct
- introducing a second spreadsheet-style sales tracker
- solving every downstream estimating or operations workflow in this phase

## Existing Foundation To Reuse

The following capabilities already exist and should remain the base of this work:

- typed CRM hierarchy across companies, properties, leads, deals, contacts, and activities
- rep and director dashboards
- weighted forecast and pipeline reporting
- stale lead and stale deal reporting
- stage config and stage-gate enforcement
- activity logging with core activity types
- automated task generation for stale work and follow-up cadence

This project extends those systems. It does not replace them.

## Launch Boundary

### Phase 1: required for sales operating rhythm

- active-record `30/60/90` forecast model with rep rollups across leads and deals
- expanded structured sales activity model
- prominent next-step and support-needed capture on leads and deals
- weekly sales review workspace
- sales data hygiene queue with actionable missing/stale checks
- stage taxonomy alignment for the sales-facing workflow

### Phase 2: follow-on improvements

- AI-generated meeting summaries and suggested next steps
- automated digest emails or Slack summaries
- travel planning and calendar-linked field scheduling
- coaching analytics and rep trend scoring
- configurable forecast scenarios beyond `commit` and `best_case`

## Recommended Approach

### Option 1: Recommended

Add a sales-operations layer on top of the current CRM.

This keeps the existing entity model and reporting contracts, extends the missing fields and activity types, and introduces a new weekly review surface that reads from canonical CRM data.

Why this is the right approach:

- avoids duplicate sources of truth
- ships faster because hierarchy and reporting already exist
- fixes the actual operating problem instead of adding another tracker
- makes the later AI/reporting work much easier

### Option 2: Separate sales-review module with sync

Build a meeting-focused module that copies forecast and activity data into its own review records.

Trade-off:

- easier to prototype quickly
- much higher risk of divergence from deals and activities
- repeats the HubSpot-plus-spreadsheet problem in a new form

### Option 3: Reporting-only patch

Add a few reports and call it done.

Trade-off:

- cheapest short-term
- does not solve rep update consistency, qualification discipline, or data hygiene
- leadership still ends up asking manual follow-up questions in meetings

## Recommended Design

Build four tightly-related capabilities:

1. forecast discipline
2. richer structured sales activities
3. weekly sales review workspace
4. hygiene queue and stage-alignment enforcement

These should be implemented as focused extensions to leads, deals, activities, reporting, and dashboards.

## Capability 1: Forecast Discipline

### Requirements

Each lead or deal that is still in active pipeline must support forecast fields that make weekly review deterministic.

Minimum fields:

- `forecastWindow`: `30_days`, `60_days`, `90_days`, `beyond_90`, `uncommitted`
- `forecastCategory`: `commit`, `best_case`, `pipeline`
- `forecastConfidencePercent`: integer `0-100`
- `forecastRevenue`: currency
- `forecastGrossProfit`: currency, nullable when unknown
- `forecastBlockers`: free text summary
- `nextMilestoneAt`: date
- `forecastUpdatedAt`
- `forecastUpdatedBy`

### Scope Rules

- Forecast fields should live on the active selling record, which in the current model means leads for pre-RFP work and deals for post-RFP work.
- Reporting must roll up both lead and deal forecasts into one management view without losing workflow distinctions.
- The system must support per-rep and team-level `30/60/90` rollups.

### Product Rules

- A record cannot be counted in `30`, `60`, or `90` view without a `nextMilestoneAt`.
- A record in `commit` must have `forecastConfidencePercent >= 70`.
- Stale forecast data should be flagged when forecast fields have not been refreshed in the configured threshold.
- Weighted forecast reports should continue to exist, but the weekly review workspace should prefer explicit forecast windows and categories over implicit weighting alone.

## Capability 2: Structured Sales Activities

### Requirements

The current activity model must be extended to better match actual sales motion.

Additional activity types:

- `voicemail`
- `lunch`
- `site_visit`
- `proposal_sent`
- `redline_review`
- `go_no_go`
- `follow_up`
- `support_request`

Every logged sales activity must support:

- canonical linked entity
- responsible user
- occurred-at timestamp
- short summary
- outcome
- optional next-step text
- optional next-step due date

### Product Rules

- The activity feed should distinguish interaction types without overloading plain notes.
- `proposal_sent`, `go_no_go`, and `redline_review` should be visible in timelines and available to reporting.
- Next-step capture should be optional at the activity level but strongly encouraged in the UI.

### Why This Is Needed

The meeting makes clear that the current problem is not absence of notes, but lack of structured, reportable activity semantics. This work must keep logging simple while making activity data usable for management and later AI workflows.

## Capability 3: Weekly Sales Review Workspace

### Purpose

The weekly sales meeting should run from the CRM using one standardized view instead of verbal updates plus spreadsheets.

### Top-Level Structure

The workspace should support:

- team view
- per-rep view
- manager drill-down into a specific record

### Access Rules

- reps can view their own forecast, activity cadence, support requests, and hygiene items
- directors and admins can view team rollups plus per-rep drill-down
- the route and payload must enforce these role boundaries server-side, not only in navigation

### Required Sections

#### 1. New opportunities

Show new leads and deals created in the last `14` days, grouped by rep.

#### 2. `30/60/90` forecast

Show active forecasted records by rep and by forecast bucket with:

- company / property / record name
- stage
- forecast category
- revenue
- gross profit
- blockers
- next milestone date

#### 3. Activity cadence

Show last `7`, `14`, and `30` day activity counts by rep:

- calls
- emails
- meetings
- lunches
- site visits
- proposals sent
- follow-ups

#### 4. Stale and missing items

Show records with:

- stale stage
- no recent activity
- missing forecast fields
- missing decision-support fields
- overdue next step

#### 5. Support requests

Show records where the rep has flagged support needed from:

- leadership
- estimating
- operations
- executive team

### Standard Meeting Row Contract

Each forecasted record in the review workspace should expose the same summary shape:

- what it is
- current stage
- close window
- confidence/category
- commercial value
- blocker
- next step
- support needed

This is the main fix for the “everybody updates differently” problem in the transcript.

## Capability 4: Data Hygiene Queue

### Purpose

Create an actionable cleanup queue instead of relying on vague instructions to “scrub the data.”

### Required Queue Checks

- stage stale beyond configured threshold
- no activity in configured window
- missing forecast window/category/confidence
- missing next milestone date
- missing linked company or property where required
- missing decision-maker or commercial qualification fields
- active records with no next step
- dead or lost records still marked as active pipeline

### Queue Behavior

- reps should see their own hygiene queue
- managers should see team rollups
- each row should explain exactly what is missing or stale
- queue actions should deep-link into the relevant record and section

## Data Model Extensions

### Lead and Deal Fields

Add the following shared operating fields to leads and deals where appropriate:

- `forecastWindow`
- `forecastCategory`
- `forecastConfidencePercent`
- `forecastRevenue`
- `forecastGrossProfit`
- `forecastBlockers`
- `nextStep`
- `nextStepDueAt`
- `nextMilestoneAt`
- `supportNeededType`
- `supportNeededNotes`
- `forecastUpdatedAt`
- `forecastUpdatedBy`

### Qualification Fields

Add first-class qualification fields rather than burying them in notes:

- `decisionMakerName`
- `decisionProcess`
- `budgetStatus`
- `incumbentVendor`
- `unitCount`
- `buildYear`

These fields should be required progressively by stage and surfaced in the hygiene queue.

## Sales Stage Taxonomy Alignment

The existing workflow engine should be aligned to the sales language used in management review.

Target stages should cover at least:

- `lead`
- `qualified_lead`
- `opportunity`
- `go_no_go`
- `estimating`
- `proposal_sent`
- `awaiting_decision`
- `closed_won`
- `closed_lost`
- `unqualified`

This does not require a new engine. It requires an explicit sales-facing stage contract and exit criteria.

## Reporting Requirements

The existing report system should be extended, not replaced.

Required additions:

- rep `30/60/90` forecast summary
- team `30/60/90` forecast summary
- new opportunities in last `14` days
- expanded activity-by-rep with new activity types
- hygiene summary counts by rep
- support-needed rollup

Existing weighted forecast, stale record, and pipeline summary reports should continue to operate and should be updated to include the new forecast fields where relevant.

## UX Requirements

- Reps must be able to update forecast and next-step fields from lead and deal detail pages without navigating to a separate admin screen.
- Weekly review screens must read as operational, not analytical; they should prioritize scan speed and consistent row structure over dense charts.
- Activity logging should stay fast. Expanding structure must not turn a call log into a long form.
- Hygiene queue items must be understandable without training documentation.
- navigation must expose the weekly review workspace and hygiene queue in the existing app shell without creating duplicate entry points that confuse reps versus managers

## Error Handling And Guardrails

- Invalid forecast combinations should fail with explicit field-level messages.
- Records missing required stage-exit fields should not advance.
- Reports must tolerate partial gross-profit data without breaking totals; null profit should remain visible as unknown, not zero.
- Hygiene checks should be deterministic and auditable.

## Testing Requirements

### Server

- forecast rollup queries across leads and deals
- hygiene queue rule evaluation
- stage-exit enforcement with qualification and forecast requirements
- activity logging with new activity types

### Client

- lead and deal forms for forecast + next step capture
- sales review workspace rendering and filtering
- hygiene queue row actions and deep links
- activity logging UX for new structured activity types

### Product Verification

- a manager can run a weekly meeting from the CRM without a spreadsheet
- a rep can update forecast, blocker, next step, and support request in one place
- stale or incomplete records become obvious without manual auditing

## Rollout Recommendation

Build this in four slices:

1. forecast fields and rollups
2. structured activity expansion
3. weekly sales review workspace
4. hygiene queue and stage enforcement

That sequence gives leadership value quickly, then tightens data quality only after the surfaces exist to support the workflow.
