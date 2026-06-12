import { resolveDatePreset } from "@/lib/pipeline-terminal-filters";
import type { FilterSelectOption } from "@/components/filters/filter-select";

// The period toggle keys. "year" = the full calendar year (Jan 1 – Dec 31); the other three delegate to the
// canonical F1 resolver. Won/Lost metrics window on this range; pipeline/forecast are snapshots regardless.
export type RegionPeriodKey = "wtd" | "mtd" | "year" | "ytd";

export const REGION_PERIOD_OPTIONS: FilterSelectOption[] = [
  { value: "wtd", label: "This Week" },
  { value: "mtd", label: "This Month" },
  { value: "year", label: "This Year" },
  { value: "ytd", label: "YTD" },
];

export function resolveRegionPeriod(key: RegionPeriodKey, now: Date = new Date()): { from: string; to: string } {
  if (key === "year") {
    const ytd = resolveDatePreset("ytd", now); // { from: 'YYYY-01-01', to: today }
    return { from: ytd.from, to: `${ytd.from.slice(0, 4)}-12-31` };
  }
  return resolveDatePreset(key, now);
}

// Safe percent: render the value as a percent; an em dash for null/undefined/NaN. A blank win rate means
// "unknown" (no won+lost outcomes), NEVER a misleading 0%.
export function pctLabel(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? "—" : `${v}%`;
}

// Heatmap colour scale: a cell's value relative to the matrix max, clamped to [0,1]. 0 when max is 0
// (no div-by-zero). The cell renders this as a background opacity so $ concentration reads at a glance.
export function heatIntensity(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(1, value / max);
}
