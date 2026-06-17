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
 *   • Idempotent — mintEstimatorCommissionForDeal does a SELECT-before-INSERT on (deal_id, estimator_user_id)
 *     and the query's NOT EXISTS already drops a deal once its estimator row exists, so re-running writes
 *     nothing new. Safe to run again after configuring missing estimator rates.
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
import * as schema from "@trock-crm/shared/schema";
import { LOST_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  mintEstimatorCommissionForDeal,
  type CalculateCommissionResult,
  type CalculateCommissionStatus,
} from "../modules/commissions/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");

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
  byStatus: Record<CalculateCommissionStatus, number>;
  totalCommissionCreated: number;
  rows: Array<EstimatorBackfillCandidate & { status: CalculateCommissionStatus; amount: string | null }>;
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
 * Active, non-lost (canonical slugs, incl. deal_canceled), non-test, non-change-order signed deals whose
 * estimator is set, DISTINCT from the owner, and has NO estimator commission row yet.
 *
 * Notes on the predicate:
 *   • estimator_user_id <> assigned_rep_id uses SQL three-valued logic: a NULL assigned_rep_id makes the
 *     comparison NULL ⇒ the row is excluded. That is intentional — a deal with no owner has no owner row,
 *     so it should not get a standalone estimator row either.
 *   • NOT EXISTS is scoped to the ESTIMATOR's own row (rep_user_id = estimator_user_id), NOT "any row":
 *     the deal already carries an owner row, and the additive estimator row is what's missing.
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
    WHERE (d.contract_signed_at IS NOT NULL OR d.contract_signed_date IS NOT NULL)
      AND psc.slug NOT IN ${LOST_STAGE_SLUGS}
      AND COALESCE(d.is_test_data, false) = false
      AND d.is_active = true
      AND d.estimator_user_id IS NOT NULL
      -- estimator distinct from owner (NULL owner ⇒ NULL comparison ⇒ excluded, intentionally).
      AND d.estimator_user_id <> d.assigned_rep_id
      -- Change-order children are base-deal-only — they never earn a standalone estimator cut. Excluded in
      -- the QUERY (not merely by the mint's skipped_change_order guard) so a CO can never be a candidate.
      AND COALESCE(d.is_change_order, false) = false
      -- No estimator row yet. Scoped to the estimator (rep_user_id = estimator_user_id) — the deal already
      -- has the owner row; only the additive estimator row is missing.
      AND NOT EXISTS (
        SELECT 1 FROM deal_signed_commissions dsc
        WHERE dsc.deal_id = d.id AND dsc.rep_user_id = d.estimator_user_id
      )
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

/** Run (dry-run rolls back; execute commits) mintEstimatorCommissionForDeal for one candidate. */
async function runOne(
  tenantDb: TenantDb,
  candidate: EstimatorBackfillCandidate,
  actorUserId: string | null,
  execute: boolean
): Promise<CalculateCommissionResult> {
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
  if (execute) {
    return tenantDb.transaction((tx) => mintEstimatorCommissionForDeal(tx, input));
  }
  // Faithful dry-run: run the real mint, capture the would-be result, then roll back.
  let captured: CalculateCommissionResult = { status: "skipped_no_value" };
  try {
    await tenantDb.transaction(async (tx) => {
      captured = await mintEstimatorCommissionForDeal(tx, input);
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
  const byStatus: Record<CalculateCommissionStatus, number> = {
    created: 0,
    skipped_existing: 0,
    skipped_no_rep: 0,
    skipped_no_value: 0,
    skipped_no_rate: 0,
    // The query already excludes change orders, so the mint should never return this on a candidate — but
    // the shared status union carries it, so the counter must too (defence in depth).
    skipped_change_order: 0,
  };
  let totalCommissionCreated = 0;
  const rows: EstimatorBackfillSummary["rows"] = [];

  for (const candidate of candidates) {
    const result = await runOne(tenantDb, candidate, opts.actorUserId, opts.execute);
    byStatus[result.status] += 1;
    if (result.status === "created" && result.amount) {
      totalCommissionCreated += Number(result.amount);
    }
    rows.push({ ...candidate, status: result.status, amount: result.amount ?? null });
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
      `no_value=${s.byStatus.skipped_no_value}, change_order=${s.byStatus.skipped_change_order}`
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
      const summary = await backfillTenantEstimatorCommissions(tenantDb, (sql, params) => client.query(sql, params as never), {
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
