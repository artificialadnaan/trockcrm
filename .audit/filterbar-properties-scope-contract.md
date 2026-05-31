# Properties FilterBar — property-date-scope contract (frontend ⇄ BLUE backend)

Wave 2 mounts the shared `<FilterBar>` on the **properties list** (`/properties`), mirroring RED's leads
Wave 1 (`.audit/filterbar-leads-date-scope-contract.md`). Same split: frontend emits these params via an
opt-in dimension set + a properties adapter (`properties-filterbar-adapter.ts`); **BLUE owns the SQL**
(`property-date-scope`). PHASE-1 scoping only — no mount until RED's `paramPrefix` lands on main. **Properties are the leaner
surface** — two real adaptations below (no owner; engagement + last-activity are *derived*).

**LOCKED v1 (product sign-off):** bar = **Search + Date + Sort**. Type stays a **page control** v1 (generic
enum dimension deferred to Wave 2.5). Engagement-Status **omitted v1** (runtime-derived, too heavy).
Properties is proved **after** Companies and reuses whatever RED lands for the owner-label/enum work.

## Properties have NO Won/Lost AND a DERIVED date — the axis is a single-axis variant with a wrinkle

Properties carry no outcome. The list leads with "last touch" (`lastActivityAt`), but **that value is
DERIVED in the service** as `max(leads.last_activity_at, deals.last_activity_at)` — it is not a stored
column. So the date axis is:

| property state | date axis (filter window + Date-column display) |
|---|---|
| (any) | `COALESCE(<derived last_activity>, created_at)` |

`filter-axis == display-axis`. BLUE provides **`buildPropertyDateScope(window, ctx)`** +
**`propertyDisplayDateExpr(ctx)`** SELECTed as **`displayDate`** — but the predicate must window over the
**same `max(leads, deals)` derivation** the SELECT uses, or the filter and the shown date diverge.
**BLUE call:** if windowing the derived max is too costly for v1, fall back to **`created_at`** as both
filter+display axis (stored, simple) and we label the Date column "Added". Frontend `getPropertyDisplayDate`
reads `displayDate`, falling back to `lastActivityAt ?? createdAt`.

## Params consumed by GET /api/properties (emitted by the properties FilterBar)

| param | values | predicate | backend status |
|---|---|---|---|
| `search` | string | existing property search (name/address/city/state/zip) | **exists** |
| `dateFrom`/`dateTo` | YYYY-MM-DD | derived-last-activity window (or `created_at` fallback) | **BLUE: new** (`buildPropertyDateScope`) |
| `sortBy`/`sortDir` | allow-list: `last_activity_at`\|`created_at`\|`name` | order-by | **BLUE: new** (server hardcodes `company.name, property.name, address ASC`) |

Dimensions (v1, locked): `["search", "date", "sort"]`. **No `scope`** (properties have no owner). **No
`rep`/owner**, **no `allowUnassigned`** relevance. **`type`** stays the existing page-level ScopeToggle
(NOT a bar param v1 — Wave 2.5); **engagement-Status omitted v1** (derived — see gaps).

## OMITTED for properties (flag if any should exist)
- **rep / owner** — **properties have NO owner field** (tied to a company via `company_id` only). A
  "my properties" scope would mean "properties of companies I own" — a join, backend-only. Omit v1; flag
  if wanted.
- **scope** (mine/all) — same reason (no per-property owner). Omit v1.
- **value** — `linkedValue`/`activePipelineValue` are *derived* deal sums, not a property attribute;
  filtering by them is a backend aggregation. Omit v1.
- **workflow, stalled, stage, region** — n/a.

## ⚠️ Component / backend gaps to flag to RED + BLUE
1. **Generic enum dimension for `type` — DEFERRED to Wave 2.5** (RED, opt-in). Property `type` is an enum
   string with no matching dimension (`projectType` emits a UUID). **DECIDED: v1 keeps the existing Type
   ScopeToggle as a page control *beside* the bar** (the control already works; smaller PR). Wave 2.5 folds
   it into the bar once RED ships the opt-in string-select dimension. The shared bar carries Search + Date +
   Sort in v1.
2. **Engagement Status is DERIVED — OMITTED v1** (BLUE, heavy). `engagementStatus` (active_deal/active_lead/
   won/no_engagement) is computed at runtime from lead/deal counts (`classifyPropertyEngagementStatus`), not
   stored. A Status filter needs BLUE to push that classification into a WHERE/HAVING. **DECIDED: omitted
   from v1**; revisit as a dedicated backend task if wanted.

## Backend asks for BLUE (properties)
1. `buildPropertyDateScope(window, ctx)` + `propertyDisplayDateExpr` → `displayDate` = derived
   `COALESCE(max(leads,deals) last_activity, created_at)::date`, windowed by the **same** expr — **or**
   the `created_at` fallback if the derived window is too costly for v1 (BLUE's call; tell us which).
2. **Sort allow-list**: `sortBy`/`sortDir` over `{last_activity_at, created_at, name}` (server hardcodes
   the name chain today).
3. *(Engagement-Status is omitted v1 — no backend ask. Revisit only if a future wave wants it.)*

## Reuse / safety (same invariants as #546/#577)
- Every predicate returns `undefined` when unset; malformed values no-match (never widen).
- The properties adapter narrows `FilterBarValue` → `PropertyListFilters` by construction (deal-only
  dimensions drop), like `filterBarValueToLeadFilters`.
- **Prove Companies before Properties** (per the rollout plan): Companies is the richer surface and shakes
  out the owner-label + enum-dimension questions; Properties then reuses whatever RED lands.
