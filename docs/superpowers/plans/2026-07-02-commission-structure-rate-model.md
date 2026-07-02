# Commission Structure + Rate Model (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each rep a solo/mixed commission **structure** with two per-rep capX rates and a service-source rate, editable on the Users page, and re-rate that rep's already-signed deals across all offices whenever those settings change.

**Architecture:** Add four columns to the `public.user_commission_settings` table. A pure resolver in `shared/` turns `(structure, capxRateSolo, capxRateMixed)` into an **effective capX rate** that the settings-save mirrors into the existing `commission_rate` column — so every existing engine read stays untouched (the "denormalized mirror"). When rate/structure fields change, a cross-office recompute re-runs the existing per-deal commission writer against the rep's `deal_signed_commissions` rows so earned commission reflects the new rates (the "live recompute", earned stays snapshot-backed).

**Tech Stack:** TypeScript, Drizzle ORM, node-postgres (pooled, `search_path`-scoped tenant connections), Express, React + shadcn/ui, Vitest + PGlite runtime tests, plain `.sql` migrations applied in filename order.

**Scope note:** This is PR1 of two. PR2 (Sales Source field + `sales_source` additive dsc row + floor-gate extension) depends on the resolvers and recompute shipped here and gets its own plan. Sales-source rows do not exist yet in PR1, so the recompute here only touches `owner`/`estimator` rows.

---

## File Structure

**Create:**
- `migrations/0173_commission_structure_rates.sql` — add 4 columns to `public.user_commission_settings` + backfill.
- `shared/src/lib/commission-structure.ts` — pure resolver functions + types (single source of truth for solo/mixed → effective rate).
- `shared/src/lib/commission-structure.test.ts` — unit tests for the resolvers.
- `server/src/modules/commissions/recompute-service.ts` — `recalculateRepCommissionsInOffice` (per-office core) + `recalculateAllCommissionsForRep` (cross-office fan-out).
- `server/tests/modules/commissions/recompute-rep.runtime.test.ts` — PGlite test for the per-office recompute core.

**Modify:**
- `shared/src/schema/public/user-commission-settings.ts` — add 4 Drizzle columns.
- `server/src/modules/commissions/service.ts:422` — export `effectiveSignedDateOf`.
- `server/src/modules/admin/users-service.ts` — extend `updateUser` input/validation/upsert (write the effective-rate mirror), trigger recompute after commit, extend `getUsersWithStats` SELECT + row map.
- `client/src/hooks/use-admin-users.ts` — extend the `AdminUser` type.
- `client/src/pages/admin/users-page.tsx` — extend the commission handler, render a Solo/Mixed structure `Select` + capX/service-source rate inputs.

---

## Task 1: Pure structure/rate resolvers (shared)

**Files:**
- Create: `shared/src/lib/commission-structure.ts`
- Test: `shared/src/lib/commission-structure.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/src/lib/commission-structure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isCommissionStructure,
  resolveEffectiveCapxRate,
  resolveEffectiveServiceSourceRate,
  type CommissionStructureRates,
} from "./commission-structure.js";

const rates = (over: Partial<CommissionStructureRates> = {}): CommissionStructureRates => ({
  commissionStructure: "solo",
  capxRateSolo: 0.03,
  capxRateMixed: 0.025,
  serviceSourceRate: 0.005,
  ...over,
});

describe("resolveEffectiveCapxRate", () => {
  it("uses the solo rate under the solo structure", () => {
    expect(resolveEffectiveCapxRate(rates({ commissionStructure: "solo" }))).toBe(0.03);
  });

  it("uses the mixed rate under the mixed structure", () => {
    expect(resolveEffectiveCapxRate(rates({ commissionStructure: "mixed" }))).toBe(0.025);
  });
});

describe("resolveEffectiveServiceSourceRate", () => {
  it("is zero under solo even if a stray rate is stored", () => {
    expect(resolveEffectiveServiceSourceRate(rates({ commissionStructure: "solo" }))).toBe(0);
  });

  it("is the stored service-source rate under mixed", () => {
    expect(resolveEffectiveServiceSourceRate(rates({ commissionStructure: "mixed" }))).toBe(0.005);
  });
});

describe("isCommissionStructure", () => {
  it("accepts the two valid values and rejects anything else", () => {
    expect(isCommissionStructure("solo")).toBe(true);
    expect(isCommissionStructure("mixed")).toBe(true);
    expect(isCommissionStructure("hybrid")).toBe(false);
    expect(isCommissionStructure(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ci --workspace=shared -- commission-structure`
Expected: FAIL — cannot resolve `./commission-structure.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `shared/src/lib/commission-structure.ts`:

```ts
/**
 * Solo vs mixed commission structure — the single source of truth for turning a rep's stored
 * structure + two capX rates into the EFFECTIVE rates the engine applies. The settings-save
 * mirrors resolveEffectiveCapxRate(...) into user_commission_settings.commission_rate so every
 * existing engine read (which reads commission_rate) stays untouched (the "denormalized mirror").
 */
export type CommissionStructure = "solo" | "mixed";

export interface CommissionStructureRates {
  commissionStructure: CommissionStructure;
  capxRateSolo: number;
  capxRateMixed: number;
  serviceSourceRate: number;
}

export function isCommissionStructure(value: unknown): value is CommissionStructure {
  return value === "solo" || value === "mixed";
}

/** The capX rate that applies to the rep's own owned deals under their active structure. */
export function resolveEffectiveCapxRate(rates: CommissionStructureRates): number {
  return rates.commissionStructure === "mixed" ? rates.capxRateMixed : rates.capxRateSolo;
}

/**
 * The rate applied to service deals this rep SOURCED. Only live under the mixed structure —
 * a solo rep with a stray serviceSourceRate value never earns a sales-source cut.
 */
export function resolveEffectiveServiceSourceRate(rates: CommissionStructureRates): number {
  return rates.commissionStructure === "mixed" ? rates.serviceSourceRate : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:ci --workspace=shared -- commission-structure`
Expected: PASS (7 assertions).

- [ ] **Step 5: Register the shared export (required for server imports)**

`shared/package.json`'s `exports` map is EXPLICIT (no `./lib/*` wildcard) — the server can't import a shared/lib module unless it's listed. Add an entry mirroring the existing `./lib/userProvisioningGuards` block:

```json
    "./lib/commission-structure": {
      "types": "./dist/lib/commission-structure.d.ts",
      "default": "./dist/lib/commission-structure.js"
    },
```

Then build shared so the `dist/` artifact the server resolves exists:

Run: `npm run build --workspace=shared`
Expected: PASS; `shared/dist/lib/commission-structure.js` now exists.

- [ ] **Step 6: Commit**

```bash
git add shared/src/lib/commission-structure.ts shared/src/lib/commission-structure.test.ts shared/package.json
git commit -m "feat(commissions): add solo/mixed structure rate resolvers"
```

---

## Task 2: Migration — structure + rate columns on user_commission_settings

**Files:**
- Create: `migrations/0173_commission_structure_rates.sql`

- [ ] **Step 1: Write the migration**

`user_commission_settings` is a **public** (shared, non-tenant) table, so this is a plain `ALTER TABLE public.… ADD COLUMN IF NOT EXISTS` — no `office_*` DO-loop and no `TENANT_SCHEMA` markers (pattern of `0142`/`0163`). Create `migrations/0173_commission_structure_rates.sql`:

```sql
-- Migration 0173: solo/mixed commission structure + per-rep capX and service-source rates.
--
-- Adds four columns to the SHARED public.user_commission_settings table (one row per user):
--   commission_structure  'solo' | 'mixed' -- the rep's active structure.
--   capx_rate_solo        capX rate when solo (the higher rate).
--   capx_rate_mixed       capX rate when mixed (the lower rate).
--   service_source_rate   rate on service deals this rep sourced (effective under 'mixed' only).
--
-- The existing commission_rate column is RETAINED as the denormalized EFFECTIVE capX rate,
-- kept in sync by the settings-save. Backfill sets both capX rates to the current
-- commission_rate and leaves every rep on 'solo', so the effective rate is UNCHANGED and no
-- payout moves on deploy. Idempotent: IF NOT EXISTS + re-runnable UPDATE.
--
-- public.user_commission_settings is a single shared table (FK to public.users), so this is a
-- plain ALTER -- no per-tenant office_* loop and no provisioner replay block.

ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS commission_structure text NOT NULL DEFAULT 'solo';
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS capx_rate_solo numeric(7,6) NOT NULL DEFAULT 0;
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS capx_rate_mixed numeric(7,6) NOT NULL DEFAULT 0;
ALTER TABLE public.user_commission_settings
  ADD COLUMN IF NOT EXISTS service_source_rate numeric(7,6) NOT NULL DEFAULT 0;

-- Backfill: existing reps keep their current effective rate. Both capX rates start equal to
-- commission_rate; structure stays 'solo' (the default). Re-runnable (guarded so it only seeds
-- rows still carrying the 0 default, never clobbering an edited rate on re-run).
UPDATE public.user_commission_settings
SET capx_rate_solo = commission_rate,
    capx_rate_mixed = commission_rate
WHERE capx_rate_solo = 0
  AND capx_rate_mixed = 0
  AND commission_rate <> 0;
```

- [ ] **Step 2: Apply the migration locally and verify**

Migrations are plain `.sql` files applied in filename order by `server/src/migrations/runner.ts` (which self-invokes on execution and skips already-applied files tracked in `public._migrations`). Apply locally by running the runner (uses `DATABASE_URL` from env):

Run: `npx tsx server/src/migrations/runner.ts`
Expected: `0173_commission_structure_rates.sql` reported applied; re-running is a no-op.

Verify the columns exist and backfill held (effective rate unchanged):

Run:
```bash
node .worktrees/feat-permanent-run-sql/scripts/run-sql.cjs "SELECT user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate FROM public.user_commission_settings LIMIT 5"
```
Expected: every row has `commission_structure='solo'`, `capx_rate_solo = capx_rate_mixed = commission_rate`, `service_source_rate=0`.

- [ ] **Step 3: Commit**

```bash
git add migrations/0173_commission_structure_rates.sql
git commit -m "feat(commissions): migration 0173 - structure + capX/service-source rate columns"
```

---

## Task 3: Drizzle schema — add the four columns

**Files:**
- Modify: `shared/src/schema/public/user-commission-settings.ts`

- [ ] **Step 1: Add the columns to the Drizzle table**

Edit `shared/src/schema/public/user-commission-settings.ts`. Insert the four new columns immediately after the `commissionRate` line (line 13), so the effective mirror and its inputs sit together:

```ts
  commissionRate: numeric("commission_rate", { precision: 7, scale: 6 }).notNull().default("0"),
  commissionStructure: text("commission_structure").notNull().default("solo"),
  capxRateSolo: numeric("capx_rate_solo", { precision: 7, scale: 6 }).notNull().default("0"),
  capxRateMixed: numeric("capx_rate_mixed", { precision: 7, scale: 6 }).notNull().default("0"),
  serviceSourceRate: numeric("service_source_rate", { precision: 7, scale: 6 }).notNull().default("0"),
```

Add `text` to the drizzle import at the top of the file (it currently imports `pgTable, uuid, numeric, integer, boolean, timestamp`):

```ts
import {
  pgTable,
  uuid,
  numeric,
  integer,
  boolean,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 2: Typecheck the shared package**

Run: `npm run typecheck --workspace=shared`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add shared/src/schema/public/user-commission-settings.ts
git commit -m "feat(commissions): add structure/rate columns to drizzle schema"
```

---

## Task 4: Export `effectiveSignedDateOf` for reuse

**Files:**
- Modify: `server/src/modules/commissions/service.ts:422`

- [ ] **Step 1: Export the helper**

Edit `server/src/modules/commissions/service.ts`. Change line 422 from:

```ts
function effectiveSignedDateOf(deal: {
```

to:

```ts
export function effectiveSignedDateOf(deal: {
```

(The recompute core in Task 5 needs it to preserve each deal's signed date during re-rating.)

- [ ] **Step 2: Typecheck the server package**

Run: `npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/commissions/service.ts
git commit -m "refactor(commissions): export effectiveSignedDateOf for recompute reuse"
```

---

## Task 5: Cross-office recompute service

**Files:**
- Create: `server/src/modules/commissions/recompute-service.ts`
- Test: `server/tests/modules/commissions/recompute-rep.runtime.test.ts`

The testable core is `recalculateRepCommissionsInOffice(officeDb, repUserId, triggeredByUserId)`: it finds every deal in one office where the rep books a dsc row and re-runs the existing `recalculateCommissionForDeal` (which re-rates each row at its booked rep's CURRENT effective rate — i.e. the mirror the settings-save just wrote). The `recalculateAllCommissionsForRep` fan-out is thin glue over the existing office helpers.

- [ ] **Step 1: Write the failing test**

Create `server/tests/modules/commissions/recompute-rep.runtime.test.ts`. This copies the harness from `server/tests/modules/commissions/calculate.runtime.test.ts` (PGlite + `tenantSchemaSql` + the `deal_signed_commissions_dedup` UNIQUE):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
  offices,
  userCommissionSettings,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { calculateCommissionForDeal } from "../../../src/modules/commissions/service.js";
import { recalculateRepCommissionsInOffice } from "../../../src/modules/commissions/recompute-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");
const ADMIN = U("0aad");
const REP = U("0a01");
const STAGE = U("0500");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function ownerRow(dealId: string) {
  const { rows } = await pg.query<{ amount: string; applied_rate: string }>(
    `SELECT amount, applied_rate FROM public.deal_signed_commissions
     WHERE deal_id = '${dealId}' AND attribution_role = 'owner' LIMIT 1`,
  );
  return rows[0];
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [deals, userCommissionSettings, dealSignedCommissions, auditLog, users, offices]),
  );
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`,
  );
  tdb = drizzle(pg);

  await pg.exec(
    `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
     VALUES ('${ADMIN}', 'admin@t.test', 'Admin', 'admin', '${OFFICE}', true),
            ('${REP}', 'rep@t.test', 'Rep', 'rep', '${OFFICE}', true)`,
  );
  // Start at the SOLO effective rate 0.030000 (mirror == commission_rate).
  await pg.exec(
    `INSERT INTO public.user_commission_settings
       (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
     VALUES ('${REP}', 0.030000, 'solo', 0.030000, 0.020000, 0.005000, true)`,
  );
  // A signed deal owned by REP, valued 100000 → owner row 3000.00 at 0.030000.
  await pg.exec(
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
        is_change_order, on_hold, office_code, contract_signed_date)
     VALUES ('${U("0c01")}', 'D-0c01', 'Deal', '${STAGE}', '${REP}', 100000, NULL, NULL,
        false, false, NULL, '2026-09-15')`,
  );
  await calculateCommissionForDeal(tdb, {
    dealId: U("0c01"),
    contractSignedDate: "2026-09-15",
    triggeredByUserId: ADMIN,
  });
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("recalculateRepCommissionsInOffice", () => {
  it("re-rates the rep's signed deals to the current effective mirror rate", async () => {
    // Baseline: solo rate 0.030000 → 3000.00.
    expect(await ownerRow(U("0c01"))).toEqual({ amount: "3000.00", applied_rate: "0.030000" });

    // Simulate a solo→mixed flip: the settings-save mirrors the mixed capX rate into commission_rate.
    await pg.exec(
      `UPDATE public.user_commission_settings
       SET commission_structure = 'mixed', commission_rate = 0.020000
       WHERE user_id = '${REP}'`,
    );

    const count = await recalculateRepCommissionsInOffice(tdb, REP, ADMIN);
    expect(count).toBe(1);

    // 100000 × 0.020000 = 2000.00 at the new mirror rate.
    expect(await ownerRow(U("0c01"))).toEqual({ amount: "2000.00", applied_rate: "0.020000" });
  });

  it("returns 0 when the rep books no rows in the office", async () => {
    expect(await recalculateRepCommissionsInOffice(tdb, U("0a99"), ADMIN)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:runtime --workspace=server -- recompute-rep`
Expected: FAIL — cannot resolve `../../../src/modules/commissions/recompute-service.js`.

- [ ] **Step 3: Write the recompute service**

Create `server/src/modules/commissions/recompute-service.ts`:

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { dealSignedCommissions, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import {
  listActiveFieldOffices,
  runInOfficeTransaction,
} from "../field/cross-office.js";
import { effectiveSignedDateOf, recalculateCommissionForDeal } from "./service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Re-rate every deal in ONE office where `repUserId` books a deal_signed_commissions row, using
 * the rep's CURRENT effective rate (the mirror written by the settings-save). Delegates to the
 * existing per-deal writer, which recomputes each row at its own booked rep's current rate and
 * preserves rep/role/date (attribution-preserving). Returns the number of deals recomputed.
 */
export async function recalculateRepCommissionsInOffice(
  officeDb: TenantDb,
  repUserId: string,
  triggeredByUserId: string,
): Promise<number> {
  const dealRows = await officeDb
    .selectDistinct({ dealId: dealSignedCommissions.dealId })
    .from(dealSignedCommissions)
    .where(eq(dealSignedCommissions.repUserId, repUserId));

  let recomputed = 0;
  for (const { dealId } of dealRows) {
    const [deal] = await officeDb
      .select({
        contractSignedAt: deals.contractSignedAt,
        contractSignedDate: deals.contractSignedDate,
      })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1);
    // Preserve the deal's own signed date so re-rating changes only amount/rate, never the date.
    const signedDate = deal ? effectiveSignedDateOf(deal) : null;
    if (!signedDate) continue;

    // recalculateCommissionForDeal returns status "created" when ≥1 row was actually re-rated,
    // else "skipped_no_rate" (no source value / inactive / zero rate). Only count real re-rates.
    const result = await recalculateCommissionForDeal(officeDb, {
      dealId,
      contractSignedDate: signedDate,
      triggeredByUserId,
    });
    if (result.status === "created") recomputed += 1;
  }
  return recomputed;
}

export interface RepRecomputeSummary {
  recomputed: number;
  officeFailures: Array<{ office: string; error: string }>;
}

/**
 * Fan out {@link recalculateRepCommissionsInOffice} across ALL active offices (there is no
 * rep→offices map; the established pattern fans out unconditionally, and a rep with no rows in
 * an office simply recomputes 0). Each office runs in its own transaction; one office failing
 * degrades gracefully and is reported, never thrown.
 */
export async function recalculateAllCommissionsForRep(
  userId: string,
  triggeredByUserId: string,
): Promise<RepRecomputeSummary> {
  const offices = await listActiveFieldOffices();
  let recomputed = 0;
  const officeFailures: Array<{ office: string; error: string }> = [];

  for (const office of offices) {
    try {
      recomputed += await runInOfficeTransaction(office, triggeredByUserId, (officeDb) =>
        recalculateRepCommissionsInOffice(officeDb, userId, triggeredByUserId),
      );
    } catch (err) {
      officeFailures.push({
        office: office.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { recomputed, officeFailures };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:runtime --workspace=server -- recompute-rep`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/commissions/recompute-service.ts server/tests/modules/commissions/recompute-rep.runtime.test.ts
git commit -m "feat(commissions): cross-office rep commission recompute"
```

---

## Task 6: Users-service — accept structure/rates, mirror effective rate, trigger recompute

**Files:**
- Modify: `server/src/modules/admin/users-service.ts`

- [ ] **Step 1: Add a structure validator**

Edit `server/src/modules/admin/users-service.ts`. Add near the other validators (after `assertPositiveInteger`, ~line 69):

```ts
function assertCommissionStructure(value: string): asserts value is "solo" | "mixed" {
  if (value !== "solo" && value !== "mixed") {
    throw new AppError(400, "commissionStructure must be 'solo' or 'mixed'");
  }
}
```

Add the resolver import to the top of the file. This file already imports a shared/lib module the same way (`@trock-crm/shared/lib/userProvisioningGuards` at line 18), and Task 1 Step 5 registered the export + built `shared/dist`:

```ts
import { resolveEffectiveCapxRate } from "@trock-crm/shared/lib/commission-structure";
```

- [ ] **Step 2: Extend the `updateUser` input type**

In `updateUser`'s parameter type (lines 220-236), add the four fields after `commissionRate`:

```ts
    commissionRate: number;
    commissionStructure: "solo" | "mixed";
    capxRateSolo: number;
    capxRateMixed: number;
    serviceSourceRate: number;
    rollingFloor: number;
```

- [ ] **Step 3: Extend the commission-patch branch to resolve, validate, mirror, and upsert**

Replace the commission-patch branch (lines 309-371) with this version. It adds the three new rate fields + structure to `hasCommissionPatch`, resolves them (input ?? current), validates, computes the **effective mirror** into `commissionRate`, and writes all columns:

```ts
    const hasCommissionPatch =
      input.commissionRate !== undefined ||
      input.commissionStructure !== undefined ||
      input.capxRateSolo !== undefined ||
      input.capxRateMixed !== undefined ||
      input.serviceSourceRate !== undefined ||
      input.rollingFloor !== undefined ||
      input.overrideRate !== undefined ||
      input.estimatedMarginRate !== undefined ||
      input.minMarginPercent !== undefined ||
      input.newCustomerShareFloor !== undefined ||
      input.newCustomerWindowMonths !== undefined ||
      input.commissionConfigActive !== undefined;

    if (hasCommissionPatch) {
      const existingConfig = await tx
        .select()
        .from(userCommissionSettings)
        .where(eq(userCommissionSettings.userId, id))
        .limit(1);
      const current = existingConfig[0];

      const commissionStructure =
        input.commissionStructure ?? (current?.commissionStructure as "solo" | "mixed" | undefined) ?? "solo";
      const capxRateSolo = input.capxRateSolo ?? Number(current?.capxRateSolo ?? 0);
      const capxRateMixed = input.capxRateMixed ?? Number(current?.capxRateMixed ?? 0);
      const serviceSourceRate = input.serviceSourceRate ?? Number(current?.serviceSourceRate ?? 0);
      const rollingFloor = input.rollingFloor ?? Number(current?.rollingFloor ?? 0);
      const overrideRate = input.overrideRate ?? Number(current?.overrideRate ?? 0);
      const estimatedMarginRate = input.estimatedMarginRate ?? Number(current?.estimatedMarginRate ?? 0.3);
      const minMarginPercent = input.minMarginPercent ?? Number(current?.minMarginPercent ?? 0.2);
      const newCustomerShareFloor = input.newCustomerShareFloor ?? Number(current?.newCustomerShareFloor ?? 0.1);
      const newCustomerWindowMonths = input.newCustomerWindowMonths ?? Number(current?.newCustomerWindowMonths ?? 6);
      const isActive = input.commissionConfigActive ?? Boolean(current?.isActive ?? true);

      assertCommissionStructure(commissionStructure);
      assertRate("capxRateSolo", capxRateSolo);
      assertRate("capxRateMixed", capxRateMixed);
      assertRate("serviceSourceRate", serviceSourceRate);
      assertNonNegative("rollingFloor", rollingFloor);
      assertRate("overrideRate", overrideRate);
      assertRate("estimatedMarginRate", estimatedMarginRate);
      assertRate("minMarginPercent", minMarginPercent);
      assertPositiveInteger("newCustomerWindowMonths", newCustomerWindowMonths);

      // Denormalized mirror: commission_rate = the EFFECTIVE capX rate for the active structure,
      // so every existing engine read of commission_rate keeps working. This SINGLE line is the
      // only place the mirror is maintained. (input.commissionRate is superseded by the capX
      // rates and no longer drives the stored rate.)
      const commissionRate = resolveEffectiveCapxRate({
        commissionStructure,
        capxRateSolo,
        capxRateMixed,
        serviceSourceRate,
      });

      await tx
        .insert(userCommissionSettings)
        .values({
          userId: id,
          commissionRate: String(commissionRate),
          commissionStructure,
          capxRateSolo: String(capxRateSolo),
          capxRateMixed: String(capxRateMixed),
          serviceSourceRate: String(serviceSourceRate),
          rollingFloor: String(rollingFloor),
          overrideRate: String(overrideRate),
          estimatedMarginRate: String(estimatedMarginRate),
          minMarginPercent: String(minMarginPercent),
          newCustomerShareFloor: String(newCustomerShareFloor),
          newCustomerWindowMonths,
          isActive,
        })
        .onConflictDoUpdate({
          target: userCommissionSettings.userId,
          set: {
            commissionRate: String(commissionRate),
            commissionStructure,
            capxRateSolo: String(capxRateSolo),
            capxRateMixed: String(capxRateMixed),
            serviceSourceRate: String(serviceSourceRate),
            rollingFloor: String(rollingFloor),
            overrideRate: String(overrideRate),
            estimatedMarginRate: String(estimatedMarginRate),
            minMarginPercent: String(minMarginPercent),
            newCustomerShareFloor: String(newCustomerShareFloor),
            newCustomerWindowMonths,
            isActive,
            updatedAt: new Date(),
          },
        });
    }
```

- [ ] **Step 4: Trigger the cross-office recompute after the transaction commits**

Add the recompute import near the top of the file:

```ts
import { recalculateAllCommissionsForRep } from "../commissions/recompute-service.js";
```

Two edits to `updateUser`:

(a) Declare a flag at the TOP of the transaction callback (inside `async (tx) => {`), and thread it out via the transaction's return object — matching how the file already returns `closeStreams` for post-commit work (don't mutate an outer variable from inside the closure):

```ts
  const result = await db.transaction(async (tx) => {
    let commissionRatesChanged = false;
    // ... existing body ...
    return { updated, closeStreams: plan.closeStreams, commissionRatesChanged };
  });
```

(b) Inside the `if (hasCommissionPatch) {` block (Step 3), right after the upsert `await tx…`, set the flag when a rate-affecting field is in this patch (structure or any capX/service rate — floor/override/isActive don't change dsc amounts):

```ts
      commissionRatesChanged =
        input.commissionStructure !== undefined ||
        input.capxRateSolo !== undefined ||
        input.capxRateMixed !== undefined ||
        input.serviceSourceRate !== undefined;
```

(c) The function ends (line 373-379) with the transaction resolving to `{ updated, closeStreams }`, then a post-commit `closeUserSseConnections` call, then `return result.updated;`. Insert the recompute immediately before that final `return result.updated;` — after commit, so it reads the freshly-mirrored `commission_rate`:

```ts
  if (result.closeStreams) closeUserSseConnections(id);

  // Best-effort: a recompute failure (incl. office enumeration) must NEVER fail the
  // already-committed settings write. Swallow + log; the per-office loop also degrades internally.
  if (result.commissionRatesChanged) {
    try {
      const summary = await recalculateAllCommissionsForRep(id, actorUserId);
      if (summary.officeFailures.length > 0) {
        console.error(
          `[commissions] rep ${id} recompute had office failures:`,
          JSON.stringify(summary.officeFailures),
        );
      }
    } catch (err) {
      console.error(`[commissions] rep ${id} recompute could not start:`, err);
    }
  }

  return result.updated;
```

- [ ] **Step 5: Extend `getUsersWithStats` SELECT + GROUP BY + row map**

In the `getUsersWithStats` raw SQL (lines 431-473), add the four columns to BOTH the SELECT list and the GROUP BY. In the SELECT, after `cs.commission_rate,`:

```sql
      cs.commission_rate,
      cs.commission_structure,
      cs.capx_rate_solo,
      cs.capx_rate_mixed,
      cs.service_source_rate,
      cs.rolling_floor,
```

In the GROUP BY, after `cs.commission_rate,`:

```sql
      cs.commission_rate,
      cs.commission_structure,
      cs.capx_rate_solo,
      cs.capx_rate_mixed,
      cs.service_source_rate,
      cs.rolling_floor,
```

In the row map (lines 553-581), after `commissionRate: Number(r.commission_rate ?? 0),`:

```ts
    commissionRate: Number(r.commission_rate ?? 0),
    commissionStructure: (r.commission_structure ?? "solo") as "solo" | "mixed",
    capxRateSolo: Number(r.capx_rate_solo ?? 0),
    capxRateMixed: Number(r.capx_rate_mixed ?? 0),
    serviceSourceRate: Number(r.service_source_rate ?? 0),
    rollingFloor: Number(r.rolling_floor ?? 0),
```

- [ ] **Step 6: Build shared, then typecheck the server package**

The server resolves `@trock-crm/shared/lib/commission-structure` from `shared/dist`, so build shared first (also done in Task 1 Step 5 — repeat if you've since edited shared):

Run: `npm run build --workspace=shared && npm run typecheck --workspace=server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/admin/users-service.ts
git commit -m "feat(commissions): users-service structure/rate write + effective mirror + recompute trigger"
```

---

## Task 7: Client — extend the AdminUser type

**Files:**
- Modify: `client/src/hooks/use-admin-users.ts`

- [ ] **Step 1: Add the fields to the `AdminUser` interface**

Edit `client/src/hooks/use-admin-users.ts`. In the `AdminUser` interface, after `commissionRate?: number;`:

```ts
  commissionRate?: number;
  commissionStructure?: "solo" | "mixed";
  capxRateSolo?: number;
  capxRateMixed?: number;
  serviceSourceRate?: number;
  rollingFloor?: number;
```

- [ ] **Step 2: Typecheck the client package**

Run: `npm run typecheck --workspace=client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/use-admin-users.ts
git commit -m "feat(commissions): expose structure/rate fields on AdminUser"
```

---

## Task 8: Users page — structure select + capX/service-source inputs

**Files:**
- Modify: `client/src/pages/admin/users-page.tsx`

- [ ] **Step 1: No new imports needed**

The structure control uses shadcn `Select`, which is ALREADY imported in this file (`Select, SelectContent, SelectItem, SelectTrigger, SelectValue`). Do NOT add a `Switch` — that component doesn't exist in the repo and would pull in a new Radix dependency. Skip to Step 2.

- [ ] **Step 2: Extend the commission field handler**

In `handleCommissionFieldUpdate` (lines 183-218), extend the `field` union and the `decimalFields` set to include the three new rates:

```tsx
    field:
      | "commissionRate"
      | "capxRateSolo"
      | "capxRateMixed"
      | "serviceSourceRate"
      | "rollingFloor"
      | "overrideRate"
      | "estimatedMarginRate"
      | "minMarginPercent"
      | "newCustomerShareFloor",
    rawValue: string
```

```tsx
    const decimalFields = new Set([
      "commissionRate",
      "capxRateSolo",
      "capxRateMixed",
      "serviceSourceRate",
      "overrideRate",
      "estimatedMarginRate",
      "minMarginPercent",
      "newCustomerShareFloor",
    ]);
```

- [ ] **Step 3: Add a structure-change handler**

Add this handler next to `handleCommissionFieldUpdate` (it sends a string enum, not a percent, so it bypasses the numeric handler):

```tsx
  const handleStructureChange = async (userId: string, value: "solo" | "mixed") => {
    setUpdatingId(userId);
    try {
      await updateUser(userId, { commissionStructure: value });
      toast.success("Commission structure updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update commission structure");
    } finally {
      setUpdatingId(null);
    }
  };
```

- [ ] **Step 4: Replace the commission cell contents**

Replace the Commission `TableCell` (lines 684-714). This swaps the single "Rate %" input for the Solo/Mixed structure select + the two capX rates + the service-source rate, and keeps Floor and Override:

```tsx
                <TableCell>
                  <div className="min-w-[320px] space-y-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Structure</p>
                      <Select
                        value={user.commissionStructure ?? "solo"}
                        onValueChange={(value) => handleStructureChange(user.id, value as "solo" | "mixed")}
                        disabled={updatingId === user.id || bulkUpdating}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="solo">Solo</SelectItem>
                          <SelectItem value="mixed">Mixed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">capX Solo %</p>
                        <Input
                          className="h-8 text-xs"
                          defaultValue={formatPercentInput(user.capxRateSolo)}
                          onBlur={(event) => handleCommissionFieldUpdate(user.id, "capxRateSolo", event.target.value)}
                          disabled={updatingId === user.id || bulkUpdating}
                        />
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">capX Mixed %</p>
                        <Input
                          className="h-8 text-xs"
                          defaultValue={formatPercentInput(user.capxRateMixed)}
                          onBlur={(event) => handleCommissionFieldUpdate(user.id, "capxRateMixed", event.target.value)}
                          disabled={updatingId === user.id || bulkUpdating}
                        />
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Service Src %</p>
                        <Input
                          className="h-8 text-xs"
                          defaultValue={formatPercentInput(user.serviceSourceRate)}
                          onBlur={(event) => handleCommissionFieldUpdate(user.id, "serviceSourceRate", event.target.value)}
                          disabled={updatingId === user.id || bulkUpdating}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Floor</p>
                        <Input
                          className="h-8 text-xs"
                          defaultValue={String(Math.round(user.rollingFloor ?? 0))}
                          onBlur={(event) => handleCommissionFieldUpdate(user.id, "rollingFloor", event.target.value)}
                          disabled={updatingId === user.id || bulkUpdating}
                        />
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-400">Override %</p>
                        <Input
                          className="h-8 text-xs"
                          defaultValue={formatPercentInput(user.overrideRate)}
                          onBlur={(event) => handleCommissionFieldUpdate(user.id, "overrideRate", event.target.value)}
                          disabled={updatingId === user.id || bulkUpdating}
                        />
                      </div>
                    </div>
                  </div>
                </TableCell>
```

- [ ] **Step 5: Typecheck + build the client**

Run: `npm run typecheck --workspace=client && npm run build --workspace=client`
Expected: PASS.

- [ ] **Step 6: Manual smoke test**

Run the app locally, open `/admin/users`, and for one rep:
- Change the Structure select solo↔mixed; confirm a success toast appears.
- Edit capX Solo %, capX Mixed %, Service Src % (blur each); confirm success toasts.
- Reload; confirm the values persisted.

Verify the mirror + persistence in the DB:
```bash
node .worktrees/feat-permanent-run-sql/scripts/run-sql.cjs "SELECT commission_structure, commission_rate, capx_rate_solo, capx_rate_mixed, service_source_rate FROM public.user_commission_settings WHERE user_id = '<rep-id>'"
```
Expected: `commission_rate` equals `capx_rate_mixed` when structure is `mixed`, else `capx_rate_solo`.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/users-page.tsx
git commit -m "feat(commissions): users-page structure select + capX/service-source rate inputs"
```

---

## Task 9: Full validation

- [ ] **Step 1: Run the shared + server test suites**

Run: `npm run test:ci --workspace=shared`
Expected: PASS (includes the new resolver tests).

Run: `npm run test:runtime --workspace=server`
Expected: PASS (includes `recompute-rep.runtime.test.ts`; existing commission tests still green).

- [ ] **Step 2: Typecheck everything**

Run: `npm run typecheck:tests:all`
Expected: PASS.

- [ ] **Step 3: End-to-end recompute check (local DB)**

With a rep who owns at least one signed deal:
1. Note their current owner dsc amount:
   ```bash
   node .worktrees/feat-permanent-run-sql/scripts/run-sql.cjs "SELECT deal_id, amount, applied_rate FROM office_dallas.deal_signed_commissions WHERE rep_user_id = '<rep-id>' AND attribution_role = 'owner'"
   ```
2. On `/admin/users`, flip the rep solo→mixed (with a different mixed rate).
3. Re-run the same query; confirm `amount`/`applied_rate` re-rated to the mixed rate — proving the live recompute reconciles the stored rows with the switch.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(commissions): solo/mixed structure + per-rep capX/service-source rates" --body "<summary + the two forks + cross-office recompute note>"
```

---

## Notes for the implementer

- **Why the mirror:** the engine reads `commission_rate` live in ~4 places; keeping it in sync with the effective capX rate means none of those reads change. Do NOT scatter structure logic into the read paths — the mirror is the whole point.
- **Why recompute after commit:** the recompute reads `commission_rate`; it must see the just-written mirror, so it runs after the settings transaction commits, not inside it.
- **Cross-office cost:** the recompute fans out to ALL active offices synchronously (2 today). If office count or per-rep deal volume grows, move `recalculateAllCommissionsForRep` to a queued/async job — the per-office core (`recalculateRepCommissionsInOffice`) stays unchanged. This is the deferred item from the spec.
- **No sales-source rows yet:** PR1's recompute only touches `owner`/`estimator` rows. PR2 adds the `sales_source` role and the floor-gate extension; the recompute already covers whatever rows the rep books, so sales-source rows re-rate for free once PR2 lands.
