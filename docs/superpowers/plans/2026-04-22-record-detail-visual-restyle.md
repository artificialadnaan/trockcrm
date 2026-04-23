# Record Detail Visual Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the lead and deal detail pages so the drill-in flow from board to stage page to record detail feels coherent, while preserving all current lead/deal workflows and the deal tab model.

**Architecture:** Keep the existing page and module structure, and layer the redesign through page-level record-context bands, lightweight summary helpers, and selective restyling of the top-of-page detail components most visible on first load. This pass avoids deep churn in lower tab bodies unless required for first-screen continuity.

**Tech Stack:** React, React Router, TypeScript, Tailwind, Vitest

---

## File Structure

### Create

- `client/src/lib/record-detail-summary.ts`
  - derives compact first-screen summary metrics for deal and lead detail pages
- `client/src/lib/record-detail-summary.test.ts`
  - locks summary derivation rules for deal and lead record context bands
- `docs/superpowers/plans/2026-04-22-record-detail-visual-restyle.md`
  - execution plan for this slice

### Modify

- `client/src/pages/deals/deal-detail-page.tsx`
  - add expanded record-context band, calmer action hierarchy, and cleaner tab chrome
- `client/src/pages/leads/lead-detail-page.tsx`
  - align lead detail with the same record-context language
- `client/src/components/deals/deal-overview-tab.tsx`
  - tune the top overview region to better match the new detail-page system
- `client/src/components/leads/lead-form.tsx`
  - align the lead-side summary card with the new detail context band
- `client/src/pages/deals/deal-detail-page.test.tsx`
  - update assertions for the new deal detail first-screen context
- `client/src/pages/leads/lead-detail-page.test.tsx`
  - update assertions for the new lead detail first-screen context

## Task 1: Add Record Detail Summary Derivation

**Files:**
- Create: `client/src/lib/record-detail-summary.ts`
- Create: `client/src/lib/record-detail-summary.test.ts`

- [ ] **Step 1: Write failing summary tests**

Add tests that prove:
- deal detail summaries derive stage age, best available value, and freshness context from the current deal payload
- lead detail summaries derive stage age, freshness, and conversion-state context from the current lead payload

- [ ] **Step 2: Run the new summary tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/record-detail-summary.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement the summary helper**

Use the current `DealDetail` and `LeadDetail` page payloads only. Do not change backend contracts.

- [ ] **Step 4: Re-run the summary tests**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/record-detail-summary.test.ts`

Expected: PASS

## Task 2: Update Detail Page Tests For The New First-Screen Context

**Files:**
- Modify: `client/src/pages/deals/deal-detail-page.test.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`

- [ ] **Step 1: Extend the deal and lead detail tests with failing first-screen assertions**

Add expectations that:
- deal detail renders the new context band labels and cleaned primary hierarchy
- lead detail renders the matching context language and summary strip

- [ ] **Step 2: Run the detail-page tests to verify they fail**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-detail-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx`

Expected: FAIL because the current pages still render the older first-screen layout.

## Task 3: Restyle Deal Detail First Screen

**Files:**
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `client/src/components/deals/deal-overview-tab.tsx`

- [ ] **Step 1: Implement the new deal context band and action hierarchy**

Update the deal page so:
- the top band reads like the next layer of the pipeline workspace
- key context and actions are above the fold
- tabs remain but get calmer visual treatment

- [ ] **Step 2: Tune the overview tab to match the new detail-page system**

Adjust the overview tab so the top section does not visually fight the new page header.

- [ ] **Step 3: Re-run the deal detail test**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/deals/deal-detail-page.test.tsx`

Expected: PASS

## Task 4: Restyle Lead Detail First Screen

**Files:**
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/components/leads/lead-form.tsx`

- [ ] **Step 1: Implement the new lead context band and summary strip**

Update the lead page so:
- the top section visually matches the deal detail grammar
- conversion and advancement actions have clearer priority
- the first screen feels connected to the stage-page and board system

- [ ] **Step 2: Align the lead summary card**

Tune `LeadForm` so its presentation supports the new record context instead of duplicating noisy header information.

- [ ] **Step 3: Re-run the lead detail test**

Run: `npx vitest run --config client/vite.config.ts client/src/pages/leads/lead-detail-page.test.tsx`

Expected: PASS

## Task 5: Full Verification And Commit

**Files:**
- Modify only if verification exposes defects in the files above

- [ ] **Step 1: Run the focused detail-page suite**

Run: `npx vitest run --config client/vite.config.ts client/src/lib/record-detail-summary.test.ts client/src/pages/deals/deal-detail-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx`

Expected: PASS

- [ ] **Step 2: Run client typecheck**

Run: `npm run typecheck --workspace=client`

Expected: PASS

- [ ] **Step 3: Review for scope drift**

Confirm the diff is isolated to the planned detail-page files and does not change lead/deal workflow behavior or unrelated modules.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-record-detail-visual-restyle-design.md \
  docs/superpowers/plans/2026-04-22-record-detail-visual-restyle.md \
  client/src/lib/record-detail-summary.ts \
  client/src/lib/record-detail-summary.test.ts \
  client/src/pages/deals/deal-detail-page.tsx \
  client/src/pages/deals/deal-detail-page.test.tsx \
  client/src/pages/leads/lead-detail-page.tsx \
  client/src/pages/leads/lead-detail-page.test.tsx \
  client/src/components/deals/deal-overview-tab.tsx \
  client/src/components/leads/lead-form.tsx
git commit -m "feat: restyle record detail pages"
```
