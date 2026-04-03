/**
 * Shared color palette for all Recharts visualizations.
 * Uses T Rock brand colors + complementary data visualization colors.
 */

export const CHART_COLORS = [
  "#CC0000", // brand red
  "#06B6D4", // brand cyan
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red-500
  "#64748B", // slate
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
] as const;

/** Get a color for an index, cycling through the palette */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Stage-specific colors (falls back to stage.color from config, then palette) */
export function getStageColor(stageColor: string | null | undefined, index: number): string {
  return stageColor ?? getChartColor(index);
}

/** Format a number as currency ($123K, $1.2M, etc.) */
export function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/** Format a number as a compact count (1.2K, 5M, etc.) */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Format a percentage */
export function formatPercent(value: number): string {
  return `${value}%`;
}
