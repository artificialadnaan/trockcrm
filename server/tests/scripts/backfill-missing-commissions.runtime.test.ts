// Real-types (PGlite + Drizzle-derived schema) test of the commission backfill: candidate selection,
// faithful dry-run (writes nothing), idempotent execute, and the "never touches a contract date" guarantee.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
  pipelineStageConfig,
  userCommissionSettings,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";
import { backfillTenantCommissions, findBackfillCandidates } from "../../src/scripts/backfill-missing-commissions.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const R1 = U("0001"); // rate 0.02
const R2 = U("0002"); // NO commission settings
const WON = U("0500");
const LOST = U("0501");

const D_HAS_DATE = U("0de1"); // has date + rep w/ rate + no row → CREATE
const D_NO_DATE = U("0de2"); // no contract date → not a candidate
const D_NO_RATE = U("0de3"); // has date + rep w/o rate → skipped_no_rate
const D_HAS_ROW = U("0de4"); // has date but already has a commission row → not a candidate
const D_LOST = U("0de5"); // has date but lost stage → not a candidate
const D_AT_ONLY = U("0de6"); // contract_signed_at only (no date column) → CREATE

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
const query = (sql: string, params?: unknown[]) => pg.query(sql, params as never[]) as Promise<{ rows: Record<string, unknown>[] }>;

async function dscCount(dealId: string): Promise<number> {
  return (await pg.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}'`)).rows.length;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [users, pipelineStageConfig, deals, userCommissionSettings, dealSignedCommissions, auditLog])
  );
  tdb = drizzle(pg);

  const OFFICE = U("0f01");
  await pg.exec(
    `INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
       ('${R1}','Rep One','r1@x.com','rep','${OFFICE}'),
       ('${R2}','Rep Two','r2@x.com','rep','${OFFICE}')`
  );
  await pg.exec(`INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES
    ('${WON}','Won','won',9), ('${LOST}','Lost','lost',10)`);
  await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${R1}', 0.020000, true)`);

  const ins = (id: string, stage: string, rep: string, date: string | null, at: string | null, awarded: number) =>
    `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, contract_signed_date, contract_signed_at)
     VALUES ('${id}','${id.slice(-4)}','Deal','${stage}','${rep}', ${awarded}, ${date ? `'${date}'` : "NULL"}, ${at ? `'${at}'` : "NULL"})`;
  await pg.exec(ins(D_HAS_DATE, WON, R1, "2026-01-15", null, 100000));
  await pg.exec(ins(D_NO_DATE, WON, R1, null, null, 100000));
  await pg.exec(ins(D_NO_RATE, WON, R2, "2026-01-20", null, 50000));
  await pg.exec(ins(D_HAS_ROW, WON, R1, "2026-01-10", null, 80000));
  await pg.exec(ins(D_LOST, LOST, R1, "2026-01-12", null, 70000));
  await pg.exec(ins(D_AT_ONLY, WON, R1, null, "2026-02-01T00:00:00.000Z", 200000));
  // D_HAS_ROW already has its commission row (so the backfill must skip it as not-a-candidate).
  await pg.exec(
    `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing)
     VALUES ('${D_HAS_ROW}','${R1}','awarded_amount', 80000, 0.020000, 1600, '2026-01-10')`
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("commission backfill", () => {
  it("selects only signed, non-lost, dated deals with an assigned rep and no existing commission row", async () => {
    const candidates = await findBackfillCandidates(query);
    const ids = candidates.map((c) => c.dealId).sort();
    expect(ids).toEqual([D_HAS_DATE, D_NO_RATE, D_AT_ONLY].sort()); // excludes no-date, has-row, lost
    // The _at-only deal's signed date comes from contract_signed_at::date.
    expect(candidates.find((c) => c.dealId === D_AT_ONLY)?.signedDate).toBe("2026-02-01");
  });

  it("dry-run is faithful but writes NOTHING", async () => {
    const summary = await backfillTenantCommissions(tdb, query, { schema: "public", execute: false });
    expect(summary.byStatus.created).toBe(2); // D_HAS_DATE + D_AT_ONLY
    expect(summary.byStatus.skipped_no_rate).toBe(1); // D_NO_RATE
    expect(summary.totalCommissionCreated).toBe(6000); // 100000×0.02 + 200000×0.02
    // Nothing was actually written (rolled back).
    expect(await dscCount(D_HAS_DATE)).toBe(0);
    expect(await dscCount(D_AT_ONLY)).toBe(0);
  });

  it("execute writes the rows; idempotent re-run writes nothing new", async () => {
    const run1 = await backfillTenantCommissions(tdb, query, { schema: "public", execute: true });
    expect(run1.byStatus.created).toBe(2);
    expect(await dscCount(D_HAS_DATE)).toBe(1);
    expect(await dscCount(D_AT_ONLY)).toBe(1);
    expect(
      Number((await pg.query<{ amount: string }>(`SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${D_AT_ONLY}'`)).rows[0].amount)
    ).toBe(4000); // 200000 × 0.02

    // Re-run: the now-rowed deals are no longer candidates (NOT EXISTS), so nothing new is created.
    const run2 = await backfillTenantCommissions(tdb, query, { schema: "public", execute: true });
    expect(run2.candidates).toBe(1); // only D_NO_RATE remains a candidate (still no rate)
    expect(run2.byStatus.created).toBe(0);
    expect(await dscCount(D_HAS_DATE)).toBe(1); // no duplicate
  });

  it("never wrote or modified a contract date (only commission rows)", async () => {
    const { rows } = await pg.query<{ id: string; contract_signed_date: string | null; contract_signed_at: string | null }>(
      `SELECT id, contract_signed_date::text AS contract_signed_date, contract_signed_at::text AS contract_signed_at FROM public.deals ORDER BY id`
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[D_AT_ONLY].contract_signed_date).toBeNull(); // _at-only deal's date column STILL null
    expect(byId[D_HAS_DATE].contract_signed_date).toBe("2026-01-15"); // unchanged
    expect(byId[D_NO_DATE].contract_signed_date).toBeNull(); // unchanged
  });

  it("once the no-rate rep gets a rate, a re-run picks up that deal (the rate-gap path)", async () => {
    await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${R2}', 0.010000, true)`);
    const run = await backfillTenantCommissions(tdb, query, { schema: "public", execute: true });
    expect(run.byStatus.created).toBe(1); // D_NO_RATE now computes
    expect(Number((await pg.query<{ amount: string }>(`SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${D_NO_RATE}'`)).rows[0].amount)).toBe(500); // 50000 × 0.01
  }, 30_000);
});
