# Sales Source Commission (PR2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **After all tasks, run the adversarial pre-PR review phase (Task 12) BEFORE opening a PR** — this is a hard requirement from the repo owner (PR1 took ~18 bot findings that a pre-PR review would have caught).

**Goal:** Attribute a service-opportunity deal to the capX rep who sourced it (`sales_source_user_id`), pay that rep an additive commission at their service-source rate, and credit the sourced deal to their commission floor — without touching the owner's or estimator's cut.

**Architecture:** New nullable `deals.sales_source_user_id` FK (set-once at service-opp creation, locked after, admin/director override). At contract sign, `calculateCommissionForDeal` mints a THIRD additive `deal_signed_commissions` row (`attribution_role='sales_source'`) at the source rep's **service-source** rate (mixed-only) — mirroring the estimator additive cut, guarded by the owner-row invariant. Rate resolution becomes **attribution-role-aware** in both the mint and PR1's per-row recompute (sales_source uses `resolveEffectiveServiceSourceRate`, owner/estimator use the capX `commission_rate` mirror). The floor gate gains a qualifying-revenue leg crediting sourced deals to the source rep at full value.

**Tech Stack:** TypeScript, Drizzle ORM, node-postgres (`search_path`-scoped tenant connections), Express, React, Vitest + PGlite runtime tests, plain `.sql` migrations. Depends on PR1 (`#858`, merged): `resolveEffectiveServiceSourceRate`, `service_source_rate` column, and the cross-office recompute all already exist.

**Scope note:** This is PR2 of two. It consumes PR1's `service_source_rate`/resolver (shipped inert) and completes the feature.

---

## Two load-bearing correctness invariants (read first)

**INV-1 — Attribution-role-aware rate.** A `sales_source` dsc row must be rated at the source rep's **effective service-source rate** (`resolveEffectiveServiceSourceRate`, which is 0 unless the rep is `mixed`), NOT the capX `commission_rate` mirror. This must hold in BOTH:
- the mint (`insertCommissionRowForRep`), and
- PR1's `recalculateCommissionForDeal` per-row re-rate (it currently reads `commission_rate` for every row — if left as-is it would silently re-rate sales_source rows at the capX rate on any settings change).

**INV-2 — Recompute-gate extension.** PR1's `users-service` fires the cross-office recompute only when the effective **capX** rate changes. A change to a rep's effective **service-source** rate must also fire it (so their sales_source rows re-rate). PR1 left a comment marking this exact spot.

Both are covered by tasks below and re-checked in the Task 12 review.

---

## File Structure

**Create:**
- `migrations/0175_deals_sales_source_user_id.sql` — add `deals.sales_source_user_id` to every `office_*` tenant schema (mirrors the sibling `estimator_user_id` migration).
- `server/tests/modules/commissions/sales-source-mint.runtime.test.ts` — PGlite: additive sales_source mint + guards + role-aware rate.
- `server/tests/modules/commissions/floor-gate-sales-source.runtime.test.ts` — PGlite: sourced deal credits the source rep's floor.

**Modify (shared):**
- `shared/src/schema/tenant/deals.ts` — add `salesSourceUserId` column.
- `shared/src/schema/tenant/deal-signed-commissions.ts` — no change (`attribution_role` is free text; `'sales_source'` allowed).

**Modify (server):**
- `server/src/modules/commissions/service.ts` — role type += `"sales_source"`; role-aware rate resolution (INV-1); `mintSalesSourceCommissionForDeal`; wire into `calculateCommissionForDeal`; `removeSalesSourceCommissionForDeal`; make `recalculateCommissionForDeal` role-aware (INV-1).
- `server/src/modules/commissions/floor-gate.ts` — sales-source qualifying leg.
- `server/src/modules/admin/users-service.ts` — recompute-gate extension (INV-2).
- `server/src/modules/deals/service.ts` — `CreateDealInput.salesSourceUserId`; `createDeal` writes it; new `setDealSalesSource`.
- `server/src/modules/deals/routes.ts` — create route accepts `salesSourceUserId`; new `PATCH /:id/sales-source`.

**Modify (client):**
- `client/src/hooks/use-deals.ts` — `Deal.salesSourceUserId`; `CreateServiceOpportunityInput`; `updateDealSalesSource`; add to `WritableDealFields` Omit (locked from generic update).
- `client/src/components/deals/service-opportunity-form.tsx` — optional Sales Source dropdown.
- `client/src/pages/deals/deal-detail-page.tsx` — read-only Sales Source rail item + admin/director edit.

---

## Task 1: Migration — `deals.sales_source_user_id`

**Files:**
- Create: `migrations/0175_deals_sales_source_user_id.sql`

`deals` is a per-tenant (`office_*`) table, so this needs the DO-loop over existing office schemas PLUS the `-- TENANT_SCHEMA_START/END` block for new-office provisioning. Mirror the exact structure of the sibling `estimator_user_id` migration.

- [ ] **Step 1: Find the sibling estimator_user_id migration to mirror**

Run (from the repo root): `grep -rl "estimator_user_id" migrations/ | head`
Read that file. Note exactly: (a) the `DO $tenant$ … LIKE 'office\_%'` loop with `ADD COLUMN IF NOT EXISTS estimator_user_id uuid`, (b) whether it adds a FK constraint to `public.users` (and its `ON DELETE` action), and (c) the `-- TENANT_SCHEMA_START/END` block against `office_dallas`.

- [ ] **Step 2: Write the migration mirroring that structure**

Create `migrations/0175_deals_sales_source_user_id.sql` — copy the estimator migration's structure verbatim, substituting `sales_source_user_id` for `estimator_user_id`. It MUST have: the header comment, the existing-tenants `DO $tenant$` loop guarded by `to_regclass(format('%I.deals', schema_name)) IS NULL … CONTINUE`, and the `-- TENANT_SCHEMA_START` / `-- TENANT_SCHEMA_END` block. If the estimator migration added a FK to `public.users`, add the identical FK for sales_source (same `ON DELETE`); if it did not, do not add one (match the sibling exactly). Example skeleton (fill the FK clause per Step 1):

```sql
-- Migration 0175: sales_source_user_id on the per-tenant deals table.
--
-- The capX rep who SOURCED a service opportunity (set once at creation, locked after; admin/director
-- override only). Nullable. Drives the additive attribution_role='sales_source' commission row and the
-- floor-gate sales-source qualifying leg (PR2). deals is a per-tenant office_* table, so this loops
-- existing tenants + a TENANT_SCHEMA block for the office provisioner. Mirrors estimator_user_id.

DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS sales_source_user_id uuid',
      schema_name
    );
    -- <FK clause here IFF the estimator migration adds one — same ON DELETE, guarded for idempotency>
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS sales_source_user_id uuid;
-- <same FK clause as above for office_dallas, if applicable>
-- TENANT_SCHEMA_END
```

- [ ] **Step 3: DO NOT apply to any DB**

The migration runs at deploy (and is Adnaan's prod-write). Do NOT run the runner or `run-sql.cjs`. Just create the file.

- [ ] **Step 4: Commit**

```bash
git add migrations/0175_deals_sales_source_user_id.sql
git commit -m "feat(commissions): migration 0175 - deals.sales_source_user_id"
```

---

## Task 2: Drizzle schema — `salesSourceUserId`

**Files:**
- Modify: `shared/src/schema/tenant/deals.ts:141`

- [ ] **Step 1: Add the column after estimatorUserId**

Edit `shared/src/schema/tenant/deals.ts`. Immediately after the `estimatorUserId: uuid("estimator_user_id"),` line (141), add:

```ts
  salesSourceUserId: uuid("sales_source_user_id"),
```

(No `.references()` — cross-schema FKs to `public.users` live in the migration, matching `assignedRepId`/`estimatorUserId`.)

- [ ] **Step 2: Typecheck shared + commit**

Run: `npm run typecheck --workspace=shared`
Expected: PASS.

```bash
git add shared/src/schema/tenant/deals.ts
git commit -m "feat(commissions): add salesSourceUserId to deals drizzle schema"
```

---

## Task 3: Role-aware rate resolution helper (INV-1 foundation)

**Files:**
- Modify: `server/src/modules/commissions/service.ts`
- Test: `server/tests/modules/commissions/sales-source-mint.runtime.test.ts` (created here, extended later)

Extract a single helper that resolves the applied rate for a rep+role, so the mint AND the recompute share one source of truth. This is the heart of INV-1.

- [ ] **Step 1: Write the failing test**

Create `server/tests/modules/commissions/sales-source-mint.runtime.test.ts` with the standard PGlite harness (copy the `beforeAll`/imports from `server/tests/modules/commissions/calculate.runtime.test.ts` — `tenantSchemaSql([deals, userCommissionSettings, dealSignedCommissions, auditLog, users, offices])` + the `deal_signed_commissions_dedup` UNIQUE). Then this first test:

`resolveAppliedRateForRole` returns a discriminated `RoleRateResolution` union — `{ status: "rate"; appliedRate }` (active, effective rate > 0), `{ status: "zero" }` (active settings, effective rate 0), or `{ status: "inactive" }` (missing/inactive settings). Assert on `status` (+ `appliedRate` when `"rate"`):

```ts
import { resolveAppliedRateForRole } from "../../../src/modules/commissions/service.js";

// ... inside describe, after harness seeds a mixed rep REP_MIX with capx_rate_mixed=0.02, service_source_rate=0.005:
it("resolves owner/estimator rate from the capX mirror and sales_source from the service-source rate", async () => {
  // REP_MIX: commission_rate (mirror) = 0.020000, service_source_rate = 0.005000, structure = mixed
  expect(await resolveAppliedRateForRole(tdb, REP_MIX, "owner")).toEqual({ status: "rate", appliedRate: "0.020000" });
  expect(await resolveAppliedRateForRole(tdb, REP_MIX, "estimator")).toEqual({ status: "rate", appliedRate: "0.020000" });
  expect(await resolveAppliedRateForRole(tdb, REP_MIX, "sales_source")).toEqual({ status: "rate", appliedRate: "0.005000" });
});

it("a solo rep's sales_source resolves to zero (no service-source cut), and inactive settings to inactive", async () => {
  // REP_SOLO: structure = solo, service_source_rate = 0.005 (stray) → effective 0 (active settings → "zero")
  expect(await resolveAppliedRateForRole(tdb, REP_SOLO, "sales_source")).toEqual({ status: "zero" });
  expect(await resolveAppliedRateForRole(tdb, REP_SOLO, "owner")).toEqual({ status: "rate", appliedRate: "0.030000" });
  // A rep whose settings row is inactive → { status: "inactive" } (recompute PRESERVES; mint skips).
});
```

Seed in `beforeAll`: `REP_MIX` with `(commission_rate 0.020000, commission_structure 'mixed', capx_rate_solo 0.030000, capx_rate_mixed 0.020000, service_source_rate 0.005000, is_active true)`; `REP_SOLO` with `(commission_rate 0.030000, 'solo', 0.030000, 0.020000, 0.005000, true)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:runtime --workspace=server -- sales-source-mint`
Expected: FAIL — `resolveAppliedRateForRole` not exported.

- [ ] **Step 3: Implement the helper**

In `server/src/modules/commissions/service.ts`, add an import for the resolver at the top (near the other `@trock-crm/shared` imports):

```ts
import { resolveEffectiveServiceSourceRate } from "@trock-crm/shared/lib/commission-structure";
```

Add this exported helper (place it just above `insertCommissionRowForRep`):

```ts
export type CommissionRole = "owner" | "estimator" | "sales_source";

/**
 * The applied rate (numeric(7,6) string) for a rep in a given role, or null to skip (no active
 * rate). owner/estimator use the capX commission_rate mirror; sales_source uses the effective
 * service-source rate (0 unless the rep is 'mixed'). Single source of rate truth — used by the
 * mint AND the settings-change recompute so a sales_source row is never rated at the capX rate.
 */
export async function resolveAppliedRateForRole(
  tx: TenantDb,
  repUserId: string,
  role: CommissionRole,
): Promise<string | null> {
  const [s] = await tx
    .select({
      commissionRate: userCommissionSettings.commissionRate,
      commissionStructure: userCommissionSettings.commissionStructure,
      capxRateSolo: userCommissionSettings.capxRateSolo,
      capxRateMixed: userCommissionSettings.capxRateMixed,
      serviceSourceRate: userCommissionSettings.serviceSourceRate,
      isActive: userCommissionSettings.isActive,
    })
    .from(userCommissionSettings)
    .where(eq(userCommissionSettings.userId, repUserId))
    .limit(1);
  if (!s || !s.isActive) return null;

  if (role === "sales_source") {
    const rate = resolveEffectiveServiceSourceRate({
      commissionStructure: (s.commissionStructure as "solo" | "mixed") ?? "solo",
      capxRateSolo: Number(s.capxRateSolo ?? 0),
      capxRateMixed: Number(s.capxRateMixed ?? 0),
      serviceSourceRate: Number(s.serviceSourceRate ?? 0),
    });
    return rate > 0 ? rate.toFixed(6) : null;
  }
  return Number(s.commissionRate) > 0 ? s.commissionRate : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:runtime --workspace=server -- sales-source-mint`
Expected: PASS.

- [ ] **Step 5: Build shared (server resolves the import from dist), typecheck, commit**

Run: `npm run build --workspace=shared && npm run typecheck --workspace=server`
Expected: PASS. (If the `@trock-crm/shared/lib/commission-structure` import errors in the CI typecheck config, it is already registered — PR1 added it to `server/tsconfig.typecheck.json`, `server/vitest.config.ts`, and `shared/package.json` exports.)

```bash
git add server/src/modules/commissions/service.ts server/tests/modules/commissions/sales-source-mint.runtime.test.ts
git commit -m "feat(commissions): role-aware applied-rate resolver (sales_source uses service-source rate)"
```

---

## Task 4: Route `insertCommissionRowForRep` through the role-aware rate

**Files:**
- Modify: `server/src/modules/commissions/service.ts` (`insertCommissionRowForRep`, ~90-175)

- [ ] **Step 1: Widen the role type + use the resolver**

In `insertCommissionRowForRep`, change the `role` param type from `"owner" | "estimator"` to `CommissionRole` (the exported type from Task 3). Replace the inline settings-read + rate check (the block that selects `commissionRate`/`isActive` and returns `skipped_no_rate`) with a call to the shared resolver:

```ts
  const appliedRate = await resolveAppliedRateForRole(tx, repUserId, role);
  if (appliedRate === null) {
    return { status: "skipped_no_rate" };
  }
```

Everything after (`const amount = multiplyDecimalStrings(sourceValue.amount, appliedRate);`, the insert with `attributionRole: role`, the audit) stays as-is — `appliedRate` is now the role-correct rate.

- [ ] **Step 2: Run the existing commission suite to prove no owner/estimator regression**

Run: `npm run test:runtime --workspace=server -- commissions`
Expected: PASS (owner/estimator behavior unchanged — the resolver returns `commission_rate` for those roles, exactly as before).

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/commissions/service.ts
git commit -m "refactor(commissions): insertCommissionRowForRep uses the role-aware rate resolver"
```

---

## Task 5: Mint the additive sales_source row

**Files:**
- Modify: `server/src/modules/commissions/service.ts` (add `mintSalesSourceCommissionForDeal`; wire into `calculateCommissionForDeal`; extend the deal `select`)
- Test: `server/tests/modules/commissions/sales-source-mint.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `sales-source-mint.runtime.test.ts`:

```ts
it("mints an additive sales_source row at the source rep's service-source rate, on top of the owner", async () => {
  const D = U("0c10");
  // Owner = REP_SOLO (service rep, 3% owner rate); Sales source = REP_MIX (mixed, 0.5% service-source).
  await seedDeal(D, { rep: REP_SOLO, awarded: 30000, salesSource: REP_MIX });
  await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
  const rows = await dscRows(D); // ordered by amount desc
  // Owner: 30000 × 0.03 = 900.00 ; sales_source: 30000 × 0.005 = 150.00
  expect(rows.find((r) => r.attribution_role === "owner")).toMatchObject({ amount: "900.00", applied_rate: "0.030000", rep_user_id: REP_SOLO });
  expect(rows.find((r) => r.attribution_role === "sales_source")).toMatchObject({ amount: "150.00", applied_rate: "0.005000", rep_user_id: REP_MIX });
});

it("does not mint a sales_source row when the source rep is solo (no service-source rate)", async () => {
  const D = U("0c11");
  await seedDeal(D, { rep: REP_MIX, awarded: 30000, salesSource: REP_SOLO }); // source is solo → rate 0
  await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
  expect((await dscRows(D)).some((r) => r.attribution_role === "sales_source")).toBe(false);
});

it("skips sales_source when the source equals the owner (dedup / self-source guard)", async () => {
  const D = U("0c12");
  await seedDeal(D, { rep: REP_MIX, awarded: 30000, salesSource: REP_MIX });
  await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
  expect((await dscRows(D)).filter((r) => r.rep_user_id === REP_MIX)).toHaveLength(1); // only the owner row
});
```

Extend the harness `seedDeal` to accept `salesSource` and write it into a `sales_source_user_id` column (add that column to the PGlite `deals` table — it comes from the Drizzle schema via `tenantSchemaSql` once Task 2 landed, so `seedDeal`'s INSERT just needs to include the column). Add `attribution_role` to the `dscRows` SELECT.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:runtime --workspace=server -- sales-source-mint`
Expected: FAIL — no sales_source row minted.

- [ ] **Step 3: Add `mintSalesSourceCommissionForDeal` (mirror the estimator mint)**

In `service.ts`, add (mirroring `mintEstimatorCommissionForDeal`, including the owner-row invariant):

```ts
export async function mintSalesSourceCommissionForDeal(
  tx: TenantDb,
  input: { dealId: string; salesSourceUserId: string; triggeredByUserId: string },
): Promise<CalculateCommissionResult> {
  const [deal] = await tx
    .select({
      id: deals.id,
      assignedRepId: deals.assignedRepId,
      isChangeOrder: deals.isChangeOrder,
      awardedAmount: deals.awardedAmount,
      bidEstimate: deals.bidEstimate,
      ddEstimate: deals.ddEstimate,
      contractSignedAt: deals.contractSignedAt,
      contractSignedDate: deals.contractSignedDate,
    })
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1);
  if (!deal) return { status: "skipped_no_value" };
  if (deal.isChangeOrder) return { status: "skipped_change_order" };

  // Already books a row on this deal (owner/estimator/sales_source)? Never mint a 2nd cut for them.
  const [existing] = await tx
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(and(eq(dealSignedCommissions.dealId, deal.id), eq(dealSignedCommissions.repUserId, input.salesSourceUserId)))
    .limit(1);
  if (existing) return { status: "skipped_existing" };

  const effectiveSignedDate = effectiveSignedDateOf(deal);
  if (!effectiveSignedDate) return { status: "skipped_no_value" };

  // OWNER-ROW INVARIANT: only mint when an owner row already exists (never the first/only row).
  const [ownerRow] = await tx
    .select({ id: dealSignedCommissions.id })
    .from(dealSignedCommissions)
    .where(and(eq(dealSignedCommissions.dealId, deal.id), eq(dealSignedCommissions.attributionRole, "owner")))
    .limit(1);
  if (!ownerRow) return { status: "skipped_no_owner_row" };

  return insertCommissionRowForRep(
    tx, deal, input.salesSourceUserId, effectiveSignedDate, input.triggeredByUserId, "sales_source",
  );
}
```

- [ ] **Step 4: Wire it into `calculateCommissionForDeal`**

Extend the deal `select` (the `.select({ id, assignedRepId, estimatorUserId, isChangeOrder, awardedAmount, bidEstimate, ddEstimate })` at ~201-213) to also pull `salesSourceUserId: deals.salesSourceUserId`. After the estimator-mint dispatch block (~247-258), add:

```ts
  let salesSourceResult: CalculateCommissionResult | undefined;
  if (
    !deal.isChangeOrder &&
    deal.salesSourceUserId != null &&
    deal.salesSourceUserId !== deal.assignedRepId &&
    deal.salesSourceUserId !== deal.estimatorUserId
  ) {
    salesSourceResult = await mintSalesSourceCommissionForDeal(tenantDb, {
      dealId: deal.id,
      salesSourceUserId: deal.salesSourceUserId,
      triggeredByUserId: input.triggeredByUserId,
    });
  }
```

And add `salesSource` to the returned object (mirroring `.estimator`):

```ts
  return {
    ...ownerResult,
    estimator: estimatorResult ? { status: estimatorResult.status, repUserId: deal.estimatorUserId ?? undefined, amount: estimatorResult.amount } : undefined,
    salesSource: salesSourceResult ? { status: salesSourceResult.status, repUserId: deal.salesSourceUserId ?? undefined, amount: salesSourceResult.amount } : undefined,
  };
```

Add `salesSource?: {...}` to the `CalculateCommissionResult` type (mirror the `estimator?` field).

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:runtime --workspace=server -- sales-source-mint`
Expected: PASS (all 3 new cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/commissions/service.ts server/tests/modules/commissions/sales-source-mint.runtime.test.ts
git commit -m "feat(commissions): mint additive sales_source commission row at sign"
```

---

## Task 6: Make the recompute role-aware (INV-1, second half)

**Files:**
- Modify: `server/src/modules/commissions/service.ts` (`recalculateCommissionForDeal` per-row loop)
- Test: `server/tests/modules/commissions/recompute-rep.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `recompute-rep.runtime.test.ts`: a mixed rep with an owner row AND a sales_source row on different deals; change their `service_source_rate`; recompute; assert the sales_source row re-rates at the NEW service-source rate while the owner row uses the capX mirror. (Copy the harness patterns already in that file.)

```ts
it("re-rates a sales_source row at the service-source rate, not the capX mirror", async () => {
  const SRC = U("0a20");            // mixed rep who sources
  const SVC = U("0a21");            // service-rep owner
  const D = U("0c20");
  await pg.exec(`INSERT INTO public.users (id,email,display_name,role,office_id,is_active) VALUES
    ('${SRC}','src@t.test','Src','rep','${OFFICE}',true),('${SVC}','svc@t.test','Svc','rep','${OFFICE}',true)`);
  await pg.exec(`INSERT INTO public.user_commission_settings
    (user_id,commission_rate,commission_structure,capx_rate_solo,capx_rate_mixed,service_source_rate,is_active) VALUES
    ('${SRC}',0.020000,'mixed',0.030000,0.020000,0.005000,true),
    ('${SVC}',0.030000,'solo',0.030000,0.020000,0.000000,true)`);
  await pg.exec(`INSERT INTO public.deals (id,deal_number,name,stage_id,assigned_rep_id,sales_source_user_id,
    awarded_amount,bid_estimate,dd_estimate,is_change_order,on_hold,office_code,contract_signed_date)
    VALUES ('${D}','D-0c20','Sourced','${STAGE}','${SVC}','${SRC}',100000,NULL,NULL,false,false,NULL,'2026-09-15')`);
  await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
  // sales_source baseline: 100000 × 0.005 = 500.00
  const srcRow = async () => (await pg.query<{amount:string;applied_rate:string}>(
    `SELECT amount, applied_rate FROM public.deal_signed_commissions WHERE deal_id=$1 AND rep_user_id=$2 AND attribution_role='sales_source' LIMIT 1`, [D, SRC])).rows[0];
  expect(await srcRow()).toEqual({ amount: "500.00", applied_rate: "0.005000" });

  // Raise the source rep's service-source rate to 0.8% (capX mirror unchanged at 0.02).
  await pg.exec(`UPDATE public.user_commission_settings SET service_source_rate = 0.008000 WHERE user_id = '${SRC}'`);
  await recalculateRepCommissionsInOffice(tdb, SRC, ADMIN);
  // Must re-rate at the SERVICE-SOURCE rate (0.008), NOT the capX mirror (0.02).
  expect(await srcRow()).toEqual({ amount: "800.00", applied_rate: "0.008000" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:runtime --workspace=server -- recompute-rep`
Expected: FAIL — the row re-rates at the capX mirror (0.02 → 2000.00), not the service-source rate.

- [ ] **Step 3: Make the per-row re-rate role-aware**

In `recalculateCommissionForDeal`, the per-row loop currently selects `commissionRate` from settings and applies it. Change it to (a) select `dsc.attribution_role` in `existingRows`, and (b) resolve the rate via `resolveAppliedRateForRole(tenantDb, row.repUserId, row.attributionRole)`:

Add `attributionRole: dealSignedCommissions.attributionRole` to the `existingRows` select. Replace the per-row settings-read + skip block with:

```ts
    const appliedRate = await resolveAppliedRateForRole(
      tenantDb, row.repUserId, row.attributionRole as CommissionRole,
    );
    // ALL-OR-NOTHING preserve when no valid rate — EXCEPT a deliberate 0% under zeroOnNoRate (PR1).
    if (!sourceValue) continue;
    if (appliedRate === null && !input.zeroOnNoRate) continue;
    const effectiveAppliedRate = appliedRate ?? "0";
    const amount = multiplyDecimalStrings(sourceValue.amount, effectiveAppliedRate);
```

Then the existing `update(...).set({ appliedRate: effectiveAppliedRate, amount, ... })`. Note: `resolveAppliedRateForRole` already folds in the isActive/rate>0 checks, so the old `!settings || !settings.isActive || rate<=0` conditions are subsumed. Keep the `zeroOnNoRate` semantics from PR1 (deliberate 0 zeros the row).

- [ ] **Step 4: Run the full commission suite (recompute + regressions)**

Run: `npm run test:runtime --workspace=server -- commissions`
Expected: PASS (new sales_source recompute test + all PR1 recompute/zeroing/scoping/preserve tests still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/commissions/service.ts server/tests/modules/commissions/recompute-rep.runtime.test.ts
git commit -m "fix(commissions): recompute re-rates each dsc row by its attribution role (INV-1)"
```

---

## Task 7: Recompute-gate extension (INV-2)

**Files:**
- Modify: `server/src/modules/admin/users-service.ts`

- [ ] **Step 1: Fire the recompute on an effective service-source rate change too**

In `updateUser`'s commission branch, PR1 set `commissionRatesChanged` by comparing the effective capX rate (`commissionRate.toFixed(6) !== previousCommissionRate.toFixed(6)`). Extend it to ALSO compare the effective service-source rate. Add the import at the top:

```ts
import { resolveEffectiveCapxRate, resolveEffectiveServiceSourceRate } from "@trock-crm/shared/lib/commission-structure";
```

Then, where `commissionRatesChanged` is computed, add the service-source comparison (using the resolved `commissionStructure`, `serviceSourceRate` new values vs `current`):

```ts
      const previousServiceSourceRate = resolveEffectiveServiceSourceRate({
        commissionStructure: current?.commissionStructure ?? "solo",
        capxRateSolo: Number(current?.capxRateSolo ?? 0),
        capxRateMixed: Number(current?.capxRateMixed ?? 0),
        serviceSourceRate: Number(current?.serviceSourceRate ?? 0),
      });
      const nextServiceSourceRate = resolveEffectiveServiceSourceRate({
        commissionStructure, capxRateSolo, capxRateMixed, serviceSourceRate,
      });
      commissionRatesChanged =
        commissionRate.toFixed(6) !== previousCommissionRate.toFixed(6) ||
        nextServiceSourceRate.toFixed(6) !== previousServiceSourceRate.toFixed(6);
```

(Delete PR1's stale "PR2 will additionally gate on the effective service-source rate" comment above this block — it's now implemented.)

- [ ] **Step 2: Typecheck + run admin/commission runtime**

Run: `npm run build --workspace=shared && npm run typecheck --workspace=server && npm run test:runtime --workspace=server -- admin commissions`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/admin/users-service.ts
git commit -m "feat(commissions): recompute when the effective service-source rate changes (INV-2)"
```

---

## Task 8: Floor-gate sales-source qualifying leg

**Files:**
- Modify: `server/src/modules/commissions/floor-gate.ts` (`computeRepEarnedFloorGate`, qualifyingRevenue ~79-125)
- Test: `server/tests/modules/commissions/floor-gate-sales-source.runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `floor-gate-sales-source.runtime.test.ts` (copy the harness from the existing `floor-gate.runtime.test.ts`, incl. `pipeline_stage_config`/`psc` seeding). Seed: a signed, non-lost, active service deal owned by a service rep, sourced by mixed rep SRC. Assert `computeRepEarnedFloorGate(tdb, SRC, {...})` returns `qualifyingRevenue` including that deal's full value (SRC owns nothing else).

```ts
it("credits a sourced service deal to the source rep's qualifying revenue at full value", async () => {
  // ... seed deal value 100000, sales_source_user_id = SRC, owner = SVC, signed/not-lost/active ...
  const gate = await computeRepEarnedFloorGate(tdb, SRC, { from: null, to: null });
  expect(Number(gate.qualifyingRevenue)).toBe(100000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:runtime --workspace=server -- floor-gate-sales-source`
Expected: FAIL — SRC's qualifyingRevenue is 0 (owner-only legs).

- [ ] **Step 3: Add the sales-source qualifying leg**

In `computeRepEarnedFloorGate`, `qualifyingRevenue` is built from owner-based legs. Add a sales-source leg that sums, at full value, deals where `d.sales_source_user_id = ${repId}` under the SAME filters the owner leg uses (`is_test_data=false`, `qualifyingSignedDate IS NOT NULL`, `notLost`, `aliasedActiveDealCountFilterSql("d")`, and the date window). Because a rep can never be both owner and source of the same deal (mint guard), summing the owner leg + a sales-source leg cannot double-count for one rep. Implementation: add a second `SELECT COALESCE(SUM(...),0)` term to the qualifyingRevenue expression:

```sql
      + COALESCE((
          SELECT SUM(COALESCE(d.awarded_amount, d.bid_estimate, d.dd_estimate, 0))
          FROM ${deals} d
          JOIN ${pipelineStageConfig} psc ON psc.id = d.stage_id
          WHERE d.sales_source_user_id = ${repId}
            AND COALESCE(d.is_test_data, false) = false
            AND ${qualifyingSignedDate} IS NOT NULL
            AND ${notLost}
            AND ${aliasedActiveDealCountFilterSql("d")}
            ${dateRange.from ? sql`AND ${qualifyingSignedDate} >= ${dateRange.from}::date` : sql``}
            ${dateRange.to ? sql`AND ${qualifyingSignedDate} <= ${dateRange.to}::date` : sql``}
        ), 0)
```

(Match the exact predicate helpers used by the owner leg — `qualifyingSignedDate`, `notLost`, `aliasedActiveDealCountFilterSql` are already defined in the function. Note the owner leg's `qualifyingSignedDate` COALESCE references `oq.owner_signed_date`, which is irrelevant for the source leg — use `COALESCE(d.contract_signed_at::date, d.contract_signed_date)` for the source leg's signed predicate, since a source rep has no owner `oq` row. Define a `sourceSignedDate = sql\`COALESCE(d.contract_signed_at::date, d.contract_signed_date)\`` and use it in the source leg's `IS NOT NULL` + date-window checks.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:runtime --workspace=server -- floor-gate`
Expected: PASS (new sales-source test + existing floor-gate tests unaffected — owner-only reps have no sales-source deals).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/commissions/floor-gate.ts server/tests/modules/commissions/floor-gate-sales-source.runtime.test.ts
git commit -m "feat(commissions): floor-gate credits sourced service deals to the source rep"
```

---

## Task 9: Server — create route accepts `salesSourceUserId`; `setDealSalesSource` + override route

**Files:**
- Modify: `server/src/modules/deals/service.ts` (`CreateDealInput`, `createDeal` insert, new `setDealSalesSource`, `removeSalesSourceCommissionForDeal` import)
- Modify: `server/src/modules/commissions/service.ts` (add `removeSalesSourceCommissionForDeal`)
- Modify: `server/src/modules/deals/routes.ts` (create route body + call; new `PATCH /:id/sales-source`)

- [ ] **Step 1: Add `removeSalesSourceCommissionForDeal` (mirror the estimator remover)**

In `commissions/service.ts`, add (mirroring `removeEstimatorCommissionForDeal`, role-scoped to `'sales_source'`):

```ts
export async function removeSalesSourceCommissionForDeal(
  tx: TenantDb,
  input: { dealId: string; salesSourceUserId: string; triggeredByUserId: string | null },
): Promise<number> {
  const removed = await tx
    .delete(dealSignedCommissions)
    .where(and(
      eq(dealSignedCommissions.dealId, input.dealId),
      eq(dealSignedCommissions.repUserId, input.salesSourceUserId),
      eq(dealSignedCommissions.attributionRole, "sales_source"),
    ))
    .returning({ id: dealSignedCommissions.id, amount: dealSignedCommissions.amount, repUserId: dealSignedCommissions.repUserId });
  for (const row of removed) {
    await writeAuditLog(tx, {
      tableName: "deal_signed_commissions", recordId: row.id, action: "delete", changedBy: input.triggeredByUserId,
      changes: { amount: { from: row.amount, to: null }, repUserId: { from: row.repUserId, to: null }, dealId: { from: input.dealId, to: null } },
    });
  }
  return removed.length;
}
```

- [ ] **Step 2: `CreateDealInput.salesSourceUserId` + write it in `createDeal`**

In `deals/service.ts`: add `salesSourceUserId?: string | null;` to `CreateDealInput` (~327-362). In the `createDeal` insert `.values({...})` (~2128-2164), add near `source`:

```ts
        salesSourceUserId: input.salesSourceUserId ?? null,
```

- [ ] **Step 3: `setDealSalesSource` service fn (mirror `setDealEstimator`, minus estimator-only bits)**

In `deals/service.ts`, add `setDealSalesSource(tenantDb, dealId, newSalesSourceUserId, userId, officeId)` mirroring `setDealEstimator` (SELECT … FOR UPDATE with `isActive=true`; change-order 409 lock; no-op short-circuit; `validateAssignee` for a non-null new source; UPDATE `salesSourceUserId`; audit; CO-child propagation if applicable). For commission re-attribution, use the sales_source removers/minters instead of estimator ones:

```ts
    // Re-attribute commissions: drop the old source's sales_source row, mint the new source's.
    if (oldSalesSourceUserId) {
      await removeSalesSourceCommissionForDeal(tx, { dealId, salesSourceUserId: oldSalesSourceUserId, triggeredByUserId: userId });
    }
    if (newSalesSourceUserId) {
      await mintSalesSourceCommissionForDeal(tx, { dealId, salesSourceUserId: newSalesSourceUserId, triggeredByUserId: userId });
    }
```

Import `removeSalesSourceCommissionForDeal` and `mintSalesSourceCommissionForDeal` from `../commissions/service.js`. Do NOT include the estimator-only bid-board first-fill lock.

- [ ] **Step 4: Create route accepts `salesSourceUserId`; add the override route**

In `deals/routes.ts` `POST /service-opportunity`: add `salesSourceUserId` to the body destructure (~1947-1963) and to the `createDeal(...)` call (~1993-2019). Then add a new route mirroring `PATCH /:id/estimator` (~2132-2179):

```ts
router.patch(
  "/:id/sales-source",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      await assertDealRouteAccess(req, req.params.id as string);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!("salesSourceUserId" in body)) {
        throw new AppError(422, "salesSourceUserId is required (send null to clear the sales source)");
      }
      const raw = body.salesSourceUserId;
      let salesSourceUserId: string | null;
      if (raw == null || raw === "") salesSourceUserId = null;
      else if (typeof raw === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim())) salesSourceUserId = raw.trim();
      else throw new AppError(422, "salesSourceUserId must be a valid UUID or null");
      const deal = await setDealSalesSource(req.tenantDb!, req.params.id as string, salesSourceUserId, req.user!.id, req.user!.activeOfficeId ?? req.user!.officeId);
      if (!deal) throw new AppError(404, "Deal not found");
      await req.commitTransaction!();
      const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
      res.json({ deal: redactDealResponse(deal, { includeHubspotId }) });
    } catch (err) { next(err); }
  },
);
```

Import `setDealSalesSource` from the service. **Lock it from generic update:** add `salesSourceUserId` to the generic `PATCH /:id` exclusion the same way `estimatorUserId` is pulled out (routes.ts ~2048-2049) so a rep can't change it post-creation via the generic path.

- [ ] **Step 5: Typecheck + run deal/commission runtime**

Run: `npm run build --workspace=shared && npm run typecheck --workspace=server && npm run test:runtime --workspace=server -- deals commissions`
Expected: PASS. (If a `setDealSalesSource` runtime test is warranted, add one mirroring any existing `setDealEstimator` test.)

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/deals/service.ts server/src/modules/deals/routes.ts server/src/modules/commissions/service.ts
git commit -m "feat(deals): sales-source create field + leadership-gated override route + re-attribution"
```

---

## Task 10: Client — types, create-form field, locked-from-update

**Files:**
- Modify: `client/src/hooks/use-deals.ts` (`Deal`, `CreateServiceOpportunityInput`, `updateDealSalesSource`, `WritableDealFields`)
- Modify: `client/src/components/deals/service-opportunity-form.tsx`

- [ ] **Step 1: Types + hook**

In `use-deals.ts`: add `salesSourceUserId?: string | null;` to the `Deal` type; add `"salesSourceUserId"` to the `CreateServiceOpportunityInput` `Pick<...>` union (~655-669); add `"salesSourceUserId"` to the `WritableDealFields` `Omit<...>` (~645) so the generic update path can't send it; add a mutation mirroring `updateDealEstimator`:

```ts
  const updateDealSalesSource = async (dealId: string, salesSourceUserId: string | null, opts?: { officeId?: string }) => {
    await api(`/deals/${dealId}/sales-source${opts?.officeId ? `?officeId=${opts.officeId}` : ""}`, {
      method: "PATCH", json: { salesSourceUserId },
    });
  };
```

Export it from the hook's return object.

- [ ] **Step 2: Service-opportunity form — Sales Source dropdown**

In `service-opportunity-form.tsx`: add `salesSourceUserId: ""` to the form-state object (~63-77); reuse the already-loaded `assignees` list (from `useTaskAssignees`, line 115) for the options. Add an OPTIONAL Sales Source `Select` right after the Assigned Sales Rep block (closes ~line 300) — first option is a blank "None". Include it in the submit payload (~190-205):

```tsx
salesSourceUserId: formData.salesSourceUserId || null,
```

```tsx
<div>
  <label className="...">Sales Source (optional)</label>
  <Select value={formData.salesSourceUserId} onValueChange={(v) => setFormData((f) => ({ ...f, salesSourceUserId: v === "__none__" ? "" : v }))}>
    <SelectTrigger className="..."><SelectValue placeholder="None" /></SelectTrigger>
    <SelectContent>
      <SelectItem value="__none__">None</SelectItem>
      {assignees.map((a) => (<SelectItem key={a.id} value={a.id}>{a.displayName}</SelectItem>))}
    </SelectContent>
  </Select>
  <p className="text-xs text-muted-foreground">The capX rep who brought this in. Set once — locked after creation.</p>
</div>
```

(Match the exact `Select`/label classNames used by the sibling Assigned Sales Rep control in this file.)

- [ ] **Step 3: Typecheck + build client**

Run: `npm run typecheck --workspace=client && npm run build --workspace=client`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/use-deals.ts client/src/components/deals/service-opportunity-form.tsx
git commit -m "feat(deals): Sales Source field on the service-opportunity form (set-once)"
```

---

## Task 11: Client — deal-detail Sales Source rail item (read-only + admin edit)

**Files:**
- Modify: `client/src/pages/deals/deal-detail-page.tsx` (`DealRightRail`)

- [ ] **Step 1: Add a Sales Source `DetailRailItem` after the Estimator item**

In `DealRightRail`, after the Estimator `DetailRailItem` (closes ~line 1314, before `</DetailRailSection>` at 1315), add a Sales Source item. Reuse `canEditEstimator`'s condition for the edit gate (`admin`/`director`), the `salesReps` list already fetched (~1112-1115), and a handler mirroring `handleEstimatorChange` that calls `updateDealSalesSource(deal.id, nextId, { officeId })`. Read-only for non-leadership; a `Select` (with a "None" option) for admin/director. Resolve the display name from `salesReps` (fall back to "Not set"). Mirror the estimator item's structure exactly, minus the change-order/bid-board special cases (sales source has no such locks — but keep it read-only when `deal.isChangeOrder`, since change orders inherit and don't carry their own source).

- [ ] **Step 2: Typecheck + build client**

Run: `npm run typecheck --workspace=client && npm run build --workspace=client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/deals/deal-detail-page.tsx
git commit -m "feat(deals): Sales Source on deal detail (read-only + admin/director override)"
```

---

## Task 12: Full validation + ADVERSARIAL PRE-PR REVIEW (required before PR)

**This phase is mandatory and precedes `gh pr create`.** It exists because PR1 accrued ~18 Codex/CodeRabbit findings post-open; a thorough pre-PR review catches them first.

- [ ] **Step 1: Full local gate**

Run each and confirm PASS:
- `npm run build` (all workspaces)
- `npm run typecheck:tests:all`
- `npm run test:ci --workspace=shared`
- `npm run test:runtime --workspace=server`
- `npm run test:ci --workspace=server`
- `npm run test:scripts`
- `npm run build --workspace=client`

- [ ] **Step 2: Dispatch adversarial review subagents (distinct lenses), fix every real finding**

Run these review lenses (each a fresh subagent reading the branch diff `git diff origin/main..HEAD`), and fix everything real BEFORE opening the PR:
1. **Correctness & concurrency:** the mint guards (owner-row invariant, source≠owner/estimator, dedup unique key), `setDealSalesSource` uses `SELECT … FOR UPDATE`, no lost-update, re-attribution order (remove-then-mint) correct.
2. **INV-1 (role-aware rate):** prove no path rates a sales_source row at the capX mirror — mint AND recompute AND `setDealSalesSource` re-mint.
3. **INV-2 (recompute gate):** a service-source-rate-only edit fires the recompute; a no-op edit does not.
4. **Floor gate:** no double-count (owner+source same rep can't happen); source leg uses the source-specific signed-date predicate; existing floor tests unaffected.
5. **DB integrity:** migration 0175 loops tenants + has the TENANT_SCHEMA block + matches the estimator FK pattern; `attribution_role='sales_source'` needs no enum change.
6. **Back-compat / gating:** sales_source is set-once at creation, excluded from the generic update allowlist, only the leadership route changes it; the change-order inheritance case is handled.
7. **UX / reconciliation:** the detail item + form label read clearly; per the [[reconciliation-consistency-rule]], sales_source earned flows to the rep's earned aggregate (it does, via `dsc.rep_user_id`) AND the floor qualifying leg — card/drawer/aggregate move together.

- [ ] **Step 3: Re-run the full gate after fixes, then open the PR**

Once the gate is green AND the review lenses are clean, push and open the PR. Deferred/live-DB steps (apply migration 0175, manual smoke of a sourced service deal) go in the PR body as Adnaan's checklist.

```bash
git push -u origin feat/sales-source-commission
gh pr create --base main --title "feat(commissions): sales-source attribution + additive commission (PR2)" --body "<summary, INV-1/INV-2 notes, live-DB checklist>"
```

---

## Notes for the implementer

- **Depends on PR1 (merged):** `resolveEffectiveServiceSourceRate`, `service_source_rate` column, cross-office recompute, and the shared-lib import aliases already exist.
- **INV-1 is the whole ballgame:** if you take one shortcut, do not let it be the role-aware rate. A sales_source row at the capX rate is a silent money bug.
- **The recompute already covers sales_source rows for free** structurally (it keys on `dsc.rep_user_id`) — Task 6 only fixes the RATE it applies to them.
- **Migration is Adnaan's prod-write.** Author it; never apply it.
