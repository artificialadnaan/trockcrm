/**
 * One-time backfill of the ADDITIVE estimator deal_signed_commissions row for already-signed deals.
 *
 * WHY: estimator-aware earned commission (PR #742) mints an additive estimator row at SIGN TIME (and on
 * the manual estimator-edit path). Deals that were signed BEFORE that shipped — or whose estimator was set
 * after signing — never ran that mint, so the estimator carries no commission row and earns $0 for work
 * they did. This re-runs the EXISTING, idempotent mintEstimatorCommissionForDeal for every active, non-lost,
 * non-test, non-change-order signed deal whose estimator is set, distinct from the owner, and has no
 * estimator commission row yet.
 *
 * RELATIONSHIP TO THE OWNER BACKFILL (backfill-missing-commissions.ts / PR #736): that one mints the OWNER
 * row (deal_signed_commissions.rep_user_id = assigned_rep_id) and skips any deal that already has ANY row.
 * This one mints the ESTIMATOR row (rep_user_id = estimator_user_id), which is ADDITIVE — it sits ON TOP of
 * the owner row, never a split. So its NOT EXISTS is scoped to the ESTIMATOR's own row, not "any row": a
 * deal will already carry an owner row (from sign time or the owner backfill) yet still need its estimator
 * row. RUN THIS LAST — after #742 deploys AND after the owner backfill (#736) has run.
 *
 * GUARANTEES:
 *   • Only writes deal_signed_commissions rows — it NEVER writes or modifies the estimator_user_id COLUMN
 *     (that column is owned by the empties-only sync + the manual estimator picker) nor any contract date.
 *     mintEstimatorCommissionForDeal only inserts a commission row; no deals UPDATE.
 *   • Idempotent — insertCommissionRowForRep does ON CONFLICT (deal_id, rep_user_id) DO NOTHING, and the
 *     query's role-scoped NOT EXISTS already drops a deal once its estimator-role row exists, so re-running
 *     writes nothing new. Safe to run again after configuring missing estimator rates.
 *   • Owner-row-first — a deal is only a candidate once its OWNER row exists (EXISTS rep = assigned_rep_id):
 *     the estimator row is ADDITIVE and must never be the first row on a deal (else the owner backfill #736,
 *     which skips any deal carrying a row, would never mint the owner row). Run AFTER #736.
 *   • Revalidated-under-lock — the candidate set is read WITHOUT a row lock, so before minting runOne
 *     re-runs the FULL candidate-eligibility predicate against the deal FOR UPDATE and skips
 *     (skipped_no_longer_eligible) if ANYTHING changed since selection: estimator changed/cleared, deal went
 *     lost/canceled, is_active flipped false, is_test_data flipped true, it became a CO, lost its signed
 *     date or its owner row, or already got its estimator row. The check uses the SAME predicate as the bulk
 *     SELECT (factored into one constant) so the two can't drift and let a mint slip through that the
 *     candidate query intentionally excludes.
 *   • Change-order children are excluded IN THE QUERY (is_change_order = false), not merely by the mint
 *     guard — a CO is base-deal-only and never earns its own estimator cut. (Defence in depth: the mint also
 *     returns skipped_change_order.)
 *   • estimator == owner is excluded in the query too (estimator_user_id <> assigned_rep_id): the owner row
 *     already credits that user their full cut, so an estimator row would double-pay them.
 *   • Per-office — fans out over every office_* schema (or a single --tenant=office_x).
 *   • The commission EARNER (deal_signed_commissions.rep_user_id) is the deal's estimator. The backfill
 *     OPERATOR (--actor) is stamped as created_by + audit changed_by, so the trail truthfully records who
 *     created these historical rows.
 *
 * USAGE (dry-run is the DEFAULT — nothing is written without --commit):
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-commissions.ts                       # dry-run, all offices
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-commissions.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-commissions.ts --commit --actor=<uuid>   # WRITE
 *
 * --commit REQUIRES --actor=<uuid> (the operator/system user stamped as created_by + audit changed_by).
 * --tenant=/--actor= must use the '=' form (the space-separated form is rejected to avoid silently
 * widening the blast radius).
 *
 * Dry-run is FAITHFUL: it runs the real mintEstimatorCommissionForDeal inside a transaction and rolls it
 * back, so the reported status/amount is exactly what --commit would write.
 */
import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { LOST_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  mintEstimatorCommissionForDeal,
  type CalculateCommissionStatus,
} from "../modules/commissions/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");

// The backfill carries ONE status the shared commission union doesn't: a revalidation-under-lock outcome.
// The candidate set is read WITHOUT a row lock, so between the bulk SELECT and the per-candidate transaction
// the deal can fall out of the eligible set (estimator changed/cleared, went lost/canceled, is_active flipped
// false, is_test_data flipped true, became a change order, lost its signed date or owner row, or already got
// its estimator row). runOne re-runs the FULL candidate predicate against the deal FOR UPDATE and, if ANY of
// those no longer hold, skips it as `skipped_no_longer_eligible` instead of minting a row the candidate query
// intentionally excludes. It's a backfill-local concurrency outcome, not a commission-calc result, so it's
// modeled here rather than in CalculateCommissionStatus.
export type EstimatorBackfillStatus = CalculateCommissionStatus | "skipped_no_longer_eligible";

export interface EstimatorBackfillCandidate {
  dealId: string;
  dealNumber: string | null;
  estimatorId: string;
  estimatorName: string | null;
  signedDate: string;
}

export interface EstimatorBackfillSummary {
  schema: string;
  executed: boolean;
  candidates: number;
  byStatus: Record<EstimatorBackfillStatus, number>;
  totalCommissionCreated: number;
  rows: Array<EstimatorBackfillCandidate & { status: EstimatorBackfillStatus; amount: string | null }>;
}

// The CANONICAL lost-stage set (includes deal_canceled) — sourced from the shared constant so the backfill
// can't drift from how the rest of the app classifies lost deals. Mirrors the owner backfill: a deal that
// ended up lost/canceled did not earn an owner row, so it must not earn an additive estimator row either.
// Trusted compile-time constants, safe to interpolate.
const LOST_STAGE_SLUGS = `(${LOST_DEAL_STAGE_SLUGS.map((s) => `'${s}'`).join(",")})`;

// Office schemas only — validated before interpolating into SET search_path (--tenant is user input).
const OFFICE_SCHEMA_RE = /^office_[a-z0-9_]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE single candidate-eligibility predicate, factored out so the unlocked bulk SELECT and the per-candidate
 * locked re-check (runOne) use the EXACT same conditions and can never drift. References aliases `d` (deals)
 * and `psc` (pipeline_stage_config). Contains ONLY compile-time constants (LOST_STAGE_SLUGS, role literals) —
 * no user input — so it is safe to interpolate raw.
 *
 * A deal is a candidate iff it is:
 *   • signed              — contract_signed_at OR contract_signed_date is set (an unsigned deal earns nothing).
 *   • not lost/canceled   — psc.slug NOT IN the canonical LOST_DEAL_STAGE_SLUGS (incl. deal_canceled): a deal
 *                           that ended lost did not earn an owner row, so no additive estimator row either.
 *   • not test data       — COALESCE(is_test_data,false)=false (test deals are excluded everywhere).
 *   • active              — is_active=true (archived/soft-deleted deals don't earn).
 *   • estimator set       — estimator_user_id IS NOT NULL.
 *   • estimator <> owner  — estimator_user_id <> assigned_rep_id (a NULL owner makes the comparison NULL ⇒
 *                           excluded, intentionally — no owner ⇒ no owner row ⇒ no standalone estimator row).
 *   • not a change order  — COALESCE(is_change_order,false)=false: a CO is base-deal-only and never earns its
 *                           own estimator cut. Excluded IN THE QUERY, not merely by the mint guard.
 *   • OWNER ROW EXISTS    — an attribution_role='owner' dsc row is already booked on the deal. Keyed on the
 *                           ROLE, NOT rep_user_id = assigned_rep_id: after an owner reassignment the booked
 *                           owner row stays on the ORIGINAL rep while assigned_rep_id moves, so an
 *                           assigned_rep_id proxy would wrongly drop a deal that has a valid owner row but a
 *                           changed current-owner (and the #736 owner backfill won't re-mint it either). The
 *                           additive estimator row must sit ON TOP of an owner row, never be the FIRST dsc row
 *                           on a deal (else the owner backfill, which skips any deal with ANY row, would never
 *                           mint the owner row). This both prevents that and enforces ordering: owner backfill
 *                           first, then this one. (Owner-row invariant — same fix as PR #742.)
 *   • NO estimator row yet— NOT EXISTS a dsc row for this estimator with attribution_role='estimator'. Scoped
 *                           to the estimator's ROLE so a user who was formerly the OWNER (carrying an 'owner'
 *                           row) does not falsely block their own missing additive estimator row.
 */
const CANDIDATE_ELIGIBILITY_SQL = `
  (d.contract_signed_at IS NOT NULL OR d.contract_signed_date IS NOT NULL)
  AND psc.slug NOT IN ${LOST_STAGE_SLUGS}
  AND COALESCE(d.is_test_data, false) = false
  AND d.is_active = true
  AND d.estimator_user_id IS NOT NULL
  AND d.estimator_user_id <> d.assigned_rep_id
  AND COALESCE(d.is_change_order, false) = false
  AND EXISTS (
    SELECT 1 FROM deal_signed_commissions o
    WHERE o.deal_id = d.id AND o.attribution_role = 'owner'
  )
  AND NOT EXISTS (
    SELECT 1 FROM deal_signed_commissions dsc
    WHERE dsc.deal_id = d.id AND dsc.rep_user_id = d.estimator_user_id
      AND dsc.attribution_role = 'estimator'
  )
`;

/**
 * Active, non-lost (canonical slugs, incl. deal_canceled), non-test, non-change-order signed deals whose
 * estimator is set, DISTINCT from the owner, an OWNER-role row already exists, and there is NO estimator-role
 * commission row yet. The full predicate (and the why behind each term) lives in CANDIDATE_ELIGIBILITY_SQL,
 * which runOne reuses verbatim for its locked re-check so the two can't drift.
 */
export async function findEstimatorBackfillCandidates(query: QueryFn): Promise<EstimatorBackfillCandidate[]> {
  const { rows } = await query(`
    SELECT d.id AS deal_id, d.deal_number, d.estimator_user_id AS estimator_id, u.display_name AS estimator_name,
           -- _at-first (canonical precedence, matching contractSignedDateForReporting / effectiveSignedDateOf);
           -- the UTC cast is tz-stable since the app stores contract_signed_at at UTC midnight.
           COALESCE((d.contract_signed_at AT TIME ZONE 'UTC')::date, d.contract_signed_date)::text AS signed_date
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN public.users u ON u.id = d.estimator_user_id
    WHERE ${CANDIDATE_ELIGIBILITY_SQL}
    ORDER BY d.deal_number
  `);
  return rows.map((r) => ({
    dealId: String(r.deal_id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    estimatorId: String(r.estimator_id),
    estimatorName: r.estimator_name == null ? null : String(r.estimator_name),
    signedDate: String(r.signed_date),
  }));
}

/**
 * Run (dry-run rolls back; execute commits) mintEstimatorCommissionForDeal for one candidate, with a full
 * revalidation-under-lock guard: the candidate set was read WITHOUT a row lock, so before minting we re-run
 * the ENTIRE candidate-eligibility predicate (CANDIDATE_ELIGIBILITY_SQL — the same one the bulk SELECT used)
 * against the deal FOR UPDATE, keyed to this deal id AND the specific estimator the candidate was selected
 * for. If the deal has since fallen out of the eligible set in ANY way (estimator changed/cleared, went
 * lost/canceled, is_active flipped false, is_test_data flipped true, became a CO, lost its signed date or its
 * owner row, or already got its estimator row) the re-check returns no row and we bail
 * (skipped_no_longer_eligible) instead of minting a commission the candidate query intentionally excludes.
 * The re-check + mint share ONE transaction and FOR UPDATE OF d holds the deals row across check-and-insert,
 * so no concurrent change can slip between them.
 */
export async function runOne(
  tenantDb: TenantDb,
  candidate: EstimatorBackfillCandidate,
  actorUserId: string | null,
  execute: boolean
): Promise<{ status: EstimatorBackfillStatus; amount: string | null }> {
  const input = {
    dealId: candidate.dealId,
    estimatorUserId: candidate.estimatorId,
    // The commission EARNER (dsc.rep_user_id) is the estimator, set by mintEstimatorCommissionForDeal.
    // triggeredByUserId only stamps created_by + the audit changed_by — for a WRITE it must be the BACKFILL
    // OPERATOR (--actor, enforced upstream), NOT the earning estimator, so the trail truthfully records who
    // created these historical rows. On a DRY-RUN (rolled back, never persisted) we fall back to the
    // estimator, who is a real user — so the throwaway INSERT doesn't trip the created_by FK.
    triggeredByUserId: actorUserId ?? candidate.estimatorId,
  };

  // Re-validate the FULL eligibility under lock, then mint — all inside ONE transaction.
  const revalidateThenMint = async (
    tx: TenantDb
  ): Promise<{ status: EstimatorBackfillStatus; amount: string | null }> => {
    // Re-run the EXACT candidate predicate the bulk SELECT used (CANDIDATE_ELIGIBILITY_SQL), now keyed to
    // THIS deal and the SPECIFIC estimator the candidate was selected for, and locking the deals row with
    // FOR UPDATE OF d so a concurrent change can't slip between the check and the insert. The deal id and
    // estimator id are parameterized; the predicate is constant SQL (no user input). If nothing matches, the
    // deal has fallen out of the eligible set since selection (estimator changed/cleared, lost/canceled,
    // is_active=false, is_test_data=true, became a CO, lost its signed date or owner row, or already minted).
    const recheck = await tx.execute(sql`
      SELECT 1
      FROM deals d
      JOIN pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.id = ${candidate.dealId}
        AND d.estimator_user_id = ${candidate.estimatorId}
        AND ${sql.raw(CANDIDATE_ELIGIBILITY_SQL)}
      FOR UPDATE OF d
    `);
    // Driver-agnostic row access (node-postgres QueryResult vs drizzle/pglite Results), matching the house
    // pattern used across the commissions reporting service.
    const recheckRows = ((recheck as { rows?: unknown[] }).rows ?? recheck) as unknown[];
    const stillEligible = Array.isArray(recheckRows) && recheckRows.length > 0;
    if (!stillEligible) {
      return { status: "skipped_no_longer_eligible", amount: null };
    }
    const result = await mintEstimatorCommissionForDeal(tx, input);
    return { status: result.status, amount: result.amount ?? null };
  };

  if (execute) {
    return tenantDb.transaction((tx) => revalidateThenMint(tx));
  }
  // Faithful dry-run: run the real revalidate + mint, capture the would-be result, then roll back.
  let captured: { status: EstimatorBackfillStatus; amount: string | null } = {
    status: "skipped_no_value",
    amount: null,
  };
  try {
    await tenantDb.transaction(async (tx) => {
      captured = await revalidateThenMint(tx);
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return captured;
}

export async function backfillTenantEstimatorCommissions(
  tenantDb: TenantDb,
  query: QueryFn,
  opts: { schema: string; execute: boolean; actorUserId: string | null }
): Promise<EstimatorBackfillSummary> {
  const candidates = await findEstimatorBackfillCandidates(query);
  const byStatus: Record<EstimatorBackfillStatus, number> = {
    created: 0,
    skipped_existing: 0,
    skipped_no_rep: 0,
    skipped_no_value: 0,
    skipped_no_rate: 0,
    // The query already excludes change orders, so the mint should never return this on a candidate — but
    // the shared status union carries it, so the counter must too (defence in depth).
    skipped_change_order: 0,
    // Revalidation-under-lock: the deal fell out of the FULL eligible set (estimator changed/cleared,
    // lost/canceled, is_active=false, is_test_data=true, became a CO, lost its signed date or owner row, or
    // already minted) between the unlocked candidate selection and the locked per-candidate re-check — no
    // row minted (see runOne / CANDIDATE_ELIGIBILITY_SQL).
    skipped_no_longer_eligible: 0,
  };
  let totalCommissionCreated = 0;
  const rows: EstimatorBackfillSummary["rows"] = [];

  for (const candidate of candidates) {
    const result = await runOne(tenantDb, candidate, opts.actorUserId, opts.execute);
    byStatus[result.status] += 1;
    if (result.status === "created" && result.amount) {
      totalCommissionCreated += Number(result.amount);
    }
    rows.push({ ...candidate, status: result.status, amount: result.amount });
  }

  return {
    schema: opts.schema,
    executed: opts.execute,
    candidates: candidates.length,
    byStatus,
    totalCommissionCreated: Number(totalCommissionCreated.toFixed(2)),
    rows,
  };
}

export function parseArgs(argv: string[]): { tenant: string | null; execute: boolean; actorUserId: string | null } {
  // --tenant / --actor are execution-safety controls. Reject the space-separated form (--tenant office_x)
  // and empty values — silently ignoring them would widen the blast radius (fall back to ALL tenants) or
  // drop the audit actor. Only the --key=value form is accepted.
  for (const key of ["--tenant", "--actor"]) {
    if (argv.includes(key)) {
      throw new Error(`Use ${key}=<value> (with '='); the space-separated form is rejected.`);
    }
  }
  const readValue = (key: string): string | null => {
    const arg = argv.find((a) => a.startsWith(`${key}=`));
    if (!arg) return null;
    const value = arg.slice(key.length + 1);
    if (!value) throw new Error(`${key}= requires a value.`);
    return value;
  };
  const tenant = readValue("--tenant");
  // The write flag is --commit (dry-run is the default). A WRITE must record a real operator/system actor
  // in created_by + the audit trail — never default it.
  const execute = argv.includes("--commit");
  const actor = readValue("--actor");
  if (execute && !actor) {
    throw new Error("--commit requires --actor=<uuid> (the operator/system user recorded as created_by + audit changed_by).");
  }
  if (actor && !UUID_RE.test(actor)) {
    throw new Error(`--actor must be a UUID, got ${JSON.stringify(actor)}.`);
  }
  return {
    tenant: tenant && tenant !== "all" ? tenant : null,
    execute,
    // null on a dry-run without --actor → runOne falls back to the deal's estimator (a real user, so the
    // rolled-back INSERT doesn't FK-fail). --commit always carries a real --actor (enforced above).
    actorUserId: actor,
  };
}

async function discoverTenants(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
  );
  return rows.map((r) => r.nspname);
}

function printSummary(s: EstimatorBackfillSummary): void {
  const mode = s.executed ? "WRITE" : "DRY-RUN";
  console.log(`\n[${s.schema}] ${mode} — ${s.candidates} candidate(s)`);
  for (const row of s.rows) {
    const tag = row.status === "created" ? `$${Number(row.amount ?? 0).toLocaleString()}` : row.status;
    console.log(`  ${(row.dealNumber ?? "(none)").padEnd(16)} ${(row.estimatorName ?? row.estimatorId).padEnd(20)} ${row.signedDate}  -> ${tag}`);
  }
  console.log(
    `  totals: created=${s.byStatus.created} ($${s.totalCommissionCreated.toLocaleString()}), ` +
      `skipped_existing=${s.byStatus.skipped_existing}, no_rate=${s.byStatus.skipped_no_rate}, ` +
      `no_value=${s.byStatus.skipped_no_value}, change_order=${s.byStatus.skipped_change_order}, ` +
      `no_longer_eligible=${s.byStatus.skipped_no_longer_eligible}`
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { tenant, execute, actorUserId } = parseArgs(argv);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const tenants = tenant ? [tenant] : await discoverTenants(client);
    // Guard the search_path interpolation: every tenant (especially a user-supplied --tenant=) must be a
    // valid office_* schema identifier — no quotes/semicolons/spaces — so it cannot be a SQL-injection vector.
    for (const t of tenants) {
      if (!OFFICE_SCHEMA_RE.test(t)) {
        throw new Error(`Refusing unsafe tenant schema name: ${JSON.stringify(t)} (expected /^office_[a-z0-9_]+$/)`);
      }
    }
    console.log(`${execute ? "WRITE" : "DRY-RUN (no writes)"} — tenants: ${tenants.join(", ")}`);
    let grandCreated = 0;
    let grandAmount = 0;
    for (const t of tenants) {
      await client.query(`SET search_path TO ${t}, public`);
      const tenantDb = drizzle(client, { schema });
      const summary = await backfillTenantEstimatorCommissions(tenantDb, (text, params) => client.query(text, params as never), {
        schema: t,
        execute,
        actorUserId,
      });
      printSummary(summary);
      grandCreated += summary.byStatus.created;
      grandAmount += summary.totalCommissionCreated;
    }
    console.log(
      `\n=== GRAND TOTAL ${execute ? "WRITTEN" : "(dry-run) WOULD WRITE"}: ${grandCreated} estimator commission rows, $${grandAmount.toLocaleString()} ===`
    );
    console.log("(No estimator_user_id columns or contract dates were modified: this script only inserts commission rows.)");
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
