# Director / stage drill-down FilterBar mount — structural mock (design sign-off)

**Status:** adapter/logic built + TDD'd on `feat/director-drilldown-filterbar`. **Live mounts gated** on the
`paramPrefix` namespace primitive landing on `main` (see Gate below). **Not merged.** Won basis untouched.

Goal (Adnaan): put the full outcome-aware shared `<FilterBar>` (the `/pipeline` row — date is now
outcome-aware + windows open deals since `ENABLE_STAGE_ENTRY_DATE_FILTER` is on, plus rep, value, status,
workflow, region, project-type, stalled) on the director/stage drill-downs that today show the legacy
Updated-After / Min-Age row, and on the `/deals` dashboard drill-downs (Won / Active / At-risk). RED owns
the base `/deals` list; these surfaces are mine.

---

## GATE — `paramPrefix` is NOT on `main`

The namespace primitive is the `prefix` parameter threaded through `useFilterState(prefix)` +
`serializeFilters` / `deserializeFilters` / `mergeFilterParams` / `clearFilterParams` + a `stripFilterBarPrefix`
helper. Verified:

- **`main`:** `useFilterState()` takes no args; **zero** `prefix` references in `client/src/components/filters/`.
- **#577** (`feat/wave1-deals-relabel-leads-filterbar`, OPEN/unmerged): adds the whole `prefix` chain.
- **#583** (MERGED) landed only the Companies-prep opts (Owner label + `statusOptions`) — **not** the prefix.

So the primitive is gated behind the leads server chain. **Ask:** RED extracts the `prefix` chain standalone
(it's a pure client-side URL primitive — no leads/server dependency) and lands it on `main`. The mounts below
flip live the moment it does; nothing here needs the leads work.

---

## Built now (fork-independent, gate-green, in this PR)

`client/src/components/deals/deals-filterbar-adapter.ts`:

- **`DRILLDOWN_FILTERBAR_PARAM_PREFIX = "fb_"`** — the bar's URL namespace on these surfaces. The host pages
  carry bare params (`scope`, `period`, `filter`, `page`, `assignedRepId`); the bar serializes as
  `fb_stageIds`, `fb_dateFrom`, `fb_page`, … so the two URL spaces are disjoint and a bar control can never
  clobber the host's scope/period/page.
- **`getDrilldownFilterBarDimensions({ pinnedStage?, ownRep? })`** — per-surface dimension set from the
  canonical deals row, dropping what the host already owns (details per surface below).
- Stage-scope split reuses the existing **`getBoardVisibleStageScope(cols, showDd=true, isTerminalSlug)`** — no
  new helper.

All exercised by `deals-filterbar-adapter.test.ts` (6 new cases, RED→GREEN).

---

## Surface A — `/deals/stages/<id>` (`deal-stage-page.tsx`)

Today: bespoke filter grid (Search, Region, Sales rep [admin], Updated-after/before, Min/Max age) +
`PipelineStageTable`, driven by `useDealStagePage` (a **separate** render path from `/pipeline`).

**FORK A — render path (needs your call):**

- **A′ (recommended):** keep `useDealStagePage` **only** for the `PipelineStagePageHeader` summary
  (active/total, stage value, avg age — a cheap aggregate). Replace the bespoke filter grid + table with
  `<DealsListSection filterBar={…} baseFilters={{ stageIds: [routeStageId] }} scope={route.query.scope} … />`.
  The list now runs through the rich `/api/deals` (getDeals) endpoint that **already** supports every
  dimension + the outcome-aware date + CSV — no server change. Visual change: the stage table adopts the
  deals-list row/columns.
  - `dimensions: getDrilldownFilterBarDimensions({ pinnedStage: true, ownRep: true })`
    → `[search, date, sort, rep, status, workflow, region, projectType, value, stalled]`
    (stage pinned by the route; the bespoke admin rep select folds into the bar).
  - `stageEntryDateEnabled: true`, `paramPrefix: DRILLDOWN_FILTERBAR_PARAM_PREFIX`.
  - `defaultStageIds: [routeStageId]`; `terminalStageIds: isTerminal(routeStage) ? [routeStageId] : []`.
- **B (not recommended):** keep `PipelineStageTable`; mount a standalone `<FilterBar prefix=…>` above it and
  extend the `/deals/stages/:id` endpoint to accept value/status/workflow/outcome-date. Smaller visual change
  but **requires server work (BLUE)** and maintains a second list path.

## Surface B — `/deals` dashboard drill-downs (`deal-list-page.tsx`)

Two render paths today:

1. **DealsListSection-backed** (Won, active_pipeline, closing_soon, opportunities, bid_board) — already render
   `<DealsListSection>` (lines ~1276-1300) in legacy mode. **Mount = add `filterBar={…}`** to that element,
   keeping `baseFilters={layeredListBaseFilters}` as the period **floor**.
   - `dimensions: getDrilldownFilterBarDimensions()` → no `rep` (the page's rep `<Select>` filters the **board
     AND** the list together via `selectedRepFilter` + `lockedOwnerId`; folding it into the bar would de-filter
     the board), no `scope` (page toggle).
   - `defaultStageIds`/`terminalStageIds` from `getBoardVisibleStageScope(drilldownVisibleStages, true, isTerminalStage)`.
   - Keep `lockedOwnerId` / `hideOwnerFilter`. `stageEntryDateEnabled: true`, `paramPrefix: "fb_"`.
2. **Custom client-side SLA list** (at_risk, stale — lines ~1221-1270) — **OUT this round (FORK B).** These
   filter at-risk **client-side** because the deals list API exposes no at-risk/stale server predicate (the
   existing banner at line ~1303 says exactly this). The bar drives a **server** getDeals query, so it can't
   filter at-risk without a new server predicate. Recommend: defer to a follow-up gated on a BLUE at-risk
   server filter; leave the at-risk/stale list as-is for now.

---

## The only shared-component change (gated, mine)

`DealsListSection` calls `useFilterState()` bare today. Threading the namespace is **one optional prop + one
call-site arg**:

```ts
// DealsListSectionProps.filterBar:
paramPrefix?: string;              // NEW — consumed only by the drill-down/stage mounts
// inside the component:
const { value, setFilters, resetFilters } = useFilterState(filterBar?.paramPrefix ?? "");  // gated on #577
```

`/pipeline` + rep-drilldown pass no `paramPrefix` → `""` → bare keys, **byte-identical** to today. This is the
sole edit to a shared component; it's inert until a mount opts in, but flagging since `DealsListSection` is
shared. Gated on #577 (`useFilterState(prefix)`).

---

## Design nuances for sign-off

1. **Stage-page render path:** A′ (reuse DealsListSection, no server work) vs B (keep the table, extend the
   endpoint). Recommend **A′**.
2. **At-risk/stale:** OUT this round (no server predicate). Confirm defer.
3. **Rep ownership:** dashboard drill-downs keep the page rep-select (board+list); the stage page folds rep
   into the bar. Confirm.
4. **Date floor vs override:** a drill-down's period (`baseFilters.dateFrom/dateTo`) is the floor; the bar's
   date dimension **overrides** it (existing spread order: `{...baseFilters, ...barValue}`). Acceptable
   (explicit refine) — or should the bar's date **intersect** the period floor? Flagging.
5. **Prefix string:** `"fb_"`. Bikeshed welcome.

---

## Won basis

Untouched. This is list-filter wiring over getDeals; no Won aggregate/KPI path touched. The `/deals` "Won" KPI
card stays on `getCanonicalTerminalMetric` (191 / $9,778,045.90).
