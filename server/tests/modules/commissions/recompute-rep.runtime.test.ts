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
});
