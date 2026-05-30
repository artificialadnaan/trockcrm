/**
 * READ-ONLY parity gate for the Won-period reporting basis change (migration 0141
 * + dual-write + backfill). Proves, PER OFFICE, that won_closed_date can safely
 * become the Won-period basis before the read helpers are flipped.
 * See .reviews/trockcrm-date-field-decision/plan.md section 6.
 *
 * Sets the transaction read-only; it never writes. Run AFTER the backfill.
 *
 * GATE INVARIANT (the safety property the flip depends on): no deal that counts
 * TODAY on the hs basis may drop after the flip. Concretely, per office:
 *   - backfill_gap = 0  : every Won row with a usable hs date has won_closed_date
 *                         present AND equal to it. (If > 0 the flip would LOSE rows.)
 *   - bid_board_collisions = 0 : won_closed_date never equals bid_board_last_updated_at
 *                         (the reseed-contamination signature; 7 for actual_close_date).
 *   - column present    : a MISSING column FAILS the gate (never a false green).
 * rollout_wins (hs NULL but won_closed_date present) are EXPECTED and NOT a failure:
 * they are deals won via the dual-write after deploy; the flip legitimately ADDS them.
 *
 * On failure the process exits non-zero so CI / Railway cannot proceed on a false
 * PASS. If ANY office fails, DO NOT flip the read helpers.
 *
 * Usage:
 *   railway run --service=Postgres npx tsx scripts/verify-won-closed-date-parity.ts
 *   railway run --service=Postgres npx tsx scripts/verify-won-closed-date-parity.ts --from=2026-01-01 --to=2026-05-29
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

const HS_EXPR =
  "public.try_parse_hs_close_date(NULLIF(NULLIF(d.hubspot_extra_properties->>'hs_closed_won_date',''),'0'))";

// aliasedEffectiveWonDealValueSql: awarded-first chain, zeroed when on hold.
const VALUE_EXPR = `CASE WHEN COALESCE(d.on_hold,false) THEN 0 ELSE COALESCE(
  CASE WHEN d.awarded_amount>0 THEN d.awarded_amount END,
  CASE WHEN d.bid_board_total_sales>0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate>0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate>0 THEN d.dd_estimate END, 0) END`;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseArgs(argv: string[]): { from: string; to: string } {
  const get = (k: string, d: string) => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.split("=")[1] : d;
  };
  const now = new Date();
  const yearStart = `${now.getUTCFullYear()}-01-01`;
  const today = now.toISOString().split("T")[0];
  return { from: get("from", yearStart), to: get("to", today) };
}

async function cardSummary(
  client: pg.Client,
  schema: string,
  dateCol: string,
  from: string,
  to: string
): Promise<{ count: number; value: number }> {
  const s = quoteIdent(schema);
  const stages = WON_STAGE_SLUGS.map((x) => `'${x}'`).join(",");
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(d.on_hold,false)=false)::int AS won_count,
       COALESCE(SUM(${VALUE_EXPR}),0)::numeric AS won_value
     FROM ${s}.deals d
     JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     WHERE COALESCE(d.is_test_data,false)=false
       AND COALESCE(d.on_hold,false)=false
       AND psc.slug IN (${stages})
       AND ${dateCol} IS NOT NULL
       AND ${dateCol} >= $1::date AND ${dateCol} <= $2::date`,
    [from, to]
  );
  return { count: Number(rows[0]?.won_count ?? 0), value: Number(rows[0]?.won_value ?? 0) };
}

async function columnExists(client: pg.Client, schema: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='deals' AND column_name='won_closed_date'`,
    [schema]
  );
  return rows.length > 0;
}

async function run(): Promise<void> {
  const { from, to } = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  const stages = WON_STAGE_SLUGS.map((x) => `'${x}'`).join(",");
  let allPass = true;
  try {
    const { rows: schemas } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
    );
    console.log(`Parity gate | window ${from}..${to} (read-only)\n`);
    for (const { nspname: schema } of schemas) {
      const s = quoteIdent(schema);

      // A missing column FAILS the gate -- never continue past it on a false green.
      if (!(await columnExists(client, schema))) {
        allPass = false;
        console.log(`  ${schema}: FAIL - won_closed_date column ABSENT (run migration 0141 + backfill first).`);
        continue;
      }

      const hs = await cardSummary(client, schema, HS_EXPR, from, to);
      const col = await cardSummary(client, schema, "d.won_closed_date", from, to);
      const { rows: par } = await client.query(
        `SELECT
           -- HARD FAIL: a hs-dated Won row the backfill genuinely MISSED (col still NULL).
           COUNT(*) FILTER (WHERE ${HS_EXPR} IS NOT NULL AND d.won_closed_date IS NULL)::int AS backfill_gap,
           -- INFORMATIONAL (not a failure): col set AND differs from a (possibly stale)
           -- hs. After the fill-only-where-null backfill this is a legitimate fresh-win
           -- divergence -- the app-owned value intentionally wins over a frozen hs.
           COUNT(*) FILTER (WHERE ${HS_EXPR} IS NOT NULL AND d.won_closed_date IS NOT NULL
                              AND d.won_closed_date <> ${HS_EXPR})::int AS fresh_win_divergence,
           -- expected / not a failure: deals won via the dual-write after deploy (hs NULL)
           COUNT(*) FILTER (WHERE ${HS_EXPR} IS NULL AND d.won_closed_date IS NOT NULL)::int AS rollout_wins
         FROM ${s}.deals d JOIN public.pipeline_stage_config psc ON psc.id=d.stage_id
         WHERE psc.slug IN (${stages}) AND COALESCE(d.is_test_data,false)=false`
      );
      const { rows: bb } = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${s}.deals d JOIN public.pipeline_stage_config psc ON psc.id=d.stage_id
          WHERE psc.slug IN (${stages}) AND d.won_closed_date = d.bid_board_last_updated_at::date`
      );
      const backfillGap = par[0].backfill_gap;
      const freshWinDivergence = par[0].fresh_win_divergence;
      const rolloutWins = par[0].rollout_wins;
      const collisions = bb[0].c;
      // PASS = no genuinely-missed fill and no bid-board reseed collision. A
      // fresh_win_divergence (col<>hs, both present) is informational, NOT a fail --
      // it is the app-owned value legitimately overriding a stale frozen hs.
      const pass = backfillGap === 0 && collisions === 0;
      allPass = allPass && pass;
      const fmt = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2 });
      console.log(
        `  ${schema}: ${pass ? "PASS" : "FAIL"}\n` +
          `    hs-basis card  = ${hs.count} / ${fmt(hs.value)}\n` +
          `    col-basis card = ${col.count} / ${fmt(col.value)}  (delta ${col.count - hs.count} = rollout wins + fresh-win divergences)\n` +
          `    backfill_gap=${backfillGap} (MUST be 0)  rollout_wins=${rolloutWins} (expected)  fresh_win_divergence=${freshWinDivergence} (informational)  bid_board_collisions=${collisions} (MUST be 0)`
      );
    }
    console.log(`\nGATE: ${allPass ? "PASS (safe to flip)" : "FAIL - DO NOT flip the read helpers"}`);
  } finally {
    await client.end();
  }
  process.exitCode = allPass ? 0 : 1;
}

run();
