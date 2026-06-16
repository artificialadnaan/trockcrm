/**
 * Backfill missing deal_signed_commissions rows for already-signed deals.
 *
 * WHY: signed deals imported from HubSpot (and a few others) had their contract date written WITHOUT
 * ever running calculateCommissionForDeal, so they carry no commission row and earn $0. This re-runs
 * the EXISTING, idempotent calculateCommissionForDeal for every active, non-lost, non-test signed deal
 * (contract_signed_at::date OR contract_signed_date) that has no commission row for its assigned rep.
 *
 * GUARANTEES:
 *   • Only writes deal_signed_commissions rows — it NEVER writes or modifies a contract date (it calls
 *     calculateCommissionForDeal, which only inserts a commission row; no deals UPDATE).
 *   • Idempotent — calculateCommissionForDeal short-circuits on an existing (deal_id, rep_user_id) row
 *     (skipped_existing), so re-running writes nothing new. Safe to run after configuring missing rates.
 *   • Per-office — fans out over every office_* schema (or a single --tenant=office_x).
 *   • The commission OWNER (deal_signed_commissions.rep_user_id) is the deal's assigned rep, set by
 *     calculateCommissionForDeal. The backfill OPERATOR (--actor) is stamped as created_by + audit
 *     changed_by, so the trail truthfully records who created these historical rows.
 *   • Skips any deal that already has ANY commission row (a reassigned deal keeps its original-rep row),
 *     so it can never insert a second row and double-pay.
 *
 * USAGE (dry-run is the DEFAULT — nothing is written without --execute):
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-missing-commissions.ts                       # dry-run, all offices
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-missing-commissions.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-missing-commissions.ts --execute --actor=<uuid>   # WRITE
 *
 * --execute REQUIRES --actor=<uuid> (the operator/system user stamped as created_by + audit changed_by).
 * --tenant=/--actor= must use the '=' form (the space-separated form is rejected to avoid silently
 * widening the blast radius).
 *
 * Dry-run is FAITHFUL: it runs the real calculateCommissionForDeal inside a transaction and rolls it
 * back, so the reported status/amount is exactly what --execute would write.
 */
import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { LOST_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import {
  calculateCommissionForDeal,
  type CalculateCommissionResult,
  type CalculateCommissionStatus,
} from "../modules/commissions/service.js";

type TenantDb = NodePgDatabase<typeof schema>;
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");

export interface BackfillCandidate {
  dealId: string;
  dealNumber: string | null;
  repId: string;
  repName: string | null;
  signedDate: string;
}

export interface BackfillSummary {
  schema: string;
  executed: boolean;
  candidates: number;
  byStatus: Record<CalculateCommissionStatus, number>;
  totalCommissionCreated: number;
  rows: Array<BackfillCandidate & { status: CalculateCommissionStatus; amount: string | null }>;
}

// The CANONICAL lost-stage set (includes deal_canceled) — sourced from the shared constant so the backfill
// can't drift from how the rest of the app classifies lost deals (which it excludes from earned commission).
// Trusted compile-time constants, safe to interpolate.
const LOST_STAGE_SLUGS = `(${LOST_DEAL_STAGE_SLUGS.map((s) => `'${s}'`).join(",")})`;

// Office schemas only — validated before interpolating into SET search_path (--tenant is user input).
const OFFICE_SCHEMA_RE = /^office_[a-z0-9_]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Active, non-lost (canonical slugs, incl. deal_canceled), non-test, non-change-order signed deals with an
 * assigned rep and NO existing commission row (any rep).
 */
export async function findBackfillCandidates(query: QueryFn): Promise<BackfillCandidate[]> {
  const { rows } = await query(`
    SELECT d.id AS deal_id, d.deal_number, d.assigned_rep_id AS rep_id, u.display_name AS rep_name,
           -- _at-first (canonical precedence, matching contractSignedDateForReporting); the UTC cast is
           -- tz-stable since the app stores contract_signed_at at UTC midnight.
           COALESCE((d.contract_signed_at AT TIME ZONE 'UTC')::date, d.contract_signed_date)::text AS signed_date
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    LEFT JOIN public.users u ON u.id = d.assigned_rep_id
    WHERE (d.contract_signed_at IS NOT NULL OR d.contract_signed_date IS NOT NULL)
      AND psc.slug NOT IN ${LOST_STAGE_SLUGS}
      AND COALESCE(d.is_test_data, false) = false
      AND d.is_active = true
      AND d.assigned_rep_id IS NOT NULL
      -- Exclude change-order children: migrateLegacyChangeOrders deliberately creates historical CO
      -- children WITHOUT commission (they don't retroactively earn), and a live CO that DOES earn already
      -- got its row on creation. Backfilling COs would mint retroactive payouts for the migrated set.
      AND COALESCE(d.is_change_order, false) = false
      -- Skip a deal that already has ANY commission row (any rep), not just one for the CURRENT assigned
      -- rep: a reassigned deal keeps its row booked to the ORIGINAL rep, and inserting a second row for the
      -- new assignee would double-pay/double-count the deal. A deal already carrying commission is "handled".
      AND NOT EXISTS (
        SELECT 1 FROM deal_signed_commissions x WHERE x.deal_id = d.id
      )
    ORDER BY d.deal_number
  `);
  return rows.map((r) => ({
    dealId: String(r.deal_id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    repId: String(r.rep_id),
    repName: r.rep_name == null ? null : String(r.rep_name),
    signedDate: String(r.signed_date),
  }));
}

/** Run (dry-run rolls back; execute commits) calculateCommissionForDeal for one candidate. */
async function runOne(
  tenantDb: TenantDb,
  candidate: BackfillCandidate,
  actorUserId: string | null,
  execute: boolean
): Promise<CalculateCommissionResult> {
  const input = {
    dealId: candidate.dealId,
    contractSignedDate: candidate.signedDate,
    // The commission OWNER (dsc.rep_user_id) is the deal's assigned rep, set by calculateCommissionForDeal
    // itself. triggeredByUserId only stamps created_by + the audit changed_by — for a WRITE it must be the
    // BACKFILL OPERATOR (--actor, enforced upstream), NOT the earning rep, so the trail truthfully records
    // who created these historical rows. On a DRY-RUN (rolled back, never persisted) we fall back to the
    // assigned rep, which is a real user — so the throwaway INSERT doesn't trip the created_by FK.
    triggeredByUserId: actorUserId ?? candidate.repId,
  };
  if (execute) {
    return tenantDb.transaction((tx) => calculateCommissionForDeal(tx, input));
  }
  // Faithful dry-run: run the real calc, capture the would-be result, then roll back.
  let captured: CalculateCommissionResult = { status: "skipped_no_rep" };
  try {
    await tenantDb.transaction(async (tx) => {
      captured = await calculateCommissionForDeal(tx, input);
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return captured;
}

export async function backfillTenantCommissions(
  tenantDb: TenantDb,
  query: QueryFn,
  opts: { schema: string; execute: boolean; actorUserId: string | null }
): Promise<BackfillSummary> {
  const candidates = await findBackfillCandidates(query);
  const byStatus: Record<CalculateCommissionStatus, number> = {
    created: 0,
    skipped_existing: 0,
    skipped_no_rep: 0,
    skipped_no_value: 0,
    skipped_no_rate: 0,
  };
  let totalCommissionCreated = 0;
  const rows: BackfillSummary["rows"] = [];

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
  const execute = argv.includes("--execute");
  const actor = readValue("--actor");
  // A WRITE must record a real operator/system actor in created_by + the audit trail — never default it.
  if (execute && !actor) {
    throw new Error("--execute requires --actor=<uuid> (the operator/system user recorded as created_by + audit changed_by).");
  }
  if (actor && !UUID_RE.test(actor)) {
    throw new Error(`--actor must be a UUID, got ${JSON.stringify(actor)}.`);
  }
  return {
    tenant: tenant && tenant !== "all" ? tenant : null,
    execute,
    // null on a dry-run without --actor → runOne falls back to the deal's assigned rep (a real user, so
    // the rolled-back INSERT doesn't FK-fail). --execute always carries a real --actor (enforced above).
    actorUserId: actor,
  };
}

async function discoverTenants(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
  );
  return rows.map((r) => r.nspname);
}

function printSummary(s: BackfillSummary): void {
  const mode = s.executed ? "WRITE" : "DRY-RUN";
  console.log(`\n[${s.schema}] ${mode} — ${s.candidates} candidate(s)`);
  for (const row of s.rows) {
    const tag = row.status === "created" ? `$${Number(row.amount ?? 0).toLocaleString()}` : row.status;
    console.log(`  ${(row.dealNumber ?? "(none)").padEnd(16)} ${(row.repName ?? row.repId).padEnd(20)} ${row.signedDate}  -> ${tag}`);
  }
  console.log(
    `  totals: created=${s.byStatus.created} ($${s.totalCommissionCreated.toLocaleString()}), ` +
      `skipped_existing=${s.byStatus.skipped_existing}, no_rate=${s.byStatus.skipped_no_rate}, ` +
      `no_value=${s.byStatus.skipped_no_value}, no_rep=${s.byStatus.skipped_no_rep}`
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
      const summary = await backfillTenantCommissions(tenantDb, (sql, params) => client.query(sql, params as never), {
        schema: t,
        execute,
        actorUserId,
      });
      printSummary(summary);
      grandCreated += summary.byStatus.created;
      grandAmount += summary.totalCommissionCreated;
    }
    console.log(
      `\n=== GRAND TOTAL ${execute ? "WRITTEN" : "(dry-run) WOULD WRITE"}: ${grandCreated} commission rows, $${grandAmount.toLocaleString()} ===`
    );
    console.log("(No contract dates were read-modified: this script only inserts commission rows.)");
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
