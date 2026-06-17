// Real-types (PGlite + Drizzle-derived schema, #715 helper) proof of the ESTIMATOR-AWARE earned
// commission money path.
//
// Comp model (locked): the estimator earns an ADDITIONAL deal_signed_commissions row at the ESTIMATOR's
// OWN rate, on top of the owner's full cut (ADDITIVE — never a split). Change-order child deals NEVER
// mint an estimator row (base-deal-only). A→B where B has no active rate removes A and mints nothing
// (net $0). The floor gate is untouched (it keys on owned deals / assigned_rep_id, not estimator rows).
//
// This exercises the REAL deal_signed_commissions / deals / user_commission_settings / users / audit_log
// schema so the money effects are type-accurate. setDealEstimator (the manual edit path) is driven
// end-to-end against the real DB; its commission re-attribution uses the ESTIMATOR-SCOPED helpers
// (removeEstimatorCommissionForDeal — a (deal_id, rep_user_id) delete), NEVER removeCommissionForDeal
// (which deletes ALL rows incl. the owner). Proven below by owner-row survival on every estimator edit.
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
  mintEstimatorCommissionForDeal,
  removeCommissionForDeal,
  removeEstimatorCommissionForDeal,
} from "../../../src/modules/commissions/service.js";
import { setDealEstimator } from "../../../src/modules/deals/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

// One office; everyone lives in it so the same-office reassignment validation passes.
const OFFICE = U("0f1");
const OWNER = U("0001"); // 2% rate
const ESTA = U("00a1"); // estimator A, 5% rate
const ESTB = U("00b2"); // estimator B, 3% rate
const ESTNR = U("00c3"); // estimator with NO active rate
const STAGE = U("0500");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function dscRows(dealId: string) {
  const { rows } = await pg.query<{
    rep_user_id: string;
    amount: string;
    applied_rate: string;
    source_value_amount: string;
    source_value_kind: string;
    contract_signed_date_at_signing: string;
    id: string;
    calculated_at: string;
  }>(
    `SELECT id, rep_user_id, amount, applied_rate, source_value_amount, source_value_kind,
            contract_signed_date_at_signing::text AS contract_signed_date_at_signing,
            calculated_at::text AS calculated_at
     FROM public.deal_signed_commissions WHERE deal_id = '${dealId}' ORDER BY amount DESC`,
  );
  return rows;
}
const rowFor = (rows: Awaited<ReturnType<typeof dscRows>>, rep: string) =>
  rows.find((r) => r.rep_user_id === rep);

// Insert a signed-able deal owned by OWNER ($100k awarded), optionally with an estimator + CO flag.
async function seedDeal(
  id: string,
  opts: { estimator?: string | null; signed?: boolean; co?: boolean } = {},
) {
  const estimator = opts.estimator === undefined ? null : opts.estimator;
  const signed = opts.signed ?? true;
  await pg.exec(
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, estimator_user_id,
        is_change_order, office_code, contract_signed_date)
     VALUES ('${id}', 'D-${id.slice(-4)}', 'Deal ${id.slice(-4)}', '${STAGE}', '${OWNER}', 100000,
        ${estimator ? `'${estimator}'` : "NULL"}, ${opts.co ? "true" : "false"}, NULL,
        ${signed ? `'2026-01-01'` : "NULL"})`,
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
  tdb = drizzle(pg);

  const mkUser = (id: string) =>
    pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${id}', '${id}@t.test', 'User ${id.slice(-4)}', 'rep', '${OFFICE}', true)`,
    );
  await mkUser(OWNER);
  await mkUser(ESTA);
  await mkUser(ESTB);
  await mkUser(ESTNR); // active user but no commission settings → no rate
  const mkRate = (id: string, rate: string) =>
    pg.exec(
      `INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active)
       VALUES ('${id}', ${rate}, true)`,
    );
  await mkRate(OWNER, "0.020000");
  await mkRate(ESTA, "0.050000");
  await mkRate(ESTB, "0.030000");
  // ESTNR deliberately gets NO settings row.
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("estimator-aware earned commission (real Drizzle-derived schema)", () => {
  // 1. SIGN-TIME: calculateCommissionForDeal mints BOTH rows (owner full cut + estimator own rate).
  it("sign-time mints BOTH the owner row and an additive estimator row at the estimator's own rate", async () => {
    const D = U("0de1");
    await seedDeal(D, { estimator: ESTA });
    const res = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-01-01",
      triggeredByUserId: OWNER,
    });
    expect(res.status).toBe("created");

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    const owner = rowFor(rows, OWNER)!;
    const est = rowFor(rows, ESTA)!;
    expect(Number(owner.amount)).toBe(2000); // 100000 × 0.02 (owner full cut)
    expect(Number(owner.applied_rate)).toBe(0.02);
    expect(Number(est.amount)).toBe(5000); // 100000 × 0.05 (estimator's OWN rate — additive)
    expect(Number(est.applied_rate)).toBe(0.05);
    // Same source value drives both rows.
    expect(owner.source_value_kind).toBe("awarded_amount");
    expect(est.source_value_kind).toBe("awarded_amount");
    expect(owner.source_value_amount).toBe(est.source_value_amount);
  });

  // 2. manual null→B on an already-signed deal: one estimator row keyed B; owner row byte-identical; audit.
  it("manual null→B mints only the estimator row and leaves the owner row byte-identical", async () => {
    const D = U("0de2");
    await seedDeal(D, { estimator: null });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;
    expect(ownerBefore).toBeTruthy();

    await setDealEstimator(tdb, D, ESTB, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    const ownerAfter = rowFor(rows, OWNER)!;
    const est = rowFor(rows, ESTB)!;
    expect(Number(est.amount)).toBe(3000); // 100000 × 0.03
    // OWNER row byte-identical (same id, amount, rate, stamp, calculated_at) — only the NEW estimator row added.
    expect(ownerAfter).toEqual(ownerBefore);

    const audit = (
      await pg.query<{ changes: { estimatorUserId?: { from: unknown; to: unknown } } }>(
        `SELECT changes FROM public.audit_log WHERE table_name='deals' AND record_id='${D}'
         AND action='update' ORDER BY id DESC LIMIT 1`,
      )
    ).rows[0];
    expect(audit.changes.estimatorUserId).toEqual({ from: null, to: ESTB });
  });

  // 3. manual A→B: A's row deleted, B's inserted, never both; owner untouched.
  it("manual A→B deletes A's estimator row and inserts B's (never both); owner untouched", async () => {
    const D = U("0de3");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    await setDealEstimator(tdb, D, ESTB, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    expect(rowFor(rows, ESTA)).toBeUndefined(); // A removed
    expect(Number(rowFor(rows, ESTB)!.amount)).toBe(3000); // B minted
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore); // owner untouched
  });

  // 4. manual B→null: estimator row removed (scoped); owner intact; removeCommissionForDeal (all-rows) NOT used.
  it("manual B→null removes ONLY the estimator row (scoped) and keeps the owner row", async () => {
    const D = U("0de4");
    await seedDeal(D, { estimator: ESTB });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    await setDealEstimator(tdb, D, null, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(1); // owner survives — proof the scoped delete (not the all-rows remove) ran
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);
    expect(rowFor(rows, ESTB)).toBeUndefined();
  });

  // 5. A→B where B has NO active rate: A removed, nothing minted (net $0); owner untouched.
  it("manual A→(rateless B) removes A and mints nothing (net $0); owner untouched", async () => {
    const D = U("0de5");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    await setDealEstimator(tdb, D, ESTNR, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(1); // ESTA gone, ESTNR has no rate so nothing minted
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);
    expect(rowFor(rows, ESTNR)).toBeUndefined();
  });

  // 6. unchanged estimator whose rate LATER vanishes: the no-op short-circuit PRESERVES the existing row.
  it("re-setting the SAME estimator is a no-op short-circuit — preserves the row even if the rate later vanished", async () => {
    const D = U("0de6");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const estaBefore = rowFor(await dscRows(D), ESTA)!;
    expect(Number(estaBefore.amount)).toBe(5000);

    // ESTA's rate is later deactivated.
    await pg.exec(`UPDATE public.user_commission_settings SET is_active=false WHERE user_id='${ESTA}'`);
    // Re-assign the SAME estimator → no-op short-circuit → no remove, no mint.
    await setDealEstimator(tdb, D, ESTA, OWNER);
    // Restore for later tests.
    await pg.exec(`UPDATE public.user_commission_settings SET is_active=true WHERE user_id='${ESTA}'`);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    expect(rowFor(rows, ESTA)).toEqual(estaBefore); // PRESERVED, not zeroed/removed
  });

  // 7. estimator == owner: null→owner mints skipped_existing (no 2nd row); owner→null is hard-guarded (owner row kept).
  it("estimator == owner: no duplicate row on set, and the hard guard keeps the owner row on clear", async () => {
    const D = U("0de7");
    await seedDeal(D, { estimator: null });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    // Set estimator = owner → mint sees estimator===owner → skipped_existing, no second row.
    await setDealEstimator(tdb, D, OWNER, OWNER);
    let rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);

    // Clear it → oldEstimator===owner so the scoped remove is hard-guarded (would otherwise delete the owner row).
    await setDealEstimator(tdb, D, null, OWNER);
    rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);

    // Direct hard-guard proof: removeEstimatorCommissionForDeal with estimator===owner returns 0 and deletes nothing.
    const removed = await removeEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: OWNER,
      ownerUserId: OWNER,
      triggeredByUserId: OWNER,
    });
    expect(removed).toBe(0);
    expect(rowFor(await dscRows(D), OWNER)).toEqual(ownerBefore);
  });

  // 8. CO base-deal-only: setDealEstimator on a CO → 409; mint on a CO → skipped_change_order; no estimator row.
  it("change order is base-deal-only: 409 on edit, skipped_change_order on mint, no estimator row ever", async () => {
    const D = U("0dc8");
    await seedDeal(D, { estimator: ESTA, co: true });

    await expect(setDealEstimator(tdb, D, ESTB, OWNER)).rejects.toMatchObject({
      statusCode: 409,
      code: "CHANGE_ORDER_FIELD_LOCKED",
    });

    const mint = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: ESTA,
      triggeredByUserId: OWNER,
    });
    expect(mint.status).toBe("skipped_change_order");

    // Even at sign time a CO mints only the owner row, never the estimator.
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const rows = await dscRows(D);
    expect(rowFor(rows, ESTA)).toBeUndefined();
    expect(rows.every((r) => r.rep_user_id !== ESTA)).toBe(true);
  });

  // 9. unsigned deal: estimator set but no effective signed date → mint skipped_no_value, no row.
  it("mint on an UNSIGNED deal is skipped_no_value (no effective signed date) — no row", async () => {
    const D = U("0de9");
    await seedDeal(D, { estimator: ESTA, signed: false });
    const mint = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: ESTA,
      triggeredByUserId: OWNER,
    });
    expect(mint.status).toBe("skipped_no_value");
    expect(await dscRows(D)).toHaveLength(0);
  });

  // 10. contract-date CLEAR→RESIGN closes the gap: clear removes ALL rows (owner+estimator), re-sign re-mints BOTH.
  // setDealContractSignedDate routes null→date to calculateCommissionForDeal and date→null to
  // removeCommissionForDeal (verified in deals/service.ts); this proves both ends at the helper level.
  it("clear (date→null) removes BOTH rows; re-sign (null→date) re-mints BOTH — the resign gap is closed", async () => {
    const D = U("0d10");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);

    // Clear → removeCommissionForDeal deletes ALL rows for the deal (owner + estimator).
    const removed = await removeCommissionForDeal(tdb, D, OWNER);
    expect(removed).toBe(2);
    expect(await dscRows(D)).toHaveLength(0);

    // Re-sign → calculateCommissionForDeal re-mints BOTH (this is the gap closure).
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-03-01", triggeredByUserId: OWNER });
    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    expect(Number(rowFor(rows, OWNER)!.amount)).toBe(2000);
    expect(Number(rowFor(rows, ESTA)!.amount)).toBe(5000);
  });

  // 11. idempotency: re-running mint returns skipped_existing (SELECT-before-INSERT / 23505 backstop), no dup.
  it("mint is idempotent — a re-run returns skipped_existing and never creates a duplicate row", async () => {
    const D = U("0d11");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);

    const again = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: ESTA,
      triggeredByUserId: OWNER,
    });
    expect(again.status).toBe("skipped_existing");
    expect(await dscRows(D)).toHaveLength(2); // no duplicate
  });
});
