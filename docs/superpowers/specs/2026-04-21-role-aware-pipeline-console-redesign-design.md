# Role-Aware Pipeline Console Redesign

**Date:** 2026-04-21
**Scope:** Client UX redesign for rep, director, and admin dashboard surfaces plus unified lead/deal pipeline interaction patterns

## Goal

Redesign the CRM's primary working surfaces so:

- reps land on a `sales showcase` centered on their own board
- directors and admins land on `operator console` surfaces organized around action, health, and throughput
- leads and deals use one shared stage-board mental model instead of separate list and board paradigms
- clicking a stage opens a dedicated paginated stage page
- all existing stage-gate, approval, and validation rules remain intact

This redesign is intended to improve clarity, consistency, and operator usefulness without losing current workflow coverage.

## Non-Goals

- changing stage-gate business rules
- weakening approval or override requirements
- changing deal or lead lifecycle semantics
- replacing current backend permissions
- redesigning unrelated non-pipeline modules for their own sake

## Audit Summary

The current codebase exposes multiple conflicting workflow models:

1. `Deals pipeline` is a drag-and-drop board in `client/src/pages/pipeline/pipeline-page.tsx`
2. `Leads pipeline` is a paginated list in `client/src/pages/leads/lead-list-page.tsx`
3. `Deals directory` is a filterable list in `client/src/pages/deals/deal-list-page.tsx`
4. `Rep dashboard` is KPI-first in `client/src/pages/dashboard/rep-dashboard-page.tsx` rather than board-first
5. `Director dashboard` currently mixes strategic metrics, alerts, and rep activity in a visually noisy layout
6. `Lead detail` and `deal detail` do not read like the same product family
7. `Lead` and `deal` stage badges encode similar workflow concepts with different visual logic

The result is a product that asks users to re-learn interaction patterns as they move between leads, deals, dashboards, and stage movement.

## Design Thesis

### Visual Thesis

Reps should feel like they are on a live sales floor with their board as the dominant working surface; admins and directors should feel like they are in an operating console with dense, legible signal and minimal decorative noise.

### Content Plan

- rep: board first, then personal performance and follow-up context
- director: team board and stage pressure first, then rep comparison and performance trends
- admin: operational health and queues first, then secondary commercial context

### Interaction Thesis

- one shared board grammar across leads and deals
- drag-and-drop only on boards
- stage click opens a dedicated paginated stage page with a clear back path

## Product Direction

### 1. Shared Pipeline System

Leads and deals should become two variants of the same pipeline system, not separate products.

Canonical board model:

- there are two canonical board routes, not one combined mixed-entity board:
  - `Leads Board`
  - `Deals Board`
- both boards use the same workspace grammar and component contract
- role-specific dashboards embed scoped entries into those canonical boards rather than inventing separate board implementations per role
- the redesign does **not** create a single mixed board that interleaves lead and deal records in one stage column

Canonical routes:

- `/leads?scope=mine|team|all`
- `/deals?scope=mine|team|all`
- `/leads/stages/:stageId?scope=mine|team|all`
- `/deals/stages/:stageId?scope=mine|team|all`

Compatibility aliases:

- `/leads/board?scope=...` redirects to `/leads?scope=...`
- `/deals/board?scope=...` redirects to `/deals?scope=...`
- sidebar and mobile navigation target the canonical base paths, not the `/board` aliases

Scope defaults:

- rep defaults to `scope=mine`
- director defaults to `scope=team`
- admin defaults to `scope=all`

Route normalization rules:

- direct links with no `scope` query normalize to the role default scope before render
- direct links with a disallowed `scope` query redirect to the role-allowed canonical route before render
- once normalized, the resolved `scope` is treated as the effective scope for breadcrumb/back-link generation

Scope authorization rules:

- reps may request `mine` only in this redesign slice
- directors may request `team` only in this redesign slice
- admins may request `all` only in this redesign slice
- if a user requests a disallowed explicit scope, the app should redirect to the role-allowed canonical route for that entity rather than 403 or silently clamp server-side
- the UI should not expose a cross-scope switcher in this first redesign slice

Scope definitions:

- `mine`: records assigned to the current user in the current active office
- `team`: records assigned to reps in the current active office
- `all`: all visible records in the current active office, including unassigned records where applicable

This redesign does not introduce tenant-wide cross-office board scopes.

Shared behaviors:

- stage columns rendered as a board
- cards inside stage columns
- drag-and-drop on the board only
- clicking a stage opens a dedicated stage page
- dedicated stage pages support pagination, search, sorting, and filtering
- stage pages are read-only with respect to movement

Shared mental model:

- `board` = move work
- `stage page` = inspect work
- `detail page` = edit and act on one record

Shared board contract:

- `entityType`: `lead` or `deal`
- `scope`: `mine`, `team`, or `all`
- `columns[]`: stage metadata, count, primary summary, secondary summary, ordered cards
- `cards[]`: record id, title, subtitle, owner label, age, risk state, and entity-specific metrics
- `columns[].cards[]` represent the full ordered stage population for the current board scope after active board filters are applied
- board UI may virtualize rendering inside a column for performance, but virtualization must not change ordering, counts, or drag semantics
- board columns are not paginated in this first slice; the dedicated stage page is the paginated inspection surface
- `canDrag`: whether the current user may move records on this board
- `onMove`: board-only movement handler
- `onOpenStage`: opens the dedicated stage page
- `onOpenRecord`: opens the record detail page

Same vs different matrix:

- same for leads and deals:
  - column header layout
  - drag/drop behavior
  - stage-click behavior
  - loading/empty states
  - card density and hover behavior
  - pagination model on stage pages
- different by entity:
  - lead cards show conversion-oriented context, not monetary value
  - deal cards show commercial value and forecast context
  - lead columns summarize count, age, and stale/conversion pressure
  - deal columns summarize count, value, and stale pressure

Lead conversion boundary:

- the lead board remains a lead-only board and does not accept direct cross-entity drops into deal stages
- dragging a lead into the terminal lead stage whose configured slug is `converted` is the conversion boundary on the lead board
- no other lead-stage drop opens the conversion flow
- dropping into that conversion boundary must open the existing lead-conversion flow rather than inventing a new direct stage mutation
- that conversion flow must still collect the current required payload, including `dealStageId`
- on initial paint, the conversion flow defaults to `workflowRoute=estimating` and preselects the first active standard-deal stage by pipeline order; the operator may change the target deal stage before submit
- on successful conversion, the lead card leaves the lead board and the successor deal appears on the deals board in the chosen deal stage

### 2. Role-Aware Home Surfaces

#### Reps: Sales Showcase

The rep home should always open with `My Board` as the dominant region.

Home behavior:

- rep home uses a segmented `Deals | Leads` board switcher
- the default opening tab is `Deals`
- the last selected board tab is preserved for the session
- both tabs remain within `scope=mine`

Primary information:

- only that rep's active pipeline stages
- visual stage pressure and card aging
- board-level quick awareness of stalled work

Secondary information:

- today's tasks
- stale follow-up risk
- current activity pace
- personal performance and coaching metrics

The rep dashboard should feel motivating and active, but still utility-first. It should avoid generic KPI mosaics that hide the actual work surface below the fold.

#### Directors: Operator Console

The director home should prioritize team operation, not decorative reporting.

Home behavior:

- director home uses a segmented `Deals | Leads` board switcher in the primary workspace band
- the default opening tab is `Deals`
- the last selected board tab is preserved for the session
- both tabs remain within `scope=team`

Primary information:

- team board / stage pressure
- stalled work
- stale work and alerts
- fast drill-through into stage pages and rep detail
- quick access to both `Leads Board` and `Deals Board` at `scope=team`

Secondary information:

- rep comparison
- funnel distribution
- performance trends
- pipeline and win-rate charts

The visual system should be calmer and more structured than the rep surface, with denser information and less theatrical emphasis.

#### Admins: Operator Console

The admin home should lead with operational triage, system health, and control.

Primary information:

- queue pressure
- system health
- operational exceptions
- admin workspace actions

Secondary information:

- limited sales context for awareness, not as the hero area

This page should make it obvious what needs attention now, what is healthy, and where to go next.

Required admin first-iteration modules:

- AI Actions
- Interventions
- Sales Process Disconnects
- Merge Queue
- Migration Exceptions
- Audit Activity
- Procore / sync health

Admin module contract for the first slice:

- every module renders as a bounded summary tile with:
  - one headline metric
  - one secondary status or age signal
  - one primary CTA into the existing full workspace
  - a compact loading state, empty state, and inline error state
- AI Actions:
  - source: existing AI action queue/workspace
  - minimum summary: pending count, oldest queued age
  - CTA: `/admin/ai-actions`
- Interventions:
  - source: existing intervention workspace
  - minimum summary: open case count, oldest open age
  - CTA: `/admin/interventions`
- Sales Process Disconnects:
  - source: existing disconnect dashboard
  - minimum summary: total disconnects, highest-pressure cluster or trend label
  - CTA: `/admin/sales-process-disconnects`
- Merge Queue:
  - source: existing merge queue page
  - minimum summary: open candidate count, oldest waiting age
  - CTA: `/admin/merge-queue`
- Migration Exceptions:
  - source: existing migration review queue
  - minimum summary: unresolved review count, oldest pending age
  - CTA: `/admin/migration/review`
- Audit Activity:
  - source: existing audit log
  - minimum summary: changes in trailing 24 hours, most recent actor and timestamp
  - CTA: `/admin/audit`
- Procore / sync health:
  - source: existing Procore sync page
  - minimum summary: sync health state, conflict or error count, last successful sync time
  - CTA: `/admin/procore`

Admin board behavior:

- admins can access both canonical boards at `scope=all`
- admin home does not lead with a board
- board access is secondary from the admin console, but once inside a board, admins use the same board and stage-page system as other roles
- admins retain existing stage-movement permissions and override rules where already permitted by the product
- the admin console exposes `Deals Board` and `Leads Board` as secondary workspace entries, not as the primary landing composition
- each first-iteration admin module renders as a bounded summary surface or action tile, not an embedded full page

## Board Design

### Unified Board Anatomy

Lead and deal boards should share:

- column headers
- column accent treatment
- counts and supplemental summary language
- card density and card spacing
- hover behavior
- empty-state behavior
- loading-state behavior

Leads and deals differ only where the underlying data differs:

- lead stages emphasize count, age, conversion readiness, and stale risk
- deal stages emphasize count, value, age, and stale risk

### Board Motion

Motion should be restrained and meaningful:

- slight lift on card hover
- subtle drop-zone emphasis during drag
- crisp page transition into stage detail routes

No ornamental animation should compete with scanning or drag precision.

## Dedicated Stage Pages

Every stage page should be a dedicated route with explicit back navigation to its parent board.

Expected behaviors:

- paginated rows
- search within the selected stage
- sort by freshness, value, age, rep, and name where relevant
- page-size control
- filters for stale/risk/status signals where relevant
- clear breadcrumb or back action

Stage pages should not allow drag-and-drop. Their job is review, not movement.

Navigation contract:

- the stage-page breadcrumb/back link always returns to the canonical board route for the same entity and effective normalized `scope`
- browser back preserves actual navigation history
- missing or disallowed `scope` values are normalized before render, so direct-entry stage pages still generate an explicit back link from the effective normalized `scope`
- dashboard entry points should deep-link into canonical stage pages rather than inventing dashboard-local stage routes

Stage-page data contract:

- path params:
  - `stageId`
- query params:
  - `scope=mine|team|all`
  - `page`
  - `pageSize`
  - `search`
  - `sort`
  - optional entity-appropriate filters such as `assignedRepId`, `staleOnly`, `status`, `workflowRoute`, or `source`
- defaults:
  - `page=1`
  - `pageSize=25`
  - default sort is `age_desc` for review-first triage

Allowed sort values:

- shared:
  - `age_desc`
  - `age_asc`
  - `lastActivity_desc`
  - `lastActivity_asc`
  - `name_asc`
  - `name_desc`
  - `rep_asc`
  - `rep_desc`
- deal-only:
  - `value_desc`
  - `value_asc`
  - `winProbability_desc`
  - `winProbability_asc`

Allowed filter schema:

- shared:
  - `assignedRepId=<repId>`
  - `staleOnly=true|false`
- lead-only:
  - `status=active|inactive|converted|disqualified`
  - `source=<normalized source slug>`
- deal-only:
  - `status=open|won|lost|on_hold`
  - `workflowRoute=estimating|service`

Stage-page response shape:

- `stage`: id, name, slug
- `scope`
- `summary`: count plus entity-appropriate summary metrics
- `pagination`: page, pageSize, total, totalPages
- `rows[]`

Minimum lead row fields:

- id
- name
- companyName
- propertyLine
- assignedRepName
- daysInStage
- lastActivityAt
- source
- status

Minimum deal row fields:

- id
- dealNumber
- name
- assignedRepName
- propertyLine
- daysInStage
- lastActivityAt
- bestEstimate
- winProbability
- workflowRoute

## Stage-Gate Preservation

All existing stage-gate rules still apply.

The redesign must preserve:

- invalid move blocking
- required-field enforcement
- terminal-stage rules
- lost/won close behavior
- director/admin-only override behavior
- approval and backward-move restrictions

This work may improve how stage-gate feedback is presented, but it must not change the rules themselves.

Movement and enforcement matrix:

- `Board / Rep`
  - may drag records visible in `scope=mine`
  - all existing preflight and blocking rules still run
- `Board / Director`
  - may drag records visible in `scope=team`
  - existing override and backward-move rules still run
- `Board / Admin`
  - may drag records visible in `scope=all`
  - existing admin/director privilege rules still run
- `Stage Page / All Roles`
  - no drag and no direct movement controls
  - review and drill-through only
- `Detail Page / All Roles`
  - existing move/advance controls remain available where they exist today
  - detail pages are still allowed to trigger stage movement through the current rule system

Preservation points:

- board drag must still invoke current stage preflight logic
- deal detail must continue using the current stage-change dialog or its equivalent rule-preserving flow
- lead-to-deal progression must remain governed by the existing conversion boundary, not by inventing mixed-entity drag behavior
- direct entry from stage pages into record detail must not bypass existing permissions or prompts

Access matrix:

- `Rep`
  - `/leads/board?scope=mine`
  - `/deals/board?scope=mine`
  - `/leads/stages/:stageId?scope=mine`
  - `/deals/stages/:stageId?scope=mine`
  - record detail for owned/visible records
- `Director`
  - `/leads/board?scope=team`
  - `/deals/board?scope=team`
  - `/leads/stages/:stageId?scope=team`
  - `/deals/stages/:stageId?scope=team`
  - rep detail and team-visible record detail
- `Admin`
  - `/leads/board?scope=all`
  - `/deals/board?scope=all`
  - `/leads/stages/:stageId?scope=all`
  - `/deals/stages/:stageId?scope=all`
  - admin home plus full-scope record detail subject to existing permissions

This access matrix is intentionally strict for the first redesign slice and does not imply a multi-scope picker for any role.

## Information Architecture Improvements

### Rep Surface

Current issue:

- KPIs and charts compete with the working board

Improvement:

- the board becomes the first screen
- personal metrics move into secondary supporting regions
- tasks and follow-up pressure become more actionable and less card-mosaic based

### Director Surface

Current issue:

- too many regions compete visually
- information density is inconsistent
- action paths are less obvious than they should be

Improvement:

- one primary team workspace band
- one secondary comparison and alert band
- one tertiary trends band
- cleaner visual separation between monitoring and drilling in

### Admin Surface

Current issue:

- operational signals and sales context are not clearly prioritized

Improvement:

- queues, system health, and operational changes become the main story
- sales context remains present but visually subordinate

### Lead/Deal Surface Family

Current issue:

- lead detail and deal detail do not feel like variants of the same workflow system
- stage badges and stage context cues differ too much

Improvement:

- unify visual language for workflow state
- align header rhythm, detail hierarchy, and contextual side panels
- make moving from lead to deal feel like progressing through one pipeline family
- this effort includes only the workflow-header, stage-state, and contextual alignment needed to support the new board and stage-page system
- it does **not** require a full tab-by-tab redesign of all lead and deal detail internals in the first iteration

## Visual System Direction

### Reps

- stronger contrast
- more visual momentum
- still disciplined, not gamified
- board dominates over stat tiles

### Admins and Directors

- calmer operator-console palette
- fewer competing accent colors
- denser but readable rows
- stronger use of structure, spacing, and typography rather than decorative cards

### Global Rules

- avoid dashboard-card mosaics as the main composition
- use layout and hierarchy before adding chrome
- keep headings literal and operational
- reduce one-off styling differences between lead and deal surfaces

## Most Useful Information To Surface

### Reps

- their board
- stale follow-up pressure
- tasks due today / overdue
- stage-specific stuck work
- personal activity pace

### Directors

- stage congestion
- stalled and stale work
- rep distribution across the funnel
- rep-level output and conversion signals
- team pipeline totals and trend context

### Admins

- system health
- queue pressure
- operational exceptions
- recent workspace changes
- lightweight commercial context

## Codebase Implications

### Existing strengths to reuse

- deal pipeline board structure in `client/src/pages/pipeline/pipeline-page.tsx`
- deal pagination/filter hook behavior in `client/src/hooks/use-deals.ts`
- stage-gate and preflight behavior in `client/src/components/deals/stage-change-dialog.tsx`
- role-specific dashboard data contracts already present for rep and director surfaces

### Likely additions

- shared board UI primitives for lead/deal boards
- dedicated stage page routes for leads and deals
- lead-stage board data shaping compatible with pagination and stage-scoped review
- shared workflow badge and stage header styling primitives
- new stage-page data contracts are allowed where existing hooks are insufficient, especially for lead-stage pagination
- admin dashboard support may require additive backend support if current client-side composition cannot provide the required operational signals cleanly

### Likely refactors

- rep dashboard layout
- director/admin dashboard layout
- lead list page into lead board
- deal list simplification is a follow-up opportunity, not a required outcome of this first redesign slice

### Scope Boundaries For This Effort

Required in this redesign:

- role-aware dashboard home surfaces
- canonical lead and deal board routes
- dedicated paginated stage pages
- unified board grammar
- stage-state visual alignment across lead/deal workflow surfaces

Explicitly not required in this first effort:

- full lead-detail or deal-detail internal re-architecture
- unrelated report or admin-module redesigns outside the new console surfaces
- replacing every existing list route on day one if it is still needed as a supporting view

Navigation and migration decisions:

- `/leads` is the canonical lead board destination
- `/deals` is the canonical deal board destination
- `/leads/board` and `/deals/board` remain temporary compatibility aliases that redirect to the canonical base paths while preserving normalized query params
- `/pipeline` redirects to the canonical deals board destination
- old list-first lead and deal pages do not remain primary navigation destinations in this redesign
- if any temporary list utilities are retained during migration, they are secondary support views only

## Acceptance Criteria

1. Rep home opens with that rep's board as the first and dominant surface.
2. Director and admin home surfaces read as operator consoles rather than card mosaics.
3. Leads and deals both have canonical board routes using the same board contract.
4. Rep home defaults to `Deals` and exposes a `Deals | Leads` board switcher that preserves the last session selection.
5. Director home defaults to `Deals` and exposes a `Deals | Leads` board switcher that preserves the last session selection.
6. Drag-and-drop is available on boards only and remains disabled on stage pages.
7. Clicking a stage opens a dedicated paginated stage page for that entity and current scope.
8. Every stage page has a breadcrumb/back link to the canonical board route for that entity and effective normalized scope.
9. Browser back continues to preserve real navigation history independently of the explicit breadcrumb/back link.
10. Missing or disallowed scopes normalize to the role-allowed canonical route for that entity before render.
11. `mine`, `team`, and `all` all resolve only within the current active office.
12. Existing stage-gate rules still apply on board drag and detail-page movement without weakening permissions or validation.
13. Detail pages remain allowed to trigger existing movement flows where those flows exist today.
14. Dragging a lead into the lead stage whose slug is `converted` opens the existing conversion flow and still requires the current conversion payload, including `dealStageId`.
15. Leads and deals share one coherent visual workflow language for board, badge, stage header, loading state, and empty state behavior.
16. Admin home includes the required first-iteration modules: AI Actions, Interventions, Sales Process Disconnects, Merge Queue, Migration Exceptions, Audit Activity, and Procore / sync health.
17. Each first-iteration admin module renders as a bounded summary or action tile rather than an embedded full-page surface, with a headline metric, secondary status, and CTA to the existing full workspace.
18. `/leads` and `/deals` are canonical board destinations, `/leads/board` and `/deals/board` redirect to them, and `/pipeline` redirects to the deals board destination.
19. Stage pages support pagination, search, page-size control, the allowed sort values, and the allowed filter schema defined in this spec.
20. Board columns expose full stage populations semantically even if the UI uses virtualization for rendering.
21. Rep home places the board before secondary metrics, director home places the board/stage-pressure workspace before trends, and admin home places operational tiles before secondary commercial context.

## Risks

- if lead data remains fetched only as a full list, dedicated stage pages may need contract changes to scale properly
- if board and stage-page patterns are not unified at the component level, visual drift will reappear quickly
- if the redesign focuses too much on visual polish without tightening hierarchy, the dashboard may remain boring while still being busy

## Recommendation

Implement this as a shared pipeline workspace system with role-aware home surfaces on top of it. That is the most durable way to make the UI more useful, more consistent, and visually stronger without losing workflow rigor.
