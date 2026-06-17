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
  runOne,
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
const D_NO_OWNER = U("0de9"); // estimator E3 set but NO owner row yet → not a candidate (FIX G: owner row required first)

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
  // tenantSchemaSql intentionally omits indexes/constraints, but the tx-safe insert now relies on the
  // (deal_id, rep_user_id) UNIQUE for ON CONFLICT DO NOTHING — recreate it so the conflict path is exercised.
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`
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
  await pg.exec(ins(D_NO_OWNER, WON, O1, E3, "2026-01-22", null, 60000)); // signed + estimator E3, but NO owner row seeded below

  // Owner rows already exist on the candidate + idempotency deals (sign time / owner backfill). The estimator
  // backfill must ADD the estimator row WITHOUT touching these. attribution_role makes the role explicit:
  // owner-credit rows carry 'owner'; D_HAS_ESTIM_ROW additionally already carries its estimator (E1) row with
  // 'estimator' (so the role-scoped NOT EXISTS drops it as already-done); D_ESTIM_IS_OWNER's single row
  // credits E1 as the 'owner'. D_NO_OWNER deliberately has NO row here (tests FIX G owner-row-required).
  await pg.exec(
    `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
       ('${D_ESTIM}','${O1}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-01-15'),
       ('${D_AT_ONLY}','${O1}','owner','awarded_amount', 200000, 0.030000, 6000, '2026-02-01'),
       ('${D_NO_RATE}','${O1}','owner','awarded_amount', 50000, 0.030000, 1500, '2026-01-20'),
       ('${D_HAS_ESTIM_ROW}','${O1}','owner','awarded_amount', 80000, 0.030000, 2400, '2026-01-10'),
       ('${D_HAS_ESTIM_ROW}','${E1}','estimator','awarded_amount', 80000, 0.020000, 1600, '2026-01-10'),
       ('${D_ESTIM_IS_OWNER}','${E1}','owner','awarded_amount', 90000, 0.020000, 1800, '2026-01-18')`
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
    // Excludes: no-date, lost, the deal that already has its estimator-role row, estimator==owner (double-pay
    // guard), a change-order child (no retroactive estimator cut), and a deal with NO owner row yet (FIX G:
    // the additive estimator row must never be the first row on a deal).
    expect(ids).not.toContain(D_NO_DATE);
    expect(ids).not.toContain(D_LOST);
    expect(ids).not.toContain(D_HAS_ESTIM_ROW);
    expect(ids).not.toContain(D_ESTIM_IS_OWNER);
    expect(ids).not.toContain(D_CO_CHILD);
    expect(ids).not.toContain(D_NO_OWNER);
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

// Isolated fixture (its own PGlite) for the two review fixes, so its mutating "flip the deal" steps don't
// perturb the shared-state counts the suite above asserts.
//   FIX G — the additive estimator row may only be minted ON TOP of an existing OWNER row (never the first
//           dsc row on a deal), else the owner backfill (#736, "skip any deal with ANY row") would skip the
//           deal forever and never mint the owner row.
//   FIX H — between the UNLOCKED candidate selection and the per-candidate transaction an admin can
//           change/clear the estimator; runOne re-reads the deal FOR UPDATE and skips a moved estimator so
//           --commit can never pay a PREVIOUS estimator.
describe("estimator backfill owner-row gate (FIX G) + TOCTOU revalidation under lock (FIX H)", () => {
  let pgG: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdbG: any;
  const queryG = (sql: string, params?: unknown[]) =>
    pgG.query(sql, params as never[]) as Promise<{ rows: Record<string, unknown>[] }>;
  const rowsForRep = async (dealId: string, rep: string) =>
    (await pgG.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}' AND rep_user_id='${rep}'`)).rows.length;

  const GO = U("0a01"); // owner, rate 0.03
  const GE1 = U("0a02"); // the candidate's estimator, rate 0.02
  const GE2 = U("0a03"); // a DIFFERENT estimator an admin switches to mid-run, rate 0.04
  const GACTOR = U("0aac");
  const GWON = U("0a50");
  const GOFFICE = U("0af1");

  const DG_NOOWNER = U("0ad1"); // estimator set, NO owner row → excluded by FIX G until an owner row appears
  const DG_OWNED = U("0ad2"); // owner row present, estimator unchanged → mints (FIX H positive control)
  const DG_CHANGED = U("0ad3"); // owner row present; estimator switched after selection → skipped (FIX H)

  beforeAll(async () => {
    pgG = new PGlite();
    await pgG.exec(
      tenantSchemaSql("public", [users, pipelineStageConfig, deals, userCommissionSettings, dealSignedCommissions, auditLog])
    );
    // ON CONFLICT (deal_id, rep_user_id) DO NOTHING needs the UNIQUE that tenantSchemaSql omits — recreate it.
    await pgG.exec(
      `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`
    );
    tdbG = drizzle(pgG);
    await pgG.exec(
      `INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
         ('${GO}','G Owner','go@x.com','rep','${GOFFICE}'),
         ('${GE1}','G Estimator One','ge1@x.com','rep','${GOFFICE}'),
         ('${GE2}','G Estimator Two','ge2@x.com','rep','${GOFFICE}')`
    );
    await pgG.exec(`INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES ('${GWON}','Won','won',9)`);
    await pgG.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES
      ('${GO}', 0.030000, true), ('${GE1}', 0.020000, true), ('${GE2}', 0.040000, true)`);
    const insG = (id: string, owner: string, estimator: string, awarded: number) =>
      `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, awarded_amount, contract_signed_date, contract_signed_at, is_change_order)
       VALUES ('${id}','${id.slice(-4)}','Deal','${GWON}','${owner}','${estimator}', ${awarded}, '2026-03-01', NULL, false)`;
    await pgG.exec(insG(DG_NOOWNER, GO, GE1, 100000));
    await pgG.exec(insG(DG_OWNED, GO, GE1, 100000));
    await pgG.exec(insG(DG_CHANGED, GO, GE1, 100000));
    // OWNER rows for the two candidates; DG_NOOWNER deliberately gets none (FIX G fixture).
    await pgG.exec(
      `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
         ('${DG_OWNED}','${GO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-03-01'),
         ('${DG_CHANGED}','${GO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-03-01')`
    );
  }, 30_000);

  afterAll(async () => {
    await pgG?.close();
  });

  it("FIX G: a deal with no owner row is NOT a candidate; minting the owner row flips it to one", async () => {
    let ids = (await findEstimatorBackfillCandidates(queryG)).map((c) => c.dealId);
    expect(ids).toContain(DG_OWNED);
    expect(ids).toContain(DG_CHANGED);
    expect(ids).not.toContain(DG_NOOWNER); // no owner row yet ⇒ excluded

    // Once the owner backfill (#736) has minted the owner row, the deal becomes eligible for the estimator row.
    await pgG.exec(
      `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
         ('${DG_NOOWNER}','${GO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-03-01')`
    );
    ids = (await findEstimatorBackfillCandidates(queryG)).map((c) => c.dealId);
    expect(ids).toContain(DG_NOOWNER);
  });

  it("FIX H: an estimator changed after selection is skipped under lock; no row minted for the PREVIOUS estimator", async () => {
    const stale = (await findEstimatorBackfillCandidates(queryG)).find((c) => c.dealId === DG_CHANGED);
    expect(stale?.estimatorId).toBe(GE1); // selected for the ORIGINAL estimator

    // An admin reassigns the estimator AFTER selection, BEFORE the per-candidate run.
    await pgG.exec(`UPDATE public.deals SET estimator_user_id='${GE2}' WHERE id='${DG_CHANGED}'`);

    const result = await runOne(tdbG, stale!, GACTOR, true);
    expect(result.status).toBe("skipped_no_longer_eligible"); // full re-validation under lock catches the moved estimator
    expect(await rowsForRep(DG_CHANGED, GE1)).toBe(0); // PREVIOUS estimator never paid
    expect(await rowsForRep(DG_CHANGED, GE2)).toBe(0); // nor the new one (we never targeted it)
    expect(await rowsForRep(DG_CHANGED, GO)).toBe(1); // owner row untouched
  });

  it("FIX H: an unchanged estimator still mints (positive control)", async () => {
    const candidate = (await findEstimatorBackfillCandidates(queryG)).find((c) => c.dealId === DG_OWNED);
    const result = await runOne(tdbG, candidate!, GACTOR, true);
    expect(result.status).toBe("created");
    expect(Number(result.amount)).toBe(2000); // 100000 × 0.02 (estimator GE1 rate)
    expect(await rowsForRep(DG_OWNED, GE1)).toBe(1);
    expect(await rowsForRep(DG_OWNED, GO)).toBe(1); // owner row still intact
  });

  it("FIX H: a faithful dry-run still revalidates but writes nothing", async () => {
    // DG_NOOWNER now has an owner row (from the FIX G test) + a current rated estimator → it WOULD mint, but
    // a dry-run must persist nothing.
    const candidate = (await findEstimatorBackfillCandidates(queryG)).find((c) => c.dealId === DG_NOOWNER);
    const result = await runOne(tdbG, candidate!, GACTOR, false);
    expect(result.status).toBe("created"); // faithful: reports the would-be outcome
    expect(await rowsForRep(DG_NOOWNER, GE1)).toBe(0); // but nothing written
  });
});

// Isolated fixture (own PGlite) for the two Codex findings on the backfill:
//   FINDING 2 (owner-row invariant — same as PR #742): the candidate OWNER-ROW gate keys on the booked
//     attribution_role='owner' ROW, NOT rep_user_id = assigned_rep_id. After an owner reassignment the booked
//     owner row stays on the ORIGINAL rep while assigned_rep_id moves; a valid deal must STILL be selected
//     (and the #736 owner backfill won't re-mint it). The old assigned_rep_id proxy would wrongly drop it.
//   FINDING 1 (revalidate the FULL excluded set under lock): runOne re-runs the ENTIRE candidate predicate
//     FOR UPDATE, so a deal that goes lost / is_active=false / is_test_data=true between the unlocked bulk
//     SELECT and the per-candidate run is skipped_no_longer_eligible and never minted — the old re-read only
//     rechecked estimator/CO/signed-date and would have minted these.
describe("estimator backfill — owner-role-row gate (Finding 2) + full revalidation under lock (Finding 1)", () => {
  let pgF: PGlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tdbF: any;
  const queryF = (sql: string, params?: unknown[]) =>
    pgF.query(sql, params as never[]) as Promise<{ rows: Record<string, unknown>[] }>;
  const rowsForRep = async (dealId: string, rep: string) =>
    (await pgF.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}' AND rep_user_id='${rep}'`)).rows.length;

  const FO = U("0b01"); // ORIGINAL owner (booked on the owner row), rate 0.03
  const FNEW = U("0b02"); // the NEW current assignee after an owner reassignment, rate 0.03
  const FEST = U("0b03"); // estimator, rate 0.02
  const FACTOR = U("0bac");
  const FWON = U("0b50");
  const FLOST = U("0b51");
  const FOFFICE = U("0bf1");

  const DF_REASSIGNED = U("0bd1"); // owner row booked on FO; assigned_rep_id since changed to FNEW (Finding 2)
  const DF_GO_LOST = U("0bd2"); // candidate, then stage→lost before runOne (Finding 1)
  const DF_GO_INACTIVE = U("0bd3"); // candidate, then is_active=false before runOne (Finding 1)
  const DF_GO_TEST = U("0bd4"); // candidate, then is_test_data=true before runOne (Finding 1)

  beforeAll(async () => {
    pgF = new PGlite();
    await pgF.exec(
      tenantSchemaSql("public", [users, pipelineStageConfig, deals, userCommissionSettings, dealSignedCommissions, auditLog])
    );
    await pgF.exec(
      `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`
    );
    tdbF = drizzle(pgF);
    await pgF.exec(
      `INSERT INTO public.users (id, display_name, email, role, office_id) VALUES
         ('${FO}','F Owner','fo@x.com','rep','${FOFFICE}'),
         ('${FNEW}','F New Owner','fn@x.com','rep','${FOFFICE}'),
         ('${FEST}','F Estimator','fe@x.com','rep','${FOFFICE}')`
    );
    await pgF.exec(`INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES
      ('${FWON}','Won','won',9), ('${FLOST}','Lost','lost',10)`);
    await pgF.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES
      ('${FO}', 0.030000, true), ('${FNEW}', 0.030000, true), ('${FEST}', 0.020000, true)`);
    const insF = (id: string, owner: string, estimator: string, awarded: number) =>
      `INSERT INTO public.deals (id, deal_number, name, stage_id, assigned_rep_id, estimator_user_id, awarded_amount, contract_signed_date, contract_signed_at, is_change_order)
       VALUES ('${id}','${id.slice(-4)}','Deal','${FWON}','${owner}','${estimator}', ${awarded}, '2026-04-01', NULL, false)`;
    // DF_REASSIGNED: CURRENT assignee is FNEW, but the booked owner row (below) stays on the ORIGINAL owner FO.
    await pgF.exec(insF(DF_REASSIGNED, FNEW, FEST, 100000));
    await pgF.exec(insF(DF_GO_LOST, FO, FEST, 100000));
    await pgF.exec(insF(DF_GO_INACTIVE, FO, FEST, 100000));
    await pgF.exec(insF(DF_GO_TEST, FO, FEST, 100000));
    // Owner-role rows. DF_REASSIGNED's owner row is on FO (the ORIGINAL owner), NOT the current assignee FNEW —
    // exactly the post-reassignment shape the old rep_user_id = assigned_rep_id gate would wrongly exclude.
    await pgF.exec(
      `INSERT INTO public.deal_signed_commissions (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
         ('${DF_REASSIGNED}','${FO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-04-01'),
         ('${DF_GO_LOST}','${FO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-04-01'),
         ('${DF_GO_INACTIVE}','${FO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-04-01'),
         ('${DF_GO_TEST}','${FO}','owner','awarded_amount', 100000, 0.030000, 3000, '2026-04-01')`
    );
  }, 30_000);

  afterAll(async () => {
    await pgF?.close();
  });

  it("Finding 2: a deal whose owner row is booked on the ORIGINAL rep (assigned_rep_id since reassigned) is STILL selected and mints the estimator row", async () => {
    // The OLD gate (EXISTS owner row WHERE rep_user_id = d.assigned_rep_id) would EXCLUDE this deal: the
    // booked owner row sits on FO but the current assigned_rep_id is FNEW. Prove the old proxy drops it...
    const oldStyle = await pgF.query(
      `SELECT 1 FROM public.deals d WHERE d.id='${DF_REASSIGNED}' AND EXISTS (
         SELECT 1 FROM public.deal_signed_commissions o WHERE o.deal_id=d.id AND o.rep_user_id=d.assigned_rep_id)`
    );
    expect(oldStyle.rows.length).toBe(0); // old assigned_rep_id gate would NOT have selected it

    // ...but the new role-keyed gate (EXISTS attribution_role='owner') DOES select it.
    const candidate = (await findEstimatorBackfillCandidates(queryF)).find((c) => c.dealId === DF_REASSIGNED);
    expect(candidate?.estimatorId).toBe(FEST);

    const result = await runOne(tdbF, candidate!, FACTOR, true);
    expect(result.status).toBe("created");
    expect(Number(result.amount)).toBe(2000); // 100000 × 0.02 (estimator FEST's own rate)
    expect(await rowsForRep(DF_REASSIGNED, FEST)).toBe(1); // estimator row minted
    expect(await rowsForRep(DF_REASSIGNED, FO)).toBe(1); // ORIGINAL owner row untouched
    expect(await rowsForRep(DF_REASSIGNED, FNEW)).toBe(0); // current assignee books no row (it's not the estimator)
  });

  it("Finding 1: a candidate that goes LOST between selection and the locked run is skipped_no_longer_eligible (no row minted)", async () => {
    const candidate = (await findEstimatorBackfillCandidates(queryF)).find((c) => c.dealId === DF_GO_LOST);
    expect(candidate).toBeTruthy(); // eligible at selection time
    await pgF.exec(`UPDATE public.deals SET stage_id='${FLOST}' WHERE id='${DF_GO_LOST}'`); // moved to lost AFTER selection
    const result = await runOne(tdbF, candidate!, FACTOR, true);
    expect(result.status).toBe("skipped_no_longer_eligible");
    expect(await rowsForRep(DF_GO_LOST, FEST)).toBe(0); // nothing minted
    expect(await rowsForRep(DF_GO_LOST, FO)).toBe(1); // owner row untouched
  });

  it("Finding 1: a candidate that goes is_active=false between selection and the locked run is skipped (no row minted)", async () => {
    const candidate = (await findEstimatorBackfillCandidates(queryF)).find((c) => c.dealId === DF_GO_INACTIVE);
    expect(candidate).toBeTruthy();
    await pgF.exec(`UPDATE public.deals SET is_active=false WHERE id='${DF_GO_INACTIVE}'`); // archived AFTER selection
    const result = await runOne(tdbF, candidate!, FACTOR, true);
    expect(result.status).toBe("skipped_no_longer_eligible");
    expect(await rowsForRep(DF_GO_INACTIVE, FEST)).toBe(0);
  });

  it("Finding 1: a candidate that becomes is_test_data=true between selection and the locked run is skipped (no row minted)", async () => {
    const candidate = (await findEstimatorBackfillCandidates(queryF)).find((c) => c.dealId === DF_GO_TEST);
    expect(candidate).toBeTruthy();
    await pgF.exec(`UPDATE public.deals SET is_test_data=true WHERE id='${DF_GO_TEST}'`); // flagged test AFTER selection
    const result = await runOne(tdbF, candidate!, FACTOR, true);
    expect(result.status).toBe("skipped_no_longer_eligible");
    expect(await rowsForRep(DF_GO_TEST, FEST)).toBe(0);
  });
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
