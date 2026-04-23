# Pipeline Stage Page Visual Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the live deal and lead stage pages so they feel like expanded board context while preserving current routing, pagination, and read-only inspection behavior.

**Architecture:** Keep the existing stage-page route and data contracts intact, and layer the redesign through shared stage header and table primitives plus lightweight page-level summaries derived from current stage payloads. The visual system should match the newly restyled boards without reworking stage-page semantics.

**Tech Stack:** React, React Router, TypeScript, Tailwind, Vitest

---

## File Structure

### Create

- `client/src/lib/pipeline-stage-summary.ts`
  - derives compact stage-page summary metrics for deal and lead stage pages
- `client/src/lib/pipeline-stage-summary.test.ts`
  - locks summary derivation and stage-context formatting rules
- `docs/superpowers/plans/2026-04-22-pipeline-stage-page-visual-restyle.md`
  - execution plan for this slice

### Modify

- `client/src/pages/deals/deal-stage-page.tsx`
  - add stage-context summary band above the table
- `client/src/pages/leads/lead-stage-page.tsx`
  - add matching stage-context summary band above the table
- `client/src/components/pipeline/pipeline-stage-page-header.tsx`
  - restyle shared stage-page header to inherit board language
- `client/src/components/pipeline/pipeline-stage-table.tsx`
  - restyle the table into a denser flattened-board-row workspace
- `client/src/pages/deals/deal-stage-page.test.tsx`
  - extend assertions for the new deal stage-page context band
- `client/src/pages/leads/lead-stage-page.test.tsx`
  - extend assertions for the new lead stage-page context band

## Task 1: Add Stage Summary Derivation

**Files:**
- Create: `client/src/lib/pipeline-stage-summary.ts`
- Create: `client/src/lib/pipeline-stage-summary.test.ts`

- [ ] **Step 1: Write failing summary tests**

Add tests that prove:
- deal stage summaries return count, stage value, and average visible age
- lead stage summaries return count, average visible age, and qualified/opportunity signals inferred from the stage slug

- [ ] **Step 2: Run the new summary tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-stage-summary.test.ts`

Expected: FAIL because the stage-summary helper does not exist yet.

- [ ] **Step 3: Implement the stage summary helper**

Use the existing `DealStagePageResponse` and `LeadStagePageResponse` payloads only. Do not change API contracts.

- [ ] **Step 4: Re-run the summary tests**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-stage-summary.test.ts`

Expected: PASS

## Task 2: Restyle Shared Stage Header And Table

**Files:**
- Modify: `client/src/components/pipeline/pipeline-stage-page-header.tsx`
- Modify: `client/src/components/pipeline/pipeline-stage-table.tsx`

- [ ] **Step 1: Extend the stage-page tests with failing presentation assertions**

Add assertions for:
- stronger back-to-board label still rendering
- summary-band labels rendering on both stage pages
- row data still rendering after the shared table restyle

- [ ] **Step 2: Run the stage-page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: FAIL because the current header and table are still visually minimal.

- [ ] **Step 3: Restyle the shared stage primitives**

Update the shared header and table so:
- the top band inherits the board workspace language
- the table reads like flattened board cards instead of a generic CRUD table
- loading, empty, and pagination controls fit the same operator-console styling

- [ ] **Step 4: Re-run the stage-page tests**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: PASS

## Task 3: Apply Deal And Lead Stage Context Bands

**Files:**
- Modify: `client/src/pages/deals/deal-stage-page.tsx`
- Modify: `client/src/pages/leads/lead-stage-page.tsx`

- [ ] **Step 1: Add failing page assertions for the new summary content**

Add expectations that:
- deals stage pages render count, stage value, and age context
- leads stage pages render count, age, and qualified/opportunity context

- [ ] **Step 2: Run the page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: FAIL because the current pages still pass only a minimal title/subtitle to the shared header.

- [ ] **Step 3: Implement the page-level stage context summaries**

Update both pages to:
- derive summary metrics through the new helper
- pass richer content into the shared stage header
- keep pagination, back-path, and table wiring unchanged

- [ ] **Step 4: Re-run the page tests**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx`

Expected: PASS

## Task 4: Full Verification And Commit

**Files:**
- Modify only if verification exposes defects in the files above

- [ ] **Step 1: Run the focused safety suite**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/pipeline-stage-summary.test.ts client/src/pages/deals/deal-stage-page.test.tsx client/src/pages/leads/lead-stage-page.test.tsx client/src/components/pipeline/pipeline-stage-table.test.tsx`

Expected: PASS

- [ ] **Step 2: Run client typecheck**

Run: `npm run typecheck --workspace=client`

Expected: PASS

- [ ] **Step 3: Review for scope drift**

Confirm the diff is isolated to the planned stage-page files and does not touch board behavior, routing logic, or backend contracts.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-pipeline-stage-page-visual-restyle-design.md \
  docs/superpowers/plans/2026-04-22-pipeline-stage-page-visual-restyle.md \
  client/src/lib/pipeline-stage-summary.ts \
  client/src/lib/pipeline-stage-summary.test.ts \
  client/src/components/pipeline/pipeline-stage-page-header.tsx \
  client/src/components/pipeline/pipeline-stage-table.tsx \
  client/src/pages/deals/deal-stage-page.tsx \
  client/src/pages/deals/deal-stage-page.test.tsx \
  client/src/pages/leads/lead-stage-page.tsx \
  client/src/pages/leads/lead-stage-page.test.tsx
git commit -m "feat: restyle pipeline stage pages"
```
