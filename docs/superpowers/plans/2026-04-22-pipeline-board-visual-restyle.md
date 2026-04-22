# Pipeline Board Visual Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the live deals and leads board views so they recover the older pipeline UI language while preserving current routes, stage names, buttons, and workflow behavior.

**Architecture:** Keep the current shared board system intact and layer the redesign through three focused slices: board-summary derivation at the page level, shared board-column/card restyling, and targeted test updates that lock the new presentation without touching movement logic. The client remains the only surface changed in this pass.

**Tech Stack:** React, React Router, TypeScript, Tailwind, Vitest

---

## File Structure

### Create

- `client/src/lib/pipeline-board-summary.ts`
  - derives high-signal summary-strip metrics for deals and leads from existing board payloads
- `client/src/lib/pipeline-board-summary.test.ts`
  - locks the summary derivation rules for both entities
- `docs/superpowers/plans/2026-04-22-pipeline-board-visual-restyle.md`
  - execution plan for this worktree

### Modify

- `client/src/pages/deals/deal-list-page.tsx`
  - apply the screenshot-style header/status/summary treatment to the live deals board page
- `client/src/pages/leads/lead-list-page.tsx`
  - apply the matching header/status/summary treatment to the live leads board page
- `client/src/components/pipeline/pipeline-board.tsx`
  - update board shell spacing, loading state, and shared board background treatment
- `client/src/components/pipeline/pipeline-board-column.tsx`
  - restyle the stage header, accent rule, count badge, and card bay
- `client/src/components/pipeline/pipeline-record-card.tsx`
  - restyle board cards toward the older flatter operating-surface treatment
- `client/src/components/pipeline/pipeline-board.test.tsx`
  - update shared board assertions for the new summary/column output
- `client/src/pages/deals/deal-list-page.test.tsx`
  - replace old list-era expectations with current board-header summary expectations
- `client/src/pages/leads/lead-list-page.test.tsx`
  - add assertions for the new leads summary/header treatment while preserving bucket-filter coverage

## Task 1: Add Summary Derivation For Deals And Leads

**Files:**
- Create: `client/src/lib/pipeline-board-summary.ts`
- Create: `client/src/lib/pipeline-board-summary.test.ts`

- [ ] **Step 1: Write failing summary tests**

Add tests that prove:
- deal summaries return total managed value, active record count, live stage count, and average age
- lead summaries return active lead count, live stage count, average age, and qualified/opportunity pressure

- [ ] **Step 2: Run the new summary tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-board-summary.test.ts`

Expected: FAIL because the summary helper does not exist yet.

- [ ] **Step 3: Implement the summary helper with existing board payloads only**

Use the current `DealBoardResponse` and `LeadBoardResponse` shapes to derive display-ready summary items without changing any API contracts.

- [ ] **Step 4: Re-run the summary tests**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-board-summary.test.ts`

Expected: PASS

## Task 2: Restyle The Shared Board Shell, Columns, And Cards

**Files:**
- Modify: `client/src/components/pipeline/pipeline-board.tsx`
- Modify: `client/src/components/pipeline/pipeline-board-column.tsx`
- Modify: `client/src/components/pipeline/pipeline-record-card.tsx`
- Modify: `client/src/components/pipeline/pipeline-board.test.tsx`

- [ ] **Step 1: Extend the board test with failing assertions for the new presentation**

Add assertions for:
- stage total display when `totalValue` is present
- the stronger `View all N` affordance remaining visible
- card metadata still rendering after the restyle

- [ ] **Step 2: Run the shared board test to verify it fails**

Run: `npx vitest run --config client/vite.config.ts client/src/components/pipeline/pipeline-board.test.tsx`

Expected: FAIL because the board does not yet render the new presentation details.

- [ ] **Step 3: Restyle the shared board primitives**

Update the board shell so:
- the board uses a lighter workspace treatment
- columns get accent-top framing and a stronger header hierarchy
- cards become flatter, tighter, and more screenshot-aligned
- loading and empty states match the new board language

- [ ] **Step 4: Re-run the shared board test**

Run: `npx vitest run --config client/vite.config.ts client/src/components/pipeline/pipeline-board.test.tsx`

Expected: PASS

## Task 3: Apply The New Header And Summary Bands To Deals And Leads

**Files:**
- Modify: `client/src/pages/deals/deal-list-page.tsx`
- Modify: `client/src/pages/leads/lead-list-page.tsx`
- Modify: `client/src/pages/deals/deal-list-page.test.tsx`
- Modify: `client/src/pages/leads/lead-list-page.test.tsx`

- [ ] **Step 1: Update page tests with failing expectations for the new top-band content**

Add assertions that:
- the deals page renders the screenshot-style status row and summary labels while keeping `New Deal`
- the leads page renders the matching summary strip while preserving bucket filtering

- [ ] **Step 2: Run the page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-list-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx`

Expected: FAIL because the current pages still use the minimal headers.

- [ ] **Step 3: Implement the page-level restyle**

Update both pages to:
- render the summary strip above the board
- preserve current button placement and behaviors
- keep current board movement and stage drill-through wiring untouched
- use the shared summary helper rather than duplicating metric logic in each page

- [ ] **Step 4: Re-run the page tests**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-list-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx`

Expected: PASS

## Task 4: Full Verification And Cleanup

**Files:**
- Modify only if verification exposes defects in the files above

- [ ] **Step 1: Run the focused visual-regression safety suite**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-board-summary.test.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/pages/deals/deal-list-page.test.tsx client/src/pages/leads/lead-list-page.test.tsx client/src/pages/leads/lead-list-page.move.test.tsx`

Expected: PASS

- [ ] **Step 2: Run client typecheck**

Run: `npm run typecheck --workspace=client`

Expected: PASS

- [ ] **Step 3: Review for scope drift**

Confirm the diff is isolated to the planned files and does not touch routing, backend contracts, or stage-movement rules.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-22-pipeline-board-visual-restyle.md \
  client/src/lib/pipeline-board-summary.ts \
  client/src/lib/pipeline-board-summary.test.ts \
  client/src/components/pipeline/pipeline-board.tsx \
  client/src/components/pipeline/pipeline-board-column.tsx \
  client/src/components/pipeline/pipeline-record-card.tsx \
  client/src/components/pipeline/pipeline-board.test.tsx \
  client/src/pages/deals/deal-list-page.tsx \
  client/src/pages/deals/deal-list-page.test.tsx \
  client/src/pages/leads/lead-list-page.tsx \
  client/src/pages/leads/lead-list-page.test.tsx
git commit -m "feat: restyle pipeline board views"
```
