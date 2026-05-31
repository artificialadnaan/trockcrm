# Leads FilterBar — lead-date-scope contract (RED frontend ⇄ BLUE backend)

Wave 1 mounts the shared `<FilterBar>` on the **leads list** (`/leads`). Same RED/BLUE split as the
deals FilterBar (#546): RED emits these exact params; **BLUE owns the SQL predicate** (a
`lead-date-scope` analogous to `deal-date-scope`). This doc is the seam.

## Leads have NO Won/Lost — the date axis is a LEAD VARIANT

Lead status is `open | converted | disqualified` (not active/on_hold/inactive), and leads carry no
`won_closed_date`/`lost_at`. The outcome-aware date window maps to lead dates:

| lead outcome | date axis (window + display) |
|---|---|
| **converted** | `converted_at` |
| **disqualified** | the disqualified-stage **entry** date — **BLUE: check if leads store a `disqualified_at` (or similar) timestamp; if yes use it, else the stage-entry timestamp into the disqualified stage** |
| **open** | `stage_entered_at` (fallback `created_at` when stage-entry is null/unreliable) |

`filter-axis == display-axis`: the same per-row date the filter windows on is the date the list's Date
column shows. BLUE provides **`buildLeadOutcomeDateScope(window, ctx)`** (the WHERE predicate) + a
companion **`leadDisplayDateExpr(ctx)`** SELECTed as a row field **`displayDate`** (ISO `YYYY-MM-DD`
or null) — mirroring `deal-date-scope.ts` / `dealDisplayDateExpr`. RED's `getLeadDisplayDate` reads
`displayDate` and falls back to the close chain until SELECTed (same graceful pattern as deals).

## Params consumed by GET /api/leads (emitted by RED's leads FilterBar)

| param | values | predicate |
|---|---|---|
| `dateFrom`/`dateTo` | YYYY-MM-DD | outcome-aware window (the lead variant above) |
| `status` | `open`\|`converted`\|`disqualified`\|`any` | lead-status variant; `any`/unset = omit (everything) |
| `assignedRepId` | uuid \| `__unassigned__` | eq, sentinel → IS NULL |
| `stageIds` | CSV | inArray(stage_id) |
| `projectTypeId` | uuid | eq (leads carry `projectTypeId`) |
| `search` | string | existing lead search |
| `sortBy`/`sortDir` | allow-list | existing |
| `scope` | mine\|all | existing (page-inherited, not a bar dimension) |

**OMITTED for leads** (flag if any should exist): **Value** (no lead value), **Workflow route** (leads
aren't normal/service), **Region** (leads carry no region today), **Stalled** (gated like deals; off).

## Reuse / safety (same as #546)
- Each predicate returns `undefined` when unset (omit, never broken/empty SQL); `__unassigned__` →
  IS NULL; malformed values no-match (never widen); unrecognized status → no-match.
- The lead-status FilterBar dimension is an **opt-in variant** (status option set passed per mount) so
  the existing deals mounts are unaffected — keep the shared component reusable.

## RED status
Frontend builds against this contract now (leads adapter + lead-status variant + the mount), and
connects when BLUE lands `buildLeadOutcomeDateScope` + the `displayDate` SELECT on getLeads — same
"build frontend against the contract, gate on backend at merge" flow as the original FilterBar.
