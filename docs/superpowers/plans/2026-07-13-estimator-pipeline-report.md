# Estimator Pipeline Report Implementation Plan

## Objective

Add a leadership-only report that shows the current active pipeline attributed to Sidney Gibson and Alex Koch, where those projects sit today, and which projects have no linked estimator.

The report is a current-assignment operational view. It does not claim to reconstruct who performed an estimate historically because the platform stores only the current `deals.estimator_user_id` assignment.

## Product contract

### Audience and route

- Roles: admin and director
- Client route: `/reports/operations/estimator-pipeline`
- API routes:
  - `GET /api/reports/estimator-pipeline`
  - `GET /api/reports/estimator-pipeline/evidence`
- Office scope: the currently selected tenant from `X-Office-ID`
- Time scope: live snapshot; no date picker

### Authoritative identity

- Attribute projects only through `deals.estimator_user_id`.
- Resolve Sidney Gibson and Alex Koch through their unique `public.users.email` values.
- Never infer identity from `deals.estimator`, `deals.bid_board_estimator`, assigned sales rep, or fuzzy display-name matching.
- If either configured user cannot be resolved, show a visible warning instead of presenting a misleading zero.

### Pipeline cohort

Include current projects that are:

- active;
- not test data;
- base projects rather than change-order children;
- not stored on hold;
- in a non-terminal CRM stage; and
- not terminal in the Bid Board mirror.

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

Use the existing report foundation's `Best current estimate` value chain. Count and value totals in every summary/matrix cell must equal the corresponding evidence result.

## API response design

### Summary

The summary returns:

- generated timestamp and scope definitions;
- active pipeline count and value;
- ordered canonical stage columns;
- ordered target estimator summaries;
- other-assigned summary;
- missing summary plus the estimating-or-later subset; and
- configuration warnings.

Stage aliases are canonicalized with the shared workflow contract before totals are merged.

### Evidence

Evidence accepts:

- `bucket=target|other|missing`;
- `estimatorKey=sidney_gibson|alex_koch` when `bucket=target`;
- optional canonical `stageSlug`;
- `page` and `pageSize`.

It returns paginated project records with project/deal number, sales owner, company/property, current stage, days in stage, best-current-estimate value, expected close date, linked estimator, legacy estimator text, and assignment issue.

## User interface

1. Add an Operations report-library card named `Estimator Pipeline`.
2. Lazy-load the report route to avoid increasing the main CRM entry bundle.
3. Render four drillable summary cards: Sidney, Alex, Other assigned, and Missing.
4. Render a semantic stage matrix. Rows are the four reconciliation buckets; columns use server-provided canonical stage order.
5. Make every non-zero card/cell a native button with an explicit accessible name.
6. Open a focused evidence sheet on drill-down. Use real project links rather than clickable table rows.
7. Preserve the current office query when opening a project.
8. Provide loading skeletons, retryable error state, zero state, configuration warnings, and plain-language definitions.
9. Keep the matrix legible through synchronized horizontal scrolling on narrow screens.

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

## Acceptance tests

- Sidney and Alex are resolved by exact unique user identity, never by client-side name matching.
- A third linked estimator appears only in Other assigned.
- A null ID with `Sidney Gibson` in legacy text remains Missing/unmapped.
- An estimator-only project with no sales owner still appears.
- Owner and estimator being the same person counts once.
- Test, inactive, held, change-order, CRM-terminal, and Bid-Board-terminal projects are excluded.
- Historical stage aliases merge into the canonical stage column.
- Missing all-stage count/value and each filtered stage cell reconcile to evidence.
- A missing configured target produces a visible warning and unresolved state.
- Rep/construction requests are rejected; admin/director requests succeed.
- The evidence sheet is keyboard accessible, closes with Escape, restores focus, and uses real links.
- A selected-office change cancels stale requests and reloads both summary and evidence.
- The page remains usable at 320px without page-level horizontal overflow.

## Validation

Run:

```bash
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npm test --workspace=server -- tests/modules/reports/estimator-pipeline-service.test.ts
npm test --workspace=client -- src/pages/reports/estimator-pipeline-page.test.tsx src/pages/reports/reports-page.test.tsx
npm run build --workspace=client
git diff --check
```

No Expo or EAS build is part of this web-report change.
