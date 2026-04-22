# Record Detail Visual Restyle

**Date:** 2026-04-22
**Scope:** Visual restyle of the lead and deal detail pages so the drill-in flow from board to stage page to record detail feels coherent end to end

## Goal

Make the lead and deal detail pages inherit the new board and stage-page visual language without removing current functionality.

This pass should:

- make `Deal Detail` feel like the next layer of the pipeline workspace rather than a crowded admin document
- make `Lead Detail` match that same product family
- keep the existing tab model for deals
- strengthen the first screen so the most important context and actions are visible immediately

## Non-Goals

- removing existing deal tabs or modules
- redesigning every nested tab body from scratch
- changing stage-gate, conversion, or routing behavior
- changing backend contracts
- rewriting lead/deal business logic

## Audit Summary

The board and stage pages now share one visual language, but the record detail pages still diverge.

Current issues:

1. `client/src/pages/deals/deal-detail-page.tsx` is functionally rich but visually crowded and top-heavy
2. the deal page header competes with too many controls at once and lacks a clear first-screen hierarchy
3. the deal tab strip is useful, but visually noisy
4. `client/src/pages/leads/lead-detail-page.tsx` already has stronger hierarchy than deals, but it still does not match the new board/stage treatment
5. leads and deals still feel like two separate products once the user drills into a record

## Design Thesis

Keep the current functional architecture, but make the detail pages read like a focused record workspace:

- stronger context band at the top
- cleaner primary actions
- denser, calmer summary region
- tabs remain, but they become cleaner navigation rather than the dominant visual feature

This is an end-to-end continuity pass, not a tab-system rewrite.

## Product Direction

### 1. Shared Detail Grammar

Leads and deals should share:

- a stronger back path to their parent collection
- a record-context hero band
- a compact summary strip with high-signal metrics
- calmer section spacing and reduced chrome
- clearer action hierarchy

They may differ in:

- available actions
- summary metrics
- tab/module count
- operational panels specific to one entity

### 2. Deal Detail Direction

Keep the current tab model, but improve the first screen.

Deal page priorities:

- record identity
- current stage and movement context
- assigned rep / ownership
- value and forecast signal
- next actions

The top of the page should stop feeling like a pile of buttons and cards and instead feel like a structured operating header with the most important context above the fold.

Tabs stay, but the chrome around them should get cleaner and lighter.

### 3. Lead Detail Direction

Lead detail should become the lead-side equivalent of the same system.

Lead page priorities:

- record identity
- stage / qualification state
- company and property context
- assigned rep
- qualification/scoping urgency
- conversion status or conversion CTA when appropriate

Lead detail already has a better split layout than deals; the redesign should preserve that strength while aligning its styling and summary logic with the rest of the new pipeline surfaces.

## Visual System

### 1. Context Band

Both record detail pages should begin with an expanded record-context band.

Shared behavior:

- strong back-link
- record id / stage / status context
- large title
- supporting business context beneath it
- compact first-screen summary metrics

This band should feel like the record equivalent of the board and stage summary bands.

### 2. Summary Strip

`Deals` summary should emphasize:

- stage
- value / estimate context
- age in stage or freshness
- ownership and next-step signal

`Leads` summary should emphasize:

- stage
- age / freshness
- assignment
- qualification / conversion readiness

The summary strip should orient the operator quickly, not duplicate everything deeper in the page.

### 3. Action Hierarchy

Actions should be visually prioritized instead of all competing equally.

Rules:

- primary actions remain obvious
- destructive or secondary actions move into calmer secondary affordances
- stage movement actions should feel connected to pipeline context, not generic toolbar controls

### 4. Tab Navigation

Deal tabs remain, but their treatment should be simpler and more integrated with the page.

Goals:

- less visual noise
- clearer active state
- better relationship between first-screen context and deeper modules

This pass does not remove tabs. It makes them less clunky.

### 5. Section Rhythm

Below the context band, both detail pages should use:

- fewer heavy card stacks
- more intentional grouping
- denser but calmer spacing
- consistent panel language with the restyled board/stage surfaces

## Implementation Direction

Implementation should focus first on the page-level layout and high-signal modules closest to the top of each detail page.

Likely touchpoints:

- `client/src/pages/deals/deal-detail-page.tsx`
- `client/src/pages/leads/lead-detail-page.tsx`
- selected top-of-page supporting components such as:
  - `client/src/components/deals/deal-overview-tab.tsx`
  - `client/src/components/leads/lead-form.tsx`
  - stage badge treatments only if needed for visual consistency

Avoid broad churn across every nested tab unless the top-level restyle makes a change unavoidable.

## Acceptance Criteria

The redesign is successful when:

1. the user can move from board to stage page to record detail without the UI feeling like a different product
2. deal detail keeps all current functional tabs but feels materially less crowded
3. lead detail matches the same visual family as deals, boards, and stage pages
4. the first screen on both pages surfaces the most useful context and actions immediately
5. no current lead/deal workflow behavior is lost

## Open Follow-Up

If this pass lands well, the next slices can target:

- selected nested tabs with the highest usage
- broader CRM-wide normalization of page headers and section rhythm
- shared record-context primitives reusable beyond leads and deals
