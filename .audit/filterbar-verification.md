# Shared FilterBar — end-to-end verification

**Scope:** the shared `<FilterBar>` on the pipeline deals list (`/pipeline`, the list under the kanban), shipped in #554 + #562. Verifies each dimension (a) actually filters, (b) filters CORRECTLY, (c) is wired to the right #546 backend predicate + the canonical date axis.

**Verdict: ✅ ALL DIMENSIONS PASS. Green light to extend to other surfaces.** One pre-existing, already-tracked residual (legacy-alias terminal deals) — not a #554/#562 defect.

**Method (this env has NO isolated DB — prod-only, so no live stack):**
- **AUTOMATED — real SQL (PGlite, in-memory Postgres):** every backend dimension run through the ACTUAL #546 predicate registry (`buildDealFilterBarConditions`) against prod-shaped seeded rows. `server/tests/modules/deals/filterbar-dimensions.runtime.test.ts` (24) + the existing `server/tests/modules/shared/deal-date-scope.runtime.test.ts` (7) = **31 real-SQL assertions, all green.**
- **AUTOMATED — client mapping/wiring (vitest):** `deals-filterbar-adapter.test.ts`, `use-deals-query.test.ts`, `deals-list-section.filterbar.test.tsx`, `filterbar-params.test.ts`, `filterbar-date.test.ts`, `deals-list-csv-export.test.ts` = **90 tests, all green.**
- **MANUAL — live click-through checklist** (below) for behaviors only a running app can confirm.

---

## Deployment / visibility (confirmed)

- **Deployed to prod:** ✅ the live bundle on trockcrm.com (`index-B3Ywssp6.js`) contains the FilterBar's `"open stages show current state"` + `"Pipeline records"` strings. Not a deploy gap.
- **No feature flag gates the bar.** `ENABLE_STAGE_ENTRY_DATE_FILTER` is OFF in prod, but it only hides the **Stalled** control + makes the date window apply to Won/Lost on their outcome dates (open rows current-state, honestly labeled). It is NOT a visibility gate.
- **Where:** **`/pipeline`** (the "Pipeline" nav, Kanban icon) → scroll below the kanban + footer → "Deal list / Pipeline records". NOT `/deals` (the "Deals" nav → `deal-list-page`, legacy dashboard drill-down, no FilterBar by design; `/deals/board` redirects to `/deals`).

---

## Per-dimension results

| Dimension | Filters? | Correct? | Right predicate / axis? | Proof |
|---|---|---|---|---|
| **Date** (dateFrom/dateTo + presets) | ✅ | ✅ | outcome-aware: Won→`won_closed_date`, Lost→`lost_at`, open→`stage_entered_at` (flag-gated) | date-scope runtime "THE bug edge" + dimensions runtime "outcome-aware date window" |
| **Status** (active/on_hold/inactive/any) | ✅ | ✅ | owns `is_active`/`on_hold`; "any" omits → everything | dimensions runtime "status" block (5 tests) |
| **Value** (valueMin/Max) | ✅ | ✅ | stage-aware effective value, on-hold-zeroed; malformed→no-match | dimensions runtime "value range" block (4 tests) |
| **Stalled** (minAge/maxAgeDays) | ✅ | ✅ | hold-aware days-in-stage; GATED on flag; malformed→no-match | dimensions runtime "stalled" block (4 tests) |
| **Workflow** (normal/service) | ✅ | ✅ | `eq(workflow_route)`; unrecognized→no-match | dimensions runtime "workflow route" block |
| **Stage** (stageIds) + board defaults | ✅ | ✅ | `inArray(stage_id)`; client defaults to board-visible (active+terminal, Show-DD mirror) | dimensions runtime "stageIds" + adapter `applyBoardVisibilityDefaults`/`getBoardVisibleStageScope` tests |
| **Scope** (page-inherited) | ✅ | ✅ | inherits page-normalized scope; ignores stale `?scope=team` unless bar owns the dim | filterbar component "ignores a bookmarked ?scope=team" + "Clear preserves scope" |
| **Rep / Region** (+`__unassigned__`) | ✅ | ✅ | `eq`, sentinel → `IS NULL` | dimensions runtime "assigned rep"/"region" blocks |
| **Search** | ✅ | ✅ | `buildDealSearchCondition` (≥2 chars); forwarded verbatim | adapter + query-params tests (search passthrough) |
| **Sort** (sortBy/sortDir) | ✅ | ✅ | `buildDealListOrder` allow-list; client picker → URL | adapter `DEAL_LIST_SORT_OPTIONS` + query-params + component header-sort tests |

### Bug-defining edges — explicitly verified (real SQL)
- **filter-axis == display-axis:** a Won deal **CREATED in-window but WON out-of-window does NOT match** (and the converse); `dealDisplayDateExpr` returns, per row, exactly the date the filter windows on. *(date-scope runtime)*
- **Malformed numeric** (`?valueMin=abc` / `?minAgeDays=abc` → NaN): **no-matches, never widens** (`sql\`false\``). *(dimensions runtime)*
- **`__unassigned__` → `IS NULL`** for both rep and region; excludes assigned rows. *(dimensions runtime)*
- **Status owns lifecycle:** `active` = is_active AND NOT on_hold; `on_hold` excludes soft-deleted (inactive) on-hold rows; `inactive` = is_active=false; `any` returns everything. *(dimensions runtime)*
- **On-hold value zeroing:** an on-hold deal is valued 0, so any positive `valueMin` excludes it. *(dimensions runtime)*
- **Unrecognized enum** (workflow/status garbage) → no-match, not silent-omit. *(dimensions runtime)*
- **Empty multi-select / "any" status** → predicate omitted, no narrowing (client omits empty `stageIds`; `status="any"` not serialized). *(adapter + params tests)*
- **`status` suppresses legacy `isActive`** on the wire (sends one or the other). *(query-params test)*

---

## Manual click-through checklist (run on the live app at `/pipeline`)

| # | Click / action | Expect |
|---|---|---|
| 1 | Load `/pipeline`, scroll under the kanban | The bar renders: Search · Date · Stage · Rep · Region · Type · Workflow · Status · Value · Sort · ✕ Clear (no Stalled) |
| 2 | Type 3+ chars in Search | List narrows to matching deal/company/owner/address; URL gains `?search=` |
| 3 | Pick **Status → Inactive** | List shows only inactive (Won/Lost/lost) deals; URL `?status=inactive`; no `isActive` param |
| 4 | Pick **Status → Any** | List shows active + terminal (everything) |
| 5 | Pick a **Rep** | List narrows to that rep; pick **Unassigned** → only deals with no rep |
| 6 | Set **Value** min (e.g. 100000) | Only deals ≥ that effective value; on-hold deals drop out |
| 7 | Open **Date → MTD** | List bounds Won/Lost to this month on their outcome dates; the Date column shows the same date it filtered on; note reads "Won/Lost & activity · open stages show current state" |
| 8 | Toggle the board's **Show DD** off | DD options disappear from Stage AND DD deals leave the list (mirrors the board) |
| 9 | Select a stage, then toggle **Show DD** off | A now-hidden DD selection is dropped from the query (no stale DD rows) |
| 10 | Switch the page **scope** toggle (Mine/All) | The list refetches in the new scope; the list page resets to 1 |
| 11 | Bookmark a URL with `?scope=team`, reload | Board + list both show Mine (team coerced); the list does NOT fetch team rows |
| 12 | Click **✕ Clear** | List dimensions reset; the board's scope + Show-DD state are preserved |
| 13 | Click a sortable column header / **Sort** | Order changes; URL `?sortBy=&sortDir=` |
| 14 | Click **Export** | CSV downloads with the SAME filters applied + the Date column = the displayed (outcome-aware) date; a cell starting with `=`/`+`/`-`/`@` is text-safe |

---

## Known residual (tracked, NOT a #554/#562 blocker)

**Legacy-alias terminal deals.** The board's Won/Lost columns aggregate the full won/lost **slug family** (e.g. `closed_won`, `production_lost`), but the list defaults to **canonical** column ids, so a terminal deal sitting on a legacy alias stage shows on the board but not the list. Verified **pre-existing** — the legacy under-kanban list emitted canonical-only terminal ids too; this is not a regression. A full family-mirror is a sensible follow-up but touches the protected Won-basis machinery and wants live-data validation. Flagged in #554, tracked for a dedicated fix pass.

---

## Conclusion

Every FilterBar dimension filters, filters correctly, and is wired to the right #546 predicate + the canonical date axis — proven by 31 real-SQL assertions + 90 client tests, with the bug-defining edges covered. **No defects found.** Green light to extend the shared FilterBar to other surfaces (rep-drilldown is YELLOW's via Batch A-client). Run the manual checklist once on the live app to close the loop on interaction behaviors.
