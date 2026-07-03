// PGlite runtime proof of the sales-source commission path:
//   • resolveAppliedRateForRole (Task 3) — attribution-role-aware rate selection (INV-1 foundation)
//   • mintSalesSourceCommissionForDeal (Task 5) — additive sales_source row at sign time
//
// Written test-first per TDD convention; tests match the plan spec exactly.
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
import {
  calculateCommissionForDeal,
  resolveAppliedRateForRole,
  type RoleRateResolution,
} from "../../../src/modules/commissions/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const OFFICE = U("0f2");
const ADMIN = U("0aae");
/** mixed rep: commission_rate mirrors capx_rate_mixed=0.020000; service_source_rate=0.005000 */
const REP_MIX = U("0a11");
/** solo rep: commission_rate mirrors capx_rate_solo=0.030000; service_source_rate=0.005000 (stray) */
const REP_SOLO = U("0a12");
/** inactive rep: is_active=false → resolveAppliedRateForRole must return { status: "inactive" } */
const REP_INACT = U("0a13");
const STAGE = U("0502");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function dscRows(dealId: string) {
  const { rows } = await pg.query<{
    rep_user_id: string;
    amount: string;
    applied_rate: string;
    attribution_role: string;
  }>(
    `SELECT rep_user_id, amount, applied_rate, attribution_role
     FROM public.deal_signed_commissions WHERE deal_id = $1 ORDER BY amount DESC`,
    [dealId],
  );
  return rows;
}

async function seedDeal(
  id: string,
  opts: {
    rep?: string;
    awarded?: number;
    salesSource?: string | null;
    /** workflow_route value — MUST be 'service' to mint a sales_source row (F3a gate) */
    workflowRoute?: "normal" | "service";
  } = {},
) {
  const rep = opts.rep ?? REP_SOLO;
  const awarded = opts.awarded ?? 30000;
  const salesSource = opts.salesSource ?? null;
  const workflowRoute = opts.workflowRoute ?? "normal";
  await pg.exec(
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id, awarded_amount,
        bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date,
        workflow_route)
     VALUES ('${id}', 'D-${id.slice(-4)}', 'Deal ${id.slice(-4)}', '${STAGE}',
        '${rep}', ${salesSource ? `'${salesSource}'` : "NULL"}, ${awarded}, NULL, NULL,
        false, false, NULL, '2026-09-15', '${workflowRoute}')`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [deals, userCommissionSettings, dealSignedCommissions, auditLog, users, offices]),
  );
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions
     ADD CONSTRAINT deal_signed_commissions_dedup_ss UNIQUE (deal_id, rep_user_id);`,
  );
  tdb = drizzle(pg);

  await pg.exec(
    `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
     VALUES ('${ADMIN}',     'admin2@t.test', 'Admin2', 'admin', '${OFFICE}', true),
            ('${REP_MIX}',  'mix@t.test',   'Mix',    'rep',   '${OFFICE}', true),
            ('${REP_SOLO}', 'solo@t.test',  'Solo',   'rep',   '${OFFICE}', true),
            ('${REP_INACT}','inact@t.test', 'Inact',  'rep',   '${OFFICE}', false)`,
  );
  // REP_MIX:   mixed → capX mirror = capx_rate_mixed = 0.020000; service-source effective = 0.005000.
  // REP_SOLO:  solo  → capX mirror = capx_rate_solo  = 0.030000; service-source effective = 0 (stray).
  // REP_INACT: is_active=false → resolveAppliedRateForRole must return { status: "inactive" }.
  await pg.exec(
    `INSERT INTO public.user_commission_settings
       (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
     VALUES ('${REP_MIX}',   0.020000, 'mixed', 0.030000, 0.020000, 0.005000, true),
            ('${REP_SOLO}',  0.030000, 'solo',  0.030000, 0.020000, 0.005000, true),
            ('${REP_INACT}', 0.025000, 'solo',  0.025000, 0.015000, 0.000000, false)`,
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

// ---------------------------------------------------------------------------
// Task 3 — resolveAppliedRateForRole (INV-1 foundation) — discriminated union
// ---------------------------------------------------------------------------
describe("resolveAppliedRateForRole", () => {
  it("resolves owner/estimator rate from the capX mirror and sales_source from the service-source rate", async () => {
    // REP_MIX: commission_rate (mirror) = 0.020000, service_source_rate = 0.005000, structure = mixed
    // All three should return { status: "rate", appliedRate: ... } since rates are > 0.
    const ownerRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_MIX, "owner");
    const estRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_MIX, "estimator");
    const ssRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_MIX, "sales_source");
    expect(ownerRes).toEqual({ status: "rate", appliedRate: "0.020000" });
    expect(estRes).toEqual({ status: "rate", appliedRate: "0.020000" });
    expect(ssRes).toEqual({ status: "rate", appliedRate: "0.005000" });
  });

  it("returns { status: 'zero' } for a solo rep's sales_source (no service-source cut)", async () => {
    // REP_SOLO: structure = solo → resolveEffectiveServiceSourceRate returns 0 → active but zero rate.
    // owner still returns { status: "rate" } since commission_rate = 0.030000 > 0.
    const ssRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_SOLO, "sales_source");
    const ownerRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_SOLO, "owner");
    expect(ssRes).toEqual({ status: "zero" });
    expect(ownerRes).toEqual({ status: "rate", appliedRate: "0.030000" });
  });

  it("returns { status: 'inactive' } for a rep with is_active=false settings", async () => {
    // REP_INACT: is_active=false → must return inactive regardless of the stored rate values.
    // This is the F1 key case: the recompute must PRESERVE rows for inactive reps, not zero them.
    const ownerRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_INACT, "owner");
    const ssRes: RoleRateResolution = await resolveAppliedRateForRole(tdb, REP_INACT, "sales_source");
    expect(ownerRes).toEqual({ status: "inactive" });
    expect(ssRes).toEqual({ status: "inactive" });
  });
});

// ---------------------------------------------------------------------------
// Task 5 — mintSalesSourceCommissionForDeal (via calculateCommissionForDeal)
// ---------------------------------------------------------------------------
describe("mintSalesSourceCommissionForDeal (via calculateCommissionForDeal)", () => {
  it("mints an additive sales_source row at the source rep's service-source rate, on top of the owner", async () => {
    const D = U("0c10");
    // Owner = REP_SOLO (solo, 3% capX rate); Sales source = REP_MIX (mixed, 0.5% service-source).
    // workflow_route = 'service' is required (F3a gate) to mint the sales_source row.
    await seedDeal(D, { rep: REP_SOLO, awarded: 30000, salesSource: REP_MIX, workflowRoute: "service" });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
    const rows = await dscRows(D); // ordered by amount desc
    // Owner: 30000 × 0.030000 = 900.00 ; sales_source: 30000 × 0.005000 = 150.00
    expect(rows.find((r) => r.attribution_role === "owner")).toMatchObject({
      amount: "900.00",
      applied_rate: "0.030000",
      rep_user_id: REP_SOLO,
    });
    expect(rows.find((r) => r.attribution_role === "sales_source")).toMatchObject({
      amount: "150.00",
      applied_rate: "0.005000",
      rep_user_id: REP_MIX,
    });
  });

  it("does not mint a sales_source row when the source rep is solo (no service-source rate)", async () => {
    const D = U("0c11");
    // Source is REP_SOLO (solo) → resolveEffectiveServiceSourceRate returns 0 → { status: "zero" } → skip.
    // workflow_route = 'service' so the F3a workflow gate passes; the skip comes from the zero-rate guard.
    await seedDeal(D, { rep: REP_MIX, awarded: 30000, salesSource: REP_SOLO, workflowRoute: "service" });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
    expect((await dscRows(D)).some((r) => r.attribution_role === "sales_source")).toBe(false);
  });

  it("skips sales_source when the source equals the owner (dedup / self-source guard)", async () => {
    const D = U("0c12");
    // REP_MIX sources their own deal → the guard `salesSourceUserId !== assignedRepId` fires.
    // workflow_route = 'service' so the F3a workflow gate passes; the skip comes from the dedup guard.
    await seedDeal(D, { rep: REP_MIX, awarded: 30000, salesSource: REP_MIX, workflowRoute: "service" });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });
    expect((await dscRows(D)).filter((r) => r.rep_user_id === REP_MIX)).toHaveLength(1); // only the owner row
  });
});
