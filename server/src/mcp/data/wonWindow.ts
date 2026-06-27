/**
 * Shared won_closed_date window presets — ONE definition used by every tool that windows Won deals
 * (get_pipeline_summary, get_bid_award_variance), so the windows can't drift between tools.
 */
export const WON_WINDOW_PRESETS = ["mtd", "qtd", "ytd", "last_90d", "all"] as const;
export type WonWindowPreset = (typeof WON_WINDOW_PRESETS)[number];

const CT_TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";

/** Inclusive lower bound on won_closed_date for the preset, or null for all-time. */
export function wonWindowStartSql(preset: WonWindowPreset): string | null {
  switch (preset) {
    case "mtd":
      return `date_trunc('month', ${CT_TODAY})::date`;
    case "qtd":
      return `date_trunc('quarter', ${CT_TODAY})::date`;
    case "ytd":
      return `date_trunc('year', ${CT_TODAY})::date`;
    case "last_90d":
      return `(${CT_TODAY} - INTERVAL '90 days')::date`;
    case "all":
      return null;
  }
}
