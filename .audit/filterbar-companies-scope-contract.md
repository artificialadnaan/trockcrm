# Companies FilterBar — company-date-scope contract (frontend ⇄ BLUE backend)

Wave 2 mounts the shared `<FilterBar>` on the **companies list** (`/companies`), mirroring RED's leads
Wave 1 (`.audit/filterbar-leads-date-scope-contract.md`). Same split: the frontend emits these exact
params via an opt-in dimension set + a companies adapter (`companies-filterbar-adapter.ts`, analog of
`leads-filterbar-adapter.ts`); **BLUE owns the SQL** (`company-date-scope`, analog of `deal-date-scope`).
This doc is the seam. PHASE-1 scoping only — no mount until RED's per-entity `paramPrefix` namespace
lands on main.

**LOCKED v1 (product sign-off):** bar = **Search + Owner + Date + Sort + Status (verification)**.
Industry stays a **page control** for v1 (the generic enum dimension is deferred to Wave 2.5). Prove
Companies before Properties.

## Companies have NO Won/Lost — the date axis is a SINGLE-AXIS variant (no outcome branching)

Companies carry no `won_closed_date`/`lost_at` and no lifecycle outcome. The board the list shows is
"last activity", so the date axis is the **last-touch** axis with a created fallback:

| company state | date axis (filter window + Date-column display) |
|---|---|
| (any) | `COALESCE(last_activity_at, created_at)` |

`filter-axis == display-axis`: the same per-row date the filter windows on is the date the list shows
(it already renders "Last activity"). BLUE provides **`buildCompanyDateScope(window, ctx)`** (the WHERE
predicate) + **`companyDisplayDateExpr(ctx)`** SELECTed as **`displayDate`** (ISO `YYYY-MM-DD` | null),
mirroring `deal-date-scope.ts`/`dealDisplayDateExpr`. The adapter's `getCompanyDisplayDate` reads
`displayDate`, falling back to `lastActivityAt ?? createdAt` until the backend SELECTs it.
*(Alternative axis if you'd rather filter "when added": `created_at`. Recommend last-activity — it
matches the column the card already leads with.)*

## Params consumed by GET /api/companies (emitted by the companies FilterBar)

| param | values | predicate | backend status |
|---|---|---|---|
| `search` | string | existing company search | **exists** |
| `dateFrom`/`dateTo` | YYYY-MM-DD | `COALESCE(last_activity_at, created_at)` window | **BLUE: new** (`buildCompanyDateScope`) |
| `assignedRepId` | uuid \| `__unassigned__` | `eq(companies.owner_id)`, sentinel → IS NULL | predicate **exists** in `listCompanies(ownerUserId)`; **route only passes "mine" today → accept a specific id** |
| `scope` | mine\|all | existing `ownerScope=mine` (page-inherited, not a bar dimension) | **exists** |
| `sortBy`/`sortDir` | allow-list: `last_activity_at`\|`created_at`\|`name` | order-by | **BLUE: new** (server hardcodes `name ASC` today) |
| `status` | `pending`\|`verified`\|`not_required`\|`any` | `companies.company_verification_status` | **BLUE: new** (verification-status filter — shipping v1) |

Dimensions (v1, locked): `["search", "rep" (relabeled Owner — see gaps), "date", "sort", "status"]` +
`scope` inherited (page-owned mine/all, not a bar dimension). **`allowUnassigned: true`** (companies.
`owner_id` is nullable → `__unassigned__` → IS NULL is meaningful; this is the deals default, NOT leads'
false). Status is the opt-in variant — the mount passes `statusOptions` = verification values.

## OMITTED for companies (flag if any should exist)
- **value** (companies have no deal value), **workflow** (n/a), **stalled** (n/a), **stage** (n/a).
- **region** — companies *carry* a `region` string, but it isn't server-filterable and the `region`
  dimension emits a `regionId` UUID (mismatch). Omit v1; revisit if region filtering is wanted.
- **industry** (existing page filter: GC/Owner/Mgmt/Restoration) — enum-string filter, **no matching
  FilterBar dimension** (`projectType` emits a UUID). **DECIDED: stays a page control beside the bar for
  v1**; Wave 2.5 moves it into the bar once RED ships the generic enum dimension.

## ⚠️ Component gaps to flag to RED (opt-in additions, RED owns `components/filters/*`)
1. **Owner vs Rep label — REQUIRED for Companies v1.** Companies filter by **owner** (`owner_id`), but the
   `rep` dimension's label is hardcoded `"Rep"`. RED adds a configurable label on `rep` (e.g. a `repLabel`
   prop) **or** a new opt-in `owner` dimension that also emits `assignedRepId`. (Reusing `assignedRepId` as
   the param is fine; only the visible label is wrong.) This is the one component change Companies v1 needs.
2. **Generic enum/category dimension — DEFERRED to Wave 2.5** (not blocking v1). Companies `industry` and
   Properties `type` are enum-string filters with no dimension that emits a plain string. Until RED ships an
   opt-in string-select dimension, both stay as **page controls beside the bar**; Wave 2.5 folds them in.

## Backend asks for BLUE (companies)
1. `buildCompanyDateScope(window, ctx)` + `companyDisplayDateExpr` → SELECT `displayDate =
   COALESCE(last_activity_at, created_at)::date`; the predicate windows the **same** expr.
2. **Sort allow-list**: accept `sortBy`/`sortDir` over `{last_activity_at, created_at, name}`
   (server currently hardcodes `name ASC`).
3. **Owner-by-id**: the `listCompanies` `ownerUserId` predicate already exists — have the route accept a
   specific `assignedRepId` (today it only forwards `req.user.id` when `ownerScope=mine`).
4. `status` → `company_verification_status` filter param (`pending`|`verified`|`not_required`; `any`/unset
   → omit). **Shipping in v1.**

## Reuse / safety (same invariants as #546/#577)
- Every predicate returns `undefined` when unset (omit, never broken/empty SQL); `__unassigned__` → IS
  NULL; malformed values no-match (never widen); unrecognized status → no-match.
- The companies adapter narrows the shared `FilterBarValue` to `CompanyFilters` by construction (deal-only
  dimensions have no `CompanyFilters` field, so they drop) — exactly like `filterBarValueToLeadFilters`.
- Status is an **opt-in variant** (the companies mount passes its own `statusOptions`) so deals/leads
  mounts are unaffected.
