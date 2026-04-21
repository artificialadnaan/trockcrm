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

function normalizeDirectorRepWorkspacePageSize(pageSize: number) {
  return Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 1;
}

export function clampDirectorRepWorkspacePage(input: {
  page: number;
  totalRows: number;
  pageSize: number;
}) {
  const normalizedPageSize = normalizeDirectorRepWorkspacePageSize(input.pageSize);
  const totalPages = Math.max(1, Math.ceil(input.totalRows / normalizedPageSize));
  return Math.min(Math.max(1, input.page), totalPages);
}

function staleRiskScore(row: DirectorRepWorkspaceRow) {
  return row.staleDeals * 10 + row.staleLeads * 8 + row.activeDeals;
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
}

function compareDescending(left: number, right: number) {
  return right - left;
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
  const pageSize = normalizeDirectorRepWorkspacePageSize(input.pageSize);
  const normalizedQuery = input.query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? rows.filter((row) => row.repName.toLowerCase().includes(normalizedQuery))
    : rows.slice();

  filtered.sort((left, right) => {
    if (input.sortKey === "repName") {
      return compareStrings(left.repName, right.repName) || compareStrings(left.repId, right.repId);
    }

    if (input.sortKey === "activeDeals") {
      return (
        compareDescending(left.activeDeals, right.activeDeals) ||
        compareStrings(left.repName, right.repName) ||
        compareStrings(left.repId, right.repId)
      );
    }

    if (input.sortKey === "winRate") {
      return (
        compareDescending(left.winRate, right.winRate) ||
        compareStrings(left.repName, right.repName) ||
        compareStrings(left.repId, right.repId)
      );
    }

    if (input.sortKey === "activity") {
      return (
        compareDescending(left.activityScore, right.activityScore) ||
        compareStrings(left.repName, right.repName) ||
        compareStrings(left.repId, right.repId)
      );
    }

    if (input.sortKey === "staleRisk") {
      return (
        compareDescending(staleRiskScore(left), staleRiskScore(right)) ||
        compareStrings(left.repName, right.repName) ||
        compareStrings(left.repId, right.repId)
      );
    }

    return (
      compareDescending(left.pipelineValue, right.pipelineValue) ||
      compareStrings(left.repName, right.repName) ||
      compareStrings(left.repId, right.repId)
    );
  });

  const totalRows = filtered.length;
  const page = clampDirectorRepWorkspacePage({
    page: input.page,
    totalRows,
    pageSize,
  });
  const start = (page - 1) * pageSize;
  const rowsForPage = filtered.slice(start, start + pageSize);

  return {
    page,
    pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
    rows: rowsForPage,
  };
}
