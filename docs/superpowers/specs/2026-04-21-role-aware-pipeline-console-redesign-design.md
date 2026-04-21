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

### 2. Role-Aware Home Surfaces

#### Reps: Sales Showcase

The rep home should always open with `My Board` as the dominant region.

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

Primary information:

- team board / stage pressure
- stalled work
- stale work and alerts
- fast drill-through into stage pages and rep detail

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

### Likely refactors

- rep dashboard layout
- director/admin dashboard layout
- lead list page into lead board
- possible deal list simplification so it aligns with the shared stage detail model

## Acceptance Criteria

1. Rep home opens with that rep's board as the first and dominant surface.
2. Director and admin home surfaces read as operator consoles rather than card mosaics.
3. Leads and deals both use stage boards with drag-and-drop on the board.
4. Clicking a stage opens a dedicated paginated stage page.
5. Every stage page has a clear path back to its parent page.
6. Drag-and-drop remains board-only.
7. Existing stage-gate rules still apply without weakening permissions or validation.
8. Leads and deals share one coherent visual workflow language.
9. The most useful information for each role is prioritized in a structured, organized hierarchy.

## Risks

- if lead data remains fetched only as a full list, dedicated stage pages may need contract changes to scale properly
- if board and stage-page patterns are not unified at the component level, visual drift will reappear quickly
- if the redesign focuses too much on visual polish without tightening hierarchy, the dashboard may remain boring while still being busy

## Recommendation

Implement this as a shared pipeline workspace system with role-aware home surfaces on top of it. That is the most durable way to make the UI more useful, more consistent, and visually stronger without losing workflow rigor.
