# Team-Commissions Drill-Down + "View as Rep" — Implementation Plan

**Branch:** `feat/team-commissions-drilldown` (worktree `.wt-comm-drill`, base `origin/main` @ 7cc16f59)
**Placement decision (Adnaan):** Extend the existing **DirectorRepDetail** page (`/director/rep/:repId`, admin/director-gated, already linked from each flat-list row). One surface, no new route, no drawer.

## Phase 0 finding (reported + approved)
- **No PR #735 exists** (list jumps 734→736); **no shared/migrated EvidenceDrawer** exists — the only evidence drawer is reports-page-local. So there is nothing to reuse and **no collision risk**. Build self-contained, fold into DirectorRepDetail.

## The three surfaces that must reconcile (by construction)
| Surface | Source fn | Window today |
|---|---|---|
| (a) Flat list `/director/commissions` | `getDirectorCommissionWorkspace` → `getDirectorRepCommissionRows` → **`getRepCommissionSummary`** (Engine B) | YTD (`presetToDateRange("ytd")`, hook-hardcoded) |
| (b) Rep-detail KPI `/director/rep/:repId` | `getRepDetail` → `getRepDashboard(commissionDateRange)` → **`getRepCommissionSummary`** (Engine B) | **Rolling-12M** ← DIVERGENT |
| (c) Rep's own page `/commissions` & "view as rep" | **`getRepCommissionDashboard`** (Engine A) | YTD (period default) |

**Reconciliation backbone:** Engine B (`getRepCommissionSummary`) feeds BOTH (a) and (b); Engine A (`getRepCommissionDashboard`) feeds (c). Both engines + the manager-override roll-up route their floor through the single `computeRepEarnedFloorGate`. Engine A `earned` (sum dsc.amount for rep, gated) == Engine B `directEarnedCommission`. Engine B total = `directEarnedCommission + overrideEarnedCommission` (override is a roll-up, not per-deal).

**THE WINDOW FIX (load-bearing):** (b) uses rolling-12M while (a)/(c) use YTD — they do NOT reconcile today. `getRollingCommissionDateRange` has exactly **one** consumer (`getRepDetail:3014`), so the change is fully contained. Switch rep-detail's commission window to the **page-selected window** (the from/to the DateRangeToggle already passes) so (b) reconciles with (a) at the same window. Relabel the KPI "Earned Commission (Rolling 12M)" → "Earned Commission · {periodLabel}". **Deliberate convention shift — document in PR body** ([[reconciliation-consistency-rule]]).

## Data layer (server)
1. **Owner/estimator split.** `attribution_role` already exists (`deal-signed-commissions.ts:25`, default `'owner'`). Add `dsc.attribution_role AS attribution_role` to `getCommissionDealRollups` (dashboard/service.ts:1106) and carry `attributionRole: "owner"|"estimator"` onto `CommissionDealRollup` + `RepCommissionDealEarning` (1003/512). Purely additive — does not change any sum. Flows through existing `commissionDeals` payload already returned by rep-detail (currently unused on client).
2. **Floor progress data.** Add `qualifyingRevenue: number` and `floorMet: boolean` to `RepCommissionSummary` (491) — surface `floorGate.qualifyingRevenue` / `floorGate.met` already in scope in `getRepCommissionSummary` (1278). Lets the bar show "$X of $Y floor" / "cleared" exactly (not derived).
3. **Window reconcile.** In `getRepDetail` (3006) pass `commissionDateRange: { from, to }` (the page window) instead of `rollingCommissionDateRange`. Remove now-orphaned `getRollingCommissionDateRange` if unused after.
4. **Missing-contract worklist.** New `getRepWonMissingContractDate(tenantDb, repId, { from?, to? })` → Won-family deals `assigned_rep_id = repId`, `is_active=true`, not test, `contract_signed_at IS NULL AND contract_signed_date IS NULL` (→ no commission minted). Return `{dealId, dealNumber, dealName, companyName, value, wonDate}`. Add to rep-detail payload.
5. **View-as-rep endpoint.** New director-gated `GET /api/dashboard/director/rep/:repId/commission-view?from&to` → `getRepCommissionDashboard(tenantDb, { role: req.user.role, userId: req.user.id, repId, from, to })` (Engine A — literally the rep's own data; rep-injection-safe via `effectiveRepForRepDashboard`). Lazy-loaded by client on expand.

## Client (`director-rep-detail.tsx`)
- **Commission Breakdown** section (new): floor-progress bar (qualifyingRevenue/floor; "below floor" vs "cleared"); split summary (Σ owner cuts + Σ estimator cuts = direct; + override line; = total); per-deal table with Owner/Estimator role badge + cut. **Below-floor** → rows visible at $0 + "below floor" note (never blank). **no_rate/inactive** (commissionRate===0) → "Uncommissioned" state, not $0-looks-broken.
- **Missing-contract worklist** (only if non-empty): list with inline "Set contract date" → `PATCH /deals/:id/contract-signed-date {date}` (exists, admin/director, triggers recalc) → refetch rep-detail.
- **View as rep** (admin/director): button → lazy GET commission-view → render read-only Engine A mirror (earned / in-pipeline / stage totals / deals). Reuse rep-page shape.
- **formatCurrency**: confirm import is the SAFE `deal-utils` impl (→ "--", never "$NaN").

## RBAC
- Route `/director/rep/:repId` + new `/commission-view` both `requireRole("admin","director")`. Client route already `RequireRole {["admin","director"]}`. Office-scoped via `tenantDb`. A rep cannot reach either; `effectiveRepForRepDashboard` locks reps to self.

## Tests (`*.runtime.test.*`, PGlite real-types + jsdom)
- **Reconciliation:** seed owner+estimator dsc rows + a report for override; assert flat-list row total === rep-detail `commissionSummary.totalEarnedCommission` === Σ(commissionDeals) + override; Engine A earned === Engine B directEarned (same window); Σ owner-cut + Σ estimator-cut === directEarned.
- **Below-floor:** rep under floor → total $0, rows visible at $0, qualifyingRevenue<floor.
- **no_rate/inactive:** inactive config → floor 0 / always-met / uncommissioned, no $NaN.
- **RBAC:** commission-view rejects rep role; rep passing repId resolves to self.
- **Worklist:** won+missing-contract query returns right deals; excludes signed / lost / test.
- **Client:** floor-progress render, role badges, view-as-rep read-only, uncommissioned state.

## No migration (attribution_role pre-exists). DRY/YAGNI: extend existing engines, never a parallel query.
