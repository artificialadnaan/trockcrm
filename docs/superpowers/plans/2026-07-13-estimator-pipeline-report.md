# Estimator Pipeline Report Implementation Plan

## Objective

Add a leadership-only report that shows the current active pipeline and current-year won work attributed to Sidney Gibson and Alex Koch, where those projects sit today, and which projects have no linked estimator.

The report is a current-assignment operational view. It does not claim to reconstruct who performed an estimate historically because the platform stores only the current `deals.estimator_user_id` assignment.

## Product contract

### Audience and route

- Roles: admin and director
- Client route: `/reports/operations/estimator-pipeline`
- API routes:
  - `GET /api/reports/estimator-pipeline`
  - `GET /api/reports/estimator-pipeline/evidence`
- Office scope: the currently selected tenant from `X-Office-ID`
- Time scope: live open-pipeline snapshot plus calendar-year-to-date won work; no date picker

### Authoritative identity

- Attribute projects only through `deals.estimator_user_id`.
- Resolve Sidney Gibson and Alex Koch through their unique `public.users.email` values.
- Never infer identity from `deals.estimator`, `deals.bid_board_estimator`, assigned sales rep, or fuzzy display-name matching.
- If either configured user cannot be resolved, show a visible warning instead of presenting a misleading zero.

### Report cohorts

The report keeps two cohorts separate so estimated pipeline and realized won value are never added together:

1. `Open pipeline` uses the live project snapshot and the `Best current estimate` value basis.
2. `Won YTD` uses genuine Won projects whose canonical won-close date falls in the current calendar year and the `Awarded-first won value` basis.

Both cohorts include current projects that are:

- active;
- not test data;
- base projects rather than change-order children;
- not stored on hold.

Open pipeline additionally requires a non-terminal CRM stage and a non-terminal Bid Board mirror state. Won YTD requires the canonical effective Won state and a usable won-close date inside the year-to-date window. Lost and other terminal projects never enter Won YTD.

Change-order children are excluded because they inherit the parent estimator and would double-count one project.

### Reconciliation buckets

Every project in the cohort belongs to exactly one bucket:

1. Sidney Gibson
2. Alex Koch
3. Other assigned estimator
4. Missing estimator

`Missing estimator` means `estimator_user_id IS NULL`, even when a legacy free-text estimator value exists. The evidence view distinguishes:

- no assignment source;
- a legacy name that is not linked to a CRM user; and
- an inactive linked estimator that needs reassignment.

The missing summary also reports the subset already at Estimating or a later open stage.

### Value basis

Use the existing report foundation's `Best current estimate` value chain for open pipeline. Use the canonical `Awarded-first won value` chain for Won YTD. Open and won count/value totals are displayed separately, and every summary/matrix cell must equal the corresponding cohort-filtered evidence result.

## API response design

### Summary

The summary returns:

- generated timestamp and scope definitions;
- the original open value-basis field as a rolling-deploy compatibility alias;
- active open-pipeline count and value;
- Won YTD count, value, and inclusive date window;
- ordered canonical stage columns;
- ordered target estimator summaries with separate open and won metrics;
- other-assigned open and won metrics;
- missing open and won metrics plus the open estimating-or-later subset; and
- configuration warnings.

Stage aliases are canonicalized with the shared workflow contract before totals are merged.

### Evidence

Evidence accepts:

- `cohort=open|won`;
- optional `asOf=YYYY-MM-DD` for Won drills, carried from the summary period so a long-lived tab still reconciles;
- `bucket=target|other|missing`;
- `estimatorKey=sidney_gibson|alex_koch` when `bucket=target`;
- optional canonical `stageSlug` for open-pipeline evidence;
- `page` and `pageSize`.

It returns paginated project records with project/deal number, sales owner, company/property, current stage, days in stage, cohort-specific value and date, linked estimator, legacy estimator text, and assignment issue. The filter metadata identifies the cohort, value basis, and Won YTD period so evidence cannot be mistaken for open pipeline.

## User interface

1. Add an Operations report-library card named `Estimator Pipeline`.
2. Lazy-load the report route to avoid increasing the main CRM entry bundle.
3. Render four drillable workload cards: Sidney, Alex, Other assigned, and Missing. Each card exposes open and Won YTD as separate actions with distinct value labels.
4. Render a responsive semantic distribution matrix. Rows are the four reconciliation buckets; columns use server-provided canonical open-stage order, followed by Open total and Won YTD.
5. Make every non-zero card/cell a native button with an explicit accessible name.
6. Open a wide, focused evidence sheet on drill-down. Use real project links rather than clickable table rows, preserve all evidence fields in responsive cards below desktop width, and provide a visible 44-pixel close target.
7. Preserve the current office query when opening a project.
8. Provide loading skeletons, retryable error state, zero state, configuration warnings, and plain-language definitions.
9. Avoid horizontal scrolling: use a fixed-layout semantic table at desktop width and stacked assignment cards below it.
10. Use semantic color to distinguish open work, Won YTD, unassigned risk, and stage groups without relying on color alone.

The v1 report does not add an inline estimator picker. Assignment changes remain in the existing deal-detail workflow because they affect commissions and already enforce office, conflict, Bid Board, and change-order rules.

## Files

### Shared

- `shared/src/types/estimator-pipeline-report.ts`
- `shared/src/types/index.ts`

### Server

- `server/src/modules/reports/estimator-pipeline-service.ts`
- `server/src/modules/reports/routes.ts`
- focused service and route/parser tests under `server/tests/modules/reports/`

### Client

- `client/src/pages/reports/estimator-pipeline-page.tsx`
- `client/src/pages/reports/estimator-pipeline/estimator-stage-matrix.tsx`
- `client/src/pages/reports/estimator-pipeline/estimator-evidence-sheet.tsx`
- `client/src/hooks/use-estimator-pipeline-report.ts`
- `client/src/App.tsx`
- `client/src/pages/reports/reports-page.tsx`
- focused page, hook, and report-index tests
- `client/e2e/estimator-pipeline-report.spec.ts` for responsive layout and drawer overflow coverage

## Acceptance tests

- Sidney and Alex are resolved by exact unique user identity, never by client-side name matching.
- A third linked estimator appears only in Other assigned.
- A null ID with `Sidney Gibson` in legacy text remains Missing/unmapped.
- An estimator-only project with no sales owner still appears.
- Owner and estimator being the same person counts once.
- Test, inactive, held, and change-order projects are excluded from both cohorts.
- CRM-terminal and Bid-Board-terminal projects are excluded from open pipeline.
- Only genuine Won projects with a canonical won-close date inside the inclusive current-year window enter Won YTD; Lost, null-date, and out-of-period records are excluded.
- Open totals use Best current estimate while Won YTD uses Awarded-first won value; the two values are never summed.
- Historical stage aliases merge into the canonical stage column.
- Missing all-stage count/value, each filtered open-stage cell, and each Won YTD bucket reconcile to cohort-filtered evidence.
- Won drill evidence uses the exact summary period end even when the calendar date changes after the page loaded.
- A missing configured target produces a visible warning and unresolved state.
- Rep/construction requests are rejected; admin/director requests succeed.
- The evidence sheet is keyboard accessible, closes with Escape or a visible touch-sized close control, restores focus, uses real links, and does not horizontally scroll.
- A selected-office change cancels stale requests and reloads both summary and evidence.
- The page remains usable at 320px without page-level, matrix, evidence-scroller, or evidence-sheet horizontal overflow.

## Validation

Run:

```bash
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npm run typecheck:tests --workspace=client
npm test --workspace=server -- tests/modules/reports/estimator-pipeline-service.runtime.test.ts tests/modules/reports/estimator-pipeline-evidence-route.test.ts
npm test --workspace=client -- src/pages/reports/estimator-pipeline-page.test.tsx src/pages/reports/estimator-pipeline/estimator-stage-matrix.test.tsx src/pages/reports/estimator-pipeline/estimator-evidence-sheet.test.tsx src/hooks/use-estimator-pipeline-report.test.tsx
npx playwright test client/e2e/estimator-pipeline-report.spec.ts --config=playwright.config.ts
npm run build --workspace=client
git diff --check
```

No Expo or EAS build is part of this web-report change.
