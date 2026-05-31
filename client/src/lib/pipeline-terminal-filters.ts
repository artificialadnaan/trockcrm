import {
  CANONICAL_TERMINAL_DEAL_STAGE_SLUGS,
  LOST_DEAL_STAGE_SLUGS,
  WON_DEAL_STAGE_SLUGS,
  type WorkflowRoute,
} from "@trock-crm/shared/types";
import { getEffectiveDealValue } from "@trock-crm/shared/types";

export const TERMINAL_STAGE_SLUGS = [
  ...new Set([...CANONICAL_TERMINAL_DEAL_STAGE_SLUGS, ...WON_DEAL_STAGE_SLUGS, ...LOST_DEAL_STAGE_SLUGS]),
] as readonly string[];

const TERMINAL_STAGE_SLUG_SET = new Set<string>(TERMINAL_STAGE_SLUGS);
const WON_STAGE_SLUG_SET = new Set<string>(WON_DEAL_STAGE_SLUGS);
const LOST_STAGE_SLUG_SET = new Set<string>(LOST_DEAL_STAGE_SLUGS);

export function isTerminalStage(stageSlug: string | null | undefined, workflowRoute?: WorkflowRoute | null) {
  if (!stageSlug) return false;
  void workflowRoute;
  return TERMINAL_STAGE_SLUG_SET.has(stageSlug);
}

export function getTerminalStageOutcome(
  stageSlug: string | null | undefined,
  workflowRoute?: WorkflowRoute | null
): TerminalOutcome | null {
  if (!stageSlug) return null;
  void workflowRoute;
  if (WON_STAGE_SLUG_SET.has(stageSlug)) return "won";
  if (LOST_STAGE_SLUG_SET.has(stageSlug)) return "lost";
  return null;
}

export type TerminalOutcome = "won" | "lost";
export type TerminalDateFilter =
  | {
      preset: "7" | "30" | "60" | "90" | "wtd" | "mtd" | "qtd" | "ytd" | "all";
      customStart?: undefined;
      customEnd?: undefined;
    }
  | { preset: "custom"; customStart: string; customEnd?: string };

const TERMINAL_FILTER_STORAGE_KEYS: Record<TerminalOutcome, string> = {
  won: "deals.kanban.wonFilter",
  lost: "deals.kanban.lostFilter",
};
const LEGACY_TERMINAL_FILTER_STORAGE_KEYS: Record<TerminalOutcome, string> = {
  won: "pipeline_terminal_filter_won",
  lost: "pipeline_terminal_filter_lost",
};
const DEFAULT_TERMINAL_DATE_FILTER: TerminalDateFilter = { preset: "all" };

export function isTerminalOutcomeSlug(slug: string): slug is TerminalOutcome {
  return slug === "won" || slug === "lost";
}

export function isTerminalPipelineStageSlug(slug: string) {
  return isTerminalStage(slug);
}

type DealWithStageSlug = {
  stageSlug?: string | null;
  bidBoardStageSlug?: string | null;
  stage?: { slug?: string | null } | null;
};

type DealWithValue = DealWithStageSlug & {
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
  onHold?: boolean | null;
};

function hasTerminalDealStage(deal: DealWithStageSlug) {
  return isTerminalStage(deal.bidBoardStageSlug) || isTerminalStage(deal.stageSlug ?? deal.stage?.slug ?? null);
}

export function numericDealValue(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function activePipelineDealValue(deal: DealWithValue) {
  return getEffectiveDealValue(deal);
}

export function excludeTerminalDeals<T extends DealWithStageSlug>(deals: T[]) {
  return deals.filter((deal) => !hasTerminalDealStage(deal));
}

export function calculateActivePipelineTotal<T extends DealWithValue>(deals: T[]) {
  const activeDeals = excludeTerminalDeals(deals);
  return {
    amount: activeDeals.reduce((sum, deal) => sum + activePipelineDealValue(deal), 0),
    count: activeDeals.length,
  };
}

function formatDateParam(date: Date) {
  return date.toISOString().split("T")[0];
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function clampDateToToday(value: string, now = new Date()) {
  if (!isIsoDate(value)) return value;
  const today = getTodayDateParam(now);
  return value > today ? today : value;
}

export function daysAgo(days: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateParam(date);
}

/**
 * CANONICAL platform-wide client date-preset resolver (window math). ONE source of truth so
 * every surface — the deals list / kanban FilterBar (toDatePresetRange), the dashboard period
 * tabs (getDashboardPeriodDateRange), and the director/rep dashboards (presetToDateRange) — maps
 * the same preset to the same {from,to} window. All boundaries are the user's LOCAL calendar
 * (presets are business-day concepts, not UTC instants), and WTD is Sunday-anchored (D-7 /
 * PR #539) so the Sunday weekly-won meeting's week is consistent everywhere. Inclusive `to` = today.
 * Numeric look-back (7/30/60/90 via daysAgo) and "custom"/"all" stay caller concerns.
 */
export type DatePreset =
  | "today"
  | "wtd"
  | "mtd"
  | "qtd"
  | "ytd"
  | "last_month"
  | "last_quarter"
  | "last_year";

const BUSINESS_TIMEZONE = "America/Chicago";

// Today's calendar date in the BUSINESS tz (Central) as YYYY-MM-DD. Every preset window anchors to this,
// so a rep in ANY timezone sees the OFFICE's week/month/quarter -- matching the server's canonical F1
// definition (server/src/lib/period.ts) at the cross-tz boundary. "This week" is the business's Central
// Sunday-Saturday week: a Pacific user late Saturday night, while it is already Sunday in CT, is in the
// new CT week (F1 is canonical; the client aligns to it, not the reverse).
function businessTodayParam(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}
// Parse a YYYY-MM-DD at UTC noon (time-of-day discarded) so day-of-week / day arithmetic never trips a
// DST or local-midnight boundary -- mirrors F1's shiftDays / dayOfWeek.
function ymdParts(isoDate: string): { year: number; month: number; day: number; dow: number } {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), dow: d.getUTCDay() };
}
function ymdToParam(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day, 12)).toISOString().slice(0, 10);
}

export function resolveDatePreset(preset: DatePreset, now = new Date()): { from: string; to: string } {
  const today = businessTodayParam(now);
  const { year, month, day, dow } = ymdParts(today);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "wtd":
      // Sunday-anchored CENTRAL week (dow: Sunday = 0 -> walk back to the most-recent Sunday in CT).
      return { from: ymdToParam(year, month, day - dow), to: today };
    case "mtd":
      return { from: ymdToParam(year, month, 1), to: today };
    case "qtd":
      return { from: ymdToParam(year, Math.floor(month / 3) * 3, 1), to: today };
    case "ytd":
      return { from: `${year}-01-01`, to: today };
    case "last_month": {
      const end = ymdParts(ymdToParam(year, month, 0)); // day 0 = last day of the previous month
      return { from: ymdToParam(end.year, end.month, 1), to: ymdToParam(end.year, end.month, end.day) };
    }
    case "last_quarter": {
      const end = ymdParts(ymdToParam(year, Math.floor(month / 3) * 3, 0)); // last day of the previous quarter
      return {
        from: ymdToParam(end.year, Math.floor(end.month / 3) * 3, 1),
        to: ymdToParam(end.year, end.month, end.day),
      };
    }
    case "last_year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
}

/**
 * Terminal-filter preset -> window. Thin delegate to {@link resolveDatePreset} (the canonical
 * resolver) so the FilterBar / deals-list date control shares the exact window math with the
 * dashboards. Behavior-preserving: these four presets already resolved local before.
 */
export function toDatePresetRange(
  preset: Extract<TerminalDateFilter["preset"], "wtd" | "mtd" | "qtd" | "ytd">,
  now = new Date()
) {
  return resolveDatePreset(preset, now);
}

export function readTerminalDateFilter(outcome: TerminalOutcome): TerminalDateFilter {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_DATE_FILTER;
  const raw =
    window.localStorage.getItem(TERMINAL_FILTER_STORAGE_KEYS[outcome]) ??
    window.localStorage.getItem(LEGACY_TERMINAL_FILTER_STORAGE_KEYS[outcome]);
  if (!raw) return DEFAULT_TERMINAL_DATE_FILTER;

  try {
    const parsed = JSON.parse(raw) as Partial<TerminalDateFilter>;
    if (
      parsed.preset === "7" ||
      parsed.preset === "30" ||
      parsed.preset === "60" ||
      parsed.preset === "90" ||
      parsed.preset === "wtd" ||
      parsed.preset === "mtd" ||
      parsed.preset === "qtd" ||
      parsed.preset === "ytd" ||
      parsed.preset === "all"
    ) {
      return { preset: parsed.preset };
    }
    if (parsed.preset === "custom" && typeof parsed.customStart === "string" && parsed.customStart) {
      return {
        preset: "custom",
        customStart: parsed.customStart,
        customEnd: typeof parsed.customEnd === "string" ? parsed.customEnd : undefined,
      };
    }
  } catch {
    return DEFAULT_TERMINAL_DATE_FILTER;
  }

  return DEFAULT_TERMINAL_DATE_FILTER;
}

export function writeTerminalDateFilter(outcome: TerminalOutcome, filter: TerminalDateFilter) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TERMINAL_FILTER_STORAGE_KEYS[outcome], JSON.stringify(filter));
}

export function getTodayDateParam(now = new Date()) {
  return daysAgo(0, now);
}

export function getTerminalDateFilterLabel(filter: TerminalDateFilter) {
  if (filter.preset === "custom") return "Custom";
  if (filter.preset === "all") return "All time";
  if (filter.preset === "wtd") return "WTD";
  if (filter.preset === "mtd") return "MTD";
  if (filter.preset === "qtd") return "QTD";
  if (filter.preset === "ytd") return "YTD";
  return `Last ${filter.preset}d`;
}

function appendTerminalDateParams(
  params: URLSearchParams,
  outcome: TerminalOutcome,
  filter: TerminalDateFilter
) {
  const prefix = outcome;
  if (filter.preset === "all") {
    params.set(`${prefix}_all_time`, "true");
    return;
  }
  if (filter.preset === "custom") {
    params.set(`${prefix}_since`, clampDateToToday(filter.customStart));
    if (filter.customEnd) params.set(`${prefix}_until`, clampDateToToday(filter.customEnd));
    return;
  }

  if (
    filter.preset === "wtd" ||
    filter.preset === "mtd" ||
    filter.preset === "qtd" ||
    filter.preset === "ytd"
  ) {
    const range = toDatePresetRange(filter.preset);
    params.set(`${prefix}_since`, range.from);
    params.set(`${prefix}_until`, range.to);
    return;
  }

  params.set(`${prefix}_since`, daysAgo(Number(filter.preset)));
}

export function appendPipelineTerminalDateParams(
  params: URLSearchParams,
  filters: Record<TerminalOutcome, TerminalDateFilter>
) {
  appendTerminalDateParams(params, "won", filters.won);
  appendTerminalDateParams(params, "lost", filters.lost);
}

export function buildPipelineRequestPath(
  showDd: boolean,
  filters: Record<TerminalOutcome, TerminalDateFilter>,
  scope?: string
) {
  const params = new URLSearchParams({ includeDd: String(showDd) });
  if (scope) params.set("scope", scope);
  appendPipelineTerminalDateParams(params, filters);
  return `/deals/pipeline?${params.toString()}`;
}

export function buildDealStageWorkspacePath(input: {
  stageId: string;
  stageSlug?: string | null;
  scope?: string;
  filters: Record<TerminalOutcome, TerminalDateFilter>;
  queryParams?: URLSearchParams | Record<string, string | null | undefined>;
}) {
  const params = new URLSearchParams();
  if (input.scope) params.set("scope", input.scope);
  if (input.queryParams) {
    const entries =
      input.queryParams instanceof URLSearchParams
        ? Array.from(input.queryParams.entries())
        : Object.entries(input.queryParams);
    for (const [key, value] of entries) {
      if (!value) continue;
      if (key === "assignedRepId" || key.startsWith("estimate_sent_")) {
        params.set(key, value);
      }
    }
  }
  if (input.stageSlug && isTerminalOutcomeSlug(input.stageSlug)) {
    appendTerminalDateParams(params, input.stageSlug, input.filters[input.stageSlug]);
  }

  const query = params.toString();
  return `/deals/stages/${input.stageId}${query ? `?${query}` : ""}`;
}

export function getActivePipelineColumns<T extends { stage: { slug: string } }>(columns: T[]) {
  return columns.filter((column) => !isTerminalPipelineStageSlug(column.stage.slug));
}

function isTerminalPreset(value: string | null): value is Exclude<TerminalDateFilter["preset"], "custom"> {
  return (
    value === "7" ||
    value === "30" ||
    value === "60" ||
    value === "90" ||
    value === "wtd" ||
    value === "mtd" ||
    value === "qtd" ||
    value === "ytd" ||
    value === "all"
  );
}

function readTerminalDateFilterFromSearchParams(
  params: URLSearchParams,
  outcome: TerminalOutcome
): TerminalDateFilter | null {
  const preset = params.get(`${outcome}_preset`);
  if (isTerminalPreset(preset)) return { preset };

  if (params.get(`${outcome}_all_time`) === "true") return { preset: "all" };

  const since = params.get(`${outcome}_since`);
  const until = params.get(`${outcome}_until`);
  if (since) {
    return {
      preset: "custom",
      customStart: clampDateToToday(since),
      customEnd: until ? clampDateToToday(until) : undefined,
    };
  }

  return null;
}

export function readTerminalDateFiltersFromSearchParams(
  params: URLSearchParams
): Record<TerminalOutcome, TerminalDateFilter> {
  return {
    won: readTerminalDateFilterFromSearchParams(params, "won") ?? DEFAULT_TERMINAL_DATE_FILTER,
    lost: readTerminalDateFilterFromSearchParams(params, "lost") ?? DEFAULT_TERMINAL_DATE_FILTER,
  };
}

export function setTerminalDateFilterSearchParams(
  params: URLSearchParams,
  outcome: TerminalOutcome,
  filter: TerminalDateFilter
) {
  params.delete(`${outcome}_preset`);
  params.delete(`${outcome}_since`);
  params.delete(`${outcome}_until`);
  params.delete(`${outcome}_all_time`);

  if (filter.preset === "all") {
    params.set(`${outcome}_all_time`, "true");
    return;
  }

  if (filter.preset === "custom") {
    params.set(`${outcome}_since`, clampDateToToday(filter.customStart));
    if (filter.customEnd) params.set(`${outcome}_until`, clampDateToToday(filter.customEnd));
    return;
  }

  params.set(`${outcome}_preset`, filter.preset);
}
