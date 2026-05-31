import {
  type TerminalDateFilter,
  toDatePresetRange,
  daysAgo,
  getTodayDateParam,
} from "@/lib/pipeline-terminal-filters";

export interface DateWindow {
  dateFrom?: string;
  dateTo?: string;
  /** Client-only label kept in the URL so the chip can re-derive without a round-trip. */
  datePreset: string;
}

/**
 * Resolve the date control's filter into the contract's date window. Presets are resolved
 * CLIENT-SIDE to concrete dates (BLUE's getDeals only reads dateFrom/dateTo); "all" emits no
 * window so no date param is sent. WTD is the user's local Sunday week (Slice 1 / #539).
 */
export function resolveDateWindow(filter: TerminalDateFilter, now = new Date()): DateWindow {
  if (filter.preset === "all") return { datePreset: "all" };
  if (filter.preset === "custom") {
    return { datePreset: "custom", dateFrom: filter.customStart, dateTo: filter.customEnd };
  }
  if (
    filter.preset === "wtd" ||
    filter.preset === "mtd" ||
    filter.preset === "qtd" ||
    filter.preset === "ytd"
  ) {
    const range = toDatePresetRange(filter.preset, now);
    return { datePreset: filter.preset, dateFrom: range.from, dateTo: range.to };
  }
  // Rolling presets: "7" | "30" | "60" | "90".
  return { datePreset: filter.preset, dateFrom: daysAgo(Number(filter.preset), now), dateTo: getTodayDateParam(now) };
}

/** Reconstruct the date control's filter from a stored FilterBar value. */
export function dateFilterFromValue(value: {
  datePreset?: string;
  dateFrom?: string;
  dateTo?: string;
}): TerminalDateFilter {
  const preset = value.datePreset;
  if (preset === "custom") {
    return { preset: "custom", customStart: value.dateFrom ?? "", customEnd: value.dateTo };
  }
  if (
    preset === "7" ||
    preset === "30" ||
    preset === "60" ||
    preset === "90" ||
    preset === "wtd" ||
    preset === "mtd" ||
    preset === "qtd" ||
    preset === "ytd" ||
    preset === "all"
  ) {
    return { preset };
  }
  return { preset: "all" };
}
