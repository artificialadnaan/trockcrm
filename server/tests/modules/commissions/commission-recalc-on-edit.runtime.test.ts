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
});
