export function getStaleLeadWatchlistMeta(_range?: {
  from?: string;
  to?: string;
}) {
  return {
    label: "Current-state lead watchlist",
    detail: "Snapshot as of today. Not filtered by the selected reporting period.",
  };
}
