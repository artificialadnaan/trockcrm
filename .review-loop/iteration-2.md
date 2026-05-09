# Track G2 Internal Review - Iteration 2

## Changes Since Iteration 1
- Added deterministic coverage for MTD/QTD/YTD/All period boundaries.

## Calculation Stress Scenarios
1. Rep has 2 signed deals worth `$100,000` and `$32,000` at `1.5%`, plus 1 contract deal worth `$305,000` at `1.5%`.
   - Expected earned: `$1,980.00`
   - Expected pipeline: `$4,575.00`
   - Expected total potential: `$6,555.00`
   - Code path: signed rows use `deal_signed_commissions.amount`; contract row uses deal value times `commission_rate`.

2. Rep has unsigned deals in estimate sent, estimating, and opportunity. None has `contract_signed_at` or `contract_signed_date`.
   - Expected earned: unchanged
   - Expected pipeline: sum of each current deal value times current rep rate
   - Expected grouping: estimate sent -> `estimate_sent`, estimating aliases -> `estimating`, opportunity -> `opportunity`.

3. Rep has a lost deal with a signed commission row.
   - Expected excluded from earned and pipeline.
   - Code path: earned side filters lost slugs; pipeline side includes only active unsigned canonical pre-signed stages.

## Test Results Carried Forward
- `npm run typecheck`: pass before period-test addition
- Focused vitest: 16 pass before period-test addition

## Open Concerns
- No commission goal table/field was found. UI intentionally shows no-goal state instead of inventing a target.
- Snapshot refresh is write-on-read. It is the smallest scoped way to make deltas persist between sessions without adding a separate recalculation worker.
