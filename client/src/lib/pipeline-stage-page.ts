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
const ESTIMATE_SENT_PRESETS = new Set(["7", "30", "60", "90", "wtd", "mtd", "qtd", "ytd"]);

function formatDateParam(date: Date) {
  return date.toISOString().split("T")[0];
}

function daysAgo(days: number, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - days);
  return formatDateParam(date);
}

function formatLocalDateParam(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function estimateSentPresetRange(preset: string, now = new Date()) {
  if (preset === "wtd") {
    // Week-to-date, Sunday-anchored on the user's local calendar (one platform-wide WTD).
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - start.getDay());
    return { from: formatLocalDateParam(start), to: formatLocalDateParam(now) };
  }
  if (preset === "mtd") {
    return {
      from: formatLocalDateParam(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: formatLocalDateParam(now),
    };
  }
  if (preset === "qtd") {
    return {
      from: formatLocalDateParam(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)),
      to: formatLocalDateParam(now),
    };
  }
  if (preset === "ytd") {
    return {
      from: formatLocalDateParam(new Date(now.getFullYear(), 0, 1)),
      to: formatLocalDateParam(now),
    };
  }
  return { from: daysAgo(Number(preset), now), to: undefined };
}

export function normalizeStagePageQuery(input: Record<string, string | undefined>): StagePageQuery {
  const parsedPage = Number(input.page);
  const parsedPageSize = Number(input.pageSize);
  const estimateSentPreset = input.estimate_sent_preset;
  const estimateSentPresetRangeValue =
    estimateSentPreset && ESTIMATE_SENT_PRESETS.has(estimateSentPreset)
      ? estimateSentPresetRange(estimateSentPreset)
      : null;
  const estimateSentFrom =
    input.estimateSentFrom ??
    input.estimate_sent_since ??
    estimateSentPresetRangeValue?.from;

  return {
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize: ALLOWED_PAGE_SIZES.has(parsedPageSize) ? parsedPageSize : 25,
    sort: input.sort ?? "",
    search: input.search?.trim() ?? "",
    filters: {
      assignedRepId: input.assignedRepId,
      estimateSentFrom,
      estimateSentTo: input.estimateSentTo ?? input.estimate_sent_until ?? estimateSentPresetRangeValue?.to,
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
