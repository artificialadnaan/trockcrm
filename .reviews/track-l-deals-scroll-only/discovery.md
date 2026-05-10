# Track L Discovery: /deals scroll cap + revert PR #219 redirect

Date: 2026-05-10
Branch: fix/deals-page-scroll-cap-only
Base: f1771f6 (PR #219 J-FIX merged)

## What PR #219 did to /deals routing

1. `client/src/App.tsx`:
   - Added `DealsToPipelineRedirect` component that wraps `<Navigate to={{ pathname: "/pipeline", search, hash }} replace />`.
   - Replaced `<Route path="/deals" element={<DealListPage />} />` with `<Route path="/deals" element={<DealsToPipelineRedirect />} />`.
   - `DealListPage` is still lazy-imported and unused for routing (dead reference but `noUnusedLocals: false` so no typecheck error).

2. `client/src/components/layout/sidebar.tsx`:
   - Pre-#219: Deals entry → `/deals` (Handshake icon), Pipeline entry → `/deals` (Kanban icon) — both pointed to old /deals.
   - Post-#219: Both entries point to `/pipeline`. Two sidebar links → same destination = UX smell flagged in PR #219 review.

3. `client/src/components/layout/mobile-nav.tsx`: Pipeline entry changed to `/pipeline`. Single entry, correct destination.

4. Nav callsites changed by #219 from `navigate("/deals")` to `navigate("/pipeline")`:
   - `deal-detail-page.tsx` (delete success + error fallback)
   - `deal-edit-page.tsx` (error fallback)
   - `deal-new-page.tsx` (back breadcrumb)
   - `rep-dashboard-page.tsx` (Link "Open my pipeline" — intentionally still points to /pipeline since that's the natural target for the label)

5. `client/src/components/layout/sidebar.test.tsx`: asserts both entries point to `/pipeline`.

## Original /deals page component

**File:** `client/src/pages/deals/deal-list-page.tsx` (384 lines, intact)

**Confirmed layout matches user description:**
- Header: `Workflow control` eyebrow + `Deals` h1 (lines 292-297)
- Scope toggle: Mine / Team / All (lines 23-27, 303)
- 3 KPI cards: Active pipeline, Won YTD, At risk (lines 312-314)
- Kanban board section header + search/info banner (lines 323-333)
- Kanban: 5 columns from `buildCanonicalDealBoardColumns` (lines 337-344)
- Below kanban: "Recent deal movement" small list (lines 347-381) — keep as-is

## Why columns have endless scroll

`BoardColumn` (line 191-231):
```tsx
<section className="flex h-full min-h-[32rem] w-[19rem] shrink-0 flex-col overflow-hidden ...">
  <div className="border-b ...">  {/* sticky header — stage name, count, value, Open stage */}
  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">  {/* cards body */}
```

The inner cards body already has `overflow-y-auto`. The problem: the column's `h-full` resolves to the parent flex row's auto-grown height. The parent (`<div className="flex min-w-max gap-4">` at line 338, inside `<div className="overflow-x-auto p-4">` at line 337) has no height constraint. Columns stretch to the tallest one → kanban region grows tall → page scroll engages.

## Fix plan

### Change 1 — revert PR #219 routing pieces
- `App.tsx`: remove `DealsToPipelineRedirect` function; restore `<Route path="/deals" element={<DealListPage />} />`.
- `deal-detail-page.tsx`: 2× `navigate("/pipeline")` → `navigate("/deals")`; "Back to Pipeline" → "Back to Deals".
- `deal-edit-page.tsx`: 1× `navigate("/pipeline")` → `navigate("/deals")`; label revert.
- `deal-new-page.tsx`: 1× `navigate("/pipeline")` → `navigate("/deals")`; "Pipeline" → "Deals".

**Keep PR #219 unchanged:** rep-dashboard `to="/pipeline"` (semantically correct since label is "Open my pipeline"), mobile-nav `/pipeline`, all server-side data-layer changes.

### Change 2 — add scroll cap to /deals kanban columns
- `deal-list-page.tsx` line 193: add `max-h-[44rem]` to the `<section>` className. With existing `overflow-hidden` on the section + `overflow-y-auto` on the inner cards body, this engages internal column scroll for columns with >~10 cards. Header (top div) stays visible.
- Inline only — do not touch /pipeline or any shared component.

### Change 3 — sidebar restore distinct destinations
- `sidebar.tsx` line 55: `to: "/pipeline"` → `to: "/deals"` (Deals entry only). Pipeline entry stays at `/pipeline`.
- `sidebar.test.tsx`: update assertion to match the two distinct destinations.

NavLink active state: react-router NavLink already auto-highlights when the URL matches `to` (default end=false matches prefix, but `/deals` and `/pipeline` don't share a prefix so no conflict).

## Tests

- `app-routing.test.tsx` (new or extend existing): `/deals` mounts `DealListPage`, `/deals/:id` mounts `DealDetailPage`, `/pipeline` mounts `PipelinePage`.
- `deal-list-page.test.tsx` (extend): assert kanban column section has `max-h-[44rem]` class; assert column header still renders.
- `sidebar.test.tsx`: assert two distinct entries — Deals→/deals and Pipeline→/pipeline.
- `pipeline-page.test.ts` (regression): unchanged — sanity check.

## Out of scope

- Do NOT touch `server/src/modules/deals/{service,routes}.ts`.
- Do NOT touch `client/src/pages/pipeline/*`.
- Do NOT delete `DealListPage` import or any lazy reference.
- Do NOT add list view, date chips, or other features beyond cap + revert.
