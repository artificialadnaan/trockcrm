import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PipelineStageTable, type PipelineStageTableColumn } from "@/components/pipeline/pipeline-stage-table";
import { useLeads, type LeadRecord } from "@/hooks/use-leads";
import { useFilterState } from "@/components/filters/use-filter-state";
import { FilterBar, type FilterDimension, type FilterBarOptions } from "@/components/filters/filter-bar";
import { filterBarValueToLeadFilters, getLeadDisplayDate } from "./leads-filterbar-adapter";
import { formatShortDate } from "@/lib/deal-utils";

export interface LeadsListSectionProps {
  scope?: "mine" | "team" | "all";
  /**
   * Shared FilterBar config for the leads surface (Wave 1). Mirrors the deals pattern: URL-backed
   * state (useFilterState) + the shared <FilterBar>, mapped to LeadFilters via the leads adapter
   * (lead-status variant, outcome-aware date, OMIT value/workflow/region). Scope is page-inherited
   * unless the bar owns the dimension.
   */
  filterBar: { dimensions: FilterDimension[]; options?: FilterBarOptions };
}

const LEAD_STATUS_LABEL: Record<LeadRecord["status"], string> = {
  open: "Open",
  converted: "Converted",
  disqualified: "Disqualified",
};

// The /leads board already owns bare search/scope/assignedRepId URL params; namespace the list's
// FilterBar params so list filtering never mutates the board above it (Codex #577).
const LEADS_LIST_PARAM_PREFIX = "ll_";

// Bound the list query: this surface replaced a small preview with a full table, and listLeads has no
// LIMIT — so without a cap every load/filter change would fetch AND render every active+converted+
// disqualified lead on a large tenant (Codex #577 P2). The client requests at most this many rows and
// the server enforces the same cap; full offset pagination is the documented BLUE follow-up.
export const LEADS_LIST_PAGE_SIZE = 100;

export function LeadsListSection({ scope, filterBar }: LeadsListSectionProps) {
  const navigate = useNavigate();
  const { filters: urlFilters, setFilters, resetFilters } = useFilterState(LEADS_LIST_PARAM_PREFIX);
  const filterBarOwnsScope = filterBar.dimensions.includes("scope");

  // Stage label map from the bar's stage options (the mount builds these from the board stages), so
  // the Stage column shows a name without a second stage fetch.
  const stageNameById = useMemo(
    () => new Map((filterBar.options?.stages ?? []).map((stage) => [stage.value, stage.label])),
    [filterBar.options?.stages]
  );

  const leadFilters = filterBarValueToLeadFilters(urlFilters);
  // Drop a stale/hidden rep filter: when the Rep dimension isn't rendered (scope=mine, or a non-admin),
  // a leftover namespaced `ll_assignedRepId` must NOT silently narrow the list — the server ANDs it with
  // scope=mine, so an invisible filter would empty/narrow the list with no control to clear it (Codex #577 P2).
  if (!filterBar.dimensions.includes("rep")) delete leadFilters.assignedRepId;
  const leadArgs = {
    ...leadFilters,
    // Scope is the page toggle's (inherited) unless the bar renders a scope control.
    scope: filterBarOwnsScope ? urlFilters.scope ?? scope : scope,
    // Show every lifecycle; the Status dimension narrows it (no implicit open-only filter like the board).
    isActive: "all" as const,
    // Cap the fetch so the full lead table is never an unbounded query (Codex #577 P2). The server
    // enforces the same ceiling; refine filters to narrow when the cap is hit.
    limit: LEADS_LIST_PAGE_SIZE,
  };
  const { leads, loading, error } = useLeads(leadArgs);
  // When the returned set hits the cap there may be more leads than shown — surface that honestly rather
  // than silently truncating (the count is server-capped; full pagination is the BLUE follow-up).
  const isCapped = leads.length >= LEADS_LIST_PAGE_SIZE;

  const columns: Array<PipelineStageTableColumn<LeadRecord>> = [
    {
      key: "name",
      header: "Lead",
      render: (lead) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">{lead.name}</p>
          <p className="mt-1 truncate text-xs font-semibold text-slate-500">
            {lead.companyName ?? "Company pending"}
          </p>
        </div>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      // Prefer the row's authoritative stageName (covers alias stages listLeads returns); fall back to the
      // canonical board-options map only when the server hasn't supplied it (Codex #577 P2).
      render: (lead) => (
        <span className="text-sm font-semibold text-slate-600">
          {lead.stageName ?? stageNameById.get(lead.stageId) ?? "—"}
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      render: (lead) => (
        <span className="text-sm font-semibold text-slate-600">{lead.assignedRepName ?? "Unassigned"}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (lead) => (
        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
          {LEAD_STATUS_LABEL[lead.status]}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      render: (lead) => <span className="text-sm font-semibold tabular-nums text-slate-600">{formatShortDate(getLeadDisplayDate(lead))}</span>,
    },
  ];

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-200 p-4">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">Lead list</p>
        <h2 className="mt-1 text-xl font-black uppercase text-slate-950">Filter & scan leads</h2>
        <p className="mt-1 text-sm font-medium text-slate-500">
          Filter the full lead list without changing the board above.
        </p>
      </div>

      <div className="border-b border-gray-200 bg-[#f7f8fb] p-4">
        <FilterBar
          dimensions={filterBar.dimensions}
          options={filterBar.options}
          value={urlFilters}
          onChange={setFilters}
          // Preserve the board-owned scope on Clear unless the bar itself renders the scope control.
          onReset={() => resetFilters(filterBarOwnsScope ? [] : ["scope"])}
        />
      </div>

      <div className="p-4">
        {error ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            {error}
          </div>
        ) : loading && leads.length === 0 ? (
          <p className="py-8 text-center text-sm font-semibold text-slate-500">Loading leads...</p>
        ) : leads.length === 0 ? (
          <p className="py-8 text-center text-sm font-semibold text-slate-500">No leads match these filters.</p>
        ) : (
          <>
            <PipelineStageTable
              rows={leads}
              columns={columns}
              // Pagination is a BLUE follow-up (the leads endpoint isn't offset-paginated yet); show the
              // capped set on one page with a record count until page/limit land server-side.
              pagination={{ page: 1, pageSize: leads.length || 1, total: leads.length, totalPages: 1 }}
              onPageChange={() => {}}
              showPagination={false}
              getRowKey={(lead) => lead.id}
              onRowClick={(lead) => navigate(`/leads/${lead.id}`)}
            />
            {isCapped ? (
              <p className="mt-3 text-center text-xs font-semibold text-slate-500">
                Showing the first {LEADS_LIST_PAGE_SIZE} leads. Refine the filters to narrow the list.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
