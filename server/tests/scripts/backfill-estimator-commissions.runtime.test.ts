// Real-types (PGlite + Drizzle-derived schema) test of the ESTIMATOR commission backfill: candidate
// selection, faithful dry-run (writes nothing), idempotent execute, CO/owner/rateless exclusions, and the
// "additive estimator row, owner row untouched" guarantee.
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
import {
  backfillTenantEstimatorCommissions,
  findEstimatorBackfillCandidates,
  parseArgs,
} from "../../src/scripts/backfill-estimator-commissions.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const O1 = U("0001"); // owner/rep, rate 0.03
const E1 = U("0002"); // estimator, rate 0.02
const E2 = U("0003"); // estimator with NO commission settings → skipped_no_rate
const E3 = U("0004"); // estimator, rate 0.05
const ACTOR = U("0ac7"); // backfill operator (created_by + audit actor)
const WON = U("0500");
const LOST = U("0501");

const D_ESTIM = U("0de1"); // signed, owner O1, estimator E1 (rated), owner row exists, no estimator row → CREATE
const D_AT_ONLY = U("0de2"); // contract_signed_at only, owner O1, estimator E3 (rated) → CREATE
const D_NO_RATE = U("0de3"); // estimator E2 (no rate) → candidate but skipped_no_rate, no row
const D_NO_DATE = U("0de4"); // no contract date → not a candidate
const D_LOST = U("0de5"); // signed but lost stage → not a candidate
const D_HAS_ESTIM_ROW = U("0de6"); // already has the estimator row → not a candidate (idempotency at query level)
const D_ESTIM_IS_OWNER = U("0de7"); // estimator == owner (E1) → not a candidate (would double-pay)
const D_CO_CHILD = U("0de8"); // is_change_order=true with an estimator → not a candidate (no retro CO estimator cut)

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
const query = (sql: string, params?: unknown[]) => pg.query(sql, params as never[]) as Promise<{ rows: Record<string, unknown>[] }>;

async function dscCount(dealId: string): Promise<number> {
  return (await pg.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}'`)).rows.length;
}
async function dscCountForRep(dealId: string, rep: string): Promise<number> {
  return (await pg.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}' AND rep_user_id='${rep}'`)).rows.length;
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
       ('${O1}','Owner One','o1@x.com','rep','${OFFICE}'),
       ('${E1}','Estimator One','e1@x.com','rep','${OFFICE}'),
       ('${E2}','Estimator Two','e2@x.com','rep','${OFFICE}'),
       ('${E3}','Estimator Three','e3@x.com','rep','${OFFICE}')`
  );
  await pg.exec(`INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES
    ('${WON}','Won','won',9), ('${LOST}','Lost','lost',10)`);
  await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES
    ('${O1}', 0.030000, true), ('${E1}', 0.020000, true), ('${E3}', 0.050000, true)`);

  // estimator = the deal's estimator_user_id; rep = assigned_rep_id (owner).
  const ins = (
    id: string,
    stage: string,
    owner: string,
    estimator: string | null,
    date: string | null,
    at: string | null,
    awarded: number,
    isCo = false
  ) =>
    `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, awarded_amount, contract_signed_date, contract_signed_at, is_change_order)
     VALUES ('${id}','${id.slice(-4)}','Deal','${stage}','${owner}', ${estimator ? `'${estimator}'` : "NULL"}, ${awarded}, ${date ? `'${date}'` : "NULL"}, ${at ? `'${at}'` : "NULL"}, ${isCo})`;
  await pg.exec(ins(D_ESTIM, WON, O1, E1, "2026-01-15", null, 100000));
  await pg.exec(ins(D_AT_ONLY, WON, O1, E3, null, "2026-02-01T00:00:00.000Z", 200000));
  await pg.exec(ins(D_NO_RATE, WON, O1, E2, "2026-01-20", null, 50000));
  await pg.exec(ins(D_NO_DATE, WON, O1, E1, null, null, 100000));
  await pg.exec(ins(D_LOST, LOST, O1, E1, "2026-01-12", null, 70000));
  await pg.exec(ins(D_HAS_ESTIM_ROW, WON, O1, E1, "2026-01-10", null, 80000));
  await pg.exec(ins(D_ESTIM_IS_OWNER, WON, E1, E1, "2026-01-18", null, 90000)); // owner == estimator == E1
  await pg.exec(ins(D_CO_CHILD, WON, O1, E1, "2026-01-25", null, 30000, true)); // change order child

  // Owner rows already exist on the candidate + idempotency deals (sign time / owner backfill). The estimator
  // backfill must ADD the estimator row WITHOUT touching these. D_HAS_ESTIM_ROW additionally already carries
  // its estimator (E1) row, and D_ESTIM_IS_OWNER's single row credits E1 as the owner.
  await pg.exec(
    `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
       ('${D_ESTIM}','${O1}','awarded_amount', 100000, 0.030000, 3000, '2026-01-15'),
       ('${D_AT_ONLY}','${O1}','awarded_amount', 200000, 0.030000, 6000, '2026-02-01'),
       ('${D_NO_RATE}','${O1}','awarded_amount', 50000, 0.030000, 1500, '2026-01-20'),
       ('${D_HAS_ESTIM_ROW}','${O1}','awarded_amount', 80000, 0.030000, 2400, '2026-01-10'),
       ('${D_HAS_ESTIM_ROW}','${E1}','awarded_amount', 80000, 0.020000, 1600, '2026-01-10'),
       ('${D_ESTIM_IS_OWNER}','${E1}','awarded_amount', 90000, 0.020000, 1800, '2026-01-18')`
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("estimator commission backfill", () => {
  it("selects only signed, non-lost, dated, non-CO deals with a distinct estimator and no estimator row", async () => {
    const candidates = await findEstimatorBackfillCandidates(query);
    const ids = candidates.map((c) => c.dealId).sort();
    expect(ids).toEqual([D_ESTIM, D_AT_ONLY, D_NO_RATE].sort());
    // Excludes: no-date, lost, the deal that already has its estimator row, estimator==owner (double-pay
    // guard), and a change-order child (no retroactive estimator cut).
    expect(ids).not.toContain(D_NO_DATE);
    expect(ids).not.toContain(D_LOST);
    expect(ids).not.toContain(D_HAS_ESTIM_ROW);
    expect(ids).not.toContain(D_ESTIM_IS_OWNER);
    expect(ids).not.toContain(D_CO_CHILD);
    // The _at-only deal's signed date comes from contract_signed_at::date.
    expect(candidates.find((c) => c.dealId === D_AT_ONLY)?.signedDate).toBe("2026-02-01");
    // The candidate carries the ESTIMATOR, not the owner.
    expect(candidates.find((c) => c.dealId === D_ESTIM)?.estimatorId).toBe(E1);
  });

  it("dry-run (default) is faithful but writes NOTHING", async () => {
    const summary = await backfillTenantEstimatorCommissions(tdb, query, { schema: "public", execute: false, actorUserId: null });
    expect(summary.byStatus.created).toBe(2); // D_ESTIM (E1) + D_AT_ONLY (E3)
    expect(summary.byStatus.skipped_no_rate).toBe(1); // D_NO_RATE (E2 has no rate)
    expect(summary.totalCommissionCreated).toBe(12000); // 100000×0.02 + 200000×0.05
    // Nothing new written: only the seeded OWNER rows remain (no estimator rows added).
    expect(await dscCountForRep(D_ESTIM, E1)).toBe(0);
    expect(await dscCountForRep(D_AT_ONLY, E3)).toBe(0);
    expect(await dscCount(D_ESTIM)).toBe(1); // owner row only
  });

  it("execute (--commit) mints exactly one estimator row each; owner rows untouched; idempotent re-run writes nothing", async () => {
    const run1 = await backfillTenantEstimatorCommissions(tdb, query, { schema: "public", execute: true, actorUserId: ACTOR });
    expect(run1.byStatus.created).toBe(2);

    // Each candidate now has its additive estimator row ON TOP of the untouched owner row.
    expect(await dscCount(D_ESTIM)).toBe(2);
    expect(await dscCountForRep(D_ESTIM, E1)).toBe(1);
    expect(await dscCountForRep(D_ESTIM, O1)).toBe(1);
    expect(await dscCount(D_AT_ONLY)).toBe(2);
    expect(await dscCountForRep(D_AT_ONLY, E3)).toBe(1);

    const estimRow = (await pg.query<{ amount: string; rep_user_id: string; created_by: string }>(
      `SELECT amount, rep_user_id, created_by FROM public.deal_signed_commissions WHERE deal_id='${D_ESTIM}' AND rep_user_id='${E1}'`
    )).rows[0];
    expect(Number(estimRow.amount)).toBe(2000); // 100000 × 0.02 (ESTIMATOR's own rate)
    expect(estimRow.rep_user_id).toBe(E1); // EARNER = the estimator
    expect(estimRow.created_by).toBe(ACTOR); // CREATED_BY = the backfill operator, not the earning estimator

    const atRow = (await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${D_AT_ONLY}' AND rep_user_id='${E3}'`
    )).rows[0];
    expect(Number(atRow.amount)).toBe(10000); // 200000 × 0.05

    // Owner rows are untouched (same amount, original NULL created_by from the seed).
    const ownerRow = (await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${D_ESTIM}' AND rep_user_id='${O1}'`
    )).rows[0];
    expect(Number(ownerRow.amount)).toBe(3000); // 100000 × 0.03, unchanged

    // Re-run: the now-rowed deals drop out of the candidate set (NOT EXISTS estimator row), so nothing new.
    const run2 = await backfillTenantEstimatorCommissions(tdb, query, { schema: "public", execute: true, actorUserId: ACTOR });
    expect(run2.candidates).toBe(1); // only D_NO_RATE remains (still rateless)
    expect(run2.byStatus.created).toBe(0);
    expect(await dscCount(D_ESTIM)).toBe(2); // no duplicate estimator row
  });

  it("never minted a row for a CO child, an estimator==owner deal, or a rateless estimator", async () => {
    // CO child: still has zero commission rows (never seeded, never minted).
    expect(await dscCount(D_CO_CHILD)).toBe(0);
    // estimator==owner: still exactly the single seeded owner-credit row for E1 — no second (estimator) row.
    expect(await dscCount(D_ESTIM_IS_OWNER)).toBe(1);
    // rateless estimator (E2): the deal keeps ONLY its owner row — no estimator row was created.
    expect(await dscCountForRep(D_NO_RATE, E2)).toBe(0);
    expect(await dscCount(D_NO_RATE)).toBe(1); // owner row only
  });

  it("never wrote or modified the estimator_user_id column (only commission rows)", async () => {
    const { rows } = await pg.query<{ id: string; estimator_user_id: string | null }>(
      `SELECT id, estimator_user_id FROM public.deals ORDER BY id`
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[D_ESTIM].estimator_user_id).toBe(E1); // unchanged
    expect(byId[D_AT_ONLY].estimator_user_id).toBe(E3); // unchanged
    expect(byId[D_CO_CHILD].estimator_user_id).toBe(E1); // CO's column untouched (just never minted)
  });

  it("once the rateless estimator gets a rate, a re-run picks up that deal (the rate-gap path)", async () => {
    await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES ('${E2}', 0.010000, true)`);
    const run = await backfillTenantEstimatorCommissions(tdb, query, { schema: "public", execute: true, actorUserId: ACTOR });
    expect(run.byStatus.created).toBe(1); // D_NO_RATE now computes for E2
    expect(await dscCountForRep(D_NO_RATE, E2)).toBe(1);
    expect(Number((await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id='${D_NO_RATE}' AND rep_user_id='${E2}'`
    )).rows[0].amount)).toBe(500); // 50000 × 0.01
  }, 30_000);
});

describe("estimator backfill parseArgs (execution-safety controls)", () => {
  it("rejects the space-separated --tenant form (would silently widen to ALL tenants)", () => {
    expect(() => parseArgs(["--tenant", "office_dallas"])).toThrow(/with '='/);
  });
  it("rejects an empty --tenant= value", () => {
    expect(() => parseArgs(["--tenant="])).toThrow(/requires a value/);
  });
  it("requires --actor for --commit", () => {
    expect(() => parseArgs(["--commit"])).toThrow(/--commit requires --actor/);
  });
  it("rejects a non-UUID --actor", () => {
    expect(() => parseArgs(["--commit", "--actor=not-a-uuid"])).toThrow(/must be a UUID/);
  });
  it("accepts a valid --commit --actor=<uuid> --tenant=office_x", () => {
    const parsed = parseArgs(["--commit", `--actor=${ACTOR}`, "--tenant=office_dallas"]);
    expect(parsed).toEqual({ tenant: "office_dallas", execute: true, actorUserId: ACTOR });
  });
  it("dry-run is the default and needs no actor", () => {
    expect(parseArgs([])).toEqual({ tenant: null, execute: false, actorUserId: null });
  });
});
