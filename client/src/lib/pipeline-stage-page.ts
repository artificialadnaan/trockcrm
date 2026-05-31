import { LOST_DEAL_STAGE_SLUGS, WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";

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

/**
 * The deal-stage ids the A′ stage-page LIST queries through getDeals. Mirrors the server stage endpoint
 * (getDealStagePage, service.ts:2700-2713): a Won/Lost route stage broadens to every stage id in its
 * terminal alias family (WON/LOST_DEAL_STAGE_SLUGS — the SAME shared constant the server broadens with),
 * so the list reconciles to the family-counting header; any other stage stays its single route id.
 */
export function getStagePageListStageIds(
  stage: { id: string; slug: string },
  allStages: ReadonlyArray<{ id: string; slug: string }>
): string[] {
  const family: readonly string[] | null = WON_DEAL_STAGE_SLUGS.includes(stage.slug)
    ? WON_DEAL_STAGE_SLUGS
    : LOST_DEAL_STAGE_SLUGS.includes(stage.slug)
      ? LOST_DEAL_STAGE_SLUGS
      : null;
  if (!family) return [stage.id];
  const familyIds = allStages.filter((item) => family.includes(item.slug)).map((item) => item.id);
  // Fall back to the route stage id if the family can't be resolved (stage list empty/failed to load),
  // so the list stays SCOPED to the route stage rather than rendering unscoped (all deals) — Codex P2.
  return familyIds.length > 0 ? familyIds : [stage.id];
}

/** Is this a Won-family stage? The Won board/summary excludes on-hold (migration parking-lot) deals
 *  from its count; a Won stage-page list sets `excludeOnHold` to reconcile. Lost stages do NOT (the
 *  summary only applies the exclusion for Won), so this is Won-specific. */
export function isWonStagePageStage(stageSlug: string): boolean {
  return WON_DEAL_STAGE_SLUGS.includes(stageSlug);
}

/** Bare stage-route filter params (set by the legacy grid + dashboard navigation). The A′ bar OWNS the
 *  list's filter state, so on mount these are translated into the fb_ namespace (where a bar dimension
 *  exists) and stripped — see getStagePageBarRedirectSearch. */
const STAGE_ROUTE_FILTER_KEYS = [
  "assignedRepId",
  "regionId",
  "source",
  "status",
  "workflowRoute",
  "search",
  "updatedAfter",
  "updatedBefore",
  "minAgeDays",
  "maxAgeDays",
  "won_since",
  "won_until",
  "won_all_time",
  "lost_since",
  "lost_until",
  "lost_all_time",
  "estimate_sent_since",
  "estimate_sent_until",
  "estimate_sent_all_time",
  "estimate_sent_preset",
  "staleOnly",
] as const;

/** Bare key -> FilterBarValue key, for the inherited filters the bar can represent. Un-mappable legacy
 *  params (updated-axis dates, source, won/lost/estimate-sent windows, staleOnly) are stripped without
 *  translation: the A′ bar is outcome-axis, so they are superseded by its own Date / Stalled controls. */
const STAGE_ROUTE_FILTER_TO_BAR_KEY: Record<string, string> = {
  assignedRepId: "assignedRepId",
  regionId: "regionId",
  status: "status",
  workflowRoute: "workflowRoute",
  search: "search",
  minAgeDays: "minAgeDays",
  maxAgeDays: "maxAgeDays",
};

/**
 * Mount redirect for the A′ stage page. If the URL still carries bare stage-route filter params,
 * returns the new search string with those filters TRANSLATED into the bar's fb_ namespace (where a bar
 * dimension exists) and ALL bare filter params removed — so the bar shows + can Clear them, and the
 * header summary reads no filters (whole-stage, the signed-off intent). Returns null when there is
 * nothing to translate (no redirect). Preserves scope/page/sort and any fb_ the user already set (an
 * explicit fb_ wins over the inherited bare value).
 */
export function getStagePageBarRedirectSearch(params: URLSearchParams, prefix = "fb_"): string | null {
  if (!STAGE_ROUTE_FILTER_KEYS.some((key) => params.has(key))) return null;
  const next = new URLSearchParams(params);
  for (const [bareKey, barKey] of Object.entries(STAGE_ROUTE_FILTER_TO_BAR_KEY)) {
    const value = params.get(bareKey);
    const fbKey = `${prefix}${barKey}`;
    if (value && !next.has(fbKey)) next.set(fbKey, value);
  }
  for (const key of STAGE_ROUTE_FILTER_KEYS) next.delete(key);
  return next.toString();
}
