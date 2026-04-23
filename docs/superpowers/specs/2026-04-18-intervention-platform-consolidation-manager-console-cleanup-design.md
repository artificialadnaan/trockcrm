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

Required anchor ids for this cleanup:

- `#queue-health`
- `#manager-alerts`
- `#outcome-effectiveness`
- `#policy-recommendations`

Required jump-row mapping:

- `Queue Health` -> `#queue-health`
- `Manager Alerts` -> `#manager-alerts`
- `Outcome Effectiveness` -> `#outcome-effectiveness`
- `Policy Recommendations` -> `#policy-recommendations`

#### Queue Health

Contains:

- current summary strip
- SLA rules
- queue outcomes summary
- hotspots
- breach queue
- the current manager-readout framing, if retained at all, must be absorbed into the `Queue Health` section header/intro and must not survive as a separate fifth dashboard block

Anchor owner:

- `#queue-health`

Purpose:

- answer “what needs attention right now?”

#### Manager Alerts

Contains:

- current manager alert panel
- latest scan/sent state
- manual preview and send actions

Anchor owner:

- `#manager-alerts`

Purpose:

- answer “what management pressure is active and what was the latest alert state?”

#### Outcome Effectiveness

Contains:

- existing outcome effectiveness summaries
- reason-performance tables
- warnings tied to outcomes

Anchor owner:

- `#outcome-effectiveness`

Purpose:

- answer “what kinds of interventions are actually working?”

#### Policy Recommendations

Contains:

- automation tuning recommendation section

Anchor owner:

- `#policy-recommendations`

Purpose:

- answer “what deterministic rule changes are worth considering?”

#### Manager Console UX Requirements

- add a compact jump-row near the top linking to each anchored section
- use section headers and descriptions to make the page readable as a console, not a list of cards
- keep all current modules available, but regroup them into the four canonical sections
- avoid repeating identical counts or explanations in multiple sections

The jump-row must use the four exact anchors above. Tests for this slice should verify both:

- the anchor ids exist in the DOM
- the jump-row links target those exact fragment ids

#### KPI Ownership Rules

To make “fewer repeated summary surfaces” enforceable, the manager console becomes the canonical owner of intervention-management KPIs.

`/admin/intervention-analytics` owns:

- queue-health counts
- SLA pressure counts
- breach and hotspot summaries
- manager-alert state
- outcome-effectiveness summaries
- policy-recommendation summaries

`/admin/sales-process-disconnects` may still show source-side disconnect metrics, but it must not recreate intervention-management KPI strips or alternate manager-summary cards for the same concepts.

Allowed on `sales-process-disconnects`:

- raw disconnect totals
- disconnect-type counts
- cluster counts
- trend slices
- disconnect narrative
- source-side automation status tied to disconnect generation

Not allowed on `sales-process-disconnects` after this cleanup:

- second copies of intervention queue-health summaries
- second copies of manager-alert summaries
- second copies of intervention outcome-effectiveness summaries
- alternate framing that presents the page as the central intervention-management dashboard

If a source-side module needs to reference an intervention-management KPI, it should do so by linking to the relevant anchored section in `/admin/intervention-analytics` instead of restating the full summary locally.

The same anti-duplication rule applies inside `/admin/intervention-analytics` itself:

- existing standalone summary/readout blocks that duplicate the new four-section framing must either be removed or absorbed into the owning section as supporting copy
- specifically, the current `Manager Readout` block must not remain as an independent fifth console module after this cleanup

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

#### Drill-In Context Preservation

Deep links must preserve supported context whenever the destination route already has a real query-param contract for that context.

Required rule:

- preserve supported filters, do not invent new client-only state

For this cleanup, the supported carry-through contract is:

- links into `/admin/interventions` preserve existing supported params such as:
  - `view`
  - `caseId`
  - `severity`
  - `disconnectType`
  - `assigneeId`
  - `repId`
  - `companyId`
  - `stageKey`
- links into `/admin/intervention-analytics` may use anchors and any currently supported query params that already exist on that page, but must not introduce fake history-only drill-in params in this slice
- links back to `/admin/sales-process-disconnects` should preserve its current source-side filters through URL search params introduced in this cleanup for existing local UI state only:
  - `type`
  - `cluster`
  - `trend`

This is explicitly allowed because it does not add new backend semantics; it only serializes already-existing local page state into the URL so drill-ins and back-links can preserve context.

This cleanup therefore includes a frontend-only contract change on `/admin/sales-process-disconnects`:

- promote the existing local filter state into URL-backed state
- hydrate local UI controls from:
  - `type`
  - `cluster`
  - `trend`
- preserve those params on links returning to `/admin/sales-process-disconnects`

This is required for consolidation and is considered in-scope because it preserves existing functionality while making cross-route drill-ins testable.

If a source context cannot be expressed with a supported destination param, the link should:

1. carry the closest supported filter subset
2. land on the canonical anchored section
3. avoid implying that unsupported hidden context was preserved

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

Concrete fallback requirements for this slice:

- if broader analytics data fails on `/admin/intervention-analytics`, the page still renders:
  - title/header
  - manager alerts panel
  - available navigation/jump affordances that do not depend on the failed payload
  - a page-level analytics-unavailable message for the missing analytics sections
- if the recommendation section fails, the page still renders the rest of the manager console and the recommendation section shows a local warning state instead of disappearing silently
- if a source-side action or downstream drill-in target is temporarily unavailable on `/admin/sales-process-disconnects`, the page still renders the disconnect inventory and control surfaces with a local error or disabled state for the affected action

The exact copy can follow existing page conventions, but the fallback shape must remain section-local wherever current behavior is section-local.

## Testing Strategy

This slice is mainly UI composition and IA cleanup, so verification should focus on:

### Client Tests

- analytics page renders the new canonical section layout
- anchored jump navigation renders and points to:
  - `#queue-health`
  - `#manager-alerts`
  - `#outcome-effectiveness`
  - `#policy-recommendations`
- existing manager-alert content still renders
- existing outcome-effectiveness content still renders
- existing policy-recommendation content still renders
- disconnects page still renders source-side controls and stronger drill-ins
- disconnects page persists `type`, `cluster`, and `trend` through the URL and uses them when rendering local filter state
- workspace still renders execution controls and links outward correctly

### Regression Checks

- no manager-alert interaction regressions
- no recommendation-section regression
- no route-link regressions between the three pages
- no disappearance of existing actions from disconnects/workspace surfaces
- no unsupported filter loss for the drill-ins this cleanup rewires
- no accidental reintroduction of duplicated manager-summary KPI strips on `sales-process-disconnects`

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
