/**
 * Bidirectional reconcile of deals.won_closed_date (migration 0141 Won-period reporting basis) for
 * BID-BOARD-OWNED deals, so the column is populated if and only if the deal is genuinely Won per the
 * Procore Bid Board. This closes the week-to-date undercount: the bid-board mirror sets a deal to the
 * Won stage but (pre-fix) never stamped won_closed_date, so period Won figures dropped it.
 *
 *   FILL  — bid-board-owned + currently in a Won-family stage + Bid Board status = Won + won_closed_date
 *           IS NULL  ->  stamp the deal's REAL won date: COALESCE(contract_signed_at::date,
 *           contract_signed_date, stage_entered_at::date). This matches the canonical
 *           resolveWonClosedDateWriteThrough convention (contract-signed wins, else the stage-entry
 *           date). It NEVER fabricates today/a blanket date, which would distort every period report.
 *   CLEAR — bid-board-owned + won_closed_date IS NOT NULL + NOT genuinely Won per Bid Board  ->  NULL.
 *
 * Correctly-Won deals (date already present) and non-bid-board-owned deals are never touched. The
 * plan is idempotent — re-running after apply yields an empty plan.
 */

export type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

// Won-family stage slugs — same set the existing scripts/backfill-won-closed-date.ts uses.
export const WON_STAGE_SLUGS = [
  "won",
  "sent_to_production",
  "service_sent_to_production",
  "service_scheduled",
  "service_complete",
  "closed_won",
] as const;

const WON_SLUG_LIST = WON_STAGE_SLUGS.map((s) => `'${s}'`).join(", ");

// "Genuinely Won per Bid Board": currently in a Won-family stage AND the mirrored Bid Board status
// maps to Won (only the 'won' status does — see bidBoardStatusToCrmStage).
const GENUINELY_WON_PREDICATE = `(sc.slug IN (${WON_SLUG_LIST}) AND lower(btrim(coalesce(d.bid_board_status, ''))) = 'won')`;

// The deal's REAL won date — contract-signed (UTC date) wins, else the stage-entry date.
const REAL_WON_DATE_EXPR = `COALESCE(d.contract_signed_at::date, d.contract_signed_date, d.stage_entered_at::date)`;

// Won-revenue value, matching aliasedEffectiveWonDealValueSql (awarded -> bid_board_total_sales ->
// bid_estimate -> dd_estimate, zeroed when on hold).
const WON_VALUE_EXPR = `(CASE WHEN COALESCE(d.on_hold, false) THEN 0 ELSE COALESCE(
  CASE WHEN d.awarded_amount > 0 THEN d.awarded_amount END,
  CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
  CASE WHEN d.bid_estimate > 0 THEN d.bid_estimate END,
  CASE WHEN d.dd_estimate > 0 THEN d.dd_estimate END, 0) END)`;

export interface ReconcileDeal {
  dealNumber: string | null;
  name: string | null;
  direction: "fill" | "clear";
  wonValue: number;
  newWonClosedDate: string | null;
}

export interface ReconcilePlan {
  fill: ReconcileDeal[];
  clear: ReconcileDeal[];
  entersWon: number;
  leavesWon: number;
}

export function quoteSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Refusing to use unsafe schema name: ${JSON.stringify(schema)}`);
  }
  return `"${schema}"`;
}

const FILL_WHERE = `d.is_bid_board_owned AND d.is_active
   AND d.won_closed_date IS NULL
   AND ${REAL_WON_DATE_EXPR} IS NOT NULL
   AND ${GENUINELY_WON_PREDICATE}`;

const CLEAR_WHERE = `d.is_bid_board_owned AND d.is_active
   AND d.won_closed_date IS NOT NULL
   AND NOT ${GENUINELY_WON_PREDICATE}`;

export async function planWonDateReconcile(client: Queryable, schema: string): Promise<ReconcilePlan> {
  const s = quoteSchema(schema);
  const join = `FROM ${s}.deals d JOIN public.pipeline_stage_config sc ON sc.id = d.stage_id`;

  const fillRes = await client.query(
    `SELECT d.deal_number, d.name, ${REAL_WON_DATE_EXPR}::text AS new_won_closed_date,
            ${WON_VALUE_EXPR} AS won_value
       ${join}
      WHERE ${FILL_WHERE}
      ORDER BY won_value DESC NULLS LAST`
  );
  const clearRes = await client.query(
    `SELECT d.deal_number, d.name, ${WON_VALUE_EXPR} AS won_value
       ${join}
      WHERE ${CLEAR_WHERE}
      ORDER BY won_value DESC NULLS LAST`
  );

  const fill: ReconcileDeal[] = fillRes.rows.map((r) => ({
    dealNumber: r.deal_number ?? null,
    name: r.name ?? null,
    direction: "fill",
    wonValue: Number(r.won_value ?? 0),
    newWonClosedDate: r.new_won_closed_date ?? null,
  }));
  const clear: ReconcileDeal[] = clearRes.rows.map((r) => ({
    dealNumber: r.deal_number ?? null,
    name: r.name ?? null,
    direction: "clear",
    wonValue: Number(r.won_value ?? 0),
    newWonClosedDate: null,
  }));

  const entersWon = fill.reduce((sum, d) => sum + d.wonValue, 0);
  const leavesWon = clear.reduce((sum, d) => sum + d.wonValue, 0);
  return { fill, clear, entersWon, leavesWon };
}

export async function applyWonDateReconcile(
  client: Queryable,
  schema: string
): Promise<{ filled: number; cleared: number }> {
  const s = quoteSchema(schema);
  await client.query("BEGIN");
  try {
    const filled = await client.query(
      `UPDATE ${s}.deals d
          SET won_closed_date = ${REAL_WON_DATE_EXPR}, updated_at = NOW()
         FROM public.pipeline_stage_config sc
        WHERE sc.id = d.stage_id
          AND ${FILL_WHERE}
        RETURNING d.id`
    );
    const cleared = await client.query(
      `UPDATE ${s}.deals d
          SET won_closed_date = NULL, updated_at = NOW()
         FROM public.pipeline_stage_config sc
        WHERE sc.id = d.stage_id
          AND ${CLEAR_WHERE}
        RETURNING d.id`
    );
    await client.query("COMMIT");
    return { filled: filled.rows.length, cleared: cleared.rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
