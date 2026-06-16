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
 *   • Attributed to the deal's assigned rep (the commission owner): triggeredByUserId = assigned_rep_id,
 *     so created_by / audit changed_by is the rep whose earned commission this is.
 *
 * USAGE (dry-run is the DEFAULT — nothing is written without --execute):
 *   railway run --service=Postgres npx tsx scripts/backfill-missing-commissions.ts                  # dry-run, all offices
 *   railway run --service=Postgres npx tsx scripts/backfill-missing-commissions.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx scripts/backfill-missing-commissions.ts --execute         # WRITE
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

const NON_LOST = "('lost','production_lost','service_lost','closed_lost')";

/** Active, non-lost, non-test signed deals with an assigned rep and NO commission row for that rep. */
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
      AND psc.slug NOT IN ${NON_LOST}
      AND COALESCE(d.is_test_data, false) = false
      AND d.is_active = true
      AND d.assigned_rep_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM deal_signed_commissions x
        WHERE x.deal_id = d.id AND x.rep_user_id = d.assigned_rep_id
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
  execute: boolean
): Promise<CalculateCommissionResult> {
  const input = {
    dealId: candidate.dealId,
    contractSignedDate: candidate.signedDate,
    triggeredByUserId: candidate.repId, // commission owner = the deal's assigned rep
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
  opts: { schema: string; execute: boolean }
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
    const result = await runOne(tenantDb, candidate, opts.execute);
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

function parseArgs(argv: string[]): { tenant: string | null; execute: boolean } {
  const tenantArg = argv.find((a) => a.startsWith("--tenant="));
  const tenant = tenantArg ? tenantArg.split("=")[1] : null;
  return { tenant: tenant && tenant !== "all" ? tenant : null, execute: argv.includes("--execute") };
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
  const { tenant, execute } = parseArgs(argv);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const tenants = tenant ? [tenant] : await discoverTenants(client);
    console.log(`${execute ? "WRITE" : "DRY-RUN (no writes)"} — tenants: ${tenants.join(", ")}`);
    let grandCreated = 0;
    let grandAmount = 0;
    for (const t of tenants) {
      await client.query(`SET search_path TO ${t}, public`);
      const tenantDb = drizzle(client, { schema });
      const summary = await backfillTenantCommissions(tenantDb, (sql, params) => client.query(sql, params as never), {
        schema: t,
        execute,
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
