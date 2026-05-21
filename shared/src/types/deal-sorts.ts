export type CanonicalDealListSort = "newest" | "oldest";

export const CANONICAL_DEAL_LIST_SORTS = ["newest", "oldest"] as const;

export type LegacyStagePageSort = "age_desc" | "updated_desc" | "name_asc" | "value_desc";

export type StagePageSort = CanonicalDealListSort | LegacyStagePageSort;

const STAGE_PAGE_SORTS = new Set<StagePageSort>([
  ...CANONICAL_DEAL_LIST_SORTS,
  "age_desc",
  "updated_desc",
  "name_asc",
  "value_desc",
]);

export function normalizeStagePageSort(value: string | undefined): StagePageSort {
  return STAGE_PAGE_SORTS.has(value as StagePageSort) ? (value as StagePageSort) : "newest";
}
