// Real-types (PGlite + Drizzle-derived schema, #715 helper) proof of the OWNER-side earned-commission
// money path in calculateCommissionForDeal.
//
// Ported from the former hand-rolled-fake calculate.test.ts. That fake db did NOT model
// `.onConflictDoNothing(...)` (added in PR1), so ~4 of its insert-reaching tests failed when actually
// executed — and because the file was not a *.runtime.test.* it was typecheck-only in CI and never ran,
// so the breakage was silent. This re-expresses EVERY original intent against the REAL
// deal_signed_commissions / deals / user_commission_settings / users / audit_log schema (including the
// (deal_id, rep_user_id) UNIQUE the ON CONFLICT DO NOTHING idempotency path relies on) so it EXECUTES in
// the CI gate (npm run test:runtime). These deals carry NO estimator, so only the owner-row logic runs.
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

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

const OFFICE = U("0f1");
const ADMIN = U("0aad"); // operator stamped as created_by + audit changed_by
const REP_FULL = U("0a01"); // 7.5%
const REP_FIVE = U("0a02"); // 5%
const REP_THREE = U("0a03"); // 3%
const REP_NORATE = U("0a04"); // active user, NO commission settings row
const REP_ZERO = U("0a05"); // 0% rate
const REP_INACTIVE = U("0a06"); // 7.5% but settings inactive
const STAGE = U("0500");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function dscRows(dealId: string) {
  const { rows } = await pg.query<{
    id: string;
    rep_user_id: string;
    amount: string;
    applied_rate: string;
    source_value_amount: string;
    source_value_kind: string;
    attribution_role: string;
    contract_signed_date_at_signing: string;
    created_by: string | null;
  }>(
    `SELECT id, rep_user_id, amount, applied_rate, source_value_amount, source_value_kind, attribution_role,
            contract_signed_date_at_signing::text AS contract_signed_date_at_signing, created_by
     FROM public.deal_signed_commissions WHERE deal_id = '${dealId}' ORDER BY amount DESC`,
  );
  return rows;
}
const rowFor = (rows: Awaited<ReturnType<typeof dscRows>>, rep: string) =>
  rows.find((r) => r.rep_user_id === rep);

async function auditInsertsFor(recordId: string) {
  const { rows } = await pg.query<{ table_name: string; action: string; changed_by: string | null }>(
    `SELECT table_name, action, changed_by FROM public.audit_log
     WHERE record_id = '${recordId}' AND table_name = 'deal_signed_commissions' AND action = 'insert'`,
  );
  return rows;
}

// Insert one signed deal. rep === null seeds a deal with NO assigned rep (the skipped_no_rep case).
async function seedDeal(
  id: string,
  opts: {
    rep?: string | null;
    awarded?: number | null;
    bid?: number | null;
    dd?: number | null;
    onHold?: boolean;
  } = {},
) {
  const rep = opts.rep === undefined ? REP_FULL : opts.rep;
  const awarded = opts.awarded === undefined ? 100000 : opts.awarded;
  const bid = opts.bid ?? null;
  const dd = opts.dd ?? null;
  const num = (v: number | null) => (v == null ? "NULL" : String(v));
  await pg.exec(
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate,
        is_change_order, on_hold, office_code, contract_signed_date)
     VALUES ('${id}', 'D-${id.slice(-4)}', 'Deal ${id.slice(-4)}', '${STAGE}',
        ${rep ? `'${rep}'` : "NULL"}, ${num(awarded)}, ${num(bid)}, ${num(dd)},
        false, ${opts.onHold ? "true" : "false"}, NULL, '2026-09-15')`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      deals,
      userCommissionSettings,
      dealSignedCommissions,
      auditLog,
      users,
      offices,
    ]),
  );
  // tenantSchemaSql omits indexes/constraints, but the tx-safe insert relies on the (deal_id, rep_user_id)
  // UNIQUE for ON CONFLICT DO NOTHING — recreate it so the idempotency conflict path is exercised for real.
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`,
  );
  tdb = drizzle(pg);

  const mkUser = (id: string) =>
    pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${id}', '${id}@t.test', 'User ${id.slice(-4)}', 'rep', '${OFFICE}', true)`,
    );
  await mkUser(ADMIN);
  await mkUser(REP_FULL);
  await mkUser(REP_FIVE);
  await mkUser(REP_THREE);
  await mkUser(REP_NORATE); // active user but NO settings → no rate
  await mkUser(REP_ZERO);
  await mkUser(REP_INACTIVE);

  const mkRate = (id: string, rate: string, isActive = true) =>
    pg.exec(
      `INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active)
       VALUES ('${id}', ${rate}, ${isActive})`,
    );
  await mkRate(REP_FULL, "0.075000");
  await mkRate(REP_FIVE, "0.050000");
  await mkRate(REP_THREE, "0.030000");
  await mkRate(REP_ZERO, "0.000000"); // rate ≤ 0 → skipped_no_rate
  await mkRate(REP_INACTIVE, "0.075000", false); // inactive → skipped_no_rate
  // REP_NORATE deliberately gets NO settings row.
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("calculateCommissionForDeal (owner row, real Drizzle-derived schema)", () => {
  it("creates a commission row for a deal with rep + rate + awardedAmount (manual calc check)", async () => {
    const D = U("0c01");
    await seedDeal(D, { rep: REP_FULL, awarded: 100000, bid: 95000, dd: 90000 });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    // Manual calc: 100000.00 (awarded_amount, preferred over bid/dd) × 0.075 (rep rate) = 7500.00
    expect(result.status).toBe("created");
    expect(result.amount).toBe("7500.00");
    expect(result.appliedRate).toBe("0.075000");
    expect(result.sourceValueAmount).toBe("100000.00");
    expect(result.sourceValueKind).toBe("awarded_amount");

    const rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    const owner = rowFor(rows, REP_FULL)!;
    expect(owner.attribution_role).toBe("owner");
    expect(owner.source_value_kind).toBe("awarded_amount");
    expect(owner.source_value_amount).toBe("100000.00");
    expect(owner.applied_rate).toBe("0.075000");
    expect(owner.amount).toBe("7500.00");
    expect(owner.contract_signed_date_at_signing).toBe("2026-09-15");
    expect(owner.created_by).toBe(ADMIN);

    const audit = await auditInsertsFor(owner.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].changed_by).toBe(ADMIN);
  });

  it("idempotency: firing twice for same (deal, rep) produces exactly one commission row", async () => {
    const D = U("0c02");
    await seedDeal(D, { rep: REP_FIVE, awarded: 100000 });

    const first = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });
    // Second fire: ON CONFLICT (deal_id, rep_user_id) DO NOTHING → empty returning → skipped_existing.
    const second = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(first.status).toBe("created");
    expect(first.amount).toBe("5000.00"); // 100000 × 0.05
    expect(second.status).toBe("skipped_existing");
    expect(await dscRows(D)).toHaveLength(1);
  });

  it("skips with skipped_no_rep when the deal has no assignedRepId", async () => {
    const D = U("0c03");
    await seedDeal(D, { rep: null, awarded: 100000 });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("skipped_no_rep");
    expect(await dscRows(D)).toHaveLength(0);
  });

  it("skips with skipped_no_rate when the rep has no commission settings", async () => {
    const D = U("0c04");
    await seedDeal(D, { rep: REP_NORATE, awarded: 100000 });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("skipped_no_rate");
    expect(await dscRows(D)).toHaveLength(0);
  });

  it("skips with skipped_no_rate when commission_rate is zero", async () => {
    const D = U("0c05");
    await seedDeal(D, { rep: REP_ZERO, awarded: 100000 });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("skipped_no_rate");
    expect(await dscRows(D)).toHaveLength(0);
  });

  it("skips with skipped_no_rate when settings.isActive is false", async () => {
    const D = U("0c06");
    await seedDeal(D, { rep: REP_INACTIVE, awarded: 100000 });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("skipped_no_rate");
    expect(await dscRows(D)).toHaveLength(0);
  });

  it("skips with skipped_no_value when all three value fields are null", async () => {
    const D = U("0c07");
    await seedDeal(D, { rep: REP_FULL, awarded: null, bid: null, dd: null });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("skipped_no_value");
    expect(await dscRows(D)).toHaveLength(0);
  });

  it("creates a commission row for an on-hold deal so releasing hold can surface the earned commission", async () => {
    const D = U("0c08");
    await seedDeal(D, { rep: REP_FULL, awarded: 100000, onHold: true });

    const result = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });

    expect(result.status).toBe("created");
    expect(result.amount).toBe("7500.00");
    const rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    const owner = rowFor(rows, REP_FULL)!;
    expect(owner.source_value_amount).toBe("100000.00");
    expect(owner.amount).toBe("7500.00");
    expect(await auditInsertsFor(owner.id)).toHaveLength(1);
  });

  it("source value preference: awardedAmount > bidEstimate > ddEstimate", async () => {
    // awardedAmount missing, bidEstimate present → uses bidEstimate.
    const D1 = U("0c09");
    await seedDeal(D1, { rep: REP_FIVE, awarded: null, bid: 80000, dd: 70000 });
    const r1 = await calculateCommissionForDeal(tdb, {
      dealId: D1,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });
    expect(r1.sourceValueKind).toBe("bid_estimate");
    expect(r1.sourceValueAmount).toBe("80000.00");
    expect(r1.amount).toBe("4000.00"); // 80000 × 0.05

    // awardedAmount + bidEstimate both missing, ddEstimate present → uses ddEstimate.
    const D2 = U("0c0a");
    await seedDeal(D2, { rep: REP_THREE, awarded: null, bid: null, dd: 70000 });
    const r2 = await calculateCommissionForDeal(tdb, {
      dealId: D2,
      contractSignedDate: "2026-09-15",
      triggeredByUserId: ADMIN,
    });
    expect(r2.sourceValueKind).toBe("dd_estimate");
    expect(r2.sourceValueAmount).toBe("70000.00");
    expect(r2.amount).toBe("2100.00"); // 70000 × 0.03
  });
});
