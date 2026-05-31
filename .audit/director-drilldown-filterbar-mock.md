# Director / stage drill-down FilterBar mount — structural mock (design sign-off)

**Branch:** `feat/director-drilldown-filterbar`. **`paramPrefix` is now on `main` (#584).** Won basis
untouched. **Not merged** — awaiting your sign-off on Surface A (stage page) below.

Goal (Adnaan): the full outcome-aware shared `<FilterBar>` (the `/pipeline` row — outcome-aware Date
that windows open deals now the flag's on, plus rep, value, status, multi-stage, workflow, region,
project-type, stalled) on the director/stage drill-downs that today show the legacy Updated-After /
Min-Age row, and on the `/deals` dashboard drill-downs (Won / Active / At-risk). RED owns the base
`/deals` list (`dashboardView.filter === null`); these drill-down surfaces are mine.

---

## Coordination split (deal-list-page.tsx, same file)

- **RED:** base-view mount (`dashboardView.filter === null`).
- **Me:** drill-down mounts (`dashboardView.filter !== null`).
- Seam: a single `drilldownFilterBar` memo (undefined for base view + at-risk) feeds
  `filterBar={drilldownFilterBar}`; `baseFilters={drilldownFilterBar ? … : layeredListBaseFilters}`.
  The base arm is `layeredListBaseFilters` verbatim (RED-safe). Both `<DealsListSection>` mounts
  consume the shared `paramPrefix` threading below.

---

## SHIPPED LIVE in this PR (TDD'd, gate-green)

1. **Adapter** (`deals-filterbar-adapter.ts`):
   - `DRILLDOWN_FILTERBAR_PARAM_PREFIX = "fb_"` — bar URL namespace.
   - `getDrilldownFilterBarDimensions({pinnedStage?, ownRep?})` — per-surface dim set (drops what the
     host owns: scope always; rep unless the bar owns it; stage when the surface pins one).
   - `buildDrilldownListFilterBar(...)` — the dashboard drill-down list config (composes the above +
     `getBoardVisibleStageScope`).
2. **Shared infra** (`deals-list-section.tsx`): `filterBar.paramPrefix` → `useFilterState(prefix)`, so
   a mount sharing its URL with a host page reads/writes `fb_*` keys and can't clobber the host's bare
   `scope`/`period`/`filter`/`page`. Default `""` = bare = byte-identical to today (pipeline, base,
   rep-drilldown). **RED's base-view mount consumes the same prop.**
3. **Surface B — `/deals` dashboard drill-downs** (`deal-list-page.tsx`, `filter !== null`): the full
   bar on every DealsListSection-backed drill-down (Won, Active/active_pipeline, Closing,
   Opportunities, Bid Board).
   - dims: `getDrilldownFilterBarDimensions()` — **no rep** (the page's rep select drives the board
     AND the list together; folding it into the bar would de-filter the board), **no scope** (page
     toggle). Stage scope = the drill-down's visible stages.
   - **Rep coupling fix:** FilterBar mode spreads `baseFilters` but ignores `lockedOwnerId`, so the
     page's selected rep is folded into `baseFilters` (no-op on the legacy/base path).
   - **Period = floor, bar date = additive:** the drill-down's `?period` stays the `baseFilters` date
     floor; the bar's date is absent by default, so a drill-down behaves **exactly as today** until the
     user touches the bar. (Nuance 4 below.)
   - **At-risk/stale:** OUT — they render a client-side SLA list with **no server predicate**, so the
     bar (which drives getDeals) can't back them. `drilldownFilterBar` is `undefined` there →
     unchanged. (Decision 2.)

---

## Surface A — `/deals/stages/<id>` (`deal-stage-page.tsx`) — **NEEDS SIGN-OFF before I build it**

Today: a bespoke filter grid (Search, Region, Sales rep, Updated-after/before, Min/Max age) +
`PipelineStageTable`, driven by `useDealStagePage` — a **separate render path** from `/pipeline`, with
its own 7-test suite. To get the *full* outcome-aware bar here, the stage endpoint would have to learn
value/status/workflow/outcome-date/stalled (it doesn't support them) — so the only no-server-work path
routes the list through the rich `/api/deals` (getDeals) that already does:

**Recommended — A′:** keep `useDealStagePage` **only** for the summary header (active/total, stage
value, avg age); replace the filter grid + table with
`<DealsListSection filterBar={…} baseFilters={{ stageIds:[routeStageId] }} scope={route.query.scope} />`.
- dims: `getDrilldownFilterBarDimensions({ pinnedStage:true, ownRep:true })` — **already built +
  tested** → `[search, date, sort, rep, status, workflow, region, projectType, value, stalled]` (stage
  pinned by the route; the bespoke admin rep select folds into the bar).
- `paramPrefix:"fb_"`, `stageEntryDateEnabled:true`, `defaultStageIds:[routeStageId]`,
  `terminalStageIds: isTerminal(routeStage) ? [routeStageId] : []`.

**Why this is the sign-off gate (not just "do it"):** A′ **replaces a bespoke, separately-tested
page** with the deals-list rows — a real visual change — and rewrites ~5 of its 7 tests. Two nuances
to confirm:
- **Summary header = whole-stage totals.** It keeps reading `useDealStagePage` (bare params), so once
  the bar (fb_) filters the list, the header shows stage totals while the list shows the filtered
  subset (like the dashboard board+list). Acceptable? Or should the header track the bar's filters?
- **Double fetch:** `useDealStagePage` (summary) + getDeals (list). Minor; or drop the rich summary.

**Alt — B (not recommended):** keep `PipelineStageTable`, mount a standalone `<FilterBar prefix>` and
extend the `/deals/stages/:id` endpoint for the new dims. Smaller visual change but **needs server
work (BLUE)** + maintains a second list path.

---

## Design nuances for sign-off

1. **Surface A render path:** A′ (reuse DealsListSection, replaces the bespoke page + ~5 tests) vs B
   (keep the table, extend the endpoint — server work). **Recommend A′ — say go and I build it.**
2. **At-risk/stale:** OUT this round (no server predicate). Confirm defer (→ a BLUE at-risk filter).
3. **Rep ownership:** dashboard keeps the page rep-select (board+list); the stage page (A′) folds rep
   into the bar. Confirm.
4. **Date floor vs override:** drill-down `?period` is the floor; the bar's date is additive/overrides
   (same `{...baseFilters, ...barValue}` spread as /pipeline). Default preserves today's behavior; a
   user-set bar date intersects. Acceptable, or intersect-only?
5. **Board/list divergence:** on a dashboard drill-down the board above is the drill-down's board
   (unfiltered by the bar); the list below refines — same pattern as /pipeline. Expected.
6. **Prefix string:** `"fb_"`. Bikeshed welcome.

## Won basis

Untouched — list-filter wiring over getDeals; no Won aggregate/KPI path touched. The `/deals` "Won" KPI
card stays on `getCanonicalTerminalMetric` (191 / $9,778,045.90).
