/**
 * Backfill deals.won_closed_date per tenant schema. BACKFILL step of the
 * expand/migrate/contract for Won-period reporting (migration 0141 + the
 * changeDealStage / bid-board-mirror dual-write).
 *
 * Run order (see .reviews/trockcrm-date-field-decision/plan.md):
 *   1. Migration 0141 applied + the dual-write deployed (changeDealStage AND the
 *      Procore/Bid-Board mirror -- both now set won_closed_date).
 *   2. THIS backfill (LAST), after the dual-write is live.
 *   3. verify-won-closed-date-parity.ts must PASS per office.
 *   4. Only then flip the read helpers.
 *
 * Normalize semantics (idempotent): for every Won-stage deal,
 *   won_closed_date := COALESCE(hs_close_won_date, won_closed_date)
 * i.e. prefer the historical HubSpot close-won date; where hs is NULL, KEEP the
 * existing value. This deliberately PRESERVES rollout wins -- deals won between the
 * dual-write deploy and this backfill already carry a dual-written won_closed_date
 * with a NULL hs, and must NOT be nulled. A no-hs / no-existing-date Won deal stays
 * NULL (excluded from windowed totals, same as today's hs-IS-NOT-NULL behavior).
 *
 * Dry-run by DEFAULT; pass --execute to write. The live Won total is unchanged by
 * this backfill (reads are still on hs until the later flip).
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

// Matches aliasedWonHsClosedWonDateSql / the reporting basis.
const HS_EXPR =
  "public.try_parse_hs_close_date(NULLIF(NULLIF(d.hubspot_extra_properties->>'hs_closed_won_date',''),'0'))";
// Target value: prefer hs, else keep the existing (dual-written) won_closed_date.
const TARGET_EXPR = `COALESCE(${HS_EXPR}, d.won_closed_date)`;

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
      // Rows the backfill WOULD change: Won-stage where the column differs from the
      // COALESCE target (rollout wins, where target == existing value, are excluded).
      const planSql = `
        SELECT COUNT(*)::int AS to_update
        FROM ${s}.deals d
        JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE psc.slug IN (${stages})
          AND d.won_closed_date IS DISTINCT FROM ${TARGET_EXPR}`;
      const { rows: planRows } = await client.query<{ to_update: number }>(planSql);
      const toUpdate = planRows[0]?.to_update ?? 0;

      if (!execute) {
        console.log(`  ${schema}: would set won_closed_date on ${toUpdate} row(s).`);
        continue;
      }
      await client.query("BEGIN");
      const updateSql = `
        UPDATE ${s}.deals d
        SET won_closed_date = ${TARGET_EXPR}
        FROM public.pipeline_stage_config psc
        WHERE psc.id = d.stage_id
          AND psc.slug IN (${stages})
          AND d.won_closed_date IS DISTINCT FROM ${TARGET_EXPR}`;
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
