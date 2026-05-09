# Track G2 Review - Iteration 2

## Calculation Findings
- Scenario 1 passes by construction: earned rows are locked values from `deal_signed_commissions`, pipeline rows are current deal value times current rate.
- Scenario 2 passes: all requested pre-signed stage buckets are represented, including legacy/service aliases.
- Scenario 3 passes: lost stages are not included in earned and cannot enter pipeline.

## Potential Calculation Regression
- The old potential endpoint still describes/uses estimated margin for legacy charts. The new dashboard endpoint intentionally follows the user prompt and does not alter old endpoints. This avoids breaking other consumers while making `/commissions` correct.

## Test Coverage Check
- Period range coverage added.
- Client coverage includes KPI strip, refetch, proportional stage display, goal progress, grouping/context, row values/rates/deltas, link semantics, export, and total row.
- Backend coverage includes rep scoping, value-times-rate pipeline calculation, stage order, delta mapping, period ranges, and migration markers.

## Verdict
No additional code changes required from calculation review.
