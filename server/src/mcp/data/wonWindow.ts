import { sql, type SQL } from "drizzle-orm";

/**
 * Shared won_closed_date window presets — ONE definition used by every tool that windows Won deals
 * (get_pipeline_summary, get_bid_award_variance), so the windows can't drift between tools.
 */
export const WON_WINDOW_PRESETS = ["mtd", "qtd", "ytd", "last_90d", "all"] as const;
export type WonWindowPreset = (typeof WON_WINDOW_PRESETS)[number];

const CT_TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";
const COLUMN_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

function startExpr(preset: Exclude<WonWindowPreset, "all">): string {
  switch (preset) {
    case "mtd":
      return `date_trunc('month', ${CT_TODAY})::date`;
    case "qtd":
      return `date_trunc('quarter', ${CT_TODAY})::date`;
    case "ytd":
      return `date_trunc('year', ${CT_TODAY})::date`;
    case "last_90d":
      return `(${CT_TODAY} - INTERVAL '90 days')::date`;
  }
}

/**
 * SQL fragment bounding a won-date column to the preset window:
 *   ` AND <col> >= <start> AND <col> <= <today>`
 *
 * BOTH bounds are applied (mirroring the CRM's period-bounded won queries, which use >= from AND
 * <= to): the upper bound at the America/Chicago business date means a stray FUTURE won_closed_date
 * (bad import / manual edit) can never inflate a "to date" total. The lower bound naturally drops
 * NULL won dates for windowed presets.
 *
 * Returns EMPTY SQL for "all" — no bounds, so all-time views still count undated wins (the CRM
 * all-time Won convention). The column name is validated as an identifier.
 */
export function wonWindowConditionSql(preset: WonWindowPreset, dateColumn: string): SQL {
  if (preset === "all") return sql``;
  if (!COLUMN_PATTERN.test(dateColumn)) {
    throw new Error(`Invalid won-date column: ${JSON.stringify(dateColumn)}`);
  }
  const col = sql.raw(dateColumn);
  return sql` AND ${col} >= ${sql.raw(startExpr(preset))} AND ${col} <= ${sql.raw(CT_TODAY)}`;
}
