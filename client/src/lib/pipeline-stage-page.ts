export interface StagePageFilters {
  assignedRepId?: string;
  estimateSentFrom?: string;
  estimateSentTo?: string;
  staleOnly: boolean;
  status?: string;
  workflowRoute?: string;
  source?: string;
  regionId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  minAgeDays?: string;
  maxAgeDays?: string;
  wonSince?: string;
  wonUntil?: string;
  wonAllTime?: boolean;
  lostSince?: string;
  lostUntil?: string;
  lostAllTime?: boolean;
}

export interface StagePageQuery {
  page: number;
  pageSize: number;
  sort: string;
  search: string;
  filters: StagePageFilters;
}

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const ESTIMATE_SENT_PRESETS = new Set(["7", "30", "60", "90"]);

function formatDateParam(date: Date) {
  return date.toISOString().split("T")[0];
}

function daysAgo(days: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateParam(date);
}

export function normalizeStagePageQuery(input: Record<string, string | undefined>): StagePageQuery {
  const parsedPage = Number(input.page);
  const parsedPageSize = Number(input.pageSize);
  const estimateSentPreset = input.estimate_sent_preset;
  const estimateSentFrom =
    input.estimateSentFrom ??
    input.estimate_sent_since ??
    (estimateSentPreset && ESTIMATE_SENT_PRESETS.has(estimateSentPreset)
      ? daysAgo(Number(estimateSentPreset))
      : undefined);

  return {
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize: ALLOWED_PAGE_SIZES.has(parsedPageSize) ? parsedPageSize : 25,
    sort: input.sort ?? "",
    search: input.search?.trim() ?? "",
    filters: {
      assignedRepId: input.assignedRepId,
      estimateSentFrom,
      estimateSentTo: input.estimateSentTo ?? input.estimate_sent_until,
      staleOnly: input.staleOnly === "true",
      status: input.status,
      workflowRoute: input.workflowRoute,
      source: input.source,
      regionId: input.regionId,
      updatedAfter: input.updatedAfter,
      updatedBefore: input.updatedBefore,
      minAgeDays: input.minAgeDays,
      maxAgeDays: input.maxAgeDays,
      wonSince: input.won_since,
      wonUntil: input.won_until,
      wonAllTime: input.won_all_time === "true",
      lostSince: input.lost_since,
      lostUntil: input.lost_until,
      lostAllTime: input.lost_all_time === "true",
    },
  };
}
