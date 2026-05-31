import { type TerminalDateFilter, toDatePresetRange } from "@/lib/pipeline-terminal-filters";

export interface DateWindow {
  /** Always present (possibly undefined) so a preset switch can CLEAR a prior window via merge. */
  dateFrom: string | undefined;
  dateTo: string | undefined;
  /** Client-only label kept in the URL so the chip can re-derive without a round-trip. */
  datePreset: string;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Rolling "last N days" on the LOCAL calendar, so it anchors "today" the same way the
 *  to-date presets (toDatePresetRange) do — one consistent local basis (see #539 WTD decision). */
function localDaysAgo(days: number, now: Date): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - days);
  return formatLocalDate(start);
}

/**
 * Resolve the date control's filter into the contract's date window. Presets are resolved
 * CLIENT-SIDE to concrete local dates (BLUE's getDeals only reads dateFrom/dateTo); "all" emits an
 * EXPLICIT empty window ({dateFrom: undefined, dateTo: undefined}) so switching to All-time clears
 * any prior bounds through mergeFilterParams. All presets anchor "today" on the local calendar.
 */
export function resolveDateWindow(filter: TerminalDateFilter, now = new Date()): DateWindow {
  if (filter.preset === "all") {
    return { datePreset: "all", dateFrom: undefined, dateTo: undefined };
  }
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
  return { datePreset: filter.preset, dateFrom: localDaysAgo(Number(filter.preset), now), dateTo: formatLocalDate(now) };
}

const NAMED_PRESETS = new Set(["7", "30", "60", "90", "wtd", "mtd", "qtd", "ytd", "all"]);

/** Reconstruct the date control's filter from a stored FilterBar value. A custom preset with no
 *  start, or an unrecognized preset, falls back to all-time. */
export function dateFilterFromValue(value: {
  datePreset?: string;
  dateFrom?: string;
  dateTo?: string;
}): TerminalDateFilter {
  const preset = value.datePreset;
  if (preset && NAMED_PRESETS.has(preset)) {
    return { preset: preset as Exclude<TerminalDateFilter["preset"], "custom"> };
  }
  // Custom preset, OR a stale/hand-crafted URL with bounds but no recognized preset: show the
  // actual window (custom) so the control matches what the server filters. customEnd only when set.
  if (value.dateFrom) {
    return value.dateTo
      ? { preset: "custom", customStart: value.dateFrom, customEnd: value.dateTo }
      : { preset: "custom", customStart: value.dateFrom };
  }
  return { preset: "all" };
}
