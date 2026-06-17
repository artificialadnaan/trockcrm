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
import { eq } from "drizzle-orm";
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
    attribution_role: string;
    contract_signed_date_at_signing: string;
    id: string;
    calculated_at: string;
  }>(
    `SELECT id, rep_user_id, amount, applied_rate, source_value_amount, source_value_kind, attribution_role,
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
  // tenantSchemaSql intentionally omits indexes/constraints, but the tx-safe insert now relies on the
  // (deal_id, rep_user_id) UNIQUE for ON CONFLICT DO NOTHING — recreate it so the conflict path is exercised.
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`,
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
    expect(owner.attribution_role).toBe("owner"); // role stamped so the estimator delete can never hit it
    expect(Number(est.amount)).toBe(5000); // 100000 × 0.05 (estimator's OWN rate — additive)
    expect(Number(est.applied_rate)).toBe(0.05);
    expect(est.attribution_role).toBe("estimator");
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

    // ESTA's rate is later deactivated. try/finally so the restore ALWAYS runs even if the assertion or
    // setDealEstimator throws — otherwise ESTA's rate would stay inactive and poison later tests.
    try {
      await pg.exec(`UPDATE public.user_commission_settings SET is_active=false WHERE user_id='${ESTA}'`);
      // Re-assign the SAME estimator → no-op short-circuit → no remove, no mint.
      await setDealEstimator(tdb, D, ESTA, OWNER);
    } finally {
      // Restore for later tests.
      await pg.exec(`UPDATE public.user_commission_settings SET is_active=true WHERE user_id='${ESTA}'`);
    }

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

    // Clear it → removeEstimatorCommissionForDeal IS now called (estimator was owner), but its DELETE is
    // role-scoped to attribution_role='estimator', so the owner's role='owner' row is never matched: 0
    // deleted, owner row survives.
    await setDealEstimator(tdb, D, null, OWNER);
    rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);

    // Direct role-scoped proof: removeEstimatorCommissionForDeal for a deal whose only row is the OWNER's
    // (role='owner') returns 0 and deletes nothing — the role predicate, not a userid check, protects it.
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

    // Even at sign time a CO mints the OWNER row but NEVER the estimator (base-deal-only).
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const rows = await dscRows(D);
    const ownerRow = rowFor(rows, OWNER);
    expect(ownerRow).toBeDefined(); // the owner row WAS minted (a CO still earns the owner's full cut)
    expect(ownerRow!.attribution_role).toBe("owner");
    expect(Number(ownerRow!.amount)).toBe(2000); // 100000 × 0.02
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

  // 11. idempotency: re-running mint returns skipped_existing (ON CONFLICT DO NOTHING → empty returning), no dup.
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

  // 12. TX-SAFETY (FIX 1): a duplicate insert hits ON CONFLICT DO NOTHING (NOT a caught 23505), so the
  // surrounding transaction stays VALID — a subsequent statement in the SAME tx still commits. A caught
  // 23505 would have left the tx ABORTED, failing this follow-up write with "current transaction is aborted".
  it("a duplicate mint inside a tx returns skipped_existing AND leaves the transaction valid (no 23505 abort)", async () => {
    const D = U("0d12");
    await seedDeal(D, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(await dscRows(D)).toHaveLength(2);

    await tdb.transaction(async (tx: typeof tdb) => {
      // Re-mint the (already-present) estimator row → ON CONFLICT DO NOTHING → skipped_existing, no throw.
      const again = await mintEstimatorCommissionForDeal(tx, {
        dealId: D,
        estimatorUserId: ESTA,
        triggeredByUserId: OWNER,
      });
      expect(again.status).toBe("skipped_existing");
      // Subsequent write in the SAME tx must succeed — proof the tx was never aborted by a unique violation.
      await tx.update(deals).set({ name: "still-valid-after-conflict" }).where(eq(deals.id, D));
    });

    // The tx COMMITTED (no abort): the follow-up update is visible, and still no duplicate commission row.
    const after = await pg.query<{ name: string }>(`SELECT name FROM public.deals WHERE id='${D}'`);
    expect(after.rows[0].name).toBe("still-valid-after-conflict");
    expect(await dscRows(D)).toHaveLength(2);
  });

  // 13. OWNER-SAFE DELETE (FIX 2, scenario a): estimator==owner at sign (only the OWNER row exists), then
  // the owner is REASSIGNED, then the estimator is changed. The role-scoped delete must NOT touch the
  // owner's row even though its rep_user_id matches the departing estimator.
  it("estimator==owner-at-sign → reassign owner → change estimator deletes NO owner row (role-scoped)", async () => {
    const D = U("0d13");
    // Signed with estimator === owner === OWNER → only the OWNER full-cut row is minted (no estimator row).
    await seedDeal(D, { estimator: OWNER });
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    let rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    const ownerBefore = rowFor(rows, OWNER)!;
    expect(ownerBefore.attribution_role).toBe("owner");

    // Reassign the OWNER to ESTA (the dsc owner row stays booked to OWNER — reassignment never moves it).
    await pg.exec(`UPDATE public.deals SET assigned_rep_id='${ESTA}' WHERE id='${D}'`);

    // Now change the estimator OWNER→ESTB. oldEstimator(OWNER) !== current owner(ESTA), so the removal
    // fires for rep=OWNER — but role-scoping (attribution_role='estimator') spares the OWNER's role='owner' row.
    await setDealEstimator(tdb, D, ESTB, OWNER);

    rows = await dscRows(D);
    // The owner row SURVIVES byte-identical; ESTB's additive estimator row is minted.
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore);
    const estb = rowFor(rows, ESTB)!;
    expect(estb).toBeDefined();
    expect(estb.attribution_role).toBe("estimator");
    expect(Number(estb.amount)).toBe(3000); // 100000 × 0.03
    expect(rows).toHaveLength(2);
  });

  // 14. OWNER-SAFE DELETE (FIX 2, scenario b): owner O + distinct estimator E, then O is reassigned TO E.
  // Clearing the estimator must STILL remove E's estimator-role row (the old userid short-circuit would
  // have wrongly skipped it because estimator===current-owner), while the original owner's row survives.
  it("owner O + est E → reassign O→E → clear estimator removes E's estimator-role row (owner row kept)", async () => {
    const D = U("0d14");
    await seedDeal(D, { estimator: ESTA }); // owner OWNER, estimator ESTA
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    let rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    const ownerBefore = rowFor(rows, OWNER)!;
    expect(rowFor(rows, ESTA)!.attribution_role).toBe("estimator");

    // Reassign the OWNER to ESTA — now the deal's current owner IS the (still-set) estimator.
    await pg.exec(`UPDATE public.deals SET assigned_rep_id='${ESTA}' WHERE id='${D}'`);

    // Clear the estimator. estimator(ESTA) === current owner(ESTA), yet the estimator-role row for ESTA must
    // still be removed (role-scoped delete targets attribution_role='estimator', not the owner's row).
    await setDealEstimator(tdb, D, null, OWNER);

    rows = await dscRows(D);
    expect(rowFor(rows, ESTA)).toBeUndefined(); // ESTA's ESTIMATOR-role row removed correctly
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore); // the original owner full-cut row survives
    expect(rows).toHaveLength(1);
  });

  // 15. CO-CHILD PROPAGATION (FIX 4): editing the parent's estimator follows down to ACTIVE change-order
  // children (inherited estimator), but inactive children are left alone and NO estimator commission row is
  // ever minted for any CO child (base-deal-only).
  it("setDealEstimator propagates to ACTIVE CO children only, minting NO estimator commission for them", async () => {
    const PARENT = U("0d15");
    const CO_ACTIVE = U("0c15");
    const CO_INACTIVE = U("0c16");
    await seedDeal(PARENT, { estimator: ESTA });
    await calculateCommissionForDeal(tdb, { dealId: PARENT, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    // Two CO children inheriting estimator ESTA: one active, one soft-deleted (is_active=false).
    const insCo = (id: string, active: boolean) =>
      pg.exec(
        `INSERT INTO public.deals
           (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, estimator_user_id,
            is_change_order, parent_deal_id, is_active, office_code, contract_signed_date)
         VALUES ('${id}', 'CO-${id.slice(-4)}', 'CO ${id.slice(-4)}', '${STAGE}', '${OWNER}', 25000, '${ESTA}',
            true, '${PARENT}', ${active}, NULL, '2026-01-01')`,
      );
    await insCo(CO_ACTIVE, true);
    await insCo(CO_INACTIVE, false);

    // Change the parent estimator ESTA→ESTB.
    await setDealEstimator(tdb, PARENT, ESTB, OWNER);

    const estimatorOf = async (id: string) =>
      (await pg.query<{ estimator_user_id: string | null }>(
        `SELECT estimator_user_id FROM public.deals WHERE id='${id}'`,
      )).rows[0].estimator_user_id;
    expect(await estimatorOf(PARENT)).toBe(ESTB); // parent updated
    expect(await estimatorOf(CO_ACTIVE)).toBe(ESTB); // ACTIVE CO child follows the parent
    expect(await estimatorOf(CO_INACTIVE)).toBe(ESTA); // inactive CO child untouched

    // Money-neutral: neither CO child ever gets an estimator commission row.
    expect(await dscRows(CO_ACTIVE)).toHaveLength(0);
    expect(await dscRows(CO_INACTIVE)).toHaveLength(0);
    // The base deal's estimator row was re-attributed ESTA→ESTB (additive, owner row intact).
    const parentRows = await dscRows(PARENT);
    expect(rowFor(parentRows, OWNER)?.attribution_role).toBe("owner");
    expect(rowFor(parentRows, ESTB)?.attribution_role).toBe("estimator");
    expect(rowFor(parentRows, ESTA)).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // OWNER-ROW INVARIANT (Codex): the mint helper's "already covered" gate keys on the ACTUAL booked
  // deal_signed_commissions row (rep presence), NEVER the mutable deal.assigned_rep_id. After an owner
  // reassignment the booked owner row stays on the ORIGINAL rep while assigned_rep_id moves — so an
  // assigned_rep_id proxy is wrong in BOTH directions. Tests 16–18 lock the invariant's guarantees; test
  // 18 (regression) preserves the sign-time estimator==owner behavior.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────

  // 16. BOOKED-OWNER GATE (no double-pay): signed owner=O, then the owner is REASSIGNED O→X (the booked
  // owner row stays rep=O role=owner), then estimator is set back to O. O must NOT get a 2nd row — the
  // gate is the booked owner ROW (rep=O present), not the assignedRepId proxy (which now points at X).
  it("reassign owner O→X then set estimator=O mints NO second row for O (booked-owner ROW gate)", async () => {
    const D = U("0d16");
    await seedDeal(D, { estimator: null }); // owner=OWNER(O), no estimator
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    let rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    const ownerBefore = rowFor(rows, OWNER)!;
    expect(ownerBefore.attribution_role).toBe("owner");

    // Reassign the OWNER O→X (X = ESTA). The booked owner row stays on O — reassignment never moves it.
    await pg.exec(`UPDATE public.deals SET assigned_rep_id='${ESTA}' WHERE id='${D}'`);

    // Set estimator = O. O already books the owner row, so the row-based gate skips — no 2nd cut for O.
    // Direct-helper proof: the assignedRepId proxy (O===X? false) would NOT short-circuit here; only the
    // (deal_id, rep_user_id) backstop would catch it. The row gate makes the skip authoritative.
    const mint = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: OWNER,
      triggeredByUserId: OWNER,
    });
    expect(mint.status).toBe("skipped_existing");

    rows = await dscRows(D);
    expect(rows).toHaveLength(1); // O keeps EXACTLY the owner row — no double-pay
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore); // byte-identical owner row
  });

  // 17. PROXY FALSE-POSITIVE (the test that strictly REQUIRES the row gate): signed owner=O, reassign
  // O→X, then set estimator=X (the NEW assignee, who books NO row yet). The assignedRepId proxy
  // (estimator===assignedRepId → X===X) would WRONGLY skip and deny X the estimator cut they are owed;
  // the row-based gate mints X's estimator row because X has no booked row. (FAILS on the old proxy.)
  it("reassign owner O→X then set estimator=X mints X's estimator row (proxy would wrongly skip)", async () => {
    const D = U("0d17");
    await seedDeal(D, { estimator: null }); // owner=OWNER(O), no estimator
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    // Reassign the OWNER O→X (X = ESTA). assigned_rep_id is now ESTA; the owner row stays booked to O.
    await pg.exec(`UPDATE public.deals SET assigned_rep_id='${ESTA}' WHERE id='${D}'`);

    // Set estimator = X (= ESTA = the current assignee). The OLD proxy (ESTA===assignedRepId ESTA) would
    // short-circuit to skipped_existing and mint NOTHING; the row gate sees ESTA books no row → mints it.
    await setDealEstimator(tdb, D, ESTA, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    const est = rowFor(rows, ESTA)!;
    expect(est).toBeDefined(); // X's estimator row WAS minted — proxy would have denied it
    expect(est.attribution_role).toBe("estimator");
    expect(Number(est.amount)).toBe(5000); // 100000 × 0.05 (X's OWN rate, additive)
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore); // the original owner's full-cut row is byte-identical
  });

  // 18. ESTIMATOR DISTINCT FROM BOTH (Y ≠ O, Y ≠ X): signed owner=O, reassign O→X, set estimator=Y.
  // Y's estimator row is minted at Y's own rate; the booked owner row (still O) is byte-identical.
  it("reassign owner O→X then set estimator=Y (distinct) mints Y's row; O's owner row byte-identical", async () => {
    const D = U("0d18");
    await seedDeal(D, { estimator: null }); // owner=OWNER(O)
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    const ownerBefore = rowFor(await dscRows(D), OWNER)!;

    // Reassign O→X (X = ESTA), then name a DISTINCT estimator Y (= ESTB).
    await pg.exec(`UPDATE public.deals SET assigned_rep_id='${ESTA}' WHERE id='${D}'`);
    await setDealEstimator(tdb, D, ESTB, OWNER);

    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    const est = rowFor(rows, ESTB)!;
    expect(est.attribution_role).toBe("estimator");
    expect(Number(est.amount)).toBe(3000); // 100000 × 0.03 (Y's own rate)
    expect(rowFor(rows, ESTA)).toBeUndefined(); // X (current assignee, not the estimator) books no row
    expect(rowFor(rows, OWNER)).toEqual(ownerBefore); // booked owner stays O, byte-identical
  });

  // 19. REGRESSION (estimator==owner at SIGN time): the sign-time path still mints ONLY the owner row.
  // The calc pre-check (estimator!==assignedRepId) is a cheap optimization; even if removed, the row gate
  // / onConflict backstop would keep this to one row. Asserted here so the existing behavior is preserved.
  it("regression: estimator==owner at SIGN time mints only the owner row (no estimator row)", async () => {
    const D = U("0d19");
    await seedDeal(D, { estimator: OWNER }); // estimator === owner at sign
    const res = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-01-01",
      triggeredByUserId: OWNER,
    });
    expect(res.status).toBe("created");
    expect(res.estimator).toBeUndefined(); // no additive estimator side-effect when estimator IS the owner

    const rows = await dscRows(D);
    expect(rows).toHaveLength(1);
    const owner = rowFor(rows, OWNER)!;
    expect(owner.attribution_role).toBe("owner");
    expect(Number(owner.amount)).toBe(2000); // 100000 × 0.02 (owner full cut only)
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // OWNER-ROW INVARIANT — 3rd facet (FINDING A): the estimator's ADDITIVE row must NEVER be the first/only
  // deal_signed_commissions row on a deal. If the OWNER mint is skipped (e.g. the owner has no active rate)
  // while a distinct estimator IS rated, the pre-fix code minted the estimator row alone — orphaning the
  // owner AND blinding the #736 owner backfill (it skips any deal that already carries ANY dsc row), so the
  // owner never got a row even after gaining a rate. The mint is now GATED on an existing owner row.
  // ───────────────────────────────────────────────────────────────────────────────────────────────────

  // Owner with NO active rate, but a distinct estimator with a rate. assigned_rep_id is ESTNR (active user,
  // no commission settings) so the owner mint skips; estimator_user_id is ESTA (5%). seedDeal hardcodes the
  // owner, so this one is inserted directly to give it a rateless owner.
  async function seedRatelessOwnerDeal(id: string) {
    await pg.exec(
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, estimator_user_id,
          is_change_order, office_code, contract_signed_date)
       VALUES ('${id}', 'D-${id.slice(-4)}', 'Deal ${id.slice(-4)}', '${STAGE}', '${ESTNR}', 100000, '${ESTA}',
          false, NULL, '2026-01-01')`,
    );
  }

  // 20. SIGN-TIME (the FINDING A scenario): rateless owner + rated distinct estimator. The owner mint is
  // skipped_no_rate (no owner row), so the estimator mint is gated → skipped_no_owner_row, and NOTHING is
  // written. The deal stays at ZERO dsc rows — no orphan estimator row, and the owner backfill can STILL
  // find and fix the deal once the owner gains a rate.
  it("sign-time: rateless owner + rated distinct estimator mints NEITHER row (estimator gated → zero rows)", async () => {
    const D = U("0d20");
    await seedRatelessOwnerDeal(D);

    const res = await calculateCommissionForDeal(tdb, {
      dealId: D,
      contractSignedDate: "2026-01-01",
      triggeredByUserId: OWNER,
    });
    expect(res.status).toBe("skipped_no_rate"); // owner has no active rate → no owner row minted
    expect(res.estimator?.status).toBe("skipped_no_owner_row"); // estimator gated on the missing owner row

    // ZERO rows: the estimator row is never the first/only dsc row → owner not orphaned, deal still backfillable.
    expect(await dscRows(D)).toHaveLength(0);
  });

  // 21. DIRECT-HELPER GATE: a SIGNED deal carrying NO owner row → mintEstimatorCommissionForDeal returns
  // skipped_no_owner_row and writes nothing (the additive estimator row can never stand alone).
  it("mint helper: a signed deal with NO owner row is skipped_no_owner_row (estimator never stands alone)", async () => {
    const D = U("0d21");
    await seedRatelessOwnerDeal(D);

    // No owner row was ever minted (owner ESTNR has no rate). Call the mint helper directly for the estimator.
    const mint = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: ESTA,
      triggeredByUserId: OWNER,
    });
    expect(mint.status).toBe("skipped_no_owner_row");
    expect(await dscRows(D)).toHaveLength(0);
  });

  // 22. REGRESSION: when the owner row DOES exist, the gate passes and the estimator row still mints. Guards
  // against the gate over-firing and silently dropping legitimate estimator commission.
  it("regression: when the owner row EXISTS, the gate passes and the estimator row still mints", async () => {
    const D = U("0d22");
    await seedDeal(D, { estimator: null }); // owner = OWNER (2% rate)
    await calculateCommissionForDeal(tdb, { dealId: D, contractSignedDate: "2026-01-01", triggeredByUserId: OWNER });
    expect(rowFor(await dscRows(D), OWNER)).toBeTruthy(); // owner row exists

    const mint = await mintEstimatorCommissionForDeal(tdb, {
      dealId: D,
      estimatorUserId: ESTA,
      triggeredByUserId: OWNER,
    });
    expect(mint.status).toBe("created");
    const rows = await dscRows(D);
    expect(rows).toHaveLength(2);
    expect(Number(rowFor(rows, ESTA)!.amount)).toBe(5000); // 100000 × 0.05 (additive estimator cut)
    expect(rowFor(rows, OWNER)!.attribution_role).toBe("owner");
  });
});
