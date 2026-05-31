import { LOST_DEAL_STAGE_SLUGS, WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import type { DealFilters } from "@/hooks/use-deals";

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
  return allStages.filter((item) => family.includes(item.slug)).map((item) => item.id);
}

/**
 * Translate the bare stage-route query (the filters the header summary applies via useDealStagePage)
 * into the DealFilters the A′ list runs through getDeals, so the list defaults to the header's
 * population (the FilterBar then refines it). Fields with no getDeals equivalent — `staleOnly` and the
 * Lost date window — are not mappable here and fall outside the no-bar-filter reconciliation.
 */
export function mapStageRouteFiltersToDealFilters(
  query: Pick<StagePageQuery, "search" | "filters">
): Partial<DealFilters> {
  const f = query.filters;
  const base: Partial<DealFilters> = {};
  if (query.search) base.search = query.search;
  if (f.assignedRepId) base.assignedRepId = f.assignedRepId;
  if (f.regionId) base.regionId = f.regionId;
  if (f.source) base.source = f.source;
  if (f.status === "active" || f.status === "on_hold" || f.status === "inactive") base.status = f.status;
  if (f.workflowRoute === "normal" || f.workflowRoute === "service") base.workflowRoute = f.workflowRoute;
  if (f.updatedAfter) base.updatedFrom = f.updatedAfter;
  if (f.updatedBefore) base.updatedTo = f.updatedBefore;
  if (f.minAgeDays) base.minAgeDays = Number(f.minAgeDays);
  if (f.maxAgeDays) base.maxAgeDays = Number(f.maxAgeDays);
  if (f.estimateSentFrom) base.estimateSentFrom = f.estimateSentFrom;
  if (f.estimateSentTo) base.estimateSentTo = f.estimateSentTo;
  if (f.wonSince) base.wonClosedFrom = f.wonSince;
  if (f.wonUntil) base.wonClosedTo = f.wonUntil;
  return base;
}
