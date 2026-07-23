# Won-metric alert email + global search enrichment — Design

**Date:** 2026-07-23
**Author:** Claude (paired with Adnaan)
**Requested by:** Takashi Yamashita (two feature requests, 2026-07-23)
**Branch:** `feat/won-email-search-enrichment` (off `main`)

## Motivation

Two enrichment requests, both "the data exists, it just isn't surfaced":

1. **"Won metric reduced" alert email** shows raw UUIDs and no business context, so a
   recipient can't tell *why* a Won figure moved. Real example decoded from prod
   (event `98f278b3…`): the deal **Terraces at Highbury Court** (`DFW-4-16326-af`,
   $12,322.86, Atlanta GA) was reassigned from **Chris Higingbotham → Caleb Stone**;
   Chris's Won YTD fell $12,322.86 → $0 while Caleb's rose $0 → $12,322.86. The email
   couldn't say any of that — it printed `Assigned Rep Id: f5ade4ca… → e537cc4a…` and
   only the losing leg, so it read like money vanished.

2. **Global top-bar search** shows job name, number, location, and stage — but not the
   **sales rep** or the **deal amount**, which are the two facts a user most wants when
   scanning results.

Non-goal for both: no new business logic, no behavioral change to *when* the alert
fires or *what* deals are searchable. Pure presentation/enrichment.

---

## Feature 1 — Enrich the "Won metric reduced" email

**File:** `worker/src/jobs/won-metric-reduction-alert.ts` (+ its test). **No migration.**

### Data sources (all confirmed available)

| Field | Source | Notes |
|---|---|---|
| Deal name / number | `event.deal_name` / `event.deal_number` | already in event |
| Deal $ amount | `new_snapshot` → best of `awardedAmount → bidEstimate → ddEstimate` (fallback `old_snapshot`) | snapshots carry all three; **no query** |
| Terminal-aware YTD impact | `event.impacts` (already terminal-aware) | stays in the existing **Figure** row |
| Rep old→new names | resolve UUIDs in `changed_fields.assigned_rep_id{.from,.to}` + `estimator_user_id` via `public.users` | **one batched query** |
| Actor name | already resolved by `enrichEventAuditCitation` | unchanged |
| Property location (area) | `SELECT property_address, property_city, property_state FROM <schema>.deals WHERE id = $1` | **one small query**; only field not in snapshot |

### Behavior

The pure builder `buildWonMetricReductionEmail` gains two optional inputs supplied by
the async handler: `userNames` (uuid → display name map) and `dealLocation`
(`{address, city, state} | null`). The handler resolves both **non-fatally** — a
failure logs and the email still sends (mirrors the existing `resolveOfficeId` pattern).

Email changes:

1. **Summary line** (new lead paragraph, above the table) — human sentence templated
   by `reason_code`. It resolves the "why". Examples:
   - `won_reassigned`: *"Won deal **Terraces at Highbury Court** (DFW-4-16326-af · $12,322.86 · Atlanta, GA) was reassigned from **Chris Higingbotham → Caleb Stone** by Chris Higingbotham. Chris Higingbotham's Won YTD fell $12,322.86; the credit moved to Caleb Stone (company Won unchanged)."*
   - `won_estimator_reassigned`: same shape, estimator wording.
   - `won_value_reduced`: *"Won value of **X** was lowered from $A → $B by <actor>."*
   - `archived_or_deactivated` / `deal_deleted`: *"**X** ($amount) was deactivated/deleted by <actor>, removing it from Won."*
   - `placed_on_hold`: *"**X** ($amount) was placed on hold, removing it from Won <metric>."*
   - `won_stage_changed` / `won_date_rebucketed` / `marked_test_data` / `won_change_order_classification_changed` / `won_contribution_reduced`: sensible per-code sentence, else a generic fallback that still names the deal, amount, and actor.
2. **New labeled rows** in the existing table: **Job** (name + number), **Amount**
   ($ value), **Location** (address / city / state), **Sales rep** (for reassignments:
   `Old → New` names; otherwise the current rep name when derivable). Rows are omitted
   when their data is unavailable (no empty rows).
3. **Fix "Changed fields"** — `formatChangedFields` receives `userNames` and resolves
   any UUID-valued entry (`assigned_rep_id`, `estimator_user_id`) to `Name` instead of
   the raw UUID. Non-UUID diffs unchanged.
4. **Figure**, **Audit citation**, **Definition**, **Release**, CTA button — unchanged.
   The text/plaintext body mirrors the same additions.

### Implementation units

- `resolveReductionUserNames(query, event) → Map<string,string>`: collect every UUID
  appearing in `changed_fields` values (`.from`/`.to`) plus `old/new_snapshot`
  `assignedRepId`/`estimatorUserId`; one query
  `SELECT id::text, display_name FROM public.users WHERE id = ANY($1::uuid[])`.
  Empty input → skip the query. Non-fatal.
- `resolveDealLocation(query, tenantSchema, dealId) → {address,city,state} | null`:
  guarded by `isSafeTenantSchema`; non-fatal.
- `buildReductionSummary(event, impact, userNames, amount, location) → string`: pure,
  reason-code templated, total fallback that never throws on missing pieces.
- `dealAmountFromSnapshot(newSnapshot, oldSnapshot) → number | null`: best-value.
- `formatChangedFields(value, userNames?)`: UUID→name resolution added.
- `buildWonMetricReductionEmail(input)`: new optional `userNames` + `dealLocation`;
  extend the internal `WonMetricReductionEmailEvent` Pick to include `oldSnapshot`.

### Edge cases

- **Deleted/archived deal**: soft-delete keeps the row (`is_active=false`), so the
  location query still returns; the summary uses the deleted-wording branch. `newSnapshot`
  is `{}` for `deal_deleted`, so amount falls back to `old_snapshot`.
- **Unknown UUID** (rep no longer in `users`): fall back to the raw id (never crash);
  keeps forward-compat with the current behavior.
- **Missing name/location/amount**: omit that row / soften the summary; email still sends.
- Existing delivery-lease / idempotency / in-app-notification logic is **untouched**.

### Tests (extend `worker/tests/jobs/won-metric-reduction-alert.test.ts`)

- Extend `makeQuery` mock: (a) a batched `public.users … WHERE id = ANY` branch
  returning `display_name`s, distinct from the existing by-email lookup; (b) a
  `<schema>.deals … property_state` location branch.
- New assertions on a `won_reassigned` event fixture: html contains `Chris Higingbotham`
  and `Caleb Stone` (not the raw UUIDs), the summary sentence, the Amount row
  (`$12,322.86`), and the Location (`Atlanta, GA`).
- Keep every existing assertion green (backward compatibility).

---

## Feature 2 — Global search: rep name + $ amount (deals only)

**Files:** `server/src/modules/search/service.ts`, `client/src/hooks/use-search.ts`,
`client/src/components/search/command-palette.tsx`, `client/src/pages/search/search-page.tsx`
(+ their tests).

### Backend (`searchDeals`)

- Add `leftJoin(users, eq(users.id, deals.assignedRepId))` — mirrors the existing
  `leftJoin(pipelineStageConfig, …)` (a public table joined into the tenant-scoped deals
  query); `assigned_rep_id` is a single FK so there is **no row fan-out**.
- Select `assignedRepName: users.displayName` and the three value columns
  `awardedAmount`, `bidEstimate`, `ddEstimate`.
- Map into `SearchResult`: `assignedRepName` (string|null) and `dealValue` = best-value
  `awardedAmount ?? bidEstimate ?? ddEstimate` as a raw string (numeric(14,2) → string),
  or null. **No on-hold zeroing** — search is a display surface, not a reporting
  aggregate, and on-hold already shows a badge (Adnaan/Takashi confirmed "as much
  information as possible").
- Add `assignedRepName?` and `dealValue?` to the server `SearchResult` interface.

### Types (client)

- Add `assignedRepName?: string | null` and `dealValue?: string | null` to the
  `SearchResult` interface in `client/src/hooks/use-search.ts`. Both are optional and
  deal-only, so non-deal results are unaffected.

### Frontend layout (amount right-aligned)

`ResultItem` (shared across entity types — new fields must be deal-only-safe):
- Append rep name to the meta sub-line: `secondaryLabel · tertiaryLabel · assignedRepName`
  (each part omitted when falsy — no dangling `·`).
- Insert a right-aligned amount span **before** the status/type badges, rendered only
  when `dealValue` is present, formatted with the existing
  `formatCurrencyCompact` (`client/src/lib/deal-utils.ts`) → e.g. `$12.3K`.

Result:
```
🏢  Terraces at Highbury Court  $12.3K [Won] [Deal]
     DFW-4-16326-af · Atlanta, GA · Caleb Stone
```

Apply the same rep+amount rendering to `search-page.tsx` for consistency.

### Tests

- Server: a `searchDeals` runtime test (named `*.runtime.test.*` so CI executes it)
  asserting the join returns `assignedRepName` and best-value `dealValue`, incl. the
  null-rep and all-null-value cases.
- Client: extend `command-palette` / `search-page` tests to assert rep name + compact
  amount render for a deal result and are absent for non-deal results.

---

## Rollout

- **One branch, one PR** off `main` (`feat/won-email-search-enrichment`), two logically
  separate commits (email; search). Neither touches the in-flight `feat/deal-billing-tab`
  work.
- Drive to green via `@codex review` after each commit until it reports no issues.

## Risks / mitigations

- *Two extra email queries* → both non-fatal and batched; negligible cost on a
  single-recipient-set alert. Delivery path unchanged.
- *Search join latency* → one single-FK join per deal row (≤25/office); mirrors the
  existing stage-config join. No fan-out.
- *Shared `ResultItem`/`SearchResult`* → new fields optional + deal-only, guarded at
  render so other entity types are byte-identical.
- *`formatChangedFields` reformat* → additive UUID→name resolution; non-UUID paths and
  the opaque-metadata guard preserved.
