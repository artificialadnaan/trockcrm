/**
 * Dry-run preview for the company-merge tool. READ-ONLY: opens a
 * `default_transaction_read_only = on` connection and only issues SELECTs -- it
 * NEVER merges or writes. For each name-match company cluster it prints the
 * chosen winner, exactly what would move per re-point target (counts + sample
 * ids), the field reconciliation, and the clearly_safe / review classification.
 *
 * Usage (read-only):
 *   TENANT_SCHEMA=office_dallas INCLUDE_IDS=true \
 *     node --import tsx scripts/preview-company-merges.ts
 */
import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  COMPANY_REPOINT_TARGETS,
  clusterCompaniesByName,
  selectMergeWinner,
  buildClusterMergePlan,
  type CompanyMergeMember,
  type TargetMove,
  type ClusterMergePlan,
} from "../server/src/services/directoryDedup.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  process.exit(1);
}

const SCHEMAS = (process.env.TENANT_SCHEMA ?? "office_dallas")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_IDS = process.env.INCLUDE_IDS === "true";
const MAX_IDS = Number(process.env.MAX_IDS ?? 25);
const SAFE_SCHEMA = /^office_[a-z0-9_]+$/;

function q(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ident)) throw new Error(`unsafe identifier: ${ident}`);
  return `"${ident}"`;
}

function fmtAddr(m: CompanyMergeMember): string {
  const parts = [m.address, m.city, m.state, m.zip].filter((p) => p && String(p).trim());
  return parts.length ? parts.join(", ") : "NULL";
}

async function loserMoves(
  client: pg.Client,
  schema: string,
  loserId: string
): Promise<TargetMove[]> {
  const moves: TargetMove[] = [];
  for (const target of COMPANY_REPOINT_TARGETS) {
    const params: unknown[] = [loserId];
    let discr = "";
    if (target.discriminatorColumn) {
      // Bind the discriminator value as a parameter (never string-interpolated).
      params.push(target.discriminatorValue);
      discr = ` AND ${q(target.discriminatorColumn)} = $${params.length}`;
    }
    const sql = `SELECT id::text AS id FROM ${q(schema)}.${q(target.table)} WHERE ${q(target.column)} = $1${discr}`;
    const res = await client.query(sql, params);
    const ids = res.rows.map((r) => r.id as string);
    moves.push({
      key: target.key,
      table: target.table,
      count: ids.length,
      ids: INCLUDE_IDS ? ids.slice(0, MAX_IDS) : [],
    });
  }
  return moves;
}

async function previewSchema(client: pg.Client, schema: string): Promise<ClusterMergePlan[]> {
  const companyRows = await client.query(
    `SELECT id::text AS id, name, address, city, state, zip, phone, website, domain,
            hubspot_id AS "hubspotId", hubspot_company_id AS "hubspotCompanyId",
            procore_id AS "procoreId", industry::text AS industry, region, category::text AS category,
            created_at AS "createdAt",
            (SELECT count(*)::int FROM ${q(schema)}.deals d WHERE d.company_id = c.id) AS "dealCount",
            (SELECT count(*)::int FROM ${q(schema)}.contacts ct WHERE ct.company_id = c.id) AS "contactCount"
     FROM ${q(schema)}.companies c
     WHERE c.is_active = true AND c.is_test_data = false`
  );
  const members = companyRows.rows as CompanyMergeMember[];
  const clusters = clusterCompaniesByName(members);

  const plans: ClusterMergePlan[] = [];
  for (const cluster of clusters) {
    // Only the losers' references move; resolve the winner once, then tally the
    // losers and assemble the plan a single time.
    const winnerId = selectMergeWinner(cluster);
    const movesByCompanyId: Record<string, TargetMove[]> = {};
    for (const loser of cluster.filter((m) => m.id !== winnerId)) {
      movesByCompanyId[loser.id] = await loserMoves(client, schema, loser.id);
    }
    plans.push(buildClusterMergePlan(cluster, movesByCompanyId));
  }
  return plans;
}

function printPlan(plan: ClusterMergePlan): void {
  const tag = plan.classification === "clearly_safe" ? "CLEARLY_SAFE" : "REVIEW";
  const reasons = plan.reasons.length ? ` (${plan.reasons.join(", ")})` : "";
  console.log(`\n[${tag}]${reasons} "${plan.name}"  (${plan.losers.length + 1} records, ${plan.totalMovedRows} rows would move)`);
  console.log(
    `  WINNER ${plan.winnerId.slice(0, 8)}  deals=${plan.winner.dealCount} contacts=${plan.winner.contactCount}  addr=${fmtAddr(plan.winner)}  site=${plan.winner.website ?? "-"}`
  );
  const reconcileKeys = Object.keys(plan.reconciliation.updates);
  if (reconcileKeys.length) {
    const pairs = reconcileKeys.map((k) => `${k}<-${JSON.stringify(plan.reconciliation.updates[k])}`).join(", ");
    console.log(`  RECONCILE winner inherits: ${pairs}`);
  }
  for (const lp of plan.loserPlans) {
    const breakdown = lp.moves
      .filter((m) => m.count > 0)
      .map((m) => `${m.key}=${m.count}`)
      .join(", ");
    console.log(`  LOSER  ${lp.loserId.slice(0, 8)}  -> moves ${lp.totalRows} rows: ${breakdown || "(none)"}`);
    if (INCLUDE_IDS) {
      for (const m of lp.moves.filter((x) => x.ids.length)) {
        console.log(`           ${m.key} ids: ${m.ids.join(", ")}${m.count > m.ids.length ? ` ... (+${m.count - m.ids.length} more)` : ""}`);
      }
    }
  }
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  const ro = await client.query("SHOW default_transaction_read_only");
  if (ro.rows[0].default_transaction_read_only !== "on") {
    throw new Error("refusing to run: connection is not read-only");
  }
  console.log("Company-merge DRY-RUN preview (READ-ONLY; no writes, no merges)");
  console.log(`read-only: ${ro.rows[0].default_transaction_read_only} | schemas: ${SCHEMAS.join(", ")}`);
  console.log("NOTE: WINNER is the RECOMMENDED pick (most-deals, has-address, ...); an operator may");
  console.log("      choose a different winner at merge time, which inverts which rows move.");
  console.log("NOTE: clusters group by EXACT company name (per the discovery deliverable). Suffix/case");
  console.log("      variants (e.g. 'X' vs 'X, LLC') are NOT grouped here -- the normalized merge-queue");
  console.log("      matcher catches those separately; treat this preview as a floor, not a ceiling.");

  for (const schema of SCHEMAS) {
    if (!SAFE_SCHEMA.test(schema)) {
      console.error(`skip unsafe schema name: ${schema}`);
      continue;
    }
    const plans = await previewSchema(client, schema);
    const safe = plans.filter((p) => p.classification === "clearly_safe");
    const review = plans.filter((p) => p.classification === "review");
    const companies = plans.reduce((a, p) => a + p.losers.length + 1, 0);
    const rows = plans.reduce((a, p) => a + p.totalMovedRows, 0);

    console.log(`\n================ ${schema} ================`);
    console.log(
      `clusters=${plans.length}  companies=${companies}  rows_that_would_move=${rows}  | clearly_safe=${safe.length}  review=${review.length}`
    );

    console.log(`\n----- CLEARLY SAFE (${safe.length}) -----`);
    safe.sort((a, b) => b.totalMovedRows - a.totalMovedRows).forEach(printPlan);
    console.log(`\n----- REVIEW (${review.length}) -----`);
    review.sort((a, b) => b.totalMovedRows - a.totalMovedRows).forEach(printPlan);
  }

  await client.end();
  console.log("\nDONE. No writes were issued. Approve clusters individually before any real merge.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
