# Team Commissions column reorg — design

**Date:** 2026-07-09
**Surface:** `trockcrm.com/director/commissions` (Team Commissions table)
**Author:** Claude (with aiqbal@trockgc.com)

## Goal

Reorganize the commission columns so accounting reads them as: **Reserved | Won Signed | Won Unsigned | Potential | Pipeline**. Remove the standalone `Unsigned Comm.` column (fold it into Reserved), and add a new gross-dollar **Won Signed** column that mirrors the existing Won·Unsigned pipeline.

## Column definitions (after change)

| Column | Definition | Windowing | Drill metric |
|---|---|---|---|
| **Reserved** | `displayedEarned` (floor-aware signed commission) **+** `wonUnsignedCommission`. Keeps the amber "held · $X to floor" badge when the earned portion is below floor. | signed part period-windowed on signed date; unsigned part live | `earned` (unchanged) |
| **Won Signed** *(new)* | Gross deal value of deals that are **won AND have a contract-signed date**, involvement-credited per rep. | period-windowed on contract-signed date | `won_signed` *(new)* |
| **Won Unsigned** | `wonUnsignedValue` — unchanged | live | `won_unsigned` |
| **Potential** | `potentialCommission` — unchanged | live | `potential` |
| **Pipeline** | `pipelineValue` — unchanged | live | `pipeline` |

`Unsigned Comm.` column is **removed**; its value (`wonUnsignedCommission`) now only appears folded into Reserved.

**Consequence (accepted):** Reserved is a mixed-window figure — signed commission responds to MTD/QTD/YTD, unsigned commission is a live snapshot. The caption note under the toggle is updated to say so.

## Approach

Mirror the existing **Won·Unsigned** pipeline end-to-end: same deal-value expression (`aliasedDealBestEstimateSql("d") + COALESCE(d.change_order_total, 0)`), same involvement-credit / office-dedup split, same drill → evidence → reconciliation wiring. Rejected alternative: a standalone Won-Signed query/module (duplicates value/credit logic, drifts from the established pattern).

The **won + signed** predicate reuses building blocks already present:
- won stage: `psc.slug IN (${WON_STAGE_SLUGS})`
- signed: `(d.contract_signed_at IS NOT NULL OR d.contract_signed_date IS NOT NULL)`
- signed-date window: `COALESCE(d.contract_signed_at::date, d.contract_signed_date) BETWEEN from AND to`
- plus the shared `is_active`, `is_test_data=false`, `aliasedActiveDealCountFilterSql("d")` guards.

## Server changes (`server/src/modules/dashboard/`)

1. **`getRepDealPipelineSummary`** (`service.ts` ~2164–2225): add `wonSignedValue` (`SUM(dealValue) FILTER (WHERE <won+signed+windowed>)`) and `wonSignedCount` (`COUNT(*) FILTER (…)`). Thread the `{from,to}` range into this function (currently live-only) and apply the window **only** to the won-signed filter — the pipeline / won-unsigned filters stay live.
2. **`getCommissionOfficeTotals`**: add de-duped `wonSignedValue`/`wonSignedCount` (each deal counted once), same windowed predicate.
3. **Interfaces**: add `wonSignedValue: number; wonSignedCount: number;` to `DirectorCommissionWorkspaceRow` (~2121–2150) and to `DirectorCommissionWorkspaceData.officeTotals` (~2152–2157).
4. **Evidence**: add `"won_signed"` to `CommissionEvidenceMetric` and an evidence deal-query branch using the **identical** windowed won+signed predicate, so the drawer total == the cell (reconciliation). Reuse the project#/won-close/actual-close/contract-signed columns already surfaced for `won_unsigned`.

## Client changes

- **`client/src/hooks/use-director-dashboard.ts`**: add `wonSignedValue`/`wonSignedCount` to the row type (~181–209) and to `officeTotals`; add `"won_signed"` to `CommissionEvidenceMetric` (~453–455).
- **`client/src/pages/commissions/team-commissions-page.tsx`**:
  - Remove the `Unsigned Comm.` header, cell, and the `"unsignedcomm"` sort column.
  - Redefine Reserved: displayed value and sort accessor become `displayedEarned(r) + r.wonUnsignedCommission`. `isHeldOnly` / held-badge logic unchanged (drives off the earned/floor fields).
  - Insert **Won Signed** column between Reserved and Won Unsigned: `<Drill metric="won_signed" money …>` with the `(count)` fallback when value is $0, mirroring Won·Unsigned. Add a `"wonsigned"` sort column (`accessor: r.wonSignedValue`).
  - Rebuild KPI cards to 6: `[Reserved][Potential][Won signed][Won unsigned][Open pipeline][Active deals]`. Reserved card value = `additive.earned + additive.wonUnsignedCommission`; Won signed card = `officeTotals.wonSignedValue`. Relabel "Earned commission" → "Reserved". Adjust grid to fit 6.
  - Footer: Reserved total = `additive.earned + additive.wonUnsignedCommission`; remove the Unsigned Comm total cell; add a de-duped Won Signed total (`officeTotals.wonSignedValue`, with count label).
  - Update the caption note (period-windowed vs live), noting Reserved's mixed window.
- **`client/src/pages/commissions/commission-evidence-drawer.tsx`**: add a `won_signed` columns branch mirroring `won_unsigned` (Project #, Won close, Actual close, Contract signed).

## Testing (TDD, runtime gate lane)

- **Server** `server/tests/modules/dashboard/team-commissions-evidence.runtime.test.ts`:
  - `won_signed` reconciliation: evidence total == table cell.
  - value/count math for a won+signed deal.
  - **windowing**: a deal signed inside the period counts; the same deal signed outside the period is excluded.
  - officeTotals de-dup for a deal with a distinct owner + estimator (counted once in office total, credited to both rep rows).
- **Client** `client/src/pages/commissions/team-commissions-page.test.tsx`:
  - Reserved renders `signed + unsigned` sum; held badge still renders for a below-floor rep.
  - `Unsigned Comm.` column no longer present.
  - Won Signed column renders, is drillable, and shows `(count)` when value is $0.
  - 6 KPI cards including Reserved (relabeled) and Won signed.
  - Footer totals: Reserved (additive), Won Signed (de-duped).

## Edge cases / notes

- Reserved drill stays `earned` (signed-commission evidence). The unsigned portion is not separately drillable — same as today (Unsigned Comm. was never clickable). Can be added later if wanted.
- Won Signed uses the same on-hold zeroing (`aliasedActiveDealCountFilterSql`) and `is_test_data=false` exclusion as the other deal-value columns.
- Won Signed gross is involvement-credited in the per-rep rows (owner + estimator both credited → rows sum higher than the de-duped office total), matching Won·Unsigned.
