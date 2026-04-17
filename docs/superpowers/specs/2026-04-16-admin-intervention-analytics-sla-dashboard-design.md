# T Rock CRM Admin Intervention Analytics and SLA Dashboard Design

**Date:** 2026-04-16  
**Status:** Draft for review  
**Scope:** Manager-first analytics and SLA oversight for admin intervention cases

## Goal

Add a dedicated admin page that shows whether the intervention system is actually working.

The page should help office managers and directors answer:

- which intervention cases are breaching response expectations
- which disconnect types are reopening or staying unresolved
- which assignees or teams are carrying the most aging load
- whether intervention actions are clearing issues or just moving them around
- where leadership attention is required right now

This phase builds on the existing intervention workspace and disconnect dashboard. It does not replace them.

## Canonical Surface Boundary

This design introduces one new read-first management surface:

- `/admin/intervention-analytics`

The current surfaces keep distinct roles:

- `/admin/sales-process-disconnects`
  - office-level diagnostic dashboard
  - optimized for disconnect detection, narratives, trends, and automation
- `/admin/interventions`
  - canonical writable queue
  - optimized for case assignment, snooze, resolve, escalate, and direct execution
- `/admin/intervention-analytics`
  - manager oversight and SLA page
  - optimized for health, aging, breach analysis, and outcome measurement

Navigation rule:

- users discover process failures on `/admin/sales-process-disconnects`
- users act on individual cases in `/admin/interventions`
- managers review system health and priority breaches on `/admin/intervention-analytics`

The analytics page should link into filtered `/admin/interventions` views. It should not duplicate case mutation controls.

Important implementation rule:

- this slice is allowed to extend the `/admin/interventions` query contract where needed for analytics-driven deep links
- analytics must not rely on the existing `aging` view semantics if those semantics do not match SLA logic

## Why This Is Next

The current admin-first AI stack already provides:

- deterministic disconnect detection
- clustered disconnect reporting
- intervention queueing
- batch and detail actions
- outcome-aware action summaries
- digest and escalation automation

The remaining gap is management control.

Right now the system can surface and mutate intervention cases, but leadership still lacks a clear answer to:

- are cases being cleared on time
- are reopen rates improving
- are escalations being handled
- are some assignees or disconnect families chronically late

That makes the system operational, but not yet measurable.

The highest-value next step is therefore a manager-first analytics and SLA dashboard.

## Approaches Considered

### 1. Add analytics cards directly to `/admin/interventions`

**Pros**

- fastest UI path
- keeps analytics close to the writable queue
- fewer routes

**Cons**

- crowds the operator workspace
- weak separation between execution and oversight
- makes the page too broad for everyday office staff

### 2. Expand `/admin/sales-process-disconnects` to include SLA analytics

**Pros**

- keeps all read-first management views together
- builds on an existing admin dashboard

**Cons**

- mixes disconnect discovery with intervention performance
- makes the disconnect page too overloaded
- blurs the separation between “what is broken” and “how the intervention system is performing”

### 3. Create a separate intervention analytics and SLA page

**Pros**

- clean boundary between detection, execution, and oversight
- easier to present in a manager workflow
- scales better for more analytics later

**Cons**

- one more navigation destination
- requires explicit cross-links from the other admin pages

## Recommendation

Build a separate page at `/admin/intervention-analytics`.

Design rules:

- read-first page
- no direct case mutations from this surface in v1
- every actionable metric should link into a filtered `/admin/interventions` queue
- SLA logic remains deterministic and fully explainable
- no model-generated scoring or fuzzy risk weights in the SLA layer

## Product Outcome

V1 of the analytics and SLA dashboard should let leadership do five things:

### 1. See SLA health immediately

Show:

- total open intervention cases
- open cases by severity
- overdue cases by severity
- snoozed cases past due
- unresolved escalations

### 2. Understand whether interventions are working

Show:

- clearance rate
- reopen rate
- average age to resolution
- median age of open cases
- intervention action mix

### 3. Find the biggest hotspots

Show:

- top assignees by open load
- top assignees by overdue load
- top disconnect types by open count
- top disconnect types by reopen count
- top reps / companies / stages contributing to intervention volume

### 4. Review the actual breach queue

Show a manager-priority list of:

- critical cases overdue now
- escalated cases still open
- snoozes that have expired
- repeat cases with at least one reopen event

### 5. Jump directly into action

Every major section should link into `/admin/interventions` with a matching filter:

- `view=escalated`
- `view=overdue`
- `view=snooze-breached`
- `view=repeat`
- specific `clusterKey`
- optional source filters such as rep, company, or stage when the linked section requires them

## Deterministic SLA Model

V1 should use static thresholds based on severity.

Recommended thresholds:

- `critical`: same business day
- `high`: 2 business days
- `medium`: 5 business days
- `low`: 10 business days

Rules:

- a case is `overdue` when its age exceeds its SLA threshold and it is still open
- a case is `snooze overdue` when `status = snoozed` and `snoozedUntil < now`
- a case is `escalation overdue` when `escalated = true` and `status != resolved`
- resolved cases do not count as active breaches
- reopened cases count toward reopen metrics and should be explicitly surfaced

Business-day handling for v1:

- use existing business-day helpers in the codebase for SLA threshold computation
- if those helpers cannot be reused safely in the server analytics path, implementation should extract shared deterministic business-day logic rather than silently falling back to calendar days

That keeps the system deterministic and avoids fake precision.

Important queue-alignment rule:

- the current `/admin/interventions?view=aging` behavior is not sufficient for SLA work because it uses a fixed aging threshold rather than severity-aware overdue logic
- this slice should introduce a dedicated `overdue` queue view based on the same deterministic threshold function used by the analytics page
- this slice should also introduce a dedicated `snooze-breached` queue view rather than reusing raw `status=snoozed`
- `view=overdue` and `view=snooze-breached` must control their own effective status semantics in the workspace
- specifically:
  - `view=overdue` should include open cases that breach SLA thresholds
  - `view=snooze-breached` should include snoozed cases whose `snoozedUntil` has expired, even if the workspace otherwise defaults to `status=open`
- the analytics page should not rely on inherited workspace defaults that would hide breached snoozes
- precedence rule:
  - when `view=overdue` or `view=snooze-breached` is present, the workspace must derive the effective status set from the view before applying any optional explicit `status` override
  - default client behavior must not inject `status=open` in a way that hides the view’s target rows

## Page Structure

### 1. SLA Summary Strip

Top-row KPI cards:

- Open Cases
- Overdue Cases
- Escalated Cases
- Snoozes Past Due
- Repeat Cases Open

Each card should support a direct link into the matching filtered intervention queue.

This section should also include a compact severity breakdown block for:

- open cases by severity
- overdue cases by severity

### 2. Outcome Metrics Section

Cards or compact tables for:

- clearance rate over 30 days
- reopen rate over 30 days
- average age to resolution
- average age of open cases
- median age of open cases
- action-type counts:
  - assign
  - snooze
  - resolve
  - escalate

### 3. Hotspots Section

Five ranked tables:

- by assignee
- by disconnect type
- by rep
- by company
- by stage

Each row should show:

- open cases
- overdue cases
- repeat open cases
- clearance rate if available

Ranking rule:

- each table should default to ranking by `overdue cases desc`, then `open cases desc`
- if two rows tie, sort by label ascending for stability

Presentation rule:

- these should be separate ranked tables or explicit tabs, not a blended mixed-dimension list

Linking rule for hotspot rows:

- if a hotspot row cannot be expressed through the current intervention workspace query contract, this slice should extend that contract
- rep/company/stage hotspot rows should not render a fake “open in queue” action unless the queue can actually reproduce the filter
- acceptable contract additions include explicit query filters such as:
  - `assigneeId` for the intervention case owner
  - `repId` for the sales rep associated with the underlying deal
  - `companyId` for the linked company
  - `stageKey` for the linked deal stage slug from pipeline stage configuration
  - `severity`
  - `disconnectType`

Source-dimension mapping rule:

- “assignee” and “rep” are distinct dimensions and must not share a filter
- assignee hotspots should deep-link via the case owner filter
- rep hotspots should deep-link via the linked deal rep filter
- company hotspots should deep-link via the linked company filter
- stage hotspots should deep-link via the linked deal stage filter

Stable hotspot identity rule:

- hotspot rows must carry both a display label and a stable filter identity
- display labels must never be used as the queue filter
- each row should include:
  - `entityType`
  - `filterValue`
  - `label`
- expected mappings:
  - assignee row: `entityType = "assignee"`, `filterValue = <userId>`
  - disconnect type row: `entityType = "disconnect_type"`, `filterValue = <disconnectType>`
  - rep row: `entityType = "rep"`, `filterValue = <repUserId>`
  - company row: `entityType = "company"`, `filterValue = <companyId>`
  - stage row: `entityType = "stage"`, `filterValue = <stageKey>`

Required queue-link contract for v1:

- `/admin/interventions` should support explicit URL/query reproduction for:
  - `view`
  - `clusterKey`
  - `status`
  - `severity`
  - `disconnectType`
  - `assigneeId`
  - `repId`
  - `companyId`
  - `stageKey`

Stage identity rule:

- `stageKey` means the canonical pipeline stage slug/key used by the deal workspace and pipeline configuration layer
- it should not mean a raw database UUID unless the codebase already exposes UUID stage filtering consistently in the admin intervention workspace

If a dashboard row cannot be represented through that contract, it should not claim a deterministic jump into the writable queue until the contract is extended.

### 4. Breach Queue Section

A read-first list of the highest-priority problem cases:

- severity
- deal / company
- disconnect type
- age
- overdue indicator
- escalated indicator
- assigned owner
- direct link to the specific case in `/admin/interventions`

This is not a second writable queue. It is a high-signal subset for leadership.

Breach membership rule:

- the breach queue should be the distinct union of:
  - overdue open cases
  - escalated still-open cases
  - snoozes past due
  - repeat open cases
- a case that matches multiple categories appears once
- each row should expose the set of breach reasons it matched

Default breach-queue ordering:

- severity desc using the explicit severity ladder:
  - critical
  - high
  - medium
  - low
- then overdue age desc
- then escalated cases before non-escalated cases when prior fields tie
- then label asc for stability

Linking rule for breach rows:

- each breach row should expose:
  - a primary `detailLink` that opens the exact case in `/admin/interventions`
  - a secondary `queueLink` that opens the broader matching queue slice
- the case-level link should use a deterministic case selector such as `caseId`
- if a breach row matches multiple breach reasons, `queueLink` must choose one deterministic primary queue slice using this precedence:
  - `overdue`
  - `escalated_open`
  - `snooze_breached`
  - `repeat_open`
- `queueLink` should use the highest-priority matching reason from that list
- the full `breachReasons` array remains in the payload so the UI can still show all matched reasons even though the queue link picks one primary slice

### 5. SLA Rules Explanation

A compact explanation block describing:

- current SLA thresholds
- what counts as overdue
- what counts as a snooze breach
- what counts as a repeat case

This matters because leadership should be able to trust and explain the metric logic.

## Data Model and Metric Semantics

The new dashboard should derive from existing intervention data rather than introducing a parallel state model.

Primary sources:

- `ai_disconnect_cases`
- `ai_disconnect_case_history`
- existing disconnect-row projection logic
- existing intervention action history and feedback

Metric definitions:

- `openCases`: cases where status is `open`
- `overdueCases`: open cases where age exceeds threshold
- `snoozeOverdueCases`: snoozed cases where `snoozedUntil < now`
- `escalatedCases`: cases where `escalated = true` and status is not resolved, including snoozed escalations
- `repeatOpenCases`: open cases with `reopenCount > 0`
- `clearanceRate30d`: distinct cases resolved in the last 30 days divided by distinct cases with at least one intervention action in the last 30 days
- `reopenRate30d`: distinct cases that reopened in the last 30 days and had a prior resolution event divided by distinct cases resolved in the last 30 days
- `averageAgeOfOpenCases`: mean age in days from the current open-case detection anchor to now
- `medianAgeOfOpenCases`: median age in days from the current open-case detection anchor to now
- `averageAgeToResolution`: mean age in days from the same detection anchor to the final resolution timestamp for cases resolved in the trailing window

Where metrics could be ambiguous, the dashboard should choose explicit definitions and use them consistently.

Dedupe rule:

- rate and hotspot metrics should count distinct case IDs unless a metric is explicitly defined as event volume
- action-type counts may be event-based
- clearance and reopen rates must be case-based, not event-based

Reopen-rate cohort rule:

- the numerator is the distinct set of cases that entered a reopened state in the trailing 30-day window after having been previously resolved
- the denominator is the distinct set of cases resolved in the trailing 30-day window
- this is a trailing operational rate, not a strict matched-cohort survival analysis
- the UI label should reflect that wording:
  - `Reopen Rate (resolved vs reopened in 30d)`
- this slice must persist the timestamp of the most recent reopen event needed for that numerator
- recommended storage contract:
  - add `lastReopenedAt` to `ai_disconnect_cases`
  - update it whenever a case transitions from `resolved` back into an active lifecycle
  - backfill it from `ai_disconnect_case_history` where prior reopen transitions can be reconstructed
- if historical backfill cannot recover every old reopen precisely, the spec should require best-effort backfill plus explicit forward correctness from the moment this slice ships

Repeat-case rule:

- v1 should define a repeat case as `reopenCount > 0`
- summary cards, breach queue, hotspot metrics, and `/admin/interventions?view=repeat` must all use that same threshold

Age-anchor rule:

- v1 age metrics should use a single explicit anchor: the current case lifecycle start timestamp
- for a case that has never reopened, that is its first active detection timestamp
- for a reopened case, that is the timestamp of the latest reopen into the current active lifecycle, not the original historical creation time
- this slice should persist that lifecycle-start timestamp in the intervention data model if it is not already available
- recommended storage contract:
  - add `currentLifecycleStartedAt` to `ai_disconnect_cases`
  - set it when a case is first materialized
  - reset it whenever the case reopens into a new active lifecycle
- this slice should backfill that lifecycle-start timestamp for existing historical cases so current open-case age, overdue status, and age metrics are computed consistently
- `ageDays`, overdue status, average open age, and average age to resolution must all use the same anchor

Hotspot metric rule:

- hotspot rows are dimension-scoped aggregations
- `openCases`, `overdueCases`, and `repeatOpenCases` on a row must all be computed only from cases belonging to that row's dimension filter
- `clearanceRate30d` on a row means:
  - distinct cases in that row's dimension resolved in the last 30 days
  - divided by distinct cases in that same row's dimension with at least one intervention action in the last 30 days
- if a dimension cannot support a trustworthy row-scoped clearance denominator in v1, that row should return `clearanceRate30d = null` rather than borrowing an office-wide rate

Formatting and empty-set rule:

- percentage metrics should return `null` when their denominator is zero
- age averages should return `null` when no qualifying cases exist
- count metrics should return integer `0`
- UI should render:
  - `0` for count metrics
  - `N/A` for `null` percentages or averages
- age metrics should be rounded to one decimal place in the payload or rounded consistently in one shared UI formatter

## Routing and Linking

New route:

- `/admin/intervention-analytics`

Primary API contract:

- `GET /api/ai/ops/intervention-analytics`

V1 should use one aggregated payload rather than multiple page-level round trips.

Suggested response shape:

```ts
interface InterventionAnalyticsDashboard {
  summary: {
    openCases: number;
    overdueCases: number;
    escalatedCases: number;
    snoozeOverdueCases: number;
    repeatOpenCases: number;
    openCasesBySeverity: Record<"critical" | "high" | "medium" | "low", number>;
    overdueCasesBySeverity: Record<"critical" | "high" | "medium" | "low", number>;
  };
  outcomes: {
    clearanceRate30d: number | null;
    reopenRate30d: number | null;
    averageAgeOfOpenCases: number | null;
    medianAgeOfOpenCases: number | null;
    averageAgeToResolution: number | null;
    actionVolume30d: {
      assign: number;
      snooze: number;
      resolve: number;
      escalate: number;
    };
  };
  hotspots: {
    assignees: InterventionAnalyticsHotspotRow[];
    disconnectTypes: InterventionAnalyticsHotspotRow[];
    reps: InterventionAnalyticsHotspotRow[];
    companies: InterventionAnalyticsHotspotRow[];
    stages: InterventionAnalyticsHotspotRow[];
  };
  breachQueue: {
    items: InterventionAnalyticsBreachRow[];
    totalCount: number;
    pageSize: number;
  };
  slaRules: {
    criticalDays: number;
    highDays: number;
    mediumDays: number;
    lowDays: number;
    timingBasis: "business_days";
  };
}

interface InterventionAnalyticsHotspotRow {
  key: string;
  entityType: "assignee" | "disconnect_type" | "rep" | "company" | "stage";
  filterValue: string | null;
  label: string;
  openCases: number;
  overdueCases: number;
  repeatOpenCases: number;
  clearanceRate30d: number | null;
  queueLink: string | null;
}

interface InterventionAnalyticsBreachRow {
  caseId: string;
  severity: string;
  disconnectType: string;
  dealId: string | null;
  dealLabel: string | null;
  companyId: string | null;
  companyLabel: string | null;
  ageDays: number;
  assignedTo: string | null;
  escalated: boolean;
  breachReasons: Array<"overdue" | "escalated_open" | "snooze_breached" | "repeat_open">;
  detailLink: string;
  queueLink: string;
}
```

Payload-size rule:

- hotspot tables should be capped to the top `10` rows per dimension in v1
- breach queue should return the first `25` rows in the aggregated payload plus `totalCount`
- if leadership needs deeper paging later, that should be a dedicated follow-up route rather than expanding the initial dashboard response without bound

New navigation links:

- from `/admin/interventions`
- from `/admin/sales-process-disconnects`
- optional sidebar item under admin/director navigation

Required deep links into `/admin/interventions`:

- overdue queue
- escalated queue
- repeat queue
- snooze-breached queue
- cluster-specific queue
- hotspot-specific queue rows where supported by the query contract
- exact case detail route using `caseId`

Case-detail deep-link contract:

- `/admin/interventions` must support a canonical query parameter:
  - `caseId=<uuid>`
- when `caseId` is present:
  - the workspace must load the matching case detail explicitly
  - the detail panel must open for that case even if the current queue page would not otherwise have that row visible
  - the queue may still load its normal list, but the detail panel selection must be driven by `caseId`
- `InterventionAnalyticsBreachRow.detailLink` must use that contract
- recommended form:
  - `/admin/interventions?caseId=<caseId>`

Filter-combination rule:

- `view` is the primary queue mode
- `status`, `severity`, `disconnectType`, `assigneeId`, `repId`, `companyId`, and `stageKey` are narrowing filters layered on top of the effective view semantics
- if a view implies its own effective statuses, those implied statuses are applied before optional narrowing filters
- analytics-generated links must never produce a queue that silently broadens beyond the dashboard row the user clicked

## AI Integration

This dashboard should remain deterministic in v1.

The AI layer does not decide SLA status, breach state, or outcome scores.

AI can later sit on top of this page to provide:

- weekly narrative summaries
- “why this hotspot matters” explanations
- recommended manager focus areas

But the actual metrics and breach rules must come from SQL and explicit business logic.

That keeps the page trustworthy and demo-safe.

## Error Handling and Empty States

The page should handle:

- no intervention cases yet
- no overdue cases
- no escalations
- no reopened cases
- missing or partial assignee labels

Empty-state language should be operational:

- “No intervention cases are currently overdue”
- “No reopened cases are active right now”
- “No escalated cases are still open”

## Testing Expectations

This design will need:

- service tests for SLA classification and metric aggregation
- route tests for analytics payload shape and authorization
- client tests for filter/path helpers and metric rendering
- focused UI smoke tests for breach-queue links into `/admin/interventions`

The implementation should prefer pure helpers for:

- SLA threshold classification
- overdue status derivation
- metric labeling
- deep-link generation

That keeps the analytics logic testable without browser-heavy test setup.

## Non-Goals

This phase should not:

- add direct case mutation controls to the analytics page
- introduce AI-generated SLA scores
- add business-day calendar engines unless one already exists
- redesign the existing disconnect dashboard
- replace the intervention workspace

## Success Criteria

This phase is successful when:

- leadership can tell which intervention cases are overdue right now
- leadership can see whether intervention actions are clearing cases
- hotspots by assignee and disconnect type are obvious
- every high-priority metric links into the canonical writable intervention queue
- the page remains deterministic, explainable, and stable under production data
