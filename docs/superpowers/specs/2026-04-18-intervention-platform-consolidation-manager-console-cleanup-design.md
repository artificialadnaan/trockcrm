# Intervention Platform Consolidation and Manager Console Cleanup Design

**Date:** 2026-04-18
**Status:** Draft for review
**Scope:** Consolidate existing intervention-related admin surfaces into a clearer operating model without deleting functionality or changing deterministic behavior

## Goal

Reduce overlap across the intervention admin experience so the platform reads as one operating system instead of a growing set of adjacent dashboards.

This slice does **not** remove capability, change backend policy semantics, or introduce inference. It reorganizes the existing intervention UI around a cleaner role split:

- `/admin/interventions` remains the execution workspace
- `/admin/intervention-analytics` becomes the canonical manager console
- `/admin/sales-process-disconnects` becomes the upstream signals page and drill-in hub

The outcome should be fewer repeated summary surfaces, clearer cross-links, and a cleaner foundation for a later inference layer and case copilot.

## Problems To Fix

The current intervention platform has accumulated real capability, but the information architecture is starting to sprawl.

Current issues:

- manager-facing monitoring is spread across multiple pages
- queue-health and policy-oriented content are partially duplicated
- `sales-process-disconnects` carries both source detection and manager-console behavior
- `intervention-analytics` has grown useful modules, but it is not yet clearly framed as the one canonical management surface
- cross-links exist, but the system still feels like several tools sitting next to each other instead of one operating model

This creates product drag:

- harder for managers to know where to look first
- easier for future features to add another panel instead of strengthening a canonical surface
- increased visual noise without proportional increase in operational clarity

## Design Principles

This cleanup follows four explicit rules:

1. Keep capability, reduce duplication.
2. Consolidate by user role, not by feature family.
3. Prefer deep links into canonical surfaces over repeated dashboard fragments.
4. Change page composition and navigation first; avoid policy or workflow behavior changes in this pass.

This is intentionally an information architecture and page-composition cleanup, not a business-logic rewrite.

## Canonical Surface Model

Long term, the intervention platform should read as three connected surfaces:

### 1. Execution Surface

Route:

- `/admin/interventions`

Purpose:

- operators and managers act on cases here

This surface owns:

- queue views
- selection and batch actions
- detail panel actions
- history
- conclusion capture
- case-level drill-in context

This surface should not expand into a second manager console. It should stay focused on doing work.

### 2. Manager Console

Route:

- `/admin/intervention-analytics`

Purpose:

- managers understand queue health, alert pressure, outcome quality, and policy tuning here

This surface becomes the one canonical manager page for the intervention system.

It should absorb and organize manager-oriented modules into a clear long-form console with anchored sections, not a growing list of disconnected cards.

### 3. Upstream Signals Surface

Route:

- `/admin/sales-process-disconnects`

Purpose:

- admins and directors inspect raw operational disconnects here before or alongside intervention handling

This surface remains distinct, but slimmer. It should present:

- disconnect inventory
- disconnect type and cluster breakdowns
- signal context and narrative
- drill-ins into interventions and analytics

It should stop behaving like a second manager console.

## Target Page Structure

### `/admin/interventions`

Keep existing behavior. Only apply minor cleanup needed to support consolidation:

- retain links to analytics and disconnect signals
- improve label clarity where needed so users understand this is the action surface
- do not add more manager-summary duplication here

This page remains the place to:

- open queues
- filter cases
- assign, snooze, resolve, escalate
- inspect history and conclusion metadata

### `/admin/intervention-analytics`

This becomes the canonical manager console and should be reorganized into one long page with anchored sections in this order:

1. `Queue Health`
2. `Manager Alerts`
3. `Outcome Effectiveness`
4. `Policy Recommendations`

#### Queue Health

Contains:

- current summary strip
- SLA rules
- queue outcomes summary
- hotspots
- breach queue

Purpose:

- answer “what needs attention right now?”

#### Manager Alerts

Contains:

- current manager alert panel
- latest scan/sent state
- manual preview and send actions

Purpose:

- answer “what management pressure is active and what was the latest alert state?”

#### Outcome Effectiveness

Contains:

- existing outcome effectiveness summaries
- reason-performance tables
- warnings tied to outcomes

Purpose:

- answer “what kinds of interventions are actually working?”

#### Policy Recommendations

Contains:

- automation tuning recommendation section

Purpose:

- answer “what deterministic rule changes are worth considering?”

#### Manager Console UX Requirements

- add a compact jump-row near the top linking to each anchored section
- use section headers and descriptions to make the page readable as a console, not a list of cards
- keep all current modules available, but regroup them into the four canonical sections
- avoid repeating identical counts or explanations in multiple sections

### `/admin/sales-process-disconnects`

This page stays, but becomes more explicitly a signals and drill-in surface.

Keep:

- disconnect summary
- disconnect inventory rows
- disconnect type summaries
- cluster summaries
- trend slices
- narrative
- deterministic disconnect automation status

Reduce manager-console duplication by:

- removing framing that makes this page look like the central intervention-management dashboard
- making links to `/admin/intervention-analytics` and `/admin/interventions` more prominent and more obviously primary for downstream action
- repositioning actions like digest, escalation scan, and admin-task queueing as source-side operational controls, not the core management console

This page should answer:

- where is process breaking?
- what kinds of disconnects are emerging?
- which route should I take next: execution or management?

## Navigation and Cross-Link Rules

Consolidation should make navigation more intentional.

Required cross-link behavior:

- `sales-process-disconnects` prominently links to both:
  - `/admin/interventions`
  - `/admin/intervention-analytics`
- `interventions` links to:
  - `/admin/intervention-analytics`
  - `/admin/sales-process-disconnects`
- `intervention-analytics` links back to:
  - `/admin/interventions`
  - `/admin/sales-process-disconnects`

Rule:

- if a user is already on a page that is not the canonical owner of a metric or action, the UI should deep-link to the canonical owner instead of reproducing that feature in-place

## Scope Boundaries

### In Scope

- page composition cleanup
- section regrouping on `intervention-analytics`
- clearer labels and descriptions
- anchored manager-console navigation
- reducing repeated dashboard framing
- stronger drill-in pathways between signals, analytics, and execution
- minor component extraction if needed to make the console structure clearer
- updating tests to match the new page structure and wording

### Out of Scope

- removing routes
- deleting any current functionality
- changing API semantics
- changing deterministic policy thresholds
- changing manager-alert behavior
- introducing new inference or copilot behavior
- large backend refactors that do not directly support UI consolidation

## Component Strategy

This cleanup should prefer composition changes over deep rewrites.

Expected frontend approach:

- keep existing analytics modules, but wrap them in section-level manager-console structure
- extract a small number of layout primitives if necessary, for example:
  - section shell
  - anchored jump navigation
  - console description blocks
- reuse existing components where possible
- avoid creating a second parallel set of manager components just for the cleanup

The implementation should leave the codebase in a state where later inference work can slot into:

- `Outcome Effectiveness`
- `Policy Recommendations`
- future `Case Copilot`

without needing another IA rewrite.

## Data and Backend Expectations

This slice should stay read-first.

Preferred backend expectation:

- use existing analytics and disconnect dashboard payloads
- only add backend fields if the consolidated UI truly needs a missing label or section boundary

No backend change should be introduced solely to cosmetically rearrange content that the client already has.

## Error Handling

Consolidation must preserve the current page-level resilience model:

- manager alerts remain independently visible if broader analytics content is unavailable
- section-level recommendation failures remain local to the recommendation section
- the disconnect signals page must still render meaningful source-side content even if downstream drill-in targets are temporarily unavailable

The cleanup must not make one page more fragile by overly coupling previously independent sections.

## Testing Strategy

This slice is mainly UI composition and IA cleanup, so verification should focus on:

### Client Tests

- analytics page renders the new canonical section layout
- anchored jump navigation renders and points to the expected sections
- existing manager-alert content still renders
- existing outcome-effectiveness content still renders
- existing policy-recommendation content still renders
- disconnects page still renders source-side controls and stronger drill-ins
- workspace still renders execution controls and links outward correctly

### Regression Checks

- no manager-alert interaction regressions
- no recommendation-section regression
- no route-link regressions between the three pages
- no disappearance of existing actions from disconnects/workspace surfaces

### Verification Commands

- focused client Vitest for the touched admin pages and components
- `npm run typecheck`
- `git diff --check`

## Success Criteria

This cleanup is successful if:

- the platform reads as three distinct but connected surfaces
- `intervention-analytics` is clearly the canonical manager console
- `sales-process-disconnects` feels like upstream source context, not a competing manager dashboard
- `interventions` stays execution-focused
- all current functionality still exists
- no new top-level dashboard surface is introduced

## Long-Term Fit

This consolidation is a prerequisite for the next layer of product evolution.

Once the platform is cleaned up, inference can be layered into the right places:

- case-level inference in the execution workspace
- pattern and policy inference in the manager console
- source-pattern inference in the disconnect signals page

That is only sustainable if the deterministic UI surfaces are first simplified and made canonical.
