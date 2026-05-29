/**
 * READ-ONLY parity gate for the Won-period reporting basis change (migration 0141
 * + dual-write + backfill). Proves, PER OFFICE, that the new won_closed_date column
 * reproduces the current hs_closed_won_date Won total before the read helpers are
 * flipped. See .reviews/trockcrm-date-field-decision/plan.md section 6.
 *
 * Sets the transaction read-only; it never writes. Run it:
 *   - NOW (pre-migration): the column is absent, so it proves the hs-basis card and
 *     notes that won_closed_date will equal hs by construction (backfill := hs).
 *   - After the backfill: it compares hs vs the real column and asserts parity.
 *
 * GATE PASSES when, for EVERY office: hs-basis count/value == column-basis
 * count/value, 0 presence-mismatch rows, 0 value-mismatch rows, and 0 bid-board
 * same-day collisions. If any office fails, DO NOT flip the read helpers.
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
      const hs = await cardSummary(client, schema, HS_EXPR, from, to);
      const hasCol = await columnExists(client, schema);

      if (!hasCol) {
        console.log(
          `  ${schema}: hs-basis card = ${hs.count} / $${hs.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}` +
            `  | won_closed_date column ABSENT - will equal hs by construction (backfill := hs). Run 0141 + backfill, then re-run.`
        );
        // bid-board collision regression on the hs basis (must be 0; cf. 7 for actual_close_date).
        const { rows: bb } = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${s}.deals d JOIN public.pipeline_stage_config psc ON psc.id=d.stage_id
            WHERE psc.slug IN (${stages}) AND ${HS_EXPR} = d.bid_board_last_updated_at::date`
        );
        console.log(`           bid-board same-day collisions (hs basis): ${bb[0].c} (must be 0)`);
        continue;
      }

      const col = await cardSummary(client, schema, "d.won_closed_date", from, to);
      const { rows: par } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE (${HS_EXPR} IS NOT NULL) <> (d.won_closed_date IS NOT NULL))::int AS presence_mismatch,
           COUNT(*) FILTER (WHERE ${HS_EXPR} IS NOT NULL AND d.won_closed_date IS NOT NULL AND ${HS_EXPR} <> d.won_closed_date)::int AS value_mismatch
         FROM ${s}.deals d JOIN public.pipeline_stage_config psc ON psc.id=d.stage_id
         WHERE psc.slug IN (${stages}) AND COALESCE(d.is_test_data,false)=false`
      );
      const { rows: bb } = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${s}.deals d JOIN public.pipeline_stage_config psc ON psc.id=d.stage_id
          WHERE psc.slug IN (${stages}) AND d.won_closed_date = d.bid_board_last_updated_at::date`
      );
      const pass =
        hs.count === col.count &&
        hs.value === col.value &&
        par[0].presence_mismatch === 0 &&
        par[0].value_mismatch === 0 &&
        bb[0].c === 0;
      allPass = allPass && pass;
      console.log(
        `  ${schema}: ${pass ? "PASS" : "FAIL"}\n` +
          `    hs   = ${hs.count} / $${hs.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n` +
          `    col  = ${col.count} / $${col.value.toLocaleString("en-US", { minimumFractionDigits: 2 })}\n` +
          `    presence_mismatch=${par[0].presence_mismatch} value_mismatch=${par[0].value_mismatch} bid_board_collisions=${bb[0].c}`
      );
    }
    console.log(`\nGATE: ${allPass ? "PASS (safe to flip)" : "FAIL - DO NOT flip the read helpers"}`);
  } finally {
    await client.end();
  }
}

run();
