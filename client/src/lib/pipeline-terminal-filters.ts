export type TerminalOutcome = "won" | "lost";
export type TerminalDateFilter =
  | { preset: "7" | "30" | "60" | "90" | "all"; customStart?: undefined; customEnd?: undefined }
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
  return (
    slug === "won" ||
    slug === "lost" ||
    slug === "sent_to_production" ||
    slug === "service_sent_to_production" ||
    slug === "closed_won" ||
    slug === "production_lost" ||
    slug === "service_lost" ||
    slug === "closed_lost"
  );
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
  filters: Record<TerminalOutcome, TerminalDateFilter>
) {
  const params = new URLSearchParams({ includeDd: String(showDd) });
  appendPipelineTerminalDateParams(params, filters);
  return `/deals/pipeline?${params.toString()}`;
}

export function buildDealStageWorkspacePath(input: {
  stageId: string;
  stageSlug?: string | null;
  scope?: string;
  filters: Record<TerminalOutcome, TerminalDateFilter>;
}) {
  const params = new URLSearchParams();
  if (input.scope) params.set("scope", input.scope);
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
  return value === "7" || value === "30" || value === "60" || value === "90" || value === "all";
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
