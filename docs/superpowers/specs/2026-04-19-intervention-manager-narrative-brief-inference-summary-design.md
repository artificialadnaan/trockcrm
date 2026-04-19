# Intervention Manager Narrative Brief and Inference Summary

## Why

The intervention platform now has:

- upstream disconnect signals in `/admin/sales-process-disconnects`
- execution in `/admin/interventions`
- a consolidated manager console in `/admin/intervention-analytics`
- manager alerts
- outcome capture
- outcome-effectiveness reporting
- automation tuning recommendations
- case-level Case Copilot guidance inside the intervention detail sheet

The next missing layer is not another deterministic dashboard module. It is a manager-level inference layer that explains what changed, what is getting worse, and where managers should focus now.

The goal of this slice is to add a concise, grounded manager brief to `/admin/intervention-analytics` without adding any new sidebar entry, menu tab, or top-level admin page.

## Product Goal

Add an advisory `Manager Narrative Brief` module at the top of `/admin/intervention-analytics` that translates existing intervention analytics into short, manager-usable summaries:

- what changed since the prior window
- which patterns need attention now
- which cases or cohorts are most likely to reopen or stall
- where managers should focus today

This module must be:

- additive to the existing manager console
- grounded in existing analytics and deterministic signals
- visibly advisory, not autonomous
- compact enough to reduce dashboard scanning burden rather than increase it

## Non-Goals

This slice does not:

- create a new admin page
- add a new menu bar tab, sidebar item, or manager sub-route
- auto-apply policy changes
- auto-escalate, auto-resolve, or auto-snooze cases
- replace existing manager-alert, outcome-effectiveness, or policy-recommendation sections
- introduce freeform LLM-only summaries without explicit source signals

## User Experience

### Surface

The brief lives inside `/admin/intervention-analytics` as the first section in the manager console, above `Queue Health`.

The existing anchored long-page structure remains. This slice adds:

- `#manager-brief`

The manager console section order becomes:

1. `Manager Brief`
2. `Queue Health`
3. `Manager Alerts`
4. `Outcome Effectiveness`
5. `Policy Recommendations`

The jump row updates accordingly, but no new page or navigation entry is introduced.

### Brief Shape

The `Manager Brief` should read like an operating summary, not a wall of metrics.

It should include:

- `Headline`
  - one short sentence summarizing the dominant operating condition
- `What Changed`
  - 2 to 4 short bullets describing meaningful movement since the prior window
- `Focus Now`
  - 2 to 4 short bullets describing where managers should spend attention today
- `Emerging Patterns`
  - 1 to 3 compact inference cards describing high-signal clusters or risks
- `Confidence / Grounding`
  - a small label or footnote indicating the brief is based on current intervention analytics, outcomes, alerts, and trend deltas

This should feel like a manager readout layered on top of the manager console, not another dashboard wall.

## Inference Model

This slice is inference-assisted but deterministic-grounded.

The brief must be built from existing analytics inputs such as:

- open / overdue / escalated / snooze-breached queue pressure
- manager-alert family counts
- hotspot concentration by assignee / disconnect type / stage / rep / company
- outcome-effectiveness data
- automation recommendation cohorts
- prior-window comparison deltas

The brief generator should infer:

- which movement matters most
- which pattern is emerging or worsening
- where a manager is likely to gain the most leverage now

It should not invent new facts or unsupported causal claims.

## Required Output Model

The server should expose a new `managerBrief` block inside the existing intervention analytics payload.

### `managerBrief`

- `headline: string`
- `summaryWindowLabel: string`
  - example: `Compared with the prior 7 days`
- `whatChanged: Array<{ key: string; tone: "improved" | "worsened" | "watch"; text: string; queueLink: string | null }>`
- `focusNow: Array<{ key: string; priority: "high" | "medium"; text: string; queueLink: string | null }>`
- `emergingPatterns: Array<{ key: string; title: string; summary: string; confidence: "high" | "medium"; queueLink: string | null }>`
- `groundingNote: string`

The payload is fully server-authored. The client should not synthesize its own narrative from raw metrics.

## Grounding Rules

Every line in the brief must map to real current analytics.

Allowed source categories:

- queue volume / breach deltas
- manager-alert family counts
- hotspot movement
- outcome-effectiveness rates
- recommendation cohorts already computed in analytics

Each brief item may include a supported queue link when there is a concrete drill-in path. If no supported drill-in exists, `queueLink` should be `null` rather than inventing unsupported filters.

## Windowing

The brief compares the current window to a prior comparison window.

Recommended v1:

- current window: trailing 7 days
- prior window: the 7 days before that

The comparison should be based on metrics the analytics layer already computes or can compute cheaply in the same pipeline.

## Heuristic Priorities

The brief should emphasize:

- worsening overdue or escalated-open pressure
- snooze breach growth
- repeat-open or poor durable-close trends
- overloaded assignee concentration
- high-confidence policy recommendations already marked `recommended_now`

It should de-emphasize noise and avoid over-reporting minor movement.

## UI Constraints

The UI should not become another crowded module.

Required constraints:

- one primary brief card at the top of the manager console
- compact subsections with short bullets
- at most 3 emerging-pattern cards in v1
- no extra tabs
- no nested accordions
- no giant paragraph blobs

The brief should reduce scanning burden, not create more of it.

## Failure and Fallback Behavior

If manager-brief generation fails:

- the rest of `/admin/intervention-analytics` must still render
- only the `Manager Brief` section should degrade
- the degraded section should show a local error/fallback state
- existing `Queue Health`, `Manager Alerts`, `Outcome Effectiveness`, and `Policy Recommendations` sections must remain available

If the brief lacks enough signal:

- render a low-noise fallback such as:
  - `No strong manager brief is available yet. Continue monitoring queue health and outcome trends.`

## Links and Cross-Surface Behavior

Any queue links emitted by the brief must:

- use existing supported workspace query params
- link into `/admin/interventions`
- preserve existing disconnect-context passthrough params where already supported by the analytics page

This slice does not add client-only filtering conventions.

## Suggested V1 Brief Themes

Allowed v1 brief themes include:

- overdue / escalated pressure worsened
- snooze breaches rising
- one assignee or disconnect type is dominating open workload
- outcome durability is weakening
- a recommendation cohort is mature enough for manager action

These should be expressed as short readouts, not raw metric dumps.

## Telemetry / Audit

At minimum, the system should be able to observe that the brief was served.

This slice does not require separate feedback or rating capture for the manager brief yet.

## Verification Expectations

The completed slice should verify:

- server brief generation is deterministic from analytics inputs
- brief items only reference supported queue links
- fallback behavior is local to the `Manager Brief` section
- `/admin/intervention-analytics` still renders when the brief fails
- the new section appears at the top of the manager console
- no new sidebar item or top-level route is introduced

## Acceptance Criteria

This slice is complete when:

- `/admin/intervention-analytics` includes a `Manager Brief` section at the top
- the brief is server-authored and grounded in existing analytics inputs
- the brief summarizes:
  - what changed
  - what needs focus now
  - emerging patterns
- all emitted drill-ins use supported queue paths
- the section degrades locally on failure
- no new page, tab, or sidebar destination is added
