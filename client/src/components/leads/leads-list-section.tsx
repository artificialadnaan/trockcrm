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

export function LeadsListSection({ scope, filterBar }: LeadsListSectionProps) {
  const navigate = useNavigate();
  const { filters: urlFilters, setFilters, resetFilters } = useFilterState();
  const filterBarOwnsScope = filterBar.dimensions.includes("scope");

  // Stage label map from the bar's stage options (the mount builds these from the board stages), so
  // the Stage column shows a name without a second stage fetch.
  const stageNameById = useMemo(
    () => new Map((filterBar.options?.stages ?? []).map((stage) => [stage.value, stage.label])),
    [filterBar.options?.stages]
  );

  const leadArgs = {
    ...filterBarValueToLeadFilters(urlFilters),
    // Scope is the page toggle's (inherited) unless the bar renders a scope control.
    scope: filterBarOwnsScope ? urlFilters.scope ?? scope : scope,
    // Show every lifecycle; the Status dimension narrows it (no implicit open-only filter like the board).
    isActive: "all" as const,
  };
  const { leads, loading, error } = useLeads(leadArgs);

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
      render: (lead) => (
        <span className="text-sm font-semibold text-slate-600">{stageNameById.get(lead.stageId) ?? "—"}</span>
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
          <PipelineStageTable
            rows={leads}
            columns={columns}
            // Pagination is a BLUE follow-up (the leads endpoint isn't paginated yet); show the
            // returned set on one page with a record count until page/limit land server-side.
            pagination={{ page: 1, pageSize: leads.length || 1, total: leads.length, totalPages: 1 }}
            onPageChange={() => {}}
            showPagination={false}
            getRowKey={(lead) => lead.id}
            onRowClick={(lead) => navigate(`/leads/${lead.id}`)}
          />
        )}
      </div>
    </section>
  );
}
