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
     WHERE deal_id = $1 AND attribution_role = 'owner' LIMIT 1`,
    [dealId],
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

  it("skips deals whose signed date is NULL even when a dsc row exists", async () => {
    const REP2 = U("0a02");
    const DEAL2 = U("0c02");

    // Seed REP2 with an active rate.
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${REP2}', 'rep2@t.test', 'Rep2', 'rep', '${OFFICE}', true)`,
    );
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${REP2}', 0.030000, 'solo', 0.030000, 0.020000, 0.005000, true)`,
    );

    // Deal with NO signed date (both contract_signed_at and contract_signed_date are NULL).
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
          is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${DEAL2}', 'D-0c02', 'Unsigned Deal', '${STAGE}', '${REP2}', 50000, NULL, NULL,
          false, false, NULL, NULL)`,
    );

    // Manually insert a dsc row so selectDistinct finds this deal for REP2.
    await pg.exec(
      `INSERT INTO public.deal_signed_commissions
         (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount,
          amount, applied_rate, contract_signed_date_at_signing, created_by)
       VALUES ('${DEAL2}', '${REP2}', 'owner', 'awarded', 50000.00,
               1500.00, 0.030000, '2026-01-01', '${ADMIN}')`,
    );

    // The deal must be skipped because effectiveSignedDateOf returns null (both date columns are NULL).
    const count = await recalculateRepCommissionsInOffice(tdb, REP2, ADMIN);
    expect(count).toBe(0);

    // The manually-inserted row must remain unchanged.
    const { rows } = await pg.query<{ amount: string; applied_rate: string }>(
      `SELECT amount, applied_rate FROM public.deal_signed_commissions
       WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'owner' LIMIT 1`,
      [DEAL2, REP2],
    );
    expect(rows[0]).toEqual({ amount: "1500.00", applied_rate: "0.030000" });
  });

  it("re-rates only the target rep's rows on a shared deal (owner vs estimator)", async () => {
    const OWNER = U("0a03");
    const ESTIMATOR = U("0a04");
    const DEAL3 = U("0c03");

    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${OWNER}', 'owner@t.test', 'Owner', 'rep', '${OFFICE}', true),
              ('${ESTIMATOR}', 'est@t.test', 'Estimator', 'rep', '${OFFICE}', true)`,
    );
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${OWNER}', 0.030000, 'solo', 0.030000, 0.020000, 0.000000, true),
              ('${ESTIMATOR}', 0.040000, 'solo', 0.040000, 0.010000, 0.000000, true)`,
    );
    // Deal owned by OWNER with ESTIMATOR set → calculateCommissionForDeal mints an owner row AND an
    // additive estimator row, so the deal carries two reps' rows.
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, awarded_amount,
          bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${DEAL3}', 'D-0c03', 'Shared Deal', '${STAGE}', '${OWNER}', '${ESTIMATOR}', 100000,
          NULL, NULL, false, false, NULL, '2026-09-15')`,
    );
    await calculateCommissionForDeal(tdb, {
      dealId: DEAL3,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    const rowFor = async (rep: string) => {
      const { rows } = await pg.query<{ amount: string; applied_rate: string }>(
        `SELECT amount, applied_rate FROM public.deal_signed_commissions
         WHERE deal_id = $1 AND rep_user_id = $2 LIMIT 1`,
        [DEAL3, rep],
      );
      return rows[0];
    };
    // Baseline: owner 3000.00 @ 0.03, estimator 4000.00 @ 0.04.
    expect(await rowFor(OWNER)).toEqual({ amount: "3000.00", applied_rate: "0.030000" });
    expect(await rowFor(ESTIMATOR)).toEqual({ amount: "4000.00", applied_rate: "0.040000" });

    // Only OWNER's rate changes; recompute OWNER.
    await pg.exec(
      `UPDATE public.user_commission_settings SET commission_rate = 0.020000 WHERE user_id = '${OWNER}'`,
    );
    await recalculateRepCommissionsInOffice(tdb, OWNER, ADMIN);

    // OWNER's row re-rated; ESTIMATOR's row on the SAME deal is left untouched.
    expect(await rowFor(OWNER)).toEqual({ amount: "2000.00", applied_rate: "0.020000" });
    expect(await rowFor(ESTIMATOR)).toEqual({ amount: "4000.00", applied_rate: "0.040000" });
  });

  it("re-rates a sales_source row at the service-source rate, not the capX mirror (INV-1)", async () => {
    const SRC = U("0a20"); // mixed rep who sources a service deal
    const SVC = U("0a21"); // service-rep owner
    const D = U("0c20");
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${SRC}', 'src@t.test', 'Src', 'rep', '${OFFICE}', true),
              ('${SVC}', 'svc@t.test', 'Svc', 'rep', '${OFFICE}', true)`,
    );
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${SRC}', 0.020000, 'mixed', 0.030000, 0.020000, 0.005000, true),
              ('${SVC}', 0.030000, 'solo',  0.030000, 0.020000, 0.000000, true)`,
    );
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
          awarded_amount, bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date,
          workflow_route)
       VALUES ('${D}', 'D-0c20', 'Sourced', '${STAGE}', '${SVC}', '${SRC}',
               100000, NULL, NULL, false, false, NULL, '2026-09-15', 'service')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    const srcRow = async () => {
      const { rows } = await pg.query<{ amount: string; applied_rate: string }>(
        `SELECT amount, applied_rate FROM public.deal_signed_commissions
         WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'sales_source' LIMIT 1`,
        [D, SRC],
      );
      return rows[0];
    };
    // Baseline: sales_source row at service-source rate 0.005000 → 100000 × 0.005 = 500.00.
    // capX mirror (commission_rate = 0.020000) must NOT appear here.
    expect(await srcRow()).toEqual({ amount: "500.00", applied_rate: "0.005000" });

    // Raise the source rep's service-source rate to 0.8% (capX mirror commission_rate unchanged at 0.02).
    await pg.exec(
      `UPDATE public.user_commission_settings SET service_source_rate = 0.008000 WHERE user_id = '${SRC}'`,
    );
    await recalculateRepCommissionsInOffice(tdb, SRC, ADMIN);

    // MUST re-rate at the SERVICE-SOURCE rate (0.008 → 800.00), NOT the capX mirror (0.02 → 2000.00).
    expect(await srcRow()).toEqual({ amount: "800.00", applied_rate: "0.008000" });
  });

  it("PRESERVES a rep's rows when their settings are DEACTIVATED even under zeroOnNoRate", async () => {
    // F1 fix verification: deactivating a rep's settings must NOT zero their historical rows when a
    // co-booked rep's settings-change recompute fires (zeroOnNoRate=true). The distinguishing logic:
    //   "inactive" (deactivated settings) → ALWAYS preserve
    //   "zero"     (active, deliberate 0%) → zero under zeroOnNoRate
    const INACT_REP = U("0a06");
    const INACT_DEAL = U("0c05");
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${INACT_REP}', 'inact@rep.test', 'InactRep', 'rep', '${OFFICE}', true)`,
    );
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${INACT_REP}', 0.030000, 'solo', 0.030000, 0.020000, 0.000000, true)`,
    );
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
          is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${INACT_DEAL}', 'D-0c05', 'Inact Deal', '${STAGE}', '${INACT_REP}', 100000, NULL, NULL,
          false, false, NULL, '2026-09-15')`,
    );
    await calculateCommissionForDeal(tdb, {
      dealId: INACT_DEAL,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });
    // Baseline: 3000.00 @ 0.03 while settings are active.
    const before = await ownerRow(INACT_DEAL);
    expect(before).toEqual({ amount: "3000.00", applied_rate: "0.030000" });

    // Deactivate the rep's settings (is_active=false). This simulates a rep leaving or being off-boarded.
    await pg.exec(
      `UPDATE public.user_commission_settings SET is_active = false WHERE user_id = '${INACT_REP}'`,
    );

    // Trigger a settings-change recompute with zeroOnNoRate (the path that a rate edit for ANY rep takes).
    // With the old `null`-based logic, `resolveAppliedRateForRole` returns null for both inactive AND
    // active-0% reps, and zeroOnNoRate would zero the row. With the new union, inactive must be preserved.
    const count = await recalculateRepCommissionsInOffice(tdb, INACT_REP, ADMIN);
    expect(count).toBe(0); // PRESERVED — not recomputed, not zeroed.

    // The row must remain at the original 3000.00, not be wiped to 0.00.
    const after = await ownerRow(INACT_DEAL);
    expect(after).toEqual({ amount: "3000.00", applied_rate: "0.030000" });
  });

  it("role-scoped: sales_source-only recompute leaves owner row at drifted value unchanged", async () => {
    // A rep has BOTH an owner row (deal A at original deal value) AND a sales_source row (deal B).
    // After minting the rows we change deal A's awarded_amount to simulate value drift, then run
    // recalculateRepCommissionsInOffice scoped to ["sales_source"] and verify:
    //   - sales_source row is re-rated (picks up the current service-source rate)
    //   - owner row is NOT touched (its amount stays at the pre-drift value, not the new current value)
    const MREP = U("0a30");
    const DEAL_A = U("0c30"); // MREP is OWNER
    const DEAL_B = U("0c31"); // MREP is SALES_SOURCE; SVC_REP is the owner

    const SVC_REP2 = U("0a31");

    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${MREP}',    'mrep@t.test',    'MRep',   'rep', '${OFFICE}', true),
              ('${SVC_REP2}','svcrep2@t.test', 'SvcRep2','rep', '${OFFICE}', true)`,
    );
    // MREP must be "mixed" structure — resolveEffectiveServiceSourceRate returns 0 for solo reps, so
    // a solo source rep never earns a sales_source cut (mintSalesSourceCommissionForDeal skipped_no_rate).
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${MREP}',     0.020000, 'mixed', 0.030000, 0.020000, 0.005000, true),
              ('${SVC_REP2}', 0.030000, 'solo',  0.030000, 0.020000, 0.000000, true)`,
    );
    // commission_rate mirror for MREP = capxRateMixed = 0.020000

    // Deal A: MREP is owner, value = 200000 → owner row 200000 × 0.020000 = 4000.00.
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
          is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${DEAL_A}', 'D-0c30', 'DealA', '${STAGE}', '${MREP}', 200000, NULL, NULL,
          false, false, NULL, '2026-09-15')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: DEAL_A, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    // Deal B: SVC_REP2 is owner, MREP is sales_source, value = 100000 → sales_source 100000 × 0.005 = 500.00.
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
          awarded_amount, bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date,
          workflow_route)
       VALUES ('${DEAL_B}', 'D-0c31', 'DealB', '${STAGE}', '${SVC_REP2}', '${MREP}',
               100000, NULL, NULL, false, false, NULL, '2026-09-15', 'service')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: DEAL_B, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    // Baseline: owner 4000.00, sales_source 500.00.
    const ownerA = await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'owner' LIMIT 1`,
      [DEAL_A, MREP],
    );
    const srcB = await pg.query<{ amount: string; applied_rate: string }>(
      `SELECT amount, applied_rate FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'sales_source' LIMIT 1`,
      [DEAL_B, MREP],
    );
    expect(ownerA.rows[0]).toEqual({ amount: "4000.00" });
    expect(srcB.rows[0]).toEqual({ amount: "500.00", applied_rate: "0.005000" });

    // Simulate value drift on Deal A: bump awarded_amount to 300000.
    // If onlyRoles is respected, the owner row must stay at 4000.00 (booked at 200000 × 0.02 = 4000).
    await pg.exec(`UPDATE public.deals SET awarded_amount = 300000 WHERE id = '${DEAL_A}'`);

    // Change MREP's service-source rate to 0.008 (capX unchanged).
    await pg.exec(
      `UPDATE public.user_commission_settings SET service_source_rate = 0.008000 WHERE user_id = '${MREP}'`,
    );

    // Run recompute scoped to sales_source only.
    const count = await recalculateRepCommissionsInOffice(tdb, MREP, ADMIN, ["sales_source"]);
    expect(count).toBe(1); // only deal B re-rated.

    // Owner row on deal A must NOT pick up the drift (still 4000.00, not 6000.00 = 300000 × 0.02).
    const ownerAAfter = await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'owner' LIMIT 1`,
      [DEAL_A, MREP],
    );
    expect(ownerAAfter.rows[0]).toEqual({ amount: "4000.00" });

    // Sales_source row on deal B must be re-rated at the new 0.008 rate: 100000 × 0.008 = 800.00.
    const srcBAfter = await pg.query<{ amount: string; applied_rate: string }>(
      `SELECT amount, applied_rate FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'sales_source' LIMIT 1`,
      [DEAL_B, MREP],
    );
    expect(srcBAfter.rows[0]).toEqual({ amount: "800.00", applied_rate: "0.008000" });
  });

  it("role-scoped: owner+estimator-only recompute leaves sales_source row unchanged", async () => {
    // Complement of the test above: a capX-only recompute must NOT touch the sales_source row.
    const CREP = U("0a32");
    const DEAL_C = U("0c32"); // CREP is owner
    const DEAL_D = U("0c33"); // CREP is sales_source; SVC_REP3 is owner

    const SVC_REP3 = U("0a33");

    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${CREP}',    'crep@t.test',    'CRep',   'rep', '${OFFICE}', true),
              ('${SVC_REP3}','svcrep3@t.test', 'SvcRep3','rep', '${OFFICE}', true)`,
    );
    // CREP must be "mixed" to earn a sales_source row on service deals (solo → service-source rate = 0).
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${CREP}',     0.020000, 'mixed', 0.030000, 0.020000, 0.005000, true),
              ('${SVC_REP3}', 0.030000, 'solo',  0.030000, 0.020000, 0.000000, true)`,
    );
    // commission_rate mirror for CREP = capxRateMixed = 0.020000

    // Deal C: CREP is owner, value = 100000 → owner row 100000 × 0.020000 = 2000.00.
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
          is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${DEAL_C}', 'D-0c32', 'DealC', '${STAGE}', '${CREP}', 100000, NULL, NULL,
          false, false, NULL, '2026-09-15')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: DEAL_C, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    // Deal D: SVC_REP3 is owner, CREP is sales_source, value = 100000 → sales_source row 500.00.
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
          awarded_amount, bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date,
          workflow_route)
       VALUES ('${DEAL_D}', 'D-0c33', 'DealD', '${STAGE}', '${SVC_REP3}', '${CREP}',
               100000, NULL, NULL, false, false, NULL, '2026-09-15', 'service')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: DEAL_D, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    // Baseline: owner 3000.00, sales_source 500.00.
    const ownerC = async () =>
      pg.query<{ amount: string; applied_rate: string }>(
        `SELECT amount, applied_rate FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'owner' LIMIT 1`,
        [DEAL_C, CREP],
      ).then((r) => r.rows[0]);
    const srcD = async () =>
      pg.query<{ amount: string; applied_rate: string }>(
        `SELECT amount, applied_rate FROM public.deal_signed_commissions WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'sales_source' LIMIT 1`,
        [DEAL_D, CREP],
      ).then((r) => r.rows[0]);

    expect(await ownerC()).toEqual({ amount: "2000.00", applied_rate: "0.020000" });
    expect(await srcD()).toEqual({ amount: "500.00", applied_rate: "0.005000" });

    // Change CREP's capX mixed rate to 0.04, update commission_rate mirror accordingly.
    // The service-source rate is intentionally left unchanged at 0.005000.
    await pg.exec(
      `UPDATE public.user_commission_settings
       SET capx_rate_mixed = 0.040000, commission_rate = 0.040000 WHERE user_id = '${CREP}'`,
    );

    // Run recompute scoped to owner+estimator only.
    const count = await recalculateRepCommissionsInOffice(tdb, CREP, ADMIN, ["owner", "estimator"]);
    expect(count).toBe(1); // only deal C (owner row) is re-rated.

    // Owner row on deal C must re-rate: 100000 × 0.040000 = 4000.00.
    expect(await ownerC()).toEqual({ amount: "4000.00", applied_rate: "0.040000" });

    // Sales_source row on deal D must be UNCHANGED.
    expect(await srcD()).toEqual({ amount: "500.00", applied_rate: "0.005000" });
  });

  it("re-rates a rep's rows to $0 when the effective rate is deliberately set to 0%", async () => {
    const REP3 = U("0a05");
    const DEAL4 = U("0c04");
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${REP3}', 'rep3@t.test', 'Rep3', 'rep', '${OFFICE}', true)`,
    );
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${REP3}', 0.030000, 'solo', 0.030000, 0.020000, 0.000000, true)`,
    );
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
          is_change_order, on_hold, office_code, contract_signed_date)
       VALUES ('${DEAL4}', 'D-0c04', 'Zero Deal', '${STAGE}', '${REP3}', 100000, NULL, NULL,
          false, false, NULL, '2026-09-15')`,
    );
    await calculateCommissionForDeal(tdb, {
      dealId: DEAL4,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });
    // Baseline: 3000.00 @ 0.03.
    expect(await ownerRow(DEAL4)).toEqual({ amount: "3000.00", applied_rate: "0.030000" });

    // Admin deliberately sets the active capX rate to 0 → mirror commission_rate = 0.
    await pg.exec(
      `UPDATE public.user_commission_settings SET commission_rate = 0, capx_rate_solo = 0 WHERE user_id = '${REP3}'`,
    );
    const count = await recalculateRepCommissionsInOffice(tdb, REP3, ADMIN);
    expect(count).toBe(1);

    // The earned row is re-rated to $0 — NOT left at the stale 3000.00 (the settings-change path
    // zeroes on a deliberate 0% rate; the deal-edit path would preserve it).
    expect(await ownerRow(DEAL4)).toEqual({ amount: "0.00", applied_rate: "0.000000" });
  });

  it("MINTS a sales_source row on recompute for a deal signed while the source rate was 0% (solo→mixed)", async () => {
    // Finding E: a sourced service deal signed while the source rep is SOLO (effective service-source
    // rate 0) mints NO sales_source row at sign. The row-scan recompute only sees deals where the rep
    // already books a row, so WITHOUT mint-on-discover this deal would never gain a source cut once the
    // rep becomes mixed. Verify the recompute now DISCOVERS the sourced deal (by deals.sales_source_user_id)
    // and mints the now-earned row.
    const SRC_E = U("0a40"); // starts SOLO → no source cut at sign
    const SVC_E = U("0a41"); // solo owner (its owner row satisfies the mint's owner-row invariant)
    const DEAL_E = U("0c40");
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${SRC_E}', 'srce@t.test', 'SrcE', 'rep', '${OFFICE}', true),
              ('${SVC_E}', 'svce@t.test', 'SvcE', 'rep', '${OFFICE}', true)`,
    );
    // SRC_E is SOLO → resolveEffectiveServiceSourceRate = 0 despite the stray service_source_rate 0.005.
    await pg.exec(
      `INSERT INTO public.user_commission_settings
         (user_id, commission_rate, commission_structure, capx_rate_solo, capx_rate_mixed, service_source_rate, is_active)
       VALUES ('${SRC_E}', 0.030000, 'solo', 0.030000, 0.020000, 0.005000, true),
              ('${SVC_E}', 0.030000, 'solo', 0.030000, 0.020000, 0.000000, true)`,
    );
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, sales_source_user_id,
          awarded_amount, bid_estimate, dd_estimate, is_change_order, on_hold, office_code, contract_signed_date,
          workflow_route)
       VALUES ('${DEAL_E}', 'D-0c40', 'Sourced-0', '${STAGE}', '${SVC_E}', '${SRC_E}',
               100000, NULL, NULL, false, false, NULL, '2026-09-15', 'service')`,
    );
    await calculateCommissionForDeal(tdb, { dealId: DEAL_E, contractSignedDate: "2026-09-15", triggeredByUserId: ADMIN });

    const srcRow = async () =>
      pg.query<{ amount: string; applied_rate: string }>(
        `SELECT amount, applied_rate FROM public.deal_signed_commissions
         WHERE deal_id = $1 AND rep_user_id = $2 AND attribution_role = 'sales_source' LIMIT 1`,
        [DEAL_E, SRC_E],
      ).then((r) => r.rows[0]);

    // No source row exists at sign (solo → effective 0%).
    expect(await srcRow()).toBeUndefined();

    // Flip SRC_E to mixed with a positive service-source rate (0.006).
    await pg.exec(
      `UPDATE public.user_commission_settings
       SET commission_structure = 'mixed', commission_rate = 0.020000, service_source_rate = 0.006000
       WHERE user_id = '${SRC_E}'`,
    );

    // Recompute (sales_source scope) must DISCOVER the sourced deal and MINT: 100000 × 0.006 = 600.00.
    const count = await recalculateRepCommissionsInOffice(tdb, SRC_E, ADMIN, ["sales_source"]);
    expect(count).toBe(1);
    expect(await srcRow()).toEqual({ amount: "600.00", applied_rate: "0.006000" });

    // Idempotent: a second recompute re-rates the now-existing row via the row-scan (count 1) but the
    // mint-on-discover pass sees the existing row and no-ops (skipped_existing) — never a duplicate.
    const count2 = await recalculateRepCommissionsInOffice(tdb, SRC_E, ADMIN, ["sales_source"]);
    expect(count2).toBe(1);
    expect(await srcRow()).toEqual({ amount: "600.00", applied_rate: "0.006000" });
  });
});
