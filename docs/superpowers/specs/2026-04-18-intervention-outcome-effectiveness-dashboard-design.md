# Intervention Outcome Effectiveness Dashboard Design

**Date:** 2026-04-18  
**Status:** Draft for review  
**Scope:** Manager-first outcome-effectiveness reporting for intervention conclusions

## Goal

Extend the existing admin intervention analytics page so leadership can see which intervention conclusions actually work.

This slice should answer:

- which resolution reasons clear cases versus reopen quickly
- which snooze reasons are effective versus just delaying the same issue
- which escalation paths produce real closure
- how long different conclusion types take to clear
- where false-positive or administrative closes are masking real operational risk

This is a refinement of the current intervention analytics surface. It is not a new route and it is not a new conclusion-capture workflow.

## Canonical Surface Boundary

This design stays on:

- `/admin/intervention-analytics`

Existing page roles remain:

- `/admin/sales-process-disconnects`
  - read-first diagnosis of disconnect patterns
- `/admin/interventions`
  - canonical writable queue and case-detail workspace
- `/admin/intervention-analytics`
  - manager-first oversight for SLA health, alerts, and outcome effectiveness

Navigation rule:

- managers discover system health and effectiveness on `/admin/intervention-analytics`
- every actionable effectiveness metric links into `/admin/interventions`
- the analytics page must stay read-first in v1

This slice is allowed to deepen the `/admin/intervention-analytics` API payload and add richer filtered deep links into `/admin/interventions`.

## Why This Is Next

The intervention stack now already provides:

- deterministic disconnect detection
- writable intervention operations
- SLA and hotspot analytics
- manager alerts and scheduled escalation summaries
- required structured conclusion capture for `resolve`, `snooze`, and `escalate`

The remaining gap is interpretation.

Right now the system can capture conclusions and show basic reopen metrics, but leadership still cannot reliably answer:

- which specific conclusion reasons are effective
- which admins or managers are producing durable outcomes
- which snooze reasons correlate with reopen risk
- which escalation reasons and target types actually lead to closure
- whether “resolved” is being used as a real fix or as administrative cleanup

That means we have outcome data, but not yet outcome learning.

## Approaches Considered

### 1. Add a separate `/admin/intervention-outcomes` page

**Pros**

- clean route boundary
- room for a large dedicated dashboard

**Cons**

- duplicates manager navigation
- splits effectiveness away from the existing analytics and alert context
- adds another admin destination before the current page is saturated

### 2. Expand `/admin/interventions` with effectiveness cards

**Pros**

- close to the writable queue
- easy drill-in path

**Cons**

- mixes execution with management analysis
- crowds an already operational page
- wrong surface for multi-week outcome interpretation

### 3. Recommended: deepen `/admin/intervention-analytics`

**Pros**

- preserves the current manager-first route
- keeps SLA, alerts, and outcomes together
- easiest fit with the existing analytics payload and components

**Cons**

- page complexity increases
- requires careful sectioning to avoid becoming a wall of cards

## Recommendation

Extend `/admin/intervention-analytics` with a dedicated outcome-effectiveness section and related drill-ins.

Design rules:

- keep the page read-first
- reuse the current `InterventionAnalyticsDashboard` response instead of creating a parallel endpoint
- make every metric explainable from conclusion history and reopen behavior
- avoid ML scoring or narrative ranking in v1
- treat structured conclusion history as the source of truth

## Product Outcome

V1 should let managers do five things:

### 1. Compare conclusion families

Show:

- reopen rate by conclusion family:
  - `resolve`
  - `snooze`
  - `escalate`
- median days to reopen by conclusion family
- average days to durable closure by conclusion family

This answers whether a class of intervention action is actually effective.

### 2. Compare specific conclusion reasons

Show ranked tables for:

- top resolve reason codes by closure durability
- top snooze reason codes by reopen risk
- top escalation reason codes by eventual closure rate

Each row should include:

- volume
- reopen rate
- durable close rate
- median days to reopen or close
- direct queue link

### 3. Find risky conclusion patterns

Highlight:

- snooze reasons with high reopen rates
- escalation reason codes with poor close-through
- escalation target types with poor close-through where sample size is meaningful
- outcome categories with high administrative-close usage
- disconnect types whose cases frequently reopen after the same reason code

This section should make weak operational habits visible, not just display averages.

### 4. See manager/admin conclusion patterns

Show:

- conclusion mix by assignee at conclusion
- durable close rate by assignee at conclusion
- reopen rate by assignee at conclusion

V1 rule:

- this is manager-coaching information, not public rep scoreboarding
- only show rows with meaningful sample size

### 5. Jump from effectiveness to action

Every section should link back into `/admin/interventions` with the nearest matching deterministic filter:

- `view=repeat`
- `view=overdue`
- `view=open`
- `caseId=<uuid>` where single-case detail is needed
- reason-aware filters added by this slice where needed

If the exact historical cohort cannot be represented in the queue, the link should take the user to the best current operational subset and the spec must label that as a best-effort drill-in rather than pretend historical exactness.

## Data Model Rules

This slice does not introduce a new outcome table.

Canonical sources stay:

- `ai_disconnect_cases`
  - latest case state
- `ai_disconnect_case_history`
  - structured conclusion events
  - reopen events

Effectiveness metrics must derive from:

- conclusion event metadata
- later reopen events
- current latest-state row only where needed for “still open” semantics

Important rule:

- historical effectiveness metrics must not depend on mutable current-row fields when those fields can drift after a reopen or later conclusion
- rates and ages should be computed from history-backed conclusion cohorts wherever possible

## Core Metric Definitions

### Durable close rate

Definition:

- percentage of conclusion events in a cohort that did not reopen within the configured observation window

Recommended v1 window:

- `30 days`

Reason:

- consistent with the current intervention analytics reporting horizon
- short enough for operational management

### Reopen rate

Definition:

- percentage of conclusion events in a cohort that produced at least one later `reopened` event within the observation window

### Median days to reopen

Definition:

- median business-day distance from a conclusion event to its first later `reopened` event

### Average days to durable closure

Definition:

- average business-day distance from case lifecycle start to a conclusion event that remained closed through the observation window

V1 caveat:

- if the sample is too small or still too recent to judge durable closure, return `null` instead of fake precision

### Administrative close rate

Definition:

- share of resolve conclusions whose `effectiveness` is administrative/unclear rather than confirmed durable movement

Purpose:

- surface when the team is cleaning up the queue without fixing the underlying disconnect

## Dashboard Structure

### 1. Outcome Effectiveness Summary

Top summary block should show:

- durable close rate
- reopen rate
- median days to reopen
- average days to durable closure

Primary cut:

- by conclusion family

This replaces the current lightweight effectiveness card with a stronger at-a-glance summary.

### 2. Reason Performance Tables

Three adjacent sections:

- Resolve Reason Performance
- Snooze Reason Performance
- Escalation Reason Performance

Each row should include:

- reason label
- volume
- durable close rate
- reopen rate
- median days to reopen or close
- direct drill-in link

Sort defaults:

- volume-desc first
- then highest operational risk within the same volume band

### 3. Disconnect-Type Interaction

Show:

- reopen rate by disconnect type and conclusion family
- top disconnect types with repeated weak reason patterns

Purpose:

- some conclusions may work well for one disconnect family and poorly for another

### 4. Manager Pattern Review

Show:

- assignee-at-conclusion rows with:
  - volume
  - resolve/snooze/escalate mix
  - durable close rate
  - reopen rate

Guardrails:

- hide rows below the minimum sample threshold
- do not rank or style this as punitive performance scoring

### 5. Operational Warnings

Add a compact warning rail for:

- snooze reasons above the high-risk reopen threshold
- escalation reason codes with low close-through
- escalation target types with low close-through when the sample is large enough
- disconnect types dominated by administrative closes

These warnings should link into `/admin/interventions` or matching analytics filters.

## Queue and Drill-In Contract

The effectiveness dashboard needs more than the current queue filters.

Recommended additions to `/admin/interventions` deep-link contract:

- `conclusionFamily`
- `outcomeCategory`
- `reasonCode`
- `assigneeAtConclusion`
- `disconnectType`

Important boundary:

- these filters are for drill-in convenience
- the workspace remains a latest-state operational queue, not a historical cohort explorer

If a drill-in uses history-backed fields:

- the server should translate the historical cohort into either:
  - an exact current case subset when the existing queue contract can represent it safely, or
  - the nearest operational filter when exact historical replay would overcomplicate the workspace contract
- the client should not fake this by string-only filtering on current rows

V1 recommendation:

- prefer exact `caseId` drill-ins for singleton warnings or exemplar rows
- prefer nearest operational filters for grouped rows unless there is already a safe workspace query parameter that matches the cohort
- do not introduce ad hoc client-only history filters

## Thresholds and Guardrails

Recommended v1 thresholds:

- minimum sample size for row-level effectiveness ranking: `5`
- minimum sample size for assignee comparison rows: `5`
- high-risk snooze warning threshold: reopen rate `>= 0.35`
- weak escalation warning threshold: durable close rate `<= 0.40`

Rules:

- below-threshold rows may still exist in raw payloads if needed for totals
- below-threshold rows should be hidden or grouped into “insufficient sample” buckets in the manager UI
- no percentile ranking language in v1

## API Shape

Keep the existing:

- `GET /api/ai/ops/intervention-analytics`

Extend `outcomeEffectiveness` with richer nested sections rather than adding a second endpoint.

Recommended response additions:

- summary by conclusion family
- reason-performance arrays for resolve/snooze/escalate
- escalation target-type rows or nested breakdowns where supported by the cohort
- disconnect-type interaction rows
- assignee-at-conclusion effectiveness rows
- warning rows with deterministic thresholds already evaluated

Important API rule:

- every row that the UI renders as actionable must carry a deterministic link target from the server
- the client must not rebuild deep links from partial state and risk drifting from server semantics

## Non-Goals

This slice should not:

- add new writable conclusion actions
- change the required outcome-capture taxonomy
- introduce AI-written narratives as the primary insight layer
- create a historical warehouse or materialized reporting subsystem
- add cross-office aggregation in v1
- expose rep-facing leaderboards

## Rollout and Compatibility

This slice builds on the already-live structured conclusion history system.

Compatibility rules:

- existing analytics cards must continue to render while richer outcome-effectiveness payload fields roll out
- the page should tolerate partial payload enrichment during deployment without crashing
- missing history-backed metrics should render as `n/a`, not as zero

## Success Criteria

This slice is successful when a director or admin can open `/admin/intervention-analytics` and answer:

- which conclusion reasons actually work
- which ones tend to reopen
- which disconnect families need different treatment
- which conclusion behaviors look operationally weak
- where to click next to inspect the live queue

That is the threshold where intervention data becomes actionable management learning, not just audit history.
