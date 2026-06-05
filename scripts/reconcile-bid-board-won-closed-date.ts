/**
 * Bidirectional reconcile of deals.won_closed_date for BID-BOARD-OWNED deals so the Won-period
 * reporting basis (migration 0141) is populated IFF the deal is genuinely Won per the Bid Board.
 * Pairs with the bid-board mirror fix (writeStageIfSafe now keeps won_closed_date in lockstep on
 * every stage transition); this script reconciles the EXISTING rows that pre-date the fix.
 *
 *   FILL  — genuinely-Won-per-Bid-Board deals missing won_closed_date  ->  the REAL per-deal won date
 *           (contract_signed ?? stage_entered_at::date). Fixes the week-to-date Won undercount.
 *   CLEAR — deals carrying a won_closed_date that are NOT genuinely Won per Bid Board  ->  null.
 *
 * 🚦 MONEY-SENSITIVE: a FILL adds a deal to Won-period revenue; a CLEAR removes it. Dry-run is the
 * DEFAULT and prints the exact deals + the net $ that enters/leaves Won revenue. Get explicit
 * sign-off on that number before re-running with --execute. The CRM only ever mirrors the Bid Board
 * here (it never writes Procore), so there is no Procore-corruption risk in this direction.
 *
 * Usage (never put the connection string on the command line):
 *   railway run --service=Postgres npx tsx scripts/reconcile-bid-board-won-closed-date.ts            # dry-run, all offices
 *   railway run --service=Postgres npx tsx scripts/reconcile-bid-board-won-closed-date.ts --tenant=office_dallas
 *   railway run --service=Postgres npx tsx scripts/reconcile-bid-board-won-closed-date.ts --execute  # commit
 */
import "dotenv/config";
import pg from "pg";
import {
  applyWonDateReconcile,
  planWonDateReconcile,
  type Queryable,
} from "./lib/bid-board-won-date-reconcile.js";

interface Args {
  tenants: string[] | null;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const tenantArg = argv.find((a) => a.startsWith("--tenant="));
  const tenant = tenantArg ? tenantArg.split("=")[1] : null;
  // A money-sensitive script must never silently fall back to ALL tenants on a malformed flag.
  // Omitting --tenant => all (intentional); --tenant= (present but empty) => hard error.
  if (tenantArg && (tenant == null || tenant.trim() === "")) {
    throw new Error("--tenant= was provided but empty. Pass --tenant=office_xxx, --tenant=all, or omit it.");
  }
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

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function run(): Promise<void> {
  const { tenants, execute } = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let totalEnters = 0;
  let totalLeaves = 0;
  try {
    await client.connect();
    // Pin the session to UTC so contract_signed_at::date / stage_entered_at::date agree with the
    // forward write-through (which derives the date via .toISOString(), i.e. UTC) and with the
    // UTC-typed Won-period report windows. Money-sensitive: a non-UTC session could shift a deal's
    // won date across a midnight-UTC boundary into an adjacent reporting period.
    await client.query("SET TIME ZONE 'UTC'");
    const queryable = client as unknown as Queryable;
    const all = tenants ?? (await discoverTenants(client));
    console.log(
      `reconcile won_closed_date (bid-board) | mode: ${execute ? "EXECUTE" : "DRY-RUN"} | tenants: ${all.join(", ")}`
    );

    for (const schema of all) {
      if (!(await columnExists(client, schema))) {
        console.log(`\n${schema}: SKIP - won_closed_date column missing (run migration 0141 first).`);
        continue;
      }
      const plan = await planWonDateReconcile(queryable, schema);
      totalEnters += plan.entersWon;
      totalLeaves += plan.leavesWon;

      console.log(`\n${schema}:`);
      console.log(`  FILL  (enters Won): ${plan.fill.length} deal(s), ${money(plan.entersWon)}`);
      for (const d of plan.fill) {
        console.log(`    + ${d.dealNumber ?? "?"}  ${d.name ?? ""}  -> won_closed_date ${d.newWonClosedDate}  (${money(d.wonValue)})`);
      }
      console.log(`  CLEAR (leaves Won): ${plan.clear.length} deal(s), ${money(plan.leavesWon)}`);
      for (const d of plan.clear) {
        console.log(`    - ${d.dealNumber ?? "?"}  ${d.name ?? ""}  -> won_closed_date NULL  (${money(d.wonValue)})`);
      }

      if (execute) {
        const { filled, cleared } = await applyWonDateReconcile(queryable, schema);
        console.log(`  APPLIED: filled ${filled}, cleared ${cleared}.`);
      }
    }

    console.log(
      `\nNET across tenants: +${money(totalEnters)} enters Won, -${money(totalLeaves)} leaves Won = ${money(totalEnters - totalLeaves)} net.`
    );
    if (!execute) {
      console.log("DRY-RUN only — re-run with --execute AFTER sign-off on the net $ impact above.");
    }
  } catch (err) {
    console.error("Reconcile failed:", err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run();
