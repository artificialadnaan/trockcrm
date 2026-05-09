# Track G2 Review - Iteration 1

## Spec Walkthrough
- Header: implemented with `COMMISSIONS`, `YOUR EARNINGS · PER PROJECT`, My commissions active, Team disabled/hidden.
- Period tabs: implemented for MTD/QTD/YTD/All and refetches.
- KPI strip: implemented with earned red, pipeline blue accent, total potential green accent.
- Pipeline by stage: implemented in fixed order and proportional to commission dollars.
- Goal progress: implemented, but no goal source exists in schema; renders no-goal state.
- Projects table: implemented grouped by stage with the required context strings, deal value, rate, commission, delta, link semantics, and total row.
- Export: implemented client-side CSV.

## Calculation Review
- Earned uses `deal_signed_commissions.amount`, which is the locked amount from contract signing.
- Pipeline uses `(awarded_amount -> bid_estimate -> dd_estimate + change_order_total) * commission_rate`, matching the prompt.
- Total potential = earned + unsigned active pipeline.
- Stages are normalized to the five screenshot buckets.

## Three-State Model Review
- Earned and potential are represented. Removed/lost deals are excluded via lost-stage filtering and signed non-lost filtering.
- The screenshot build did not request a visible Removed bucket for the sales-rep page, so no removed group was added.

## Security Review
- Rep users are forced to `req.user.id` in the dashboard endpoint.
- The UI does not expose rep selection.
- Existing admin/director route guard for `/commissions` remains outside this page; this endpoint still cannot show another rep to a rep.

## Issues Found
1. `getCommissionPeriodDateRange` should have a deterministic unit test for MTD/QTD/YTD/All.
2. The final report and PR body must explicitly call out that goal storage is missing and no synthetic goal was invented.
3. The snapshot table write-on-read should be documented as intentional because no central recalculation job currently exists.

## Verdict
Proceed after adding period range test coverage and documenting the goal/snapshot decisions.
