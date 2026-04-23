export type StagePageSort = "age_desc" | "updated_desc" | "name_asc" | "value_desc";

export interface StagePageFilters {
  assignedRepId?: string;
  staleOnly: boolean;
  status?: string;
  workflowRoute?: string;
  source?: string;
  regionId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface StagePageQuery {
  page: number;
  pageSize: number;
  sort: StagePageSort;
  search: string;
  filters: StagePageFilters;
}

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const ALLOWED_STAGE_SORTS = new Set<StagePageSort>([
  "age_desc",
  "updated_desc",
  "name_asc",
  "value_desc",
]);

export function normalizeStagePageQuery(input: Record<string, string | undefined>): StagePageQuery {
  const parsedPage = Number(input.page);
  const parsedPageSize = Number(input.pageSize);
  const rawSort = input.sort as StagePageSort | undefined;

  return {
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize: ALLOWED_PAGE_SIZES.has(parsedPageSize) ? parsedPageSize : 25,
    sort: ALLOWED_STAGE_SORTS.has(rawSort ?? "age_desc") ? (rawSort ?? "age_desc") : "age_desc",
    search: input.search?.trim() ?? "",
    filters: {
      assignedRepId: input.assignedRepId,
      staleOnly: input.staleOnly === "true",
      status: input.status,
      workflowRoute: input.workflowRoute,
      source: input.source,
      regionId: input.regionId,
      updatedAfter: input.updatedAfter,
      updatedBefore: input.updatedBefore,
    },
  };
}
