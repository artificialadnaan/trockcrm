# Bid Board Estimate Sync Diagnosis

## Root Cause

The Bid Board ingestion path already parses `Total Sales` into `NormalizedBidBoardRow.bidBoardTotalSales` and mirrors it into `office_dallas.deals.bid_board_total_sales`, but the CRM-owned estimate fields are never updated from that value.

Evidence:

- `server/src/modules/bid-board-sync/service.ts:24-39` includes `bidBoardTotalSales`.
- `server/src/modules/bid-board-sync/service.ts:89-96` parses formatted numeric strings by removing `$`, `%`, spaces, and commas.
- `server/src/modules/bid-board-sync/service.ts:213-250` writes `bid_board_total_sales = $9` but does not write `bid_estimate`.
- `server/src/modules/bid-board-sync/service.ts:652-654` counts only the mirrored Bid Board field update.
- The production `office_dallas.deals` columns `bid_estimate`, `dd_estimate`, `awarded_amount`, and `bid_board_total_sales` are all `numeric(14,2)`.

## Field Mapping

Bid Board `Total Sales` maps to CRM `bid_estimate`.

Rationale:

- The export contains `Project Cost` and `Total Sales`; `Project Cost` is internal cost, while `Total Sales` is the customer-facing estimate amount.
- The deal-detail "Deal value" card uses `bestEstimate(deal)`, which resolves `awardedAmount > bidEstimate > ddEstimate` (`client/src/lib/deal-utils.ts:84-97`) and labels the KPI as "Bid" when `bidEstimate` is present (`client/src/pages/deals/deal-detail-page.tsx:580-589`).
- The schema keeps `bid_estimate` as the estimating-phase amount (`shared/src/schema/tenant/deals.ts:76-78`), separate from `awarded_amount`.
- Therefore this PR writes `Total Sales -> bid_estimate`, not `awarded_amount`. No separate `deal_value` column exists; UI/reporting derives deal value from the estimate fields.

## Live Production Evidence

Latest production Bid Board sync runs are succeeding every ~19 minutes with 489 rows, 155 matches, and 0 stage updates in the latest sampled cycles. Those runs mirror Bid Board fields but do not promote `Total Sales` into `bid_estimate`.

Examples sampled from production after the latest run:

- `hidden ridge` (`DFW-2-13126-aa`): Bid Board Total Sales `42878.57`, CRM `bid_estimate` null, stage `estimating`.
- `Cottages at Bedford` (`DFW-1-12626-aa`): Bid Board Total Sales `285085.71`, CRM `bid_estimate` `400000.11`, stage `estimating`.
- `The Sea Gate on St. Simons` (`ATL-1-11726-ab`): Bid Board Total Sales `130759.29`, CRM `bid_estimate` `200000.11`, stage `estimate_under_review`.

These validate both zero-to-real writes and down-revisions as real production cases.

## Corrected Safety Rails

Bid Board owns the estimate once a deal is in the Bid Board estimating flow. Estimators can revise estimates up or down, so CRM must follow any non-zero Bid Board value.

Implementation rules:

- Skip zero, null, or blank Bid Board `Total Sales`; treat it as missing export data, not an authoritative zero estimate.
- Write any non-zero Bid Board `Total Sales`, including lower values than the current CRM `bid_estimate`.
- Skip same-value writes for idempotency.
- Audit every estimate write in `deal_history` with field `bid_estimate`, source reason `Bid Board export sync - Total Sales -> Bid Estimate`, old value, new value, and the sync user.
- Log a warning but still write when the change is a large drop. The warning is operational visibility, not a guard.
- Do not enqueue rep notifications or otherwise trigger user-authored stage-change side effects.

## Schema Impact

`bid_board_sync_runs` needs new per-run counters:

- `estimate_updated_count`
- `estimate_updated_higher_count`
- `estimate_updated_lower_count`
- `estimate_skipped_no_value_count`
- `estimate_skipped_no_change_count`
- `estimate_warning_count`

The production table currently has no `estimate_%` columns, so this PR includes a tenant migration plus the shared schema update.

## Assumptions

- `Total Sales` is the authoritative Bid Board estimate amount.
- `bid_estimate` is the CRM field that drives the deal-detail "Deal value" card during estimating; there is no independent `deal_value` column to update.
- A missing active admin/director user should prevent an estimate write because the audit row requires `changed_by`; production currently has such a user because stage writeback history works.
