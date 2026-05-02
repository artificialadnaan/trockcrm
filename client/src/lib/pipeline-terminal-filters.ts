export type TerminalOutcome = "won" | "lost";
export type TerminalDateFilter =
  | { preset: "30" | "60" | "90"; customStart?: undefined; customEnd?: undefined }
  | { preset: "custom"; customStart: string; customEnd?: string };

const TERMINAL_FILTER_STORAGE_KEYS: Record<TerminalOutcome, string> = {
  won: "pipeline_terminal_filter_won",
  lost: "pipeline_terminal_filter_lost",
};
const DEFAULT_TERMINAL_DATE_FILTER: TerminalDateFilter = { preset: "30" };

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

export function daysAgo(days: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateParam(date);
}

export function readTerminalDateFilter(outcome: TerminalOutcome): TerminalDateFilter {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_DATE_FILTER;
  const raw = window.localStorage.getItem(TERMINAL_FILTER_STORAGE_KEYS[outcome]);
  if (!raw) return DEFAULT_TERMINAL_DATE_FILTER;

  try {
    const parsed = JSON.parse(raw) as Partial<TerminalDateFilter>;
    if (parsed.preset === "30" || parsed.preset === "60" || parsed.preset === "90") {
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

export function getTerminalDateFilterLabel(filter: TerminalDateFilter) {
  return filter.preset === "custom" ? "custom" : `${filter.preset}d`;
}

function appendTerminalDateParams(
  params: URLSearchParams,
  outcome: TerminalOutcome,
  filter: TerminalDateFilter
) {
  const prefix = outcome;
  if (filter.preset === "custom") {
    params.set(`${prefix}_since`, filter.customStart);
    if (filter.customEnd) params.set(`${prefix}_until`, filter.customEnd);
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
