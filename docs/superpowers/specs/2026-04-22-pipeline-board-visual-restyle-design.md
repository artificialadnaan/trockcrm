# Pipeline Board Visual Restyle

**Date:** 2026-04-22
**Scope:** Visual restyle of the canonical `Deals Board` and `Leads Board` views using the older pipeline UI language as the reference

## Goal

Restore the strongest visual qualities of the older pipeline board UI across the live deals and leads boards without changing the current workflow model.

This pass should:

- make the live `Deals Board` feel closer to the provided screenshot
- make the live `Leads Board` match the same board language
- preserve all current stage names, buttons, routes, drag/drop behavior, and stage-gate rules
- improve scanability and reduce the generic card-stack feeling of the current shared board

## Non-Goals

- changing stage names or stage order
- changing stage-gate, approval, validation, or conversion rules
- redesigning stage detail pages in this slice
- changing the current dark CRM shell outside the board workspace
- reverting to the old route/component architecture
- removing current buttons or moving them to new positions

## Audit Summary

The board interaction model is now structurally correct, but the visual treatment lost a lot of the readability and personality of the older pipeline surface.

Current issues:

1. `client/src/components/pipeline/pipeline-board.tsx` and `pipeline-board-column.tsx` render a neutral, generic board shell with low visual hierarchy
2. `client/src/components/pipeline/pipeline-record-card.tsx` uses a soft utility-card treatment that makes dense board scanning slower than it should be
3. `client/src/pages/deals/deal-list-page.tsx` and `client/src/pages/leads/lead-list-page.tsx` use minimal page headers, so the board lacks the summary band and stage framing that made the older UI feel more intentional
4. `Deals Board` and `Leads Board` now share structure, but they do not yet share a strong branded visual grammar
5. the current board UI feels more cluttered at high volume because every card and column has similar emphasis

Reference source:

- the old visual language lived on the earlier deal pipeline page and is still partially represented in the older `pipeline-page` styling direction
- the attached screenshot is the approved visual reference for this restyle

## Design Thesis

Keep the modern shared board system, but restore the older pipeline board's operating texture:

- lighter workspace inside the current dark app shell
- clearer top summary framing
- thinner, sharper stage headers
- stronger accent-color rhythm across columns
- flatter white cards with heavier numeric hierarchy
- tighter spacing so the board reads like an active work surface rather than a generic dashboard

This is a `hybrid restore`, not a full reversion.

## Product Direction

### 1. Board Scope

This redesign applies to:

- `Deals Board` at `/deals`
- `Leads Board` at `/leads`
- shared board primitives used by those pages

This redesign does not apply yet to:

- `/deals/stages/:stageId`
- `/leads/stages/:stageId`
- record detail pages
- dashboards outside of embedded board consistency concerns

### 2. Structural Rules

The following stay unchanged:

- current canonical routes
- current stage names
- current drag-and-drop behavior
- current `Show DD`, `New Deal`, and `New Lead` button behavior and placement
- current lead conversion boundary
- all existing move validation, approval, and override logic
- current `View all N` stage drill-through behavior

The board continues to teach:

- `board` = move work
- `stage click` = inspect a stage on its dedicated page

## Visual System

### 1. Shell vs Workspace

Keep the existing CRM shell as-is:

- left navigation remains dark
- global page chrome remains consistent with the rest of the product

Inside the main board workspace:

- switch to a lighter operating surface
- use the screenshot's white/light-gray board language
- create stronger contrast between page chrome and board content

### 2. Page Header Treatment

Both board pages should use a more editorial top band inspired by the older pipeline page.

Shared behavior:

- keep the title row and existing CTA buttons
- increase spacing clarity between title, supporting status text, summary strip, and board columns
- use a cleaner `hero band` before the board instead of dropping straight into columns

`Deals Board` top band:

- page title uses the current live deals-board title, styled in the older `Deal Pipeline` visual language
- include a compact status line below the title
- include a summary strip with high-signal commercial metrics

`Leads Board` top band:

- page title uses the current live leads-board title, styled in the matching board language
- include a compact status line below the title
- include a summary strip focused on count and aging/velocity, with value secondary when present

### 3. Summary Strip

Add a screenshot-style summary strip above the columns on both boards.

`Deals` summary priorities:

- total managed pipeline value
- active record count
- average stage age or velocity
- success/health signal if already available from current board data

`Leads` summary priorities:

- active lead count
- average age or velocity
- qualified/opportunity pressure if available from current board data
- value only as a secondary field if it already exists in the live payload

This summary strip is for orientation only. It should not become another dense KPI dashboard.

### 4. Column Design

Board columns should visually move closer to the screenshot:

- uppercase stage labels
- stronger stage header spacing
- thin accent rule tied to stage identity/order
- clear count badge
- larger primary stage summary line
- lighter column bay behind the cards

Column behavior remains unchanged:

- click stage name/header to open stage page
- keep `View all N` for truncated stages
- preserve drag target behavior

### 5. Card Design

Cards should adopt the older board's flatter, more legible treatment.

Shared card behavior:

- white rectangular cards
- reduced decorative chrome
- stronger top-right numeric/value emphasis
- tighter vertical rhythm
- metadata aligned for scan speed rather than “card” aesthetics

`Deals` card emphasis order:

1. deal number
2. deal name
3. top-right value
4. days in stage
5. location or company context

`Leads` card emphasis order:

1. lead identifier if present
2. lead name
3. aging / stage-time signal
4. company, property, or source context
5. value only if real lead-side value exists

Leads should not visually mimic deal certainty where the data is less reliable.

### 6. Color Direction

Color should come from stage rhythm, not loud UI controls.

Rules:

- preserve current shell colors
- use stage accent colors as thin dividers and count-badge anchors
- keep cards mostly neutral white
- reserve strong color for meaningful structural cues, not decoration

The result should feel cleaner and more confident than the current board without becoming a high-saturation “sales theme.”

## Deals vs Leads Alignment

Leads and deals should now read as part of the same board family.

Must match:

- top-band structure
- column proportions
- stage header anatomy
- card spacing
- empty-state treatment
- loading-state treatment
- board background language

May differ:

- summary metrics
- card metadata fields
- stage count/value semantics

## Implementation Direction

Use the old board UI as a visual reference, not as the implementation source of truth.

Implementation should:

- keep the current shared board architecture
- restyle `PipelineBoard`, `PipelineBoardColumn`, and `PipelineRecordCard`
- add lightweight summary/header presentation at the page level in the live `Deals` and `Leads` board pages
- avoid introducing a second parallel board implementation

Likely touchpoints:

- `client/src/pages/deals/deal-list-page.tsx`
- `client/src/pages/leads/lead-list-page.tsx`
- `client/src/components/pipeline/pipeline-board.tsx`
- `client/src/components/pipeline/pipeline-board-column.tsx`
- `client/src/components/pipeline/pipeline-record-card.tsx`

## Acceptance Criteria

The redesign is successful when:

1. `Deals Board` visually reads like the older screenshot's UI language while keeping the current live route and interactions
2. `Leads Board` matches the same visual grammar without changing lead stage names or lead movement rules
3. all current board buttons remain present and behave exactly as they do now
4. stage names remain exactly as live
5. clicking a stage still opens the current dedicated stage page
6. drag-and-drop still follows all current validation rules
7. the board feels less cluttered and easier to scan at current data volumes

## Open Follow-Up

If this board pass lands well, the next slice can extend the same visual system into:

- stage detail pages
- rep/director/admin board embeddings
- broader CRM surfaces that should share the same operator-language theme
