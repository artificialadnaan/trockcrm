# Commission Structure Switch + Sales Source — Design

**Date:** 2026-07-02
**Status:** Approved for planning
**Author:** Adnaan Iqbal (with Claude)

## Problem

capX sales reps (who sell larger, ≥$50k "normal-route" deals) want a choice of
commission structure:

- **Solo:** a *higher* rate on their own capX deals, and **no** commission on service jobs.
- **Mixed:** a *slightly lower* rate on their own capX deals, **plus** a small percentage
  on the **service jobs they bring in** — even when they are not the deal owner or estimator.

For the mixed structure to pay out, a service opportunity must record **who sourced it**.
Today there is no way to attribute a service deal to a non-owner rep, and the commission
engine has only a single rate/floor per rep with no notion of "capX vs service" or of
alternate structures.

## Background: how the engine works today (verified against code)

- **Settings are per-rep and global.** `public.user_commission_settings` has one row per
  user (`shared/src/schema/public/user-commission-settings.ts:11-23`): a single
  `commission_rate`, a single `rolling_floor`, an `override_rate`, and several inert legacy
  columns. There is **no** capX/service split and **nothing** flags a rep as capX or service.
- **The "$50k / service" concept is pipeline routing only**, never commissions
  (`server/src/modules/deals/routing-service.ts:22-25`, `workflow-backfill.ts`). A "service
  opportunity" is a deal with `project_type="service"` + `workflow_route="service"`, created
  via the dedicated **New Service Opportunity** form.
- **Commission is additive per rep** via `deal_signed_commissions` (dsc) rows keyed by
  `attribution_role` (`'owner' | 'estimator'` today;
  `shared/src/schema/tenant/deal-signed-commissions.ts`). Unique key is `(deal_id, rep_user_id)` —
  a rep gets at most one row per deal. The **estimator "additive cut"**
  (`server/src/modules/commissions/service.ts:456-540`) already mints an *extra* row for a
  non-owner at that person's own rate, on top of the owner's full cut, guarded by an
  **owner-row invariant** (never the first/only row on a deal). Sales-source is the same
  pattern with a third role.
- **Earned is snapshotted; pipeline/floor read live.** Earned commission reads stored
  `dsc.amount` / `dsc.applied_rate` (frozen at sign time). Pipeline/potential reads the live
  `commission_rate` from settings. The **floor is a gate**
  (`server/src/modules/commissions/floor-gate.ts:62-155`): `qualifyingRevenue` = the rep's
  **owned signed book** (`assigned_rep_id` + retained `attribution_role='owner'` rows);
  below floor → earned held at $0, at/above → full from dollar one.
- **Deal fields:** owner = `deals.assigned_rep_id` (`shared/src/schema/tenant/deals.ts:72`),
  estimator = `deals.estimator_user_id` (line 141, written only by the leadership-gated
  `PATCH /deals/:id/estimator`). `deals.source` (line 100) is an **existing free-text
  lead-source string** — NOT reusable for sales source.

## Decisions (locked)

| Area | Decision |
|---|---|
| Rate model | Per rep: `capx_rate_solo`, `capx_rate_mixed`, `service_source_rate`, `commission_structure` (`solo`/`mixed`), unchanged `rolling_floor`. The switch auto-swaps the effective capX rate. |
| Sales Source field | New `sales_source_user_id` FK on `deals` (distinct from `deals.source`). Dropdown of **all office reps**, **optional**, only on the service-opportunity creation form. |
| Payout | **Additive.** New `attribution_role='sales_source'` dsc row at the source's `service_source_rate`, on top of the owner's full cut. |
| Floor credit | Sourced deal's **full value** credits both the owner's floor (unchanged) and the source's floor (new). Same deal can help two reps clear their floors. |
| Retroactivity | **Live recompute.** A settings change (structure or rates) re-rates all of that rep's already-signed deals by rewriting their dsc rows. |
| Correction | Sales Source is **locked** for reps (create-only), with an **admin/director override** path (mirrors the estimator correction route). |
| Effective-rate wiring | **Denormalized mirror** (Fork 1): the settings-save keeps `commission_rate` in sync with the effective capX rate so existing live reads are untouched. |
| Recompute mechanism | **Bulk-recompute stored rows** (Fork 2): re-run the per-deal writer across the rep's deals so `dsc` refreshes; earned stays snapshot-backed and auditable. |

## Architecture

### Data model changes

**`public.user_commission_settings`** — migration `0172` adds:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `commission_structure` | text | `'solo'` | `'solo'` \| `'mixed'`. The rep's active structure. |
| `capx_rate_solo` | numeric(7,6) | `0` | capX rate when solo (the higher rate). |
| `capx_rate_mixed` | numeric(7,6) | `0` | capX rate when mixed (the lower rate). |
| `service_source_rate` | numeric(7,6) | `0` | rate applied to service deals this rep sourced (mixed only). |

`commission_rate` is **retained** as the denormalized *effective capX rate*
(= `capx_rate_mixed` when `commission_structure='mixed'`, else `capx_rate_solo`), kept in sync
on every settings save. All existing engine reads of `commission_rate` continue to work
unchanged.

**Backfill (in the migration, inert):** for existing rows set
`capx_rate_solo = commission_rate`, `capx_rate_mixed = commission_rate`,
`commission_structure = 'solo'`, `service_source_rate = 0`. Every rep stays on their current
rate with no service-source behavior — zero change to existing payouts.

**`tenant.deals`** — migration `0173` adds:

| Column | Type | Meaning |
|---|---|---|
| `sales_source_user_id` | uuid (nullable, FK → users) | The rep who sourced a service opportunity. Distinct from free-text `source`. |

### The "effective rate" resolver (Fork 1)

Single source of truth for turning the structure + two capX rates into the effective rates,
implemented as pure functions in `shared/` (e.g. `resolveEffectiveCapxRate(settings)` and
`resolveEffectiveServiceSourceRate(settings)`):

```
effectiveCapxRate         = commission_structure === 'mixed' ? capx_rate_mixed : capx_rate_solo
effectiveServiceSourceRate = commission_structure === 'mixed' ? service_source_rate : 0
```

The service-source rate is **only** live under the mixed structure — a solo rep with a stray
`service_source_rate` value never earns a sales-source cut. All mint/recompute logic uses the
*effective* rates, never the raw columns.

The Users-page settings save (`server/.../admin/users-service.ts` commission branch) computes
this and writes it into `commission_rate` in the same upsert. This is the **only** place the
denormalization is maintained. Live pipeline/potential/earned reads keep reading
`commission_rate` as they do today.

### PR1 — Rate model + Users page

1. **Schema + backfill:** migration `0172` (above); extend the Drizzle schema and the
   `AdminUser` type (`client/src/hooks/use-admin-users.ts`).
2. **Settings write path:** extend `updateUser` input + `hasCommissionPatch` +
   `onConflictDoUpdate` set (`server/src/modules/admin/users-service.ts:309-371`) for the four
   new fields, and compute/write the effective `commission_rate` mirror in the same upsert.
   Route (`admin/routes.ts:198-207`) is a passthrough — no change.
3. **Users-page UI** (`client/src/pages/admin/users-page.tsx:684-714`): add a structure
   `Switch` (solo/mixed — first toggle in this column; precedent is the existing
   `commissionConfigActive` boolean) plus inputs for the two capX rates and the service-source
   rate. Consider gating the structure/capX-specific inputs to `role === "rep"`.
4. **Live recompute on settings change (Fork 2):** a new service
   `recalculateAllCommissionsForRep(userId)` that fans out across every office the rep has
   deals in and re-runs the per-deal writer (`recalculateCommissionForDeal`) for the rep's
   owner rows **and** `sales_source` rows, refreshing `dsc.amount`/`applied_rate` to the new
   effective rates. Triggered after a commission-settings save. See "Cross-office recompute"
   risk below.

### PR2 — Sales Source end-to-end

1. **Schema:** migration `0173` adds `deals.sales_source_user_id`.
2. **Service-opportunity form** (`client/src/components/deals/service-opportunity-form.tsx`):
   add an optional "Sales Source" dropdown of all office reps; include
   `salesSourceUserId` in the submit payload. Server create route
   (`server/src/modules/deals/routes.ts:1815-1900`) accepts and persists it. Set-once at
   creation.
3. **Deal-detail display** (`client/src/pages/deals/deal-detail-page.tsx`, `DealRightRail`,
   after the Estimator item ~line 1275): read-only "Sales Source" row under Estimator.
   For admin/director, an inline editable control.
4. **Admin/director override route:** `PATCH /deals/:id/sales-source`
   (`requireRole("admin","director")`), mirroring the estimator route
   (`routes.ts:2000-2053` / `setDealEstimator`). Excluded from the generic `PATCH /deals/:id`
   allowlist so only this gated route can change it after creation. On change: remove the old
   source's `sales_source` dsc row and mint the new source's, then recompute.
5. **Engine — additive mint** in `calculateCommissionForDeal`
   (`server/src/modules/commissions/service.ts`): after the owner (and estimator) rows, if the
   deal has a `sales_source_user_id`, mint an additional `attribution_role='sales_source'` row
   at the source rep's `service_source_rate`. Guards mirror the estimator cut:
   - source rep is on `commission_structure='mixed'` with `service_source_rate > 0` (use the
     effective service-source rate) — else skip (documented but $0);
   - `sales_source_user_id !== assigned_rep_id` and `!== estimator_user_id` (unique key is
     `(deal_id, rep_user_id)`; avoid collision);
   - **owner-row invariant** — only mint if an `attribution_role='owner'` row already exists;
   - value = the deal's booked `source_value` (same resolution as owner: awarded → bid → dd).
   Add a role-scoped `removeSalesSourceCommissionForDeal` (deletes only
   `attribution_role='sales_source'`) for the override path.
6. **Floor-gate extension** (`server/src/modules/commissions/floor-gate.ts`): extend
   `qualifyingRevenue` to also include, at full value, signed/non-test/non-lost/active deals
   where `sales_source_user_id = repId` within the window — in addition to the existing
   owner-based legs. Guard against double-counting when a rep is both owner and source of the
   same deal (shouldn't happen given the mint guard, but the SQL must not sum it twice).

## Data flow

**Creating a sourced service opportunity → signing it:**
1. Rep creates a service opportunity, optionally picks Sales Source = capX rep *S*.
   `deals.sales_source_user_id = S`. Field is now locked (reps).
2. On contract sign, `calculateCommissionForDeal` mints: owner row (service rep, their rate) +,
   if *S* is mixed, a `sales_source` row (`value × S.service_source_rate`).
3. Dashboards: the owner sees their normal earned; *S* sees an extra `sales_source` earned row.
   The deal's full value counts toward both the owner's and *S*'s `qualifyingRevenue`
   (floor credit).

**Flipping a rep's structure (or editing rates) on the Users page:**
1. Save recomputes the effective `commission_rate` mirror and persists all rate fields.
2. `recalculateAllCommissionsForRep(S)` fans out across offices and rewrites *S*'s dsc rows
   (owner + sales_source) to the new effective rates. Dashboards reflect the change immediately.

## Error handling / edge cases

- **Cross-office recompute** is the biggest cost: settings live in `public`, dsc rows live in
  per-office tenant schemas. Recompute must fan out per office (existing fan-out infra),
  transaction-per-office, and be debounced so multi-field edits don't trigger repeated full
  recomputes. Failure in one office must not corrupt another; surface partial-failure clearly.
- **Source = owner / estimator:** guarded at mint (skip) to respect the `(deal_id, rep_user_id)`
  unique key.
- **Non-mixed source picked:** recorded on the deal, but no dsc row (rate 0) — inert by design.
- **Override changes source after sign:** delete old `sales_source` row, mint new, recompute
  that deal; both old and new source floors adjust accordingly.
- **Backfill safety:** existing reps default to `solo` at their current rate → no behavior
  change on deploy. No prod data-write script needed; the column defaults + in-migration
  UPDATE cover it (schema migration, not an ops backfill).

## Testing

- **Pure functions first (TDD):** `resolveEffectiveCapxRate` (solo/mixed/inactive), the
  sales-source mint guards, and the floor-gate qualifying-revenue extension as SQL run on
  PGlite (per the repo convention: "test SQL on PGlite, not string mocks"). Name runtime tests
  `*.runtime.test.*` so the CI gate executes them.
- **Reconciliation invariants** (per the repo's reconciliation rule): a `sales_source` change
  or a settings flip must move the per-deal row, the rep's earned aggregate, AND the floor
  qualifying revenue together — no half-applied drift. Prove evidence-total == displayed cell.
- **Backfill migration:** assert existing rows land on `solo` with
  `capx_rate_solo = capx_rate_mixed = old commission_rate`, effective rate unchanged.
- **Additive invariant:** owner payout unchanged when a sales source is added; sales_source row
  is never the first/only dsc row on a deal (owner-row invariant).

## Out of scope / deferred

- No change to service reps' own structure (the switch is meaningful for capX reps only).
- No historical backfill of Sales Source onto already-created service deals (create-only going
  forward; admin override exists for one-off corrections).
- Shortening the settings-save latency if cross-office recompute proves heavy (could move to a
  queued/async recompute) — start synchronous, revisit if needed.
