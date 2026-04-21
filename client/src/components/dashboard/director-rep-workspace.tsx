import { useMemo, useState } from "react";
import {
  buildDirectorRepWorkspaceState,
  type DirectorRepSortKey,
  type DirectorRepWorkspaceRow,
} from "@/lib/director-rep-workspace";

export function DirectorRepWorkspace({
  repCards,
  initialPageSize = 25,
  onSelectRep,
}: {
  repCards: DirectorRepWorkspaceRow[];
  initialPageSize?: number;
  onSelectRep: (repId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<DirectorRepSortKey>("pipeline");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const workspace = useMemo(
    () => buildDirectorRepWorkspaceState(repCards, { query, sortKey, page, pageSize }),
    [page, pageSize, query, repCards, sortKey]
  );

  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-900">Rep performance</h2>
          <p className="mt-1 text-sm text-gray-500">
            Search, sort, and drill into the team without endless scrolling.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search reps"
            className="h-9 rounded-lg border border-gray-200 px-3 text-sm"
          />
          <select
            value={sortKey}
            onChange={(event) => {
              setSortKey(event.target.value as DirectorRepSortKey);
              setPage(1);
            }}
            className="h-9 rounded-lg border border-gray-200 px-3 text-sm"
            aria-label="Sort by"
          >
            <option value="pipeline">Pipeline</option>
            <option value="staleRisk">Stale risk</option>
            <option value="activity">Activity</option>
            <option value="winRate">Win rate</option>
            <option value="activeDeals">Active deals</option>
            <option value="repName">Rep name</option>
          </select>
          <select
            value={String(pageSize)}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            className="h-9 rounded-lg border border-gray-200 px-3 text-sm"
            aria-label="Rows per page"
          >
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto px-5 py-4">
        <table className="min-w-full border-separate border-spacing-y-3">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-widest text-gray-400">
              <th className="px-4 py-2">Rep</th>
              <th className="px-4 py-2">Pipeline</th>
              <th className="px-4 py-2">Win rate</th>
              <th className="px-4 py-2">Activity</th>
              <th className="px-4 py-2">Stale</th>
            </tr>
          </thead>
          <tbody>
            {workspace.rows.map((row) => (
              <tr key={row.repId} className="rounded-2xl bg-gray-50">
                <td className="rounded-l-2xl px-4 py-4">
                  <button
                    type="button"
                    onClick={() => onSelectRep(row.repId)}
                    className="text-sm font-bold text-gray-900 hover:text-[#CC0000]"
                  >
                    {row.repName}
                  </button>
                </td>
                <td className="px-4 py-4 text-sm text-gray-600">${row.pipelineValue.toLocaleString()}</td>
                <td className="px-4 py-4 text-sm text-gray-600">{row.winRate}%</td>
                <td className="px-4 py-4 text-sm text-gray-600">{row.activityScore}</td>
                <td className="rounded-r-2xl px-4 py-4 text-sm text-gray-600">
                  {row.staleDeals} deals, {row.staleLeads} leads
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {workspace.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No reps found.</p>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-500">
            Page {workspace.page} of {workspace.totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={workspace.page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={workspace.page >= workspace.totalPages}
              onClick={() => setPage((current) => Math.min(workspace.totalPages, current + 1))}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
