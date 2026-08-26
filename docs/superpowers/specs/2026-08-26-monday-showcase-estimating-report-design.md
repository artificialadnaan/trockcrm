# Monday Showcase A1 — Estimating Report

## Objective

Add an **A1 · Estimating Report** view to Monday Showcase immediately after **Exec · One Glance**. It gives leadership a compact, reconcilable view of estimating workload, new RFP intake, estimates sent to clients, pricing variance, margin, and RFP intake by sales rep.

The report reuses the existing Monday Showcase period selector and Service/Other department filter. It does not create a second report route, filter bar, or competing definition of a Service project.

## Locked product decisions

### Placement, access, and controls

- The new view is the second showcase variant: `Exec · One Glance`, then `A1 · Estimating Report`, followed by the existing views.
- It is available to the same roles and selected-office scope as Monday Showcase.
- The existing time controls govern the two activity cohorts, not the live queue:
  - **Last full week** is the default and means the prior completed Sunday–Saturday week.
  - **Week-to-date** means the current Sunday through today; it is not a rolling seven-day window.
  - **Month-to-date** and **Year-to-date** expand the same cohorts to their displayed Central-time calendar windows.
  - The UI must use the returned selected-period label, never continue to claim “last 7 days” after the user changes mode.
- The existing Service/Other chips apply to every A1 cohort and every row. `Other` is the established, canonical non-Service complement; the implementation must use `aliasedWorkflowRouteFilterSql`, not a raw `workflow_route` equality.

### Reporting population

All A1 queries exclude test data and use the Showcase’s canonical current reportability rule (`on_hold = false`); no new change-order exclusion is invented. This makes A1 an operational report rather than an immutable historical ledger: a project currently stored on hold is excluded from both the current queue and historical activity cohorts. The activity cohorts otherwise retain the existing Showcase behavior and are not narrowed by a later `is_active` change.

The current-stage query additionally requires `is_active = true` and must use the effective stage `COALESCE(NULLIF(bid_board_stage_slug, ''), CRM stage)` so a Bid Board-owned project is not classified from a stale CRM stage.

This is an operational report. Stored on-hold work is intentionally excluded in the same manner as the rest of the Monday Showcase; the UI must not silently treat excluded work as zero workload.

## A1 sections

### 1. Current projects in Estimating

This is a live current-state list, not a period-entry cohort.

- Include only projects whose effective stage is in shared `ESTIMATED_STAGE_SLUGS`: `estimating`, `service_estimating`, or the legacy `estimate_in_progress` alias.
- Do not include `estimate_under_review` or `estimate_sent_to_client`; they are distinct downstream stages.
- Show a headline with:
  - project count; and
  - total **Known DD Estimate**, plus visible DD coverage (for example, “DD present for 8 of 10 projects”).
- Sum `deals.dd_estimate` directly. Missing DD values contribute nothing to the known-value sum, while the individual row renders `—`, never `$0`.
- Do not use Bid Board Total Sales, bid estimate, awarded amount, or the general “best current estimate” chain for this section. The business question is explicitly the DD value while estimating is still in progress.
- Render a prominent `Live current workload as of <Central-time timestamp>` caption. It must use the response’s generated-at timestamp, not `period.to`; the time controls affect the activity sections below, not this queue.
- Render the full project list with Project, Project # / deal # where present, current stage, DD Estimate, and time in stage. Use the existing hold-aware `aliasedEffectiveStageAgeDaysSql('d')`; sort oldest work first, then project name for a stable tie-break.

### 2. New RFPs submitted

This is a time-bounded intake cohort.

- The report’s business interpretation of “submitted” is **RFP request opened**. Its date is the current cycle’s `deals.rfp_approval_requested_at`; this is deliberately not swapped for Bid Board Created Date, which measures a later, different handoff.
- `rfp_approval_requested_at` is mutable cycle state, not an immutable successful-delivery event: a cancelled/retried or returned-to-opportunity RFP can be cleared or overwritten. The UI must label the section **New RFP submissions initiated** and disclose “current RFP-request cycle; cancelled/restarted cycles are not retained.” It must not claim a confirmed external Bid Board creation.
- Count each project once in the selected period.
- Show the headline count and total **Known DD Estimate**, using the same direct-DD and visible-coverage rule as the current-estimating section.
- The section label must follow the selected period, for example “New RFP submissions initiated — Week to date” or “New RFP submissions initiated — Last full week.”
- Include a supporting project table with Project, Project # / deal #, request-opened date, Current RFP status, Current assigned sales rep, and DD Estimate. The status and sales owner are current fields, not historic snapshots.
- The per-salesperson section below is the supporting breakdown of this exact cohort; its count and DD total must re-sum to the New RFP headline, including an explicit Unassigned row when necessary.

### 3. Estimates sent to client

This is a time-bounded **projects** (not send-events) cohort.

- A project is in the cohort when it entered one of the established sent-to-client stages during the selected period: `estimate_sent_to_client`, `service_estimate_sent_to_client`, or the historical `bid_sent` alias.
- A project that re-entered a sent stage during the same period counts once, with its earliest in-period sent timestamp displayed. This matches the existing Monday Showcase sent-count convention and prevents revision loops from inflating the total.
- Show:
  - number of projects sent;
  - total **Latest Bid Board Total Sales** (`deals.bid_board_total_sales`);
  - total **Current DD Estimate** for comparable projects;
  - dollar and percent variance, defined as `Latest Bid Board Total Sales − Current DD Estimate` and `((Latest Bid Board Total Sales / Current DD Estimate) − 1) × 100` (for example, `20%`);
  - weighted blended margin; and
  - a project table with Project, Project # / deal #, first qualifying sent date, Current DD Estimate, Latest Bid Board Total Sales, variance $, variance %, and Latest Bid Board margin.
- `bid_board_total_sales` is the source for Latest Bid Board Total Sales. Do not quietly substitute `bid_estimate`, awarded value, or a general fallback chain when the export value is missing.
- The current data model does not retain a send-time price, DD, cost, margin, sales-owner, or route snapshot. Therefore the report must make its current/latest source explicit in both card and table captions: it is a selected-period sent-project cohort shown with values **as of page refresh**, not a reconstruction of the exact amount sent on that date.
- Project margin is the current `deals.bid_board_profit_margin_pct`, displayed as the percentage stored by the latest export (for example stored `28.5` renders `28.5%`). Blended margin is value-weighted, not a simple average: `SUM(latest total sales × current margin %) / SUM(latest total sales)` across rows with both a positive latest total and a margin. It must state its coverage, e.g. “weighted across 5 of 7 sent projects.”
- Dollar variance is calculated only for rows with both a DD Estimate and a latest total; percentage variance additionally requires a positive DD denominator. Show separate dollar- and percentage-coverage counts. A missing amount or a zero DD denominator renders `—` for the affected percentage, never `0%`.
- Missing latest totals or margins are visible data-quality gaps. The known-value sum must remain reconcilable, and the section must disclose incomplete rows rather than converting missing data into a confident zero.

### 4. RFPs by salesperson

This table is the selected-period New-RFP-submissions-initiated cohort grouped by current `assigned_rep_id`.

- Show Salesperson, RFP count, and DD Estimate total.
- Resolve names from `public.users.display_name`; a null assignment is an **Unassigned** row. The heading must say **Current assigned sales rep**, because reassignment can move historical attribution in this operational report.
- Rows sort by DD Estimate descending, then name.
- The footer reads the canonical New-RFP count and DD total rather than independently recomputing totals in the browser.

## Data-honesty decision

The platform stores current mutable RFP-cycle fields and latest Bid Board export values, but it does not retain immutable snapshots for RFP initiation/success or for DD / Bid Board Total Sales / margin at the exact moment a project was sent to a client. This PR intentionally ships a transparent operational report, not fabricated history:

- **New RFP submissions initiated** means the current RFP-request cycle opened during the selected period.
- **Projects sent to client** is a historical stage-entry cohort, while its displayed DD, Bid Board Total Sales, margin, and sales-owner values are current/latest as of refresh.
- Service/Other uses the project’s current canonical project-type-aware classification for every cohort; a later retype can therefore move a historical activity row between the two chips, while the two chips remain an exact partition.
- A future append-only event/snapshot feature would need to capture RFP owner/value at initiation and sent price/DD/cost/margin/route at stage entry. It cannot responsibly backfill exact historic values from current mirrors, so it is not silently approximated here.

## API contract

Extend the single `GET /api/reports/monday-showcase` payload with a required `estimatingReport` object. It is calculated in the existing service transaction with the same `period` and parsed `routes` selection as the rest of the payload.

```ts
interface EstimatingMetric {
  count: number;
  ddValue: number;
  missingDdCount: number;
}

interface CurrentEstimatingProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  stageLabel: string;
  ddEstimate: number | null;
  daysInStage: number | null;
}

interface RfpInitiatedProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  requestedAt: string;
  currentRfpStatus: string | null;
  assignedRepId: string | null;
  assignedRepName: string;
  ddEstimate: number | null;
}

interface EstimateSentProject {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  sentAt: string;
  ddEstimate: number | null;
  latestBidBoardTotalSales: number | null;
  varianceAmount: number | null;
  variancePercent: number | null;
  marginPercent: number | null;
}

interface EstimatingReport {
  currentAsOf: string;
  currentEstimating: EstimatingMetric & { projects: CurrentEstimatingProject[] };
  newRfps: EstimatingMetric & { projects: RfpInitiatedProject[] };
  rfpBySalesperson: Array<{ repId: string | null; repName: string; count: number; ddValue: number; missingDdCount: number }>;
  estimatesSent: {
    count: number;
    latestBidBoardTotalSales: number;
    projects: EstimateSentProject[];
    comparison: {
      dollarComparableCount: number;
      percentageComparableCount: number;
      dollarComparableDdValue: number;
      dollarComparableLatestBidBoardTotalSales: number;
      varianceAmount: number;
      percentageComparableDdValue: number;
      percentageComparableLatestBidBoardTotalSales: number;
      variancePercent: number | null; // formatted percent units, e.g. 20 => "20%"
    };
    margin: { projectCount: number; latestBidBoardTotalSales: number; blendedPercent: number | null };
    missingSentValueCount: number;
    missingMarginCount: number;
  };
}
```

All money values are finite numbers rounded to cents during assembly. Client display helpers must not infer a missing value from zero. A real stored zero remains `0`; only SQL null is missing.

## Query and assembly requirements

1. Build dedicated, exported SQL builders for current-estimating, RFP-submission, and sent-estimate cohorts so their predicates can be SQL-shape tested.
2. Pass the same `routes` value to each builder. The Service bucket plus Other bucket must equal the unfiltered cohort.
3. Use CT-calendar-date predicates for timestamp period windows, matching existing Showcase stage-entry cohorts. `currentAsOf` must be generated from the server’s report time and is deliberately independent of the period window.
4. Use `deal_stage_history` for sent-stage entry, not the current stage, so a project later moved onward remains credited to the period in which it was sent.
5. Query actual project rows once for each list cohort and derive its headline/breakdown totals in server assembly. This makes a visible row set the source of the published metric and lets every subtotal reconcile by construction.
6. Query and format user names server-side. Do not derive a salesperson from estimator, Bid Board free text, or project name. RFP attribution is current assigned sales-rep attribution, never silently presented as historic ownership or request actor.

## User interface

- Add `A1` to `SHOWCASE_VARIANTS` directly after the Exec tile and wire a `VariantA1EstimatingReport` component into the existing variant map.
- Keep the A1 view inside the existing `DrillProvider`, but the requested current-estimating list and sent-estimate table are direct supporting evidence, so users can see exactly which rows produce each total without a new endpoint.
- Use responsive semantic tables with the existing synchronized horizontal-scroll treatment on narrow widths; do not hide the DD, latest Bid Board total, variance, or margin information on mobile.
- Provide clear zero states for each section and loading/error behavior through the existing page shell.
- Make coverage and source notes visible in A1, not only in the collapsed page-level source notes.

## Acceptance criteria

- A1 is directly after Exec and respects all existing period choices and Service/Other filters.
- Current-estimating total equals its visible table’s known-DD sum; projects in an estimate-sent or under-review stage do not appear, and the section visibly states a live `currentAsOf` timestamp.
- New-RFP headline equals the summed salesperson rows, including Unassigned.
- Sent count uses distinct projects, not repeated stage events; its visible project rows equal the headline count.
- Latest Bid Board Total Sales never falls back to a non-Bid-Board amount.
- Aggregate and project-level variance use only comparable values; dollar and percentage coverage are distinct, and zero/missing denominators never show a fabricated percentage.
- Blended margin is value-weighted and its data-coverage denominator is visible.
- Current/latest source labels and the RFP current-cycle limitation are visible in A1, not hidden in source notes.
- Every new section’s Service plus Other totals re-sum to the unfiltered total.
- Historical alias rows are handled consistently with the existing Showcase sent and estimating contracts.
- Existing Showcase variants and route/evidence behavior remain unchanged.

## Verification

- Server SQL-shape and runtime tests for cohort membership, dates, route partitioning, DD-vs-latest-export source selection, sent-stage de-duplication, variance, margin weighting, current-as-of semantics, reassignment behavior, and missing-data coverage.
- Client tests for A1 placement, selected-period labels, summaries, tables, zero/missing states, and responsive column visibility.
- A mutation test that intentionally changes the DD/sent comparison or blended-margin guard and proves the targeted tests fail before restoring the source.
- Full repository-required typechecks and CI-equivalent test command before PR.
- After merge/deploy, browser verification of the live A1 tab, a route-filter change, a period change, visible rows/totals, and sent-estimate/variance/margin rendering.
