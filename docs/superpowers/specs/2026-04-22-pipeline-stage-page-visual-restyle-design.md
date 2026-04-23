# Pipeline Stage Page Visual Restyle

**Date:** 2026-04-22
**Scope:** Visual restyle of the canonical lead and deal stage-detail pages so they feel like expanded board context instead of generic table screens

## Goal

Make the dedicated stage pages inherit the same visual language as the newly restyled boards while preserving the existing route model, pagination model, and stage inspection behavior.

This pass should:

- make `/deals/stages/:stageId` feel like an expanded view of the deals board
- make `/leads/stages/:stageId` feel like an expanded view of the leads board
- preserve current back-path behavior, pagination behavior, and read-only stage-page semantics
- make the table rows feel like flattened board cards rather than a default CRUD table

## Non-Goals

- changing stage routes or route normalization logic
- adding drag-and-drop to stage pages
- changing search, sort, or pagination contracts
- changing stage-gate or approval rules
- redesigning record detail pages in this slice
- changing board behavior again in this slice

## Audit Summary

The board surfaces now carry the intended visual language, but the stage pages still break that mental model.

Current issues:

1. `client/src/pages/deals/deal-stage-page.tsx` and `client/src/pages/leads/lead-stage-page.tsx` render a structurally correct but visually minimal page
2. `client/src/components/pipeline/pipeline-stage-page-header.tsx` is a generic title block, not a board-derived stage context header
3. `client/src/components/pipeline/pipeline-stage-table.tsx` reads like a default table instead of a continuation of the board system
4. clicking from a styled board into a plain stage page currently feels like context loss

## Design Thesis

The stage page should feel like the user stepped inside one stage of the board.

It should read as:

- same workspace family as the board
- more focused and inspection-oriented
- denser and calmer
- still operational, not editorial

This is `expanded board context`, not `generic spreadsheet workspace`.

## Product Direction

### 1. Scope

This redesign applies to:

- `Deals` stage pages at `/deals/stages/:stageId`
- `Leads` stage pages at `/leads/stages/:stageId`
- shared stage-page header and stage-table primitives

This redesign does not apply to:

- the board pages already restyled in the prior slice
- record detail pages
- dashboard-embedded stage previews

### 2. Structural Rules

The following stay unchanged:

- current stage-page routes
- current back-link target behavior
- current pagination model
- current sort/search/filter model
- stage pages remain read-only for movement
- board remains the only drag-and-drop surface

The mental model stays:

- `board` = move work
- `stage page` = inspect work in one stage

## Visual System

### 1. Page Context Header

The top of the stage page should become a full stage-context band instead of a plain heading.

Shared behavior:

- strong back-to-board link
- current stage name as the headline
- concise supporting line that explains count and scope
- stage-accent treatment tied to the same stage language used on the board
- a summary strip beneath the title so the page explains the stage before the table starts

This should feel like a stage has been opened, not like a new unrelated module has loaded.

### 2. Summary Strip

`Deals` stage pages should emphasize:

- count in stage
- total stage value
- average age or throughput signal

`Leads` stage pages should emphasize:

- count in stage
- average age or staleness signal
- qualified/opportunity pressure if that stage participates in those categories

The summary strip should be compact and operational, not a dashboard wall.

### 3. Table Direction

The table should behave like board cards flattened into rows.

That means:

- tighter vertical rhythm
- stronger first column hierarchy
- muted supporting columns
- rows that feel like operational records, not spreadsheets
- hover treatment that connects visually to the card system

Rows should not become decorative cards, but they should inherit the same typography, spacing, and signal hierarchy as the board cards.

### 4. Header and Table Alignment

Stage pages should visually match the boards through:

- the same light workspace surface inside the dark shell
- similar accent-color logic
- consistent typography for labels, counts, and metadata
- similar spacing language between summary band and main content

## Deals vs Leads Differences

Must match:

- top-band structure
- back-link treatment
- stage-accent framing
- table density and row rhythm
- loading and error presentation

May differ:

- summary metrics
- column labels
- monetary emphasis on deals versus count/aging emphasis on leads

## Implementation Direction

Keep the existing shared stage-page architecture and restyle it through shared primitives.

Implementation should:

- restyle `PipelineStagePageHeader`
- restyle `PipelineStageTable`
- add lightweight derived summary context in the deal and lead stage pages using the data already returned by current hooks
- avoid introducing a second stage-page implementation

Likely touchpoints:

- `client/src/pages/deals/deal-stage-page.tsx`
- `client/src/pages/leads/lead-stage-page.tsx`
- `client/src/components/pipeline/pipeline-stage-page-header.tsx`
- `client/src/components/pipeline/pipeline-stage-table.tsx`
- stage-page tests for deals and leads

## Acceptance Criteria

The redesign is successful when:

1. a user clicking from a board into a stage page still feels inside the same product surface
2. deals and leads stage pages match the new board language without changing routes or semantics
3. rows feel like flattened board cards rather than a plain generic table
4. back-to-board navigation remains clear and unchanged in behavior
5. pagination and stage inspection still work exactly as they do now

## Open Follow-Up

If this slice lands well, the next visual extension can target:

- record detail pages
- board embeddings inside rep/director/admin dashboards
- broader CRM surface normalization around the same operator-language theme
