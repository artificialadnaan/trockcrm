// Real-types (PGlite + Drizzle-derived schema, #715 helper) proof of the recalc-on-edit money path.
//
// PR: setDealContractSignedDate now re-fires commission on every contract-date transition —
//   null→date = calculate, date→date' = recalculate (remove stale + recompute), date→null = remove.
// This test exercises the underlying commission helpers against the REAL deal_signed_commissions /
// deals / user_commission_settings / audit_log schema so the money effects are type-accurate:
//   • recalc with a changed source value updates the amount and leaves EXACTLY ONE row (no dup),
//   • recalc is idempotent,
//   • remove deletes the row (the date→null clear: no signed date ⇒ no phantom payout).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
  userCommissionSettings,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import {
  calculateCommissionForDeal,
  recalculateCommissionForDeal,
  removeCommissionForDeal,
} from "../../../src/modules/commissions/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("0de1");
const REP = U("0001");
const STAGE = U("0500");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function dscRows() {
  const { rows } = await pg.query<{
    amount: string;
    source_value_amount: string;
    source_value_kind: string;
    contract_signed_date_at_signing: string;
  }>(
    `SELECT amount, source_value_amount, source_value_kind,
            contract_signed_date_at_signing::text AS contract_signed_date_at_signing
     FROM public.deal_signed_commissions WHERE deal_id = '${DEAL}'`,
  );
  return rows;
}

beforeAll(async () => {
  pg = new PGlite();
  // Real schema generated from the Drizzle table objects (enums in public, NOT NULL + numeric precision
  // verbatim) — not hand-rolled DDL that could drift from prod.
  await pg.exec(tenantSchemaSql("public", [deals, userCommissionSettings, dealSignedCommissions, auditLog]));
  tdb = drizzle(pg);
  // A signed-able deal owned by REP with a $100,000 awarded amount, and REP on a 2% active rate.
  await pg.exec(
    `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount)
     VALUES ('${DEAL}', 'D-1', 'Recalc Test Deal', '${STAGE}', '${REP}', 100000)`,
  );
  await pg.exec(
    `INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active)
     VALUES ('${REP}', 0.020000, true)`,
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("commission recalc-on-edit (real Drizzle-derived schema)", () => {
  it("initial calc (null→date) creates exactly one row at value × rate", async () => {
    const result = await calculateCommissionForDeal(tdb, {
      dealId: DEAL,
      contractSignedDate: "2026-01-01",
      triggeredByUserId: REP,
    });
    expect(result.status).toBe("created");
    const rows = await dscRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(2000); // 100000 × 0.02
    expect(rows[0].source_value_kind).toBe("awarded_amount");
  });

  it("edit (date→date' with a changed source value) recalculates: ONE row, new amount, new date stamp", async () => {
    // The awarded amount was corrected upward — a stale commission here is a real payout error.
    await pg.exec(`UPDATE public.deals SET awarded_amount = 200000 WHERE id = '${DEAL}'`);

    const result = await recalculateCommissionForDeal(tdb, {
      dealId: DEAL,
      contractSignedDate: "2026-02-01",
      triggeredByUserId: REP,
    });
    expect(result.status).toBe("created");

    const rows = await dscRows();
    expect(rows).toHaveLength(1); // remove-then-insert ⇒ never a duplicate
    expect(Number(rows[0].amount)).toBe(4000); // 200000 × 0.02 — recomputed from CURRENT source value
    expect(rows[0].contract_signed_date_at_signing).toBe("2026-02-01"); // re-stamped to the new date
  });

  it("recalc is idempotent — running it again leaves exactly one identical row", async () => {
    await recalculateCommissionForDeal(tdb, {
      dealId: DEAL,
      contractSignedDate: "2026-02-01",
      triggeredByUserId: REP,
    });
    const rows = await dscRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(4000);
  });

  it("clear (date→null) removes the row — no signed date ⇒ zero commission rows (no phantom payout)", async () => {
    const removed = await removeCommissionForDeal(tdb, DEAL, REP);
    expect(removed).toBe(1);
    expect(await dscRows()).toHaveLength(0);
  });

  it("a no-rate rep is skipped (the backfill 'skipped_no_rate' set), then computes once a rate exists", async () => {
    const norateRep = U("0099");
    const norateDeal = U("0de9");
    await pg.exec(
      `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount)
       VALUES ('${norateDeal}', 'D-9', 'No-Rate Deal', '${STAGE}', '${norateRep}', 50000)`,
    );
    // No user_commission_settings for this rep yet → calc must skip (mirrors the 8 dry-run skips).
    const skipped = await calculateCommissionForDeal(tdb, {
      dealId: norateDeal,
      contractSignedDate: "2026-03-01",
      triggeredByUserId: norateRep,
    });
    expect(skipped.status).toBe("skipped_no_rate");
    expect((await pg.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${norateDeal}'`)).rows).toHaveLength(0);

    // After the rate is configured, a re-run (the idempotent backfill re-run path) computes it.
    await pg.exec(
      `INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${norateRep}', 0.010000, true)`,
    );
    const created = await calculateCommissionForDeal(tdb, {
      dealId: norateDeal,
      contractSignedDate: "2026-03-01",
      triggeredByUserId: norateRep,
    });
    expect(created.status).toBe("created");
    expect(Number((await pg.query<{ amount: string }>(`SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${norateDeal}'`)).rows[0].amount)).toBe(500); // 50000 × 0.01
  }, 30_000);

  // CodeRabbit bug 2: a date correction recomputes against the BOOKED rep, it does not re-attribute
  // commission to a deal's later reassigned owner.
  it("recalc PRESERVES the original rep attribution when the deal was reassigned after signing", async () => {
    const dealId = U("0da2");
    const repA = U("00a1");
    const repB = U("00b2");
    await pg.exec(
      `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount)
       VALUES ('${dealId}', 'D-2', 'Reassigned Deal', '${STAGE}', '${repA}', 100000)`,
    );
    await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${repA}', 0.020000, true)`);
    await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${repB}', 0.050000, true)`);
    // Commission booked to rep A on signing.
    await calculateCommissionForDeal(tdb, { dealId, contractSignedDate: "2026-01-01", triggeredByUserId: repA });
    // Deal reassigned to rep B AFTER signing (normal ownership change — must not move the booked commission).
    await pg.exec(`UPDATE public.deals SET assigned_rep_id = '${repB}' WHERE id = '${dealId}'`);

    await recalculateCommissionForDeal(tdb, { dealId, contractSignedDate: "2026-02-01", triggeredByUserId: repA });

    const { rows } = await pg.query<{ rep_user_id: string; amount: string }>(
      `SELECT rep_user_id, amount FROM public.deal_signed_commissions WHERE deal_id = '${dealId}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rep_user_id).toBe(repA); // attribution stayed with the ORIGINAL rep, not rep B
    expect(Number(rows[0].amount)).toBe(2000); // recomputed at rep A's 2% (100000 × 0.02), NOT rep B's 5%
  }, 30_000);

  // CodeRabbit bug 1 (the critical one): an edit that cannot validly recompute must LEAVE the existing
  // row intact — never delete-then-skip, which would silently wipe earned commission to $0.
  it("recalc PRESERVES the existing row when the booked rep's rate is gone (no delete-then-skip data loss)", async () => {
    const dealId = U("0da3");
    const rep = U("00c3");
    await pg.exec(
      `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount)
       VALUES ('${dealId}', 'D-3', 'Deactivated-Rep Deal', '${STAGE}', '${rep}', 100000)`,
    );
    await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${rep}', 0.020000, true)`);
    await calculateCommissionForDeal(tdb, { dealId, contractSignedDate: "2026-01-01", triggeredByUserId: rep });

    // The rep's commission settings are deactivated, and the source value also changed — the recompute
    // CANNOT produce a valid replacement.
    await pg.exec(`UPDATE public.user_commission_settings SET is_active = false WHERE user_id = '${rep}'`);
    await pg.exec(`UPDATE public.deals SET awarded_amount = 999999 WHERE id = '${dealId}'`);

    const result = await recalculateCommissionForDeal(tdb, { dealId, contractSignedDate: "2026-02-01", triggeredByUserId: rep });
    expect(result.status).toBe("skipped_no_rate"); // nothing recomputed

    const { rows } = await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id = '${dealId}'`,
    );
    expect(rows).toHaveLength(1); // the row is STILL THERE — no data loss
    expect(Number(rows[0].amount)).toBe(2000); // original booked amount preserved (NOT 999999×rate, NOT $0)
  }, 30_000);
});
