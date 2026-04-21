export type DirectorRepWorkspaceRow = {
  repId: string;
  repName: string;
  activeDeals: number;
  pipelineValue: number;
  winRate: number;
  activityScore: number;
  staleDeals: number;
  staleLeads: number;
};

export type DirectorRepSortKey =
  | "pipeline"
  | "staleRisk"
  | "activity"
  | "winRate"
  | "activeDeals"
  | "repName";

export function clampDirectorRepWorkspacePage(input: {
  page: number;
  totalRows: number;
  pageSize: number;
}) {
  const totalPages = Math.max(1, Math.ceil(input.totalRows / input.pageSize));
  return Math.min(Math.max(1, input.page), totalPages);
}

function staleRiskScore(row: DirectorRepWorkspaceRow) {
  return row.staleDeals * 10 + row.staleLeads * 8 + row.activeDeals;
}

export function buildDirectorRepWorkspaceState(
  rows: DirectorRepWorkspaceRow[],
  input: {
    query: string;
    sortKey: DirectorRepSortKey;
    page: number;
    pageSize: number;
  }
) {
  const normalizedQuery = input.query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? rows.filter((row) => row.repName.toLowerCase().includes(normalizedQuery))
    : rows.slice();

  filtered.sort((left, right) => {
    if (input.sortKey === "repName") return left.repName.localeCompare(right.repName);
    if (input.sortKey === "activeDeals") return right.activeDeals - left.activeDeals;
    if (input.sortKey === "winRate") return right.winRate - left.winRate;
    if (input.sortKey === "activity") return right.activityScore - left.activityScore;
    if (input.sortKey === "staleRisk") return staleRiskScore(right) - staleRiskScore(left);
    return right.pipelineValue - left.pipelineValue;
  });

  const totalRows = filtered.length;
  const page = clampDirectorRepWorkspacePage({
    page: input.page,
    totalRows,
    pageSize: input.pageSize,
  });
  const start = (page - 1) * input.pageSize;
  const rowsForPage = filtered.slice(start, start + input.pageSize);

  return {
    page,
    pageSize: input.pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / input.pageSize)),
    rows: rowsForPage,
  };
}
