/**
 * Backfill deals.won_closed_date from the HubSpot close-won date (the current
 * reporting basis), per tenant schema. This is the BACKFILL step of the
 * expand/migrate/contract for Won-period reporting (migration 0141 + the
 * changeDealStage dual-write).
 *
 * Run order (see .reviews/trockcrm-date-field-decision/plan.md):
 *   1. Migration 0141 applied + the changeDealStage dual-write deployed.
 *   2. THIS backfill (run LAST, after the dual-write is live, so any deal won
 *      during rollout is captured).
 *   3. verify-won-closed-date-parity.ts must PASS per office.
 *   4. Only then flip the read helpers.
 *
 * Idempotent: only rows whose won_closed_date differs from the computed value are
 * touched, so a re-run reports 0 updates. Dry-run by DEFAULT; pass --execute to
 * write. The live Won total is unchanged by this backfill (it only fills the new
 * column; reads are still on hs until the later flip).
 *
 * Usage (never put the connection string on the command line):
 *   railway run --service=Postgres npx tsx scripts/backfill-won-closed-date.ts            # dry-run, all offices
 *   railway run --service=Postgres npx tsx scripts/backfill-won-closed-date.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx scripts/backfill-won-closed-date.ts --execute  # commit
 */
import "dotenv/config";
import pg from "pg";

const WON_STAGE_SLUGS = [
  "won",
  "sent_to_production",
  "service_sent_to_production",
  "service_scheduled",
  "service_complete",
  "closed_won",
];

// Matches aliasedWonHsClosedWonDateSql / the backfill expression in the plan.
const HS_EXPR =
  "public.try_parse_hs_close_date(NULLIF(NULLIF(d.hubspot_extra_properties->>'hs_closed_won_date',''),'0'))";

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

interface Args {
  tenants: string[] | null; // null = all office_* schemas
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const tenantArg = argv.find((a) => a.startsWith("--tenant="));
  const tenant = tenantArg ? tenantArg.split("=")[1] : null;
  return {
    tenants: tenant && tenant !== "all" ? [tenant] : null,
    execute: argv.includes("--execute"),
  };
}

async function discoverTenants(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
  );
  return rows.map((r) => r.nspname);
}

async function columnExists(client: pg.Client, schema: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'deals' AND column_name = 'won_closed_date'`,
    [schema]
  );
  return rows.length > 0;
}

async function run(): Promise<void> {
  const { tenants, execute } = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const all = tenants ?? (await discoverTenants(client));
    console.log(`backfill won_closed_date | mode: ${execute ? "EXECUTE" : "DRY-RUN"} | tenants: ${all.join(", ")}`);
    const stages = WON_STAGE_SLUGS.map((s) => `'${s}'`).join(",");

    for (const schema of all) {
      const s = quoteIdent(schema);
      if (!(await columnExists(client, schema))) {
        console.log(`  ${schema}: SKIP - won_closed_date column missing (run migration 0141 first).`);
        continue;
      }
      // Rows the backfill WOULD set: Won-stage, usable hs date, and the column is
      // not already equal to it (idempotent).
      const planSql = `
        SELECT COUNT(*)::int AS to_update
        FROM ${s}.deals d
        JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE psc.slug IN (${stages})
          AND ${HS_EXPR} IS NOT NULL
          AND d.won_closed_date IS DISTINCT FROM ${HS_EXPR}`;
      const { rows: planRows } = await client.query<{ to_update: number }>(planSql);
      const toUpdate = planRows[0]?.to_update ?? 0;

      if (!execute) {
        console.log(`  ${schema}: would set won_closed_date on ${toUpdate} row(s).`);
        continue;
      }
      await client.query("BEGIN");
      const updateSql = `
        UPDATE ${s}.deals d
        SET won_closed_date = ${HS_EXPR}
        FROM public.pipeline_stage_config psc
        WHERE psc.id = d.stage_id
          AND psc.slug IN (${stages})
          AND ${HS_EXPR} IS NOT NULL
          AND d.won_closed_date IS DISTINCT FROM ${HS_EXPR}`;
      const res = await client.query(updateSql);
      await client.query("COMMIT");
      console.log(`  ${schema}: updated ${res.rowCount} row(s).`);
    }
    console.log("Done. Reads still on hs; run verify-won-closed-date-parity.ts before any flip.");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run();
